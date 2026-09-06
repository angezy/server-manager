import { z } from 'zod';
import { CanonicalToolName, ToolName, RiskLevel, type CanonicalToolName as CanonicalName, type ToolName as AnyToolName } from './types.js';
import { ToolArgs } from './validation.js';

export type JsonSchema = Record<string, unknown>;
export type ToolDefinition = {
  name: AnyToolName;
  description: string;
  args: z.ZodTypeAny;
  parameters: JsonSchema;
  risk: z.infer<typeof RiskLevel>;
  requiresConfirmation: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  auditEvent: string;
  canonical: boolean;
};

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const string = (description: string): JsonSchema => ({ type: 'string', description });
const integer = (description: string, minimum = 1, maximum = 200): JsonSchema => ({ type: 'integer', description, minimum, maximum });
const boolean = (description: string): JsonSchema => ({ type: 'boolean', description });
const enumValue = (values: string[], description: string): JsonSchema => ({ type: 'string', enum: values, description });
const emptyParams = object({});

const read = (name: CanonicalName, description: string, args: z.ZodTypeAny = ToolArgs.empty, parameters: JsonSchema = emptyParams): ToolDefinition => ({ name, description, args, parameters, risk: 'LOW', requiresConfirmation: false, timeoutMs: 15000, maxOutputBytes: 128 * 1024, auditEvent: `tool.${name}`, canonical: true });
const modify = (name: CanonicalName, description: string, args: z.ZodTypeAny, parameters: JsonSchema, risk: z.infer<typeof RiskLevel> = 'MEDIUM'): ToolDefinition => ({ name, description, args, parameters, risk, requiresConfirmation: true, timeoutMs: 30000, maxOutputBytes: 128 * 1024, auditEvent: `tool.${name}`, canonical: true });
const legacyRead = (name: AnyToolName, description: string, args: z.ZodTypeAny = ToolArgs.empty): ToolDefinition => ({ name, description, args, parameters: emptyParams, risk: 'LOW', requiresConfirmation: false, timeoutMs: 15000, maxOutputBytes: 128 * 1024, auditEvent: `tool.${name}`, canonical: false });
const legacyModify = (name: AnyToolName, description: string, args: z.ZodTypeAny, risk: z.infer<typeof RiskLevel> = 'MEDIUM'): ToolDefinition => ({ name, description, args, parameters: emptyParams, risk, requiresConfirmation: true, timeoutMs: 30000, maxOutputBytes: 128 * 1024, auditEvent: `tool.${name}`, canonical: false });

