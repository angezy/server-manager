import { describe, expect, it } from 'vitest';
import { buildNginxSiteConfig, execute } from '../host-agent/src/registry.js';
import { randomUUID } from 'node:crypto';

const request = (tool: string, args: Record<string, unknown> = {}) => ({ requestId: randomUUID(), operationId: randomUUID(), tool, args });

describe('host agent validation', () => {
  it('returns deterministic resource data without a shell', async () => { const result = await execute(request('system.getResources')); expect(result.tool).toBe('system.getResources'); expect(result.ok).toBe(true); expect(result.data).toBeTruthy(); });
  it('rejects unknown operations and arbitrary command-shaped payloads', async () => { await expect(execute(request('exec', { command: 'sudo bash' }))).rejects.toThrow(); await expect(execute(request('docker.exec', { command: 'cat /etc/shadow' }))).rejects.toThrow(); });
  it('requires a confirmation token for controlled operations', async () => { await expect(execute(request('nginx.reload'))).rejects.toThrow('Confirmation is required'); });
  it('rejects unapproved paths and service names', async () => { await expect(execute(request('config.getAllowlistedFile', { path: '../../../etc/passwd' }))).rejects.toThrow(); await expect(execute(request('systemd.restartAllowlistedService', { service: 'ssh; rm -rf /' }))).rejects.toThrow(); });
  it('generates a fixed reverse-proxy config without accepting shell-shaped content', () => { const config = buildNginxSiteConfig('loan-demo.nickwebproject.com', 3000); expect(config).toContain('server_name loan-demo.nickwebproject.com;'); expect(config).toContain('proxy_pass http://127.0.0.1:3000;'); expect(config).not.toContain('location /;'); });
  it('rejects deployment unless the exact path, process, and domain are allowlisted', async () => { const raw = request('deploy_node_app', { path: '/var/www/vhosts/laon-demo', processName: 'loan-demo', domain: 'loan-demo.nickwebproject.com', port: 3000, certbotEmail: 'ops@example.com' }); raw.confirmationId = randomUUID(); await expect(execute(raw)).resolves.toMatchObject({ ok: false, error: { category: 'execution_error' } }); });
});
