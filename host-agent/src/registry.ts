import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, cp, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import { ToolRequestSchema, type ToolName, type ToolResult } from '../../shared/src/types.js';
import { ToolArgs } from '../../shared/src/validation.js';
import { TOOL_REGISTRY, canonicalToolName, validateToolArgs } from '../../shared/src/tooling.js';

const execFile = promisify(execFileCb);
const MAX = 128 * 1024;
const BACKUP_ROOT = '/var/backups/server-manager/';
const CONFIG_ROOTS = ['/etc/nginx/sites-available/', '/etc/nginx/sites-enabled/', '/etc/server-manager/allowlisted/', '/opt/server-manager/allowlisted/'];
const REPO_ROOTS = ['/opt/server-manager/', '/app/'];
const HIDDIFY_ROOTS = ['/etc/hiddify-manager/', '/opt/hiddify-manager/', '/var/lib/hiddify-manager/', '/var/lib/hiddify/', '/etc/cron.d/'];
const NGINX_ROOTS = ['/etc/nginx/sites-available/', '/etc/nginx/sites-enabled/'];
const BROAD_PATHS = new Set(['/', '/etc', '/opt', '/var', '/var/lib', '/var/lib/docker']);
const sensitivePath = (value: string): boolean => /(^|\/)(?:\.env|id_[^/]+|[^/]*(?:secret|password|credential|private)[^/]*)$|\.(?:pem|key|p12|pfx)$/i.test(value);
const allowed = (name: string, envName: string): boolean => (process.env[envName] ?? '').split(',').map((v) => v.trim()).filter(Boolean).includes(name);
const envPaths = (envName: string): string[] => (process.env[envName] ?? '').split(',').map((v) => v.trim()).filter(Boolean).map((v) => resolve(v));
const roots = (base: string[], envName: string): string[] => [...base, ...envPaths(envName)];

async function fixed(executable: string, args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFile(executable, args, { shell: false, timeout: timeoutMs, maxBuffer: MAX, windowsHide: true, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } });
    return { stdout: redactText(String(result.stdout).slice(0, MAX)), stderr: redactText(String(result.stderr).slice(0, MAX)), exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
    return { stdout: redactText((e.stdout ?? '').slice(0, MAX)), stderr: redactText((e.stderr ?? e.message ?? '').slice(0, MAX)), exitCode: typeof e.code === 'number' ? e.code : 1 };
  }
}

function result(tool: ToolName, startedAt: string, data?: unknown, error?: { category: string; message: string }, exitCode?: number): ToolResult {
  const finishedAt = new Date().toISOString();
  const base: ToolResult = { ok: !error, tool, startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt) };
  if (data !== undefined) base.data = data; if (error) base.error = error; if (exitCode !== undefined) base.exitCode = exitCode; return base;
}
function commandData(command: { stdout: string; stderr: string; exitCode: number }): { exitCode: number; stdout: string; stderr: string } { return { exitCode: command.exitCode, stdout: command.stdout, stderr: command.stderr }; }
function commandResult(tool: ToolName, startedAt: string, command: { stdout: string; stderr: string; exitCode: number }, extra?: Record<string, unknown>): ToolResult {
  const data = { ...(extra ?? {}), ...commandData(command) };
  return command.exitCode === 0 ? result(tool, startedAt, data, undefined, command.exitCode) : result(tool, startedAt, data, { category: 'command_failed', message: command.stderr || `Command exited with code ${command.exitCode}` }, command.exitCode);
}
function percent(used: number, total: number): number { return total > 0 ? Math.round((used / total) * 10000) / 100 : 0; }
function redactText(text: string): string { return text.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED PRIVATE KEY]').replace(/((?:["']?(?:api[_-]?key|password|secret|token|private[_-]?key|authorization)["']?\s*[:=]\s*["']?))[^\s"',}]+/gi, '$1[REDACTED]'); }