const canonicalDefinitions: Record<CanonicalName, ToolDefinition> = {
  list_directory: read('list_directory', 'List entries in one exact allowlisted directory.', ToolArgs.listDirectory, object({ path: string('Exact directory path.'), includeHidden: boolean('Include dot entries.') }, ['path'])),
  search_files: read('search_files', 'Search filenames and bounded text in one exact allowlisted tree.', ToolArgs.searchFiles, object({ path: string('Exact allowlisted search root.'), pattern: string('Literal case-insensitive filename or content pattern.'), maxResults: integer('Maximum number of results.', 1, 200) }, ['path', 'pattern'])),
  read_file: read('read_file', 'Read one exact non-sensitive allowlisted file.', ToolArgs.readFile, object({ path: string('Exact file path.'), maxBytes: integer('Maximum bytes to return.', 1, 131072) }, ['path'])),
  git_status: read('git_status', 'Read git status for one allowlisted repository.', ToolArgs.git, object({ path: string('Allowlisted repository path.') })),
  git_diff: read('git_diff', 'Read a bounded git diff for one allowlisted repository.', ToolArgs.git, object({ path: string('Allowlisted repository path.') })),
  system_resources: read('system_resources', 'Read CPU, memory, swap, uptime, and disk resources.'),
  listening_ports: read('listening_ports', 'Read listening TCP and UDP sockets.'),
  systemd_status: read('systemd_status', 'Read systemd status for the host or one named service.', ToolArgs.systemdStatus, object({ service: string('Optional exact service name.') })),
  journal_logs: read('journal_logs', 'Read bounded journal logs, optionally for one named service.', ToolArgs.journal, object({ service: string('Optional exact service name.'), lines: integer('Number of lines.', 1, 200) })),
  docker_status: read('docker_status', 'Read Docker daemon and container status.'),
  pm2_status: read('pm2_status', 'Read PM2 process status.'),
  nginx_test: read('nginx_test', 'Validate the active Nginx configuration.'),
  nginx_config_inventory: read('nginx_config_inventory', 'List Nginx configuration files and references without modifying them.'),
  hiddify_inventory: read('hiddify_inventory', 'Inventory Hiddify services, files, processes, containers, images, volumes, cron jobs, Nginx references, and ports. Never modifies anything.'),
  write_file: modify('write_file', 'Atomically write one exact allowlisted file after creating a backup.', ToolArgs.writeFile, object({ path: string('Exact allowlisted file path.'), content: string('Complete replacement content.'), expectedSha256: string('Expected current-file SHA-256, if known.') }, ['path', 'content']), 'HIGH'),
  delete_file: modify('delete_file', 'Back up and delete one exact allowlisted file.', ToolArgs.deleteFile, object({ path: string('Exact allowlisted file path.') }, ['path']), 'HIGH'),
  delete_directory: modify('delete_directory', 'Back up and delete one exact allowlisted directory.', ToolArgs.deleteDirectory, object({ path: string('Exact allowlisted directory path.') }, ['path']), 'CRITICAL'),
  restart_service: modify('restart_service', 'Restart one explicitly allowlisted service.', ToolArgs.restartService, object({ service: string('Exact allowlisted service name.') }, ['service']), 'MEDIUM'),
  reload_nginx: modify('reload_nginx', 'Validate Nginx, then reload it.', ToolArgs.empty, emptyParams, 'MEDIUM'),
  remove_docker_container: modify('remove_docker_container', 'Back up metadata and remove one explicitly allowlisted Docker container.', ToolArgs.removeDockerContainer, object({ name: string('Exact allowlisted container name.') }, ['name']), 'HIGH'),
  remove_systemd_unit: modify('remove_systemd_unit', 'Back up and remove one explicitly allowlisted systemd unit file.', ToolArgs.removeSystemdUnit, object({ unit: string('Exact allowlisted unit name.') }, ['unit']), 'CRITICAL'),
  remove_hiddify_artifact: modify('remove_hiddify_artifact', 'Back up and remove one exact Hiddify artifact previously identified by inventory.', ToolArgs.removeHiddifyArtifact, object({ kind: enumValue(['file', 'directory', 'service', 'container', 'volume', 'cron', 'nginx_reference'], 'Artifact type.'), path: string('Exact path or exact allowlisted artifact identifier.') }, ['kind', 'path']), 'CRITICAL')
};

