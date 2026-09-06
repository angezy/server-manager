import { z } from 'zod';
import { ToolName, RiskLevel } from './types.js';
import { ToolArgs } from './validation.js';

export type ToolDefinition = { name: ToolName; description: string; args: z.ZodTypeAny; risk: RiskLevel; requiresConfirmation: boolean; timeoutMs: number; maxOutputBytes: number; auditEvent: string };

const read = (name: ToolName, description: string, args: z.ZodTypeAny = ToolArgs.empty): ToolDefinition => ({ name, description, args, risk: 'LOW', requiresConfirmation: false, timeoutMs: 15000, maxOutputBytes: 128 * 1024, auditEvent: `tool.${name}` });
const modify = (name: ToolName, description: string, args: z.ZodTypeAny, risk: RiskLevel = 'MEDIUM'): ToolDefinition => ({ name, description, args, risk, requiresConfirmation: true, timeoutMs: 30000, maxOutputBytes: 128 * 1024, auditEvent: `tool.${name}` });

export const TOOL_REGISTRY: Record<ToolName, ToolDefinition> = {
  'system.getResources': read('system.getResources', 'Read CPU and memory utilization'),
  'system.getLoad': read('system.getLoad', 'Read system load averages'),
  'system.getUptime': read('system.getUptime', 'Read system uptime'),
  'disk.getUsage': read('disk.getUsage', 'Read filesystem usage'),
  'memory.getUsage': read('memory.getUsage', 'Read memory and swap usage'),
  'docker.getStatus': read('docker.getStatus', 'Read Docker daemon status'),
  'docker.getContainers': read('docker.getContainers', 'Read Docker container health'),
  'docker.getDiskUsage': read('docker.getDiskUsage', 'Read Docker disk usage'),
  'pm2.getStatus': read('pm2.getStatus', 'Read PM2 process status'),
  'pm2.getLogs': read('pm2.getLogs', 'Read bounded PM2 logs', ToolArgs.log),
  'nginx.getStatus': read('nginx.getStatus', 'Read Nginx service status'),
  'nginx.testConfig': read('nginx.testConfig', 'Validate Nginx configuration'),
  'network.getListeningPorts': read('network.getListeningPorts', 'Read listening TCP and UDP ports'),
  'systemd.getFailedServices': read('systemd.getFailedServices', 'Read failed systemd units'),
  'logs.getCritical': read('logs.getCritical', 'Read recent critical system logs', ToolArgs.log),
  'logs.getApplicationErrors': read('logs.getApplicationErrors', 'Read recent application errors', ToolArgs.log),
  'ssl.checkCertificate': read('ssl.checkCertificate', 'Inspect a TLS certificate', ToolArgs.ssl),
  'http.checkWebsite': read('http.checkWebsite', 'Check a configured website', ToolArgs.website),
  'dns.resolveConfiguredDomain': read('dns.resolveConfiguredDomain', 'Resolve a configured domain', ToolArgs.domain),
  'config.getAllowlistedFile': read('config.getAllowlistedFile', 'Read an allowlisted configuration file', ToolArgs.config),
  'backup.create': modify('backup.create', 'Create a timestamped backup of an allowlisted file', ToolArgs.config, 'LOW'),
  'nginx.reload': modify('nginx.reload', 'Reload Nginx', ToolArgs.empty, 'MEDIUM'),
  'nginx.updateAllowlistedConfig': modify('nginx.updateAllowlistedConfig', 'Replace an allowlisted Nginx configuration after backup', ToolArgs.configUpdate, 'HIGH'),
  'pm2.restartAllowlistedProcess': modify('pm2.restartAllowlistedProcess', 'Restart an allowlisted PM2 process', ToolArgs.process, 'MEDIUM'),
  'pm2.reloadAllowlistedProcess': modify('pm2.reloadAllowlistedProcess', 'Reload an allowlisted PM2 process', ToolArgs.process, 'MEDIUM'),
  'docker.restartAllowlistedContainer': modify('docker.restartAllowlistedContainer', 'Restart an allowlisted container', ToolArgs.container, 'MEDIUM'),
  'docker.composeUpAllowlistedProject': modify('docker.composeUpAllowlistedProject', 'Start an allowlisted Compose project', ToolArgs.project, 'HIGH'),
  'docker.composeDownAllowlistedProject': modify('docker.composeDownAllowlistedProject', 'Stop an allowlisted Compose project', ToolArgs.project, 'HIGH'),
  'systemd.restartAllowlistedService': modify('systemd.restartAllowlistedService', 'Restart an allowlisted systemd service', ToolArgs.service, 'MEDIUM'),
  'config.restoreBackup': modify('config.restoreBackup', 'Restore an allowlisted backup atomically', ToolArgs.backup, 'HIGH'),
  'rollback.restore': modify('rollback.restore', 'Restore a recorded backup with validation', ToolArgs.backup, 'CRITICAL')
};

export function getToolDefinition(name: string): ToolDefinition | undefined { return ToolName.safeParse(name).success ? TOOL_REGISTRY[name as ToolName] : undefined; }
export function validateToolArgs(name: ToolName, args: unknown): Record<string, unknown> { return getToolDefinition(name)!.args.parse(args) as Record<string, unknown>; }