export async function execute(raw: unknown): Promise<ToolResult> {
  const request = ToolRequestSchema.parse(raw);
  const args = validateToolArgs(request.tool, request.args);
  const definition = TOOL_REGISTRY[request.tool];
  if (definition.requiresConfirmation && !request.confirmationId) throw new Error('Confirmation is required for this operation');
  const canonical = canonicalToolName(request.tool);
  const startedAt = new Date().toISOString();
  try {
    if (!definition.canonical) return legacyExecute(request.tool, startedAt, args, request.operationId);
    switch (canonical) {
      case 'list_directory': return result(request.tool, startedAt, await listDirectory(args as z.infer<typeof ToolArgs.listDirectory>));
      case 'search_files': return result(request.tool, startedAt, await searchFiles(args as z.infer<typeof ToolArgs.searchFiles>));
      case 'read_file': return result(request.tool, startedAt, await readAllowlistedFile((args as z.infer<typeof ToolArgs.readFile>).path, (args as z.infer<typeof ToolArgs.readFile>).maxBytes));
      case 'git_status': return commandResult(request.tool, startedAt, await gitCommand(args as z.infer<typeof ToolArgs.git>, ['status', '--short', '--branch']));
      case 'git_diff': return commandResult(request.tool, startedAt, await gitCommand(args as z.infer<typeof ToolArgs.git>, ['diff', '--no-ext-diff', '--no-color']));
      case 'system_resources': return result(request.tool, startedAt, { cpuPercent: await cpuPercent(), ramPercent: percent(os.totalmem() - os.freemem(), os.totalmem()), ramTotalBytes: os.totalmem(), ramFreeBytes: os.freemem(), swapPercent: await swapPercent(), uptimeSeconds: os.uptime(), disk: commandData(await fixed('/usr/bin/df', ['-P', '-x', 'tmpfs', '-x', 'devtmpfs'])) });
      case 'listening_ports': return commandResult(request.tool, startedAt, await fixed('/usr/bin/ss', ['-H', '-lntup']));
      case 'systemd_status': return commandResult(request.tool, startedAt, await systemdStatus(args as z.infer<typeof ToolArgs.systemdStatus>));
      case 'journal_logs': return commandResult(request.tool, startedAt, await journalLogs(args as z.infer<typeof ToolArgs.journal>));
      case 'docker_status': return result(request.tool, startedAt, { daemon: commandData(await fixed('/usr/bin/systemctl', ['is-active', 'docker'])), containers: commandData(await fixed('/usr/bin/docker', ['ps', '-a', '--format', '{{json .}}'])), disk: commandData(await fixed('/usr/bin/docker', ['system', 'df'])) });
      case 'pm2_status': return commandResult(request.tool, startedAt, await fixed('/usr/bin/pm2', ['jlist']));
      case 'nginx_test': return commandResult(request.tool, startedAt, await fixed('/usr/sbin/nginx', ['-t']));
      case 'nginx_config_inventory': return result(request.tool, startedAt, await nginxInventory());
      case 'hiddify_inventory': return result(request.tool, startedAt, await hiddifyInventory());
      case 'write_file': return result(request.tool, startedAt, await writeAllowlistedFile(args as z.infer<typeof ToolArgs.writeFile>, request.operationId));
      case 'delete_file': return result(request.tool, startedAt, await deleteAllowlistedFile((args as z.infer<typeof ToolArgs.deleteFile>).path, request.operationId));
      case 'delete_directory': return result(request.tool, startedAt, await deleteAllowlistedDirectory((args as z.infer<typeof ToolArgs.deleteDirectory>).path, request.operationId));
      case 'restart_service': return await restartService(request.tool, startedAt, (args as z.infer<typeof ToolArgs.restartService>).service, request.operationId);
      case 'reload_nginx': return await reloadNginx(request.tool, startedAt, request.operationId);
      case 'remove_docker_container': return await removeDockerContainer(request.tool, startedAt, (args as z.infer<typeof ToolArgs.removeDockerContainer>).name, request.operationId);
      case 'remove_systemd_unit': return await removeSystemdUnit(request.tool, startedAt, (args as z.infer<typeof ToolArgs.removeSystemdUnit>).unit, request.operationId);
      case 'remove_hiddify_artifact': return await removeHiddifyArtifact(request.tool, startedAt, args as z.infer<typeof ToolArgs.removeHiddifyArtifact>, request.operationId);
      default: return legacyExecute(request.tool, startedAt, args, request.operationId);
    }
  } catch (error) { return result(request.tool, startedAt, undefined, { category: 'execution_error', message: error instanceof Error ? error.message : 'Tool failed' }); }
}

