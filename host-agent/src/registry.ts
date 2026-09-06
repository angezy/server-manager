import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { ToolRequestSchema, type ToolName, type ToolResult } from '../../shared/src/types.js';
import { ToolArgs } from '../../shared/src/validation.js';
import { TOOL_REGISTRY, validateToolArgs } from '../../shared/src/tooling.js';

const execFile = promisify(execFileCb);
const MAX = 128 * 1024;
const ALLOWED_PATH_PREFIXES = ['/etc/nginx/sites-available/', '/etc/nginx/sites-enabled/', '/etc/server-manager/allowlisted/', '/opt/server-manager/allowlisted/'];
const ALLOWED_BACKUP_PREFIX = '/var/backups/server-manager/';
const allowed = (name: string, envName: string): boolean => (process.env[envName] ?? '').split(',').map((v) => v.trim()).filter(Boolean).includes(name);
const safeConfigPath = (value: string): string => { const normalized = resolve(value); if (!ALLOWED_PATH_PREFIXES.some((prefix) => normalized.startsWith(resolve(prefix)))) throw new Error('Path is not allowlisted'); return normalized; };
const safeBackupPath = (value: string): string => { const normalized = resolve(value); if (!normalized.startsWith(resolve(ALLOWED_BACKUP_PREFIX))) throw new Error('Backup path is not allowlisted'); return normalized; };

async function fixed(executable: string, args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFile(executable, args, { shell: false, timeout: timeoutMs, maxBuffer: MAX, windowsHide: true, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } });
    return { stdout: result.stdout.slice(0, MAX), stderr: result.stderr.slice(0, MAX), exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; message?: string };
    return { stdout: (e.stdout ?? '').slice(0, MAX), stderr: (e.stderr ?? e.message ?? '').slice(0, MAX), exitCode: typeof e.code === 'number' ? e.code : 1 };
  }
}

function result(tool: ToolName, startedAt: string, data?: unknown, error?: { category: string; message: string }): ToolResult {
  const finishedAt = new Date().toISOString();
  const base: ToolResult = { ok: !error, tool, startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt) };
  if (data !== undefined) base.data = data; if (error) base.error = error; return base;
}
function commandData(command: { stdout: string; stderr: string; exitCode: number }): unknown { return { exitCode: command.exitCode, stdout: command.stdout, stderr: command.stderr }; }
function percent(used: number, total: number): number { return total > 0 ? Math.round((used / total) * 10000) / 100 : 0; }

