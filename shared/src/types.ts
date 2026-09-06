import { z } from 'zod';

export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ToolName = z.enum([
  // Canonical agent tools. These are the only names advertised to the LLM.
  'list_directory', 'search_files', 'read_file', 'git_status', 'git_diff',
  'system_resources', 'listening_ports', 'systemd_status', 'journal_logs',
  'docker_status', 'pm2_status', 'nginx_test', 'nginx_config_inventory', 'hiddify_inventory',
  'write_file', 'delete_file', 'delete_directory', 'restart_service', 'reload_nginx',
  'remove_docker_container', 'remove_systemd_unit', 'remove_hiddify_artifact',
  // Legacy names are accepted at the RPC boundary for backwards compatibility.
  'system.getResources', 'system.getLoad', 'system.getUptime', 'disk.getUsage', 'memory.getUsage',
  'docker.getStatus', 'docker.getContainers', 'docker.getDiskUsage', 'pm2.getStatus', 'pm2.getLogs',
  'nginx.getStatus', 'nginx.testConfig', 'network.getListeningPorts', 'systemd.getFailedServices',
  'logs.getCritical', 'logs.getApplicationErrors', 'ssl.checkCertificate', 'http.checkWebsite',
  'dns.resolveConfiguredDomain', 'config.getAllowlistedFile', 'backup.create', 'nginx.reload',
  'nginx.updateAllowlistedConfig', 'pm2.restartAllowlistedProcess', 'pm2.reloadAllowlistedProcess',
  'docker.restartAllowlistedContainer', 'docker.composeUpAllowlistedProject', 'docker.composeDownAllowlistedProject',
  'systemd.restartAllowlistedService', 'config.restoreBackup', 'rollback.restore'
]);
export type ToolName = z.infer<typeof ToolName>;

export const CanonicalToolName = z.enum([
  'list_directory', 'search_files', 'read_file', 'git_status', 'git_diff',
  'system_resources', 'listening_ports', 'systemd_status', 'journal_logs',
  'docker_status', 'pm2_status', 'nginx_test', 'nginx_config_inventory', 'hiddify_inventory',
  'write_file', 'delete_file', 'delete_directory', 'restart_service', 'reload_nginx',
  'remove_docker_container', 'remove_systemd_unit', 'remove_hiddify_artifact'
]);
export type CanonicalToolName = z.infer<typeof CanonicalToolName>;

export const ToolRequestSchema = z.object({
  requestId: z.string().uuid(),
  operationId: z.string().uuid(),
  tool: ToolName,
  args: z.record(z.string(), z.unknown()).default({}),
  confirmationId: z.string().uuid().optional()
});
export type ToolRequest = z.infer<typeof ToolRequestSchema>;

export const AgentPlanSchema = z.object({
  kind: z.enum(['answer', 'tool_plan']),
  message: z.string().max(12000),
  tools: z.array(z.object({
    tool: ToolName,
    args: z.record(z.string(), z.unknown()).default({}),
    reason: z.string().max(1000)
  })).max(8).default([]),
  risk: RiskLevel.default('LOW'),
  requiresConfirmation: z.boolean().default(false)
});
export type AgentPlan = z.infer<typeof AgentPlanSchema>;

export type ToolResult = {
  ok: boolean;
  tool: ToolName;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode?: number;
  data?: unknown;
  error?: { category: string; message: string };
  evidence?: string[];
};

export type HealthReport = {
  health: 'GOOD' | 'WARNING' | 'CRITICAL';
  metrics: Record<string, string | number>;
  warnings: string[];
  criticalIssues: string[];
  evidence: Array<{ source: string; fact: string; at: string }>;
};

export type User = { id: string; username: string; role: 'admin' | 'operator' | 'viewer' };