async function listDirectory(args: z.infer<typeof ToolArgs.listDirectory>): Promise<unknown> { const path = await safeExistingPath(args.path, roots(CONFIG_ROOTS, 'SERVER_MANAGER_PATH_ALLOWLIST'), true); const entries = await readdir(path, { withFileTypes: true }); return { path, entries: entries.filter((entry) => args.includeHidden || !entry.name.startsWith('.')).slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })) }; }
async function searchFiles(args: z.infer<typeof ToolArgs.searchFiles>): Promise<unknown> {
  const root = await safeExistingPath(args.path, roots(CONFIG_ROOTS, 'SERVER_MANAGER_PATH_ALLOWLIST'), true); const found: Array<{ path: string; match: 'filename' | 'content' }> = []; const needle = args.pattern.toLowerCase();
  const visit = async (path: string): Promise<void> => { if (found.length >= args.maxResults) return; let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) { if (found.length >= args.maxResults || entry.name.startsWith('.')) continue; const child = resolve(path, entry.name); if (sensitivePath(child)) continue; if (entry.isDirectory()) await visit(child); else if (entry.isFile()) { if (entry.name.toLowerCase().includes(needle)) found.push({ path: child, match: 'filename' }); else if ((await readFile(child).catch(() => Buffer.alloc(0))).subarray(0, 128 * 1024).toString('utf8').toLowerCase().includes(needle)) found.push({ path: child, match: 'content' }); }
    }
  }; await visit(root); return { root, pattern: args.pattern, results: found };
}
async function readAllowlistedFile(input: string, maxBytes: number): Promise<unknown> { if (sensitivePath(input)) throw new Error('Sensitive files cannot be read'); const path = await safeExistingPath(input, roots(CONFIG_ROOTS, 'SERVER_MANAGER_PATH_ALLOWLIST'), false); const info = await stat(path); if (!info.isFile()) throw new Error('Path is not a file'); return { path, content: redactText((await readFile(path)).subarray(0, maxBytes).toString('utf8')) }; }
async function gitCommand(args: z.infer<typeof ToolArgs.git>, command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> { const path = await safeExistingPath(args.path ?? process.cwd(), roots(REPO_ROOTS, 'GIT_REPO_ALLOWLIST'), true); return fixed('/usr/bin/git', ['-C', path, ...command]); }
async function systemdStatus(args: z.infer<typeof ToolArgs.systemdStatus>): Promise<{ stdout: string; stderr: string; exitCode: number }> { if (args.service) { assertServiceName(args.service); return fixed('/usr/bin/systemctl', ['status', args.service, '--no-pager', '--plain']); } return fixed('/usr/bin/systemctl', ['--failed', '--no-legend', '--plain']); }
async function journalLogs(args: z.infer<typeof ToolArgs.journal>): Promise<{ stdout: string; stderr: string; exitCode: number }> { if (args.service) { assertServiceName(args.service); return fixed('/usr/bin/journalctl', ['-u', args.service, '-n', String(args.lines), '--no-pager', '-o', 'short-iso']); } return fixed('/usr/bin/journalctl', ['-n', String(args.lines), '--no-pager', '-o', 'short-iso']); }

async function nginxInventory(): Promise<unknown> { const files = await filesUnder(NGINX_ROOTS); const references: Array<{ path: string; lines: string[] }> = []; const serverNames = new Set<string>(); for (const path of files) { if (sensitivePath(path)) continue; const content = await readFile(path, 'utf8').catch(() => ''); const allLines = content.split(/\r?\n/); for (const line of allLines) { if (/^\s*server_name\s+/i.test(line)) for (const name of line.replace(/;.*$/, '').replace(/^\s*server_name\s+/i, '').split(/\s+/)) if (/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/.test(name) && !/hiddify/i.test(name)) serverNames.add(name.toLowerCase()); } const lines = allLines.filter((line) => line.toLowerCase().includes('hiddify') || line.toLowerCase().includes('proxy_pass')); if (lines.length) references.push({ path, lines: lines.slice(0, 40).map(redactText) }); } return { files, serverNames: [...serverNames].slice(0, 20), hiddifyReferences: references.filter((item) => item.lines.some((line) => /hiddify/i.test(line))) }; }

type Finding = { kind: 'file' | 'directory' | 'service' | 'process' | 'container' | 'image' | 'volume' | 'cron' | 'nginx_reference' | 'port'; identifier: string; classification: 'definite' | 'possible' | 'unrelated'; evidence: string };
async function hiddifyInventory(): Promise<unknown> {
  const [units, unitFiles, processes, containers, images, volumes, cron, ports, nginx, hiddifyFiles] = await Promise.all([
    fixed('/usr/bin/systemctl', ['list-units', '--all', '--type=service', '--no-legend', '--plain']),
    fixed('/usr/bin/systemctl', ['list-unit-files', '--type=service', '--no-legend', '--plain']),
    fixed('/usr/bin/ps', ['-eo', 'pid=,user=,comm=,args=']),
    fixed('/usr/bin/docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}']),
    fixed('/usr/bin/docker', ['images', '--no-trunc', '--format', '{{json .}}']),
    fixed('/usr/bin/docker', ['volume', 'ls', '--format', '{{json .}}']),
    fixed('/usr/bin/find', ['/etc/cron.d', '/etc/cron.daily', '/etc/cron.hourly', '/etc/cron.weekly', '/etc/cron.monthly', '-maxdepth', '2', '-type', 'f', '-print']),
    fixed('/usr/bin/ss', ['-H', '-lntup']),
    nginxInventory(),
    filesUnder(HIDDIFY_ROOTS)
  ]);
  const findings: Finding[] = [];
  addMatching(findings, 'file', hiddifyFiles.join('\n'), /hiddify/i);
  addMatching(findings, 'service', units.stdout, /hiddify/i);
  addMatching(findings, 'service', unitFiles.stdout, /hiddify/i);
  addMatching(findings, 'process', processes.stdout, /hiddify/i);
  addMatching(findings, 'container', containers.stdout, /hiddify/i);
  addMatching(findings, 'image', images.stdout, /hiddify/i);
  addMatching(findings, 'volume', volumes.stdout, /hiddify/i);
  addMatching(findings, 'cron', cron.stdout, /hiddify/i);
  for (const reference of (nginx as { hiddifyReferences?: Array<{ path: string; lines: string[] }> }).hiddifyReferences ?? []) findings.push({ kind: 'nginx_reference', identifier: reference.path, classification: 'definite', evidence: reference.lines.join('\n') });
  if (/hiddify/i.test(ports.stdout)) addMatching(findings, 'port', ports.stdout, /hiddify/i); else if (ports.stdout) findings.push({ kind: 'port', identifier: 'listening ports', classification: 'possible', evidence: redactText(ports.stdout).slice(0, 4000) });
  const scanStatus = { services: units.exitCode, systemdUnitFiles: unitFiles.exitCode, processes: processes.exitCode, containers: containers.exitCode, images: images.exitCode, volumes: volumes.exitCode, cron: cron.exitCode, ports: ports.exitCode };
  const unrelated = Object.entries(scanStatus).filter(([, exitCode]) => exitCode === 0).map(([source]) => ({ source, classification: 'unrelated' as const, note: `Non-Hiddify ${source} findings are excluded from cleanup.` }));
  return { findings, unrelated, scanStatus, nginx: nginx, note: 'Inventory is read-only. Definite findings contain Hiddify evidence; possible findings require review; unrelated infrastructure is never deleted automatically.' };
}
function addMatching(findings: Finding[], kind: Finding['kind'], text: string, pattern: RegExp): void { for (const line of text.split(/\r?\n/).filter((value) => pattern.test(value)).slice(0, 100)) findings.push({ kind, identifier: extractIdentifier(kind, line), classification: 'definite', evidence: redactText(line).slice(0, 2000) }); }
function extractIdentifier(kind: Finding['kind'], line: string): string {
  if (kind === 'cron') return line.trim();
  if (kind === 'service') return line.trim().split(/\s+/)[0] ?? line.trim();
  if (kind === 'process') return line.trim().split(/\s+/).slice(-1)[0] ?? line.trim();
  if (kind === 'container' || kind === 'volume') { try { const parsed = JSON.parse(line) as Record<string, unknown>; const value = parsed.Names ?? parsed.Name; if (typeof value === 'string') return value.split(',')[0] ?? value; } catch { /* Keep a bounded evidence identifier below. */ } }
  if (kind === 'image') { try { const parsed = JSON.parse(line) as Record<string, unknown>; const repository = typeof parsed.Repository === 'string' ? parsed.Repository : ''; const tag = typeof parsed.Tag === 'string' ? parsed.Tag : ''; if (repository) return tag && tag !== '<none>' ? `${repository}:${tag}` : repository; } catch { /* Keep a bounded evidence identifier below. */ } }
  return line.trim().slice(0, 255);
}
async function filesUnder(searchRoots: string[]): Promise<string[]> { const files: string[] = []; for (const root of searchRoots) { const visit = async (path: string): Promise<void> => { const entries = await readdir(path, { withFileTypes: true }).catch(() => []); for (const entry of entries) { const child = resolve(path, entry.name); if (entry.isDirectory()) await visit(child); else if (entry.isFile()) files.push(child); } }; await visit(root); } return files.slice(0, 500); }