export async function execute(raw: unknown): Promise<ToolResult> {
  const request = ToolRequestSchema.parse(raw);
  const args = validateToolArgs(request.tool, request.args);
  const definition = TOOL_REGISTRY[request.tool];
  if (definition.requiresConfirmation && !request.confirmationId) throw new Error('Confirmation is required for this operation');
  const startedAt = new Date().toISOString();
  try {
    switch (request.tool) {
      case 'system.getResources': {
        const total = os.totalmem(); const free = os.freemem();
        return result(request.tool, startedAt, { cpuPercent: await cpuPercent(), ramPercent: percent(total - free, total), ramTotalBytes: total, ramFreeBytes: free, swapPercent: await swapPercent() });
      }
      case 'system.getLoad': return result(request.tool, startedAt, { load1: os.loadavg()[0] ?? 0, load5: os.loadavg()[1] ?? 0, load15: os.loadavg()[2] ?? 0, cpuCount: os.cpus().length });
      case 'system.getUptime': return result(request.tool, startedAt, { uptimeSeconds: os.uptime(), hostname: os.hostname(), platform: os.platform(), at: new Date().toISOString() });
      case 'disk.getUsage': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/df', ['-P', '-x', 'tmpfs', '-x', 'devtmpfs'])));
      case 'memory.getUsage': return result(request.tool, startedAt, { totalBytes: os.totalmem(), freeBytes: os.freemem(), swap: commandData(await fixed('/usr/bin/free', ['-b'])) });
      case 'docker.getStatus': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/systemctl', ['is-active', 'docker'])));
      case 'docker.getContainers': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/docker', ['ps', '-a', '--format', '{{json .}}'])));
      case 'docker.getDiskUsage': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/docker', ['system', 'df'])));
      case 'pm2.getStatus': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/pm2', ['jlist'])));
      case 'pm2.getLogs': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/pm2', ['logs', (args as z.infer<typeof ToolArgs.log>).service ?? 'all', '--lines', String((args as z.infer<typeof ToolArgs.log>).lines ?? 50), '--nostream'])));
      case 'nginx.getStatus': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/systemctl', ['is-active', 'nginx'])));
      case 'nginx.testConfig': return result(request.tool, startedAt, commandData(await fixed('/usr/sbin/nginx', ['-t'])));
      case 'network.getListeningPorts': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/ss', ['-H', '-lntup'])));
      case 'systemd.getFailedServices': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/systemctl', ['--failed', '--no-legend', '--plain'])));
      case 'logs.getCritical': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/journalctl', ['-p', '0..2', '-n', String((args as z.infer<typeof ToolArgs.log>).lines ?? 50), '--no-pager', '-o', 'short-iso'])));
      case 'logs.getApplicationErrors': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/journalctl', ['-p', '0..3', '-n', String((args as z.infer<typeof ToolArgs.log>).lines ?? 50), '--no-pager', '-o', 'short-iso'])));
      case 'ssl.checkCertificate': return result(request.tool, startedAt, await sslCheck(args as z.infer<typeof ToolArgs.ssl>));
      case 'http.checkWebsite': return result(request.tool, startedAt, await websiteCheck(args as z.infer<typeof ToolArgs.website>));
      case 'dns.resolveConfiguredDomain': return result(request.tool, startedAt, { domain: (args as z.infer<typeof ToolArgs.domain>).domain, addresses: await dns.resolve((args as z.infer<typeof ToolArgs.domain>).domain) });
      case 'config.getAllowlistedFile': { const path = safeConfigPath((args as z.infer<typeof ToolArgs.config>).path); return result(request.tool, startedAt, { path, content: (await readFile(path, 'utf8')).slice(0, MAX) }); }
      case 'backup.create': return result(request.tool, startedAt, await createBackup((args as z.infer<typeof ToolArgs.config>).path, request.operationId));
      case 'nginx.reload': return result(request.tool, startedAt, commandData(await fixed('/usr/bin/systemctl', ['reload', 'nginx'])));
      case 'nginx.updateAllowlistedConfig': return result(request.tool, startedAt, await updateNginxConfig(args as z.infer<typeof ToolArgs.configUpdate>, request.operationId));
      case 'pm2.restartAllowlistedProcess': return allowlistedCommand(request.tool, startedAt, 'PM2_ALLOWLIST', (args as z.infer<typeof ToolArgs.process>).name, '/usr/bin/pm2', ['restart', (args as z.infer<typeof ToolArgs.process>).name]);
      case 'pm2.reloadAllowlistedProcess': return allowlistedCommand(request.tool, startedAt, 'PM2_ALLOWLIST', (args as z.infer<typeof ToolArgs.process>).name, '/usr/bin/pm2', ['reload', (args as z.infer<typeof ToolArgs.process>).name]);
      case 'docker.restartAllowlistedContainer': return allowlistedCommand(request.tool, startedAt, 'DOCKER_CONTAINER_ALLOWLIST', (args as z.infer<typeof ToolArgs.container>).name, '/usr/bin/docker', ['restart', (args as z.infer<typeof ToolArgs.container>).name]);
      case 'docker.composeUpAllowlistedProject': return allowlistedCommand(request.tool, startedAt, 'DOCKER_PROJECT_ALLOWLIST', (args as z.infer<typeof ToolArgs.project>).project, '/usr/bin/docker', ['compose', '--project-name', (args as z.infer<typeof ToolArgs.project>).project, 'up', '-d']);
      case 'docker.composeDownAllowlistedProject': return allowlistedCommand(request.tool, startedAt, 'DOCKER_PROJECT_ALLOWLIST', (args as z.infer<typeof ToolArgs.project>).project, '/usr/bin/docker', ['compose', '--project-name', (args as z.infer<typeof ToolArgs.project>).project, 'down']);
      case 'systemd.restartAllowlistedService': return allowlistedCommand(request.tool, startedAt, 'SYSTEMD_SERVICE_ALLOWLIST', (args as z.infer<typeof ToolArgs.service>).service, '/usr/bin/systemctl', ['restart', (args as z.infer<typeof ToolArgs.service>).service]);
      case 'config.restoreBackup': return result(request.tool, startedAt, await restoreBackup((args as z.infer<typeof ToolArgs.backup>).path));
      case 'rollback.restore': return result(request.tool, startedAt, await restoreBackup((args as z.infer<typeof ToolArgs.backup>).path));
    }
  } catch (error) { return result(request.tool, startedAt, undefined, { category: 'execution_error', message: error instanceof Error ? error.message : 'Tool failed' }); }
}

async function cpuPercent(): Promise<number> {
  const first = os.cpus().map((c) => c.times); await new Promise((r) => setTimeout(r, 100)); const second = os.cpus().map((c) => c.times);
  let idle = 0; let total = 0; for (let i = 0; i < first.length; i++) { const a = first[i]!; const b = second[i]!; const d = Object.values(b).reduce((x, y) => x + y, 0) - Object.values(a).reduce((x, y) => x + y, 0); idle += b.idle - a.idle; total += d; } return total ? Math.round((1 - idle / total) * 10000) / 100 : 0;
}
async function swapPercent(): Promise<number> { const text = (await fixed('/usr/bin/free', ['-b'])).stdout; const line = text.split('\n').find((v) => v.startsWith('Swap:')); const values = line?.split(/\s+/).filter(Boolean).slice(1).map(Number) ?? []; return values[0] ? percent(values[0] - (values[2] ?? 0), values[0]) : 0; }