const legacyDefinitions: Partial<Record<AnyToolName, ToolDefinition>> = {
  'system.getResources': legacyRead('system.getResources', 'Compatibility alias for system_resources'),
  'system.getLoad': legacyRead('system.getLoad', 'Compatibility alias for system_resources'),
  'system.getUptime': legacyRead('system.getUptime', 'Compatibility alias for system_resources'),
  'disk.getUsage': legacyRead('disk.getUsage', 'Compatibility alias for system_resources'),
  'memory.getUsage': legacyRead('memory.getUsage', 'Compatibility alias for system_resources'),
  'docker.getStatus': legacyRead('docker.getStatus', 'Compatibility alias for docker_status'),
  'docker.getContainers': legacyRead('docker.getContainers', 'Compatibility alias for docker_status'),
  'docker.getDiskUsage': legacyRead('docker.getDiskUsage', 'Compatibility alias for docker_status'),
  'pm2.getStatus': legacyRead('pm2.getStatus', 'Compatibility alias for pm2_status'),
  'pm2.getLogs': legacyRead('pm2.getLogs', 'Compatibility alias for journal_logs', ToolArgs.log),
  'nginx.getStatus': legacyRead('nginx.getStatus', 'Compatibility alias for nginx_test'),
  'nginx.testConfig': legacyRead('nginx.testConfig', 'Compatibility alias for nginx_test'),
  'network.getListeningPorts': legacyRead('network.getListeningPorts', 'Compatibility alias for listening_ports'),
  'systemd.getFailedServices': legacyRead('systemd.getFailedServices', 'Compatibility alias for systemd_status'),
  'logs.getCritical': legacyRead('logs.getCritical', 'Compatibility alias for journal_logs', ToolArgs.log),
  'logs.getApplicationErrors': legacyRead('logs.getApplicationErrors', 'Compatibility alias for journal_logs', ToolArgs.log),
  'ssl.checkCertificate': legacyRead('ssl.checkCertificate', 'Compatibility TLS check', ToolArgs.ssl),
  'http.checkWebsite': legacyRead('http.checkWebsite', 'Compatibility website check', ToolArgs.website),
  'dns.resolveConfiguredDomain': legacyRead('dns.resolveConfiguredDomain', 'Compatibility DNS check', ToolArgs.domain),
  'config.getAllowlistedFile': legacyRead('config.getAllowlistedFile', 'Compatibility file read', ToolArgs.config),
  'backup.create': legacyModify('backup.create', 'Compatibility backup operation', ToolArgs.config, 'LOW'),
  'nginx.reload': legacyModify('nginx.reload', 'Compatibility alias for reload_nginx', ToolArgs.empty),
  'nginx.updateAllowlistedConfig': legacyModify('nginx.updateAllowlistedConfig', 'Compatibility Nginx update', ToolArgs.configUpdate, 'HIGH'),
  'pm2.restartAllowlistedProcess': legacyModify('pm2.restartAllowlistedProcess', 'Compatibility PM2 restart', ToolArgs.process),
  'pm2.reloadAllowlistedProcess': legacyModify('pm2.reloadAllowlistedProcess', 'Compatibility PM2 reload', ToolArgs.process),
  'docker.restartAllowlistedContainer': legacyModify('docker.restartAllowlistedContainer', 'Compatibility Docker restart', ToolArgs.container),
  'docker.composeUpAllowlistedProject': legacyModify('docker.composeUpAllowlistedProject', 'Compatibility Docker compose up', ToolArgs.project, 'HIGH'),
  'docker.composeDownAllowlistedProject': legacyModify('docker.composeDownAllowlistedProject', 'Compatibility Docker compose down', ToolArgs.project, 'HIGH'),
  'systemd.restartAllowlistedService': legacyModify('systemd.restartAllowlistedService', 'Compatibility systemd restart', ToolArgs.service),
  'config.restoreBackup': legacyModify('config.restoreBackup', 'Compatibility backup restore', ToolArgs.backup, 'HIGH'),
  'rollback.restore': legacyModify('rollback.restore', 'Compatibility rollback restore', ToolArgs.backup, 'CRITICAL')
};

export const TOOL_REGISTRY: Record<AnyToolName, ToolDefinition> = { ...canonicalDefinitions, ...Object.fromEntries(Object.entries(legacyDefinitions).filter(([, definition]) => Boolean(definition))) } as Record<AnyToolName, ToolDefinition>;
export const LLM_TOOL_DEFINITIONS = Object.values(canonicalDefinitions).map((definition) => ({ type: 'function' as const, function: { name: definition.name, description: definition.description, parameters: definition.parameters } }));

export const LEGACY_TO_CANONICAL: Partial<Record<AnyToolName, CanonicalName>> = {
  'system.getResources': 'system_resources', 'system.getLoad': 'system_resources', 'system.getUptime': 'system_resources', 'disk.getUsage': 'system_resources', 'memory.getUsage': 'system_resources',
  'docker.getStatus': 'docker_status', 'docker.getContainers': 'docker_status', 'docker.getDiskUsage': 'docker_status', 'pm2.getStatus': 'pm2_status', 'pm2.getLogs': 'journal_logs',
  'nginx.getStatus': 'nginx_test', 'nginx.testConfig': 'nginx_test', 'network.getListeningPorts': 'listening_ports', 'systemd.getFailedServices': 'systemd_status', 'logs.getCritical': 'journal_logs', 'logs.getApplicationErrors': 'journal_logs',
  'nginx.reload': 'reload_nginx'
};

export function getToolDefinition(name: string): ToolDefinition | undefined { return ToolName.safeParse(name).success ? TOOL_REGISTRY[name as AnyToolName] : undefined; }
export function validateToolArgs(name: AnyToolName, args: unknown): Record<string, unknown> { const definition = getToolDefinition(name); if (!definition) throw new Error('Unknown tool'); return definition.args.parse(args) as Record<string, unknown>; }
export function canonicalToolName(name: AnyToolName): CanonicalName { return (LEGACY_TO_CANONICAL[name] ?? name) as CanonicalName; }