async function writeAllowlistedFile(args: z.infer<typeof ToolArgs.writeFile>, operationId: string): Promise<unknown> {
  const path = await safeExistingPath(args.path, roots(CONFIG_ROOTS, 'SERVER_MANAGER_PATH_ALLOWLIST'), false, true); const exists = await existsFile(path); const current = exists ? await readFile(path) : Buffer.alloc(0); if (args.expectedSha256 && createHash('sha256').update(current).digest('hex') !== args.expectedSha256) throw new Error('Current-file checksum does not match the reviewed version'); const backup = exists ? await createBackupForPath(path, operationId) : await createAbsenceBackup(path, operationId); const temp = `${path}.server-manager-${randomUUID()}.tmp`;
  try { await writeFile(temp, args.content, { mode: 0o640 }); await rename(temp, path); return { updated: path, backupPath: backup, checksum: createHash('sha256').update(args.content).digest('hex') }; } catch (error) { await unlink(temp).catch(() => undefined); if (backup) await restoreBackupFile(backup, path).catch(() => undefined); throw error; }
}
async function deleteAllowlistedFile(input: string, operationId: string): Promise<unknown> { const path = await safeExistingPath(input, roots(CONFIG_ROOTS, 'SERVER_MANAGER_PATH_ALLOWLIST'), false); return deleteFileAtPath(path, operationId); }
async function deleteAllowlistedDirectory(input: string, operationId: string): Promise<unknown> { const path = await safeExistingPath(input, roots(CONFIG_ROOTS, 'SERVER_MANAGER_PATH_ALLOWLIST'), false); return deleteDirectoryAtPath(path, operationId); }
async function deleteFileAtPath(path: string, operationId: string): Promise<unknown> { const info = await stat(path); if (!info.isFile()) throw new Error('Path is not a file'); const backup = await createBackupForPath(path, operationId); await unlink(path); return { deleted: path, backupPath: backup }; }
async function deleteDirectoryAtPath(path: string, operationId: string): Promise<unknown> { const info = await stat(path); if (!info.isDirectory()) throw new Error('Path is not a directory'); const backup = await createDirectoryBackup(path, operationId); await rm(path, { recursive: true, force: false }); return { deleted: path, backupPath: backup }; }
async function restartService(tool: ToolName, startedAt: string, service: string, operationId: string): Promise<ToolResult> { assertServiceName(service); if (!allowedService(service)) throw new Error('Service is not allowlisted'); const backup = await backupOperation({ operationId, kind: 'service', service, before: await fixed('/usr/bin/systemctl', ['is-active', service]) }); return commandResult(tool, startedAt, await fixed('/usr/bin/systemctl', ['restart', service]), { backupPath: backup }); }
async function reloadNginx(tool: ToolName, startedAt: string, operationId: string): Promise<ToolResult> { const validation = await fixed('/usr/sbin/nginx', ['-t']); if (validation.exitCode !== 0) return commandResult(tool, startedAt, validation, { phase: 'validation', reloaded: false }); const backup = await backupOperation({ operationId, kind: 'nginx_reload', before: await nginxInventory() }); return commandResult(tool, startedAt, await fixed('/usr/bin/systemctl', ['reload', 'nginx']), { phase: 'reload', backupPath: backup }); }
async function removeDockerContainer(tool: ToolName, startedAt: string, name: string, operationId: string): Promise<ToolResult> { if (!allowed(name, 'DOCKER_CONTAINER_ALLOWLIST')) throw new Error('Container is not allowlisted'); const inspect = await fixed('/usr/bin/docker', ['inspect', name]); if (inspect.exitCode !== 0) return commandResult(tool, startedAt, inspect, { phase: 'inspect', removed: false }); const backup = await backupOperation({ operationId, kind: 'docker_container', name, inspect: inspect.stdout }); return commandResult(tool, startedAt, await fixed('/usr/bin/docker', ['rm', name]), { backupPath: backup }); }
async function removeSystemdUnit(tool: ToolName, startedAt: string, unit: string, operationId: string): Promise<ToolResult> { assertServiceName(unit); if (!allowedService(unit)) throw new Error('Systemd unit is not allowlisted'); const unitPath = await safeExistingPath(`/etc/systemd/system/${unit}`, ['/etc/systemd/system/'], false).catch(() => null); const fileBackup = unitPath ? await createBackup(unitPath, operationId) : undefined; const backup = await backupOperation({ operationId, kind: 'systemd_unit', unit, status: await fixed('/usr/bin/systemctl', ['status', unit, '--no-pager', '--plain']) }, fileBackup); const stopped = await fixed('/usr/bin/systemctl', ['disable', '--now', unit]); if (stopped.exitCode !== 0) return commandResult(tool, startedAt, stopped, { backupPath: backup, removed: false }); if (unitPath) await unlink(unitPath); const reloaded = await fixed('/usr/bin/systemctl', ['daemon-reload']); if (reloaded.exitCode !== 0 && unitPath && fileBackup) { await restoreBackupFile(fileBackup, unitPath).catch(() => undefined); await fixed('/usr/bin/systemctl', ['daemon-reload']); } return commandResult(tool, startedAt, reloaded, { backupPath: backup, removed: reloaded.exitCode === 0, rolledBack: reloaded.exitCode !== 0 && Boolean(fileBackup) }); }
async function removeHiddifyArtifact(tool: ToolName, startedAt: string, args: z.infer<typeof ToolArgs.removeHiddifyArtifact>, operationId: string): Promise<ToolResult> {
  if (args.kind === 'service') { if (!/hiddify/i.test(args.path) || !allowed(args.path, 'HIDDIFY_SERVICE_ALLOWLIST')) throw new Error('Hiddify service is not allowlisted'); return restartOrDisable(tool, startedAt, args.path, operationId); }
  if (args.kind === 'container') { if (!/hiddify/i.test(args.path) || !allowed(args.path, 'HIDDIFY_CONTAINER_ALLOWLIST')) throw new Error('Hiddify container is not allowlisted'); return removeDockerContainer(tool, startedAt, args.path, operationId); }
  if (args.kind === 'volume') { if (!/hiddify/i.test(args.path) || !allowed(args.path, 'HIDDIFY_VOLUME_ALLOWLIST')) throw new Error('Hiddify volume is not allowlisted'); const inspect = await fixed('/usr/bin/docker', ['volume', 'inspect', args.path]); if (inspect.exitCode !== 0) return commandResult(tool, startedAt, inspect, { removed: false }); const backup = await backupOperation({ operationId, kind: 'hiddify_volume', name: args.path, inspect: inspect.stdout }); return commandResult(tool, startedAt, await fixed('/usr/bin/docker', ['volume', 'rm', args.path]), { backupPath: backup }); }
  const allowedRoots = args.kind === 'nginx_reference' ? NGINX_ROOTS : args.kind === 'cron' ? ['/etc/cron.d/'] : HIDDIFY_ROOTS; const path = await safeExistingPath(args.path, roots(allowedRoots, 'HIDDIFY_PATH_ALLOWLIST'), false); if (args.kind === 'nginx_reference') { const content = await readFile(path, 'utf8'); if (!/hiddify/i.test(content)) throw new Error('Nginx file is not a confirmed Hiddify reference'); }
  if (!/hiddify/i.test(args.path) && args.kind !== 'nginx_reference') throw new Error('Artifact is not identified as Hiddify');
  if (args.kind === 'directory') return result(tool, startedAt, await deleteDirectoryAtPath(path, operationId));
  return result(tool, startedAt, await deleteFileAtPath(path, operationId));
}
async function restartOrDisable(tool: ToolName, startedAt: string, service: string, operationId: string): Promise<ToolResult> { const backup = await backupOperation({ operationId, kind: 'hiddify_service', service, before: await fixed('/usr/bin/systemctl', ['is-active', service]) }); return commandResult(tool, startedAt, await fixed('/usr/bin/systemctl', ['disable', '--now', service]), { backupPath: backup }); }