async function sslCheck(args: z.infer<typeof ToolArgs.ssl>): Promise<unknown> {
  return new Promise((resolveResult) => { const started = Date.now(); const socket = tls.connect({ host: args.domain, port: args.port, servername: args.domain, rejectUnauthorized: false, timeout: 10000 }, () => { const cert = socket.getPeerCertificate(true); const validTo = cert.valid_to ? Date.parse(cert.valid_to) : 0; resolveResult({ domain: args.domain, authorized: socket.authorized, authorizationError: socket.authorizationError, subject: cert.subject, issuer: cert.issuer, validFrom: cert.valid_from, validTo: cert.valid_to, daysRemaining: validTo ? Math.floor((validTo - Date.now()) / 86400000) : null, latencyMs: Date.now() - started, protocol: socket.getProtocol() }); socket.end(); }); socket.on('error', (error) => resolveResult({ domain: args.domain, authorized: false, error: error.message })); socket.on('timeout', () => { socket.destroy(); resolveResult({ domain: args.domain, authorized: false, error: 'TLS timeout' }); }); });
}
async function websiteCheck(args: z.infer<typeof ToolArgs.website>): Promise<unknown> {
  const url = new URL(args.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) is allowed'); const client = url.protocol === 'https:' ? httpsRequest : httpRequest; return new Promise((resolveResult) => { const started = Date.now(); const req = client(url, { method: 'GET', timeout: 10000, headers: { 'user-agent': 'server-manager-health/1.0', accept: '*/*' } }, (res) => { let bytes = 0; res.on('data', (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > 32 * 1024) res.destroy(); }); res.on('end', () => resolveResult({ url: args.url, status: res.statusCode, headers: { server: res.headers.server, location: res.headers.location, contentType: res.headers['content-type'] }, latencyMs: Date.now() - started })); }); req.on('error', (error) => resolveResult({ url: args.url, error: error.message, latencyMs: Date.now() - started })); req.end(); });
}
async function createBackup(inputPath: string, operationId: string): Promise<unknown> { const path = safeConfigPath(inputPath); const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const dir = `/var/backups/server-manager/${stamp}`; await mkdir(dir, { recursive: true, mode: 0o750 }); const dest = `${dir}/${path.split('/').pop() ?? 'config'}`; await cp(path, dest, { errorOnExist: true }); const content = await readFile(path); const checksum = createHash('sha256').update(content).digest('hex'); await writeFile(`${dest}.sha256`, `${checksum}  ${dest}\n`, { mode: 0o640 }); await writeFile(`${dest}.json`, JSON.stringify({ operationId, originalPath: path, checksum, createdAt: new Date().toISOString() }, null, 2), { mode: 0o640 }); return { backupPath: dest, originalPath: path, checksum, operationId }; }
async function restoreBackup(inputPath: string): Promise<unknown> { const backup = safeBackupPath(inputPath); const metadata = JSON.parse(await readFile(`${backup}.json`, 'utf8')) as { originalPath: string; checksum: string }; const sourceHash = createHash('sha256').update(await readFile(backup)).digest('hex'); if (sourceHash !== metadata.checksum) throw new Error('Backup checksum mismatch'); const original = safeConfigPath(metadata.originalPath); const currentBackup = await createBackup(original, randomUUID()); const temp = `${original}.server-manager-${randomUUID()}.tmp`; await cp(backup, temp); await rename(temp, original); return { restored: original, checksum: sourceHash, currentBackup }; }
async function updateNginxConfig(args: z.infer<typeof ToolArgs.configUpdate>, operationId: string): Promise<unknown> { const path = safeConfigPath(args.path); const content = Buffer.from(args.content, 'utf8'); const checksum = createHash('sha256').update(content).digest('hex'); if (args.expectedSha256 && args.expectedSha256 !== checksum) throw new Error('Expected checksum does not match reviewed content'); const backup = await createBackup(path, operationId) as { backupPath: string }; const temp = `${path}.server-manager-${randomUUID()}.tmp`; await writeFile(temp, content, { mode: 0o640 }); const test = await fixed('/usr/sbin/nginx', ['-t', '-c', temp]); if (test.exitCode !== 0) { await rename(temp, `${path}.rejected-${randomUUID()}`); throw new Error(`Nginx validation failed; backup available at ${backup.backupPath}`); } await rename(temp, path); return { updated: path, checksum, backupPath: backup.backupPath }; }
function allowlistedCommand(tool: ToolName, startedAt: string, env: string, name: string, executable: string, args: string[]): Promise<ToolResult> { if (!allowed(name, env)) return Promise.resolve(result(tool, startedAt, undefined, { category: 'not_allowlisted', message: `${name} is not allowlisted` })); return fixed(executable, args).then(commandData).then((data) => result(tool, startedAt, data)); }