async function legacyExecute(tool: ToolName, startedAt: string, args: Record<string, unknown>, operationId: string): Promise<ToolResult> {
  switch (tool) {
    case 'system.getResources': return result(tool, startedAt, { cpuPercent: await cpuPercent(), ramPercent: percent(os.totalmem() - os.freemem(), os.totalmem()), swapPercent: await swapPercent() });
    case 'system.getLoad': return result(tool, startedAt, { load1: os.loadavg()[0] ?? 0, load5: os.loadavg()[1] ?? 0, load15: os.loadavg()[2] ?? 0, cpuCount: os.cpus().length });
    case 'system.getUptime': return result(tool, startedAt, { uptimeSeconds: os.uptime(), hostname: os.hostname(), platform: os.platform() });
    case 'disk.getUsage': return commandResult(tool, startedAt, await fixed('/usr/bin/df', ['-P', '-x', 'tmpfs', '-x', 'devtmpfs']));
    case 'memory.getUsage': return result(tool, startedAt, { totalBytes: os.totalmem(), freeBytes: os.freemem(), swap: commandData(await fixed('/usr/bin/free', ['-b'])) });
    case 'docker.getStatus': return commandResult(tool, startedAt, await fixed('/usr/bin/systemctl', ['is-active', 'docker']));
    case 'docker.getContainers': return commandResult(tool, startedAt, await fixed('/usr/bin/docker', ['ps', '-a', '--format', '{{json .}}']));
    case 'docker.getDiskUsage': return commandResult(tool, startedAt, await fixed('/usr/bin/docker', ['system', 'df']));
    case 'pm2.getStatus': return commandResult(tool, startedAt, await fixed('/usr/bin/pm2', ['jlist']));
    case 'pm2.getLogs': return commandResult(tool, startedAt, await fixed('/usr/bin/pm2', ['logs', String(args.service ?? 'all'), '--lines', String(args.lines ?? 50), '--nostream']));
    case 'nginx.getStatus': return commandResult(tool, startedAt, await fixed('/usr/bin/systemctl', ['is-active', 'nginx']));
    case 'nginx.testConfig': return commandResult(tool, startedAt, await fixed('/usr/sbin/nginx', ['-t']));
    case 'network.getListeningPorts': return commandResult(tool, startedAt, await fixed('/usr/bin/ss', ['-H', '-lntup']));
    case 'systemd.getFailedServices': return commandResult(tool, startedAt, await fixed('/usr/bin/systemctl', ['--failed', '--no-legend', '--plain']));
    case 'logs.getCritical': return commandResult(tool, startedAt, await fixed('/usr/bin/journalctl', ['-p', '0..2', '-n', String(args.lines ?? 50), '--no-pager', '-o', 'short-iso']));
    case 'logs.getApplicationErrors': return commandResult(tool, startedAt, await fixed('/usr/bin/journalctl', ['-p', '0..3', '-n', String(args.lines ?? 50), '--no-pager', '-o', 'short-iso']));
    case 'ssl.checkCertificate': return result(tool, startedAt, await sslCheck(args as z.infer<typeof ToolArgs.ssl>));
    case 'http.checkWebsite': return result(tool, startedAt, await websiteCheck(args as z.infer<typeof ToolArgs.website>));
    case 'dns.resolveConfiguredDomain': return result(tool, startedAt, { domain: String(args.domain), addresses: await dns.resolve(String(args.domain)) });
    case 'config.getAllowlistedFile': return result(tool, startedAt, await readAllowlistedFile(String(args.path), MAX));
    case 'backup.create': return result(tool, startedAt, { backupPath: await createBackup(String(args.path), operationId) });
    case 'nginx.reload': return reloadNginx(tool, startedAt, operationId);
    case 'nginx.updateAllowlistedConfig': return result(tool, startedAt, await writeAllowlistedFile({ path: String(args.path), content: String(args.content), ...(args.expectedSha256 ? { expectedSha256: String(args.expectedSha256) } : {}) }, operationId));
    case 'pm2.restartAllowlistedProcess': return allowlistedCommand(tool, startedAt, 'PM2_ALLOWLIST', String(args.name), '/usr/bin/pm2', ['restart', String(args.name)], operationId);
    case 'pm2.reloadAllowlistedProcess': return allowlistedCommand(tool, startedAt, 'PM2_ALLOWLIST', String(args.name), '/usr/bin/pm2', ['reload', String(args.name)], operationId);
    case 'docker.restartAllowlistedContainer': return allowlistedCommand(tool, startedAt, 'DOCKER_CONTAINER_ALLOWLIST', String(args.name), '/usr/bin/docker', ['restart', String(args.name)], operationId);
    case 'docker.composeUpAllowlistedProject': return allowlistedCommand(tool, startedAt, 'DOCKER_PROJECT_ALLOWLIST', String(args.project), '/usr/bin/docker', ['compose', '--project-name', String(args.project), 'up', '-d'], operationId);
    case 'docker.composeDownAllowlistedProject': return allowlistedCommand(tool, startedAt, 'DOCKER_PROJECT_ALLOWLIST', String(args.project), '/usr/bin/docker', ['compose', '--project-name', String(args.project), 'down'], operationId);
    case 'systemd.restartAllowlistedService': return allowlistedCommand(tool, startedAt, 'SYSTEMD_SERVICE_ALLOWLIST', String(args.service), '/usr/bin/systemctl', ['restart', String(args.service)], operationId);
    case 'config.restoreBackup': return result(tool, startedAt, await restoreBackup(String(args.path)));
    case 'rollback.restore': return result(tool, startedAt, await restoreBackup(String(args.path)));
    default: throw new Error('Unknown tool');
  }
}

async function allowlistedCommand(tool: ToolName, startedAt: string, env: string, name: string, executable: string, args: string[], operationId: string): Promise<ToolResult> { if (!allowed(name, env)) return result(tool, startedAt, undefined, { category: 'not_allowlisted', message: `${name} is not allowlisted` }); const backup = await backupOperation({ operationId, kind: 'command', tool, name, before: new Date().toISOString() }); return commandResult(tool, startedAt, await fixed(executable, args), { backupPath: backup }); }
async function safeExistingPath(input: string, allowedRoots: string[], mustBeDirectory: boolean, allowMissing = false): Promise<string> { const normalized = resolve(input); assertNotBroad(normalized); const matching = allowedRoots.map(resolveRoot).find((root) => normalized.startsWith(root) && normalized !== root.slice(0, -1)); if (!matching) throw new Error('Path is not allowlisted'); const actual = await realpath(normalized).catch(async () => { if (!allowMissing) throw new Error('Path does not exist'); const parent = await realpath(dirname(normalized)).catch(() => { throw new Error('Parent path does not exist'); }); if (!parent.startsWith(matching)) throw new Error('Parent path escapes the allowlist'); return normalized; }); if (!actual.startsWith(matching)) throw new Error('Symlink escapes the allowlist'); if (mustBeDirectory && (await stat(actual)).isDirectory() === false) throw new Error('Path is not a directory'); return actual; }
function resolveRoot(value: string): string { const root = resolve(value); return root.endsWith('/') ? root : `${root}/`; }
function assertNotBroad(path: string): void { if (BROAD_PATHS.has(path) || path.endsWith('/..')) throw new Error('Broad path is not allowed'); }
function assertServiceName(name: string): void { if (!/^[a-zA-Z0-9_.@:-]+(?:\.service)?$/.test(name) || name.includes('/')) throw new Error('Unsafe service name'); }
function allowedService(name: string): boolean { return allowed(name, 'SYSTEMD_SERVICE_ALLOWLIST') || allowed(name, 'HIDDIFY_SERVICE_ALLOWLIST'); }
async function existsFile(path: string): Promise<boolean> { return stat(path).then(() => true).catch(() => false); }
async function createBackupIfPresent(path: string, operationId: string): Promise<string | null> { return (await existsFile(path)) ? createBackup(path, operationId) : null; }
async function createBackup(inputPath: string, operationId: string): Promise<string> { const path = await safeExistingPath(inputPath, roots(CONFIG_ROOTS, 'SERVER_MANAGER_PATH_ALLOWLIST'), false); return createBackupForPath(path, operationId); }
async function createBackupForPath(path: string, operationId: string): Promise<string> { const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const dir = `${BACKUP_ROOT}${stamp}-${randomUUID()}`; await mkdir(dir, { recursive: true, mode: 0o750 }); const dest = `${dir}/${basename(path)}`; await cp(path, dest, { errorOnExist: true }); const checksum = createHash('sha256').update(await readFile(path)).digest('hex'); await writeFile(`${dest}.sha256`, `${checksum}  ${dest}\n`, { mode: 0o640 }); await writeFile(`${dest}.json`, JSON.stringify({ operationId, originalPath: path, checksum, createdAt: new Date().toISOString() }, null, 2), { mode: 0o640 }); return dest; }
async function createAbsenceBackup(path: string, operationId: string): Promise<string> { const dir = `${BACKUP_ROOT}${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`; await mkdir(dir, { recursive: true, mode: 0o750 }); const dest = `${dir}/${basename(path)}.missing`; await writeFile(`${dest}.json`, JSON.stringify({ operationId, originalPath: path, kind: 'absence', createdAt: new Date().toISOString() }, null, 2), { mode: 0o640 }); return dest; }
async function createDirectoryBackup(path: string, operationId: string): Promise<string> { const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const dir = `${BACKUP_ROOT}${stamp}-${randomUUID()}`; await mkdir(dir, { recursive: true, mode: 0o750 }); const dest = `${dir}/${basename(path)}`; await cp(path, dest, { recursive: true, errorOnExist: true }); await writeFile(`${dest}.json`, JSON.stringify({ operationId, originalPath: path, directory: true, createdAt: new Date().toISOString() }, null, 2), { mode: 0o640 }); return dest; }
async function restoreBackupFile(backup: string, original: string): Promise<void> { const metadata = JSON.parse(await readFile(`${backup}.json`, 'utf8')) as { originalPath: string; checksum?: string; kind?: string }; if (resolve(metadata.originalPath) !== resolve(original)) throw new Error('Backup path mismatch'); if (metadata.kind === 'absence') { await unlink(original).catch(() => undefined); return; } if (!metadata.checksum || createHash('sha256').update(await readFile(backup)).digest('hex') !== metadata.checksum) throw new Error('Backup checksum mismatch'); const temp = `${original}.server-manager-restore-${randomUUID()}.tmp`; await cp(backup, temp); await rename(temp, original); }
async function restoreBackup(inputPath: string): Promise<unknown> { const backup = await safeBackupPath(inputPath); const metadata = JSON.parse(await readFile(`${backup}.json`, 'utf8')) as { originalPath: string; checksum: string }; const original = await safeExistingPath(metadata.originalPath, roots([...CONFIG_ROOTS, ...HIDDIFY_ROOTS, ...NGINX_ROOTS], 'SERVER_MANAGER_PATH_ALLOWLIST'), false, true); await restoreBackupFile(backup, original); return { restored: original, checksum: metadata.checksum }; }
async function safeBackupPath(input: string): Promise<string> { const normalized = resolve(input); if (!normalized.startsWith(resolveRoot(BACKUP_ROOT)) || normalized === resolve(BACKUP_ROOT)) throw new Error('Backup path is not allowlisted'); return normalized; }
async function backupOperation(data: Record<string, unknown>, extraPath?: string): Promise<string> { const dir = `${BACKUP_ROOT}operations`; await mkdir(dir, { recursive: true, mode: 0o750 }); const path = `${dir}/${String(data.operationId)}.json`; await writeFile(path, JSON.stringify({ ...data, extraPath, createdAt: new Date().toISOString() }, null, 2), { mode: 0o640 }); await appendFile(`${dir}/audit.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...data, extraPath }) + '\n', { mode: 0o640 }); return path; }

async function cpuPercent(): Promise<number> { const first = os.cpus().map((c) => c.times); await new Promise((r) => setTimeout(r, 50)); const second = os.cpus().map((c) => c.times); let idle = 0; let total = 0; for (let i = 0; i < first.length; i += 1) { const a = first[i]!; const b = second[i]!; const delta = Object.values(b).reduce((x, y) => x + y, 0) - Object.values(a).reduce((x, y) => x + y, 0); idle += b.idle - a.idle; total += delta; } return total ? Math.round((1 - idle / total) * 10000) / 100 : 0; }
async function swapPercent(): Promise<number> { const text = (await fixed('/usr/bin/free', ['-b'])).stdout; const line = text.split('\n').find((v) => v.startsWith('Swap:')); const values = line?.split(/\s+/).filter(Boolean).slice(1).map(Number) ?? []; return values[0] ? percent(values[0] - (values[2] ?? 0), values[0]) : 0; }
async function sslCheck(args: z.infer<typeof ToolArgs.ssl>): Promise<unknown> { return new Promise((resolveResult) => { const started = Date.now(); const socket = tls.connect({ host: args.domain, port: args.port, servername: args.domain, rejectUnauthorized: false, timeout: 10000 }, () => { const cert = socket.getPeerCertificate(true); const validTo = cert.valid_to ? Date.parse(cert.valid_to) : 0; resolveResult({ domain: args.domain, authorized: socket.authorized, authorizationError: socket.authorizationError, subject: cert.subject, issuer: cert.issuer, validFrom: cert.valid_from, validTo: cert.valid_to, daysRemaining: validTo ? Math.floor((validTo - Date.now()) / 86400000) : null, latencyMs: Date.now() - started, protocol: socket.getProtocol() }); socket.end(); }); socket.on('error', (error) => resolveResult({ domain: args.domain, authorized: false, error: error.message })); socket.on('timeout', () => { socket.destroy(); resolveResult({ domain: args.domain, authorized: false, error: 'TLS timeout' }); }); }); }
async function websiteCheck(args: z.infer<typeof ToolArgs.website>): Promise<unknown> { const url = new URL(args.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) is allowed'); const client = url.protocol === 'https:' ? httpsRequest : httpRequest; return new Promise((resolveResult) => { const started = Date.now(); const req = client(url, { method: 'GET', timeout: 10000, headers: { 'user-agent': 'sentinel-health/1.0', accept: '*/*' } }, (res) => { let bytes = 0; res.on('data', (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > 32 * 1024) res.destroy(); }); res.on('end', () => resolveResult({ url: args.url, status: res.statusCode, headers: { server: res.headers.server, location: res.headers.location, contentType: res.headers['content-type'] }, latencyMs: Date.now() - started })); }); req.on('error', (error) => resolveResult({ url: args.url, error: error.message, latencyMs: Date.now() - started })); req.end(); }); }
