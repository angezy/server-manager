import { createServer } from 'node:http';
import { unlink, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execute } from './registry.js';

loadDotEnv();
if (process.env.NODE_ENV !== 'test' && typeof process.getuid === 'function' && process.getuid() === 0) throw new Error('Host Agent must run as the restricted server-manager user');
const socketPath = process.env.HOST_AGENT_SOCKET ?? '/run/server-manager/agent.sock';
const logDir = process.env.HOST_AGENT_LOG_DIR ?? './logs';
const audit = async (event: string, fields: Record<string, unknown>): Promise<void> => { try { await mkdir(logDir, { recursive: true, mode: 0o750 }); const { appendFile } = await import('node:fs/promises'); await appendFile(`${logDir}/host-agent.jsonl`, JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o640 }); } catch { /* audit is best effort */ } };

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/execute') { res.writeHead(404).end(JSON.stringify({ error: 'not_found' })); return; }
  let body = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; if (body.length > 64 * 1024) req.destroy(new Error('request too large')); });
  req.on('end', async () => { try { const request = JSON.parse(body) as { requestId?: string; tool?: string }; const output = await execute(request); await audit('agent.execute', { requestId: request.requestId, tool: request.tool, ok: output.ok }); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(output)); } catch (error) { await audit('agent.reject', { error: error instanceof Error ? error.message : 'invalid' }); res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: { category: 'validation', message: 'Invalid tool request' } })); } });
});

await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 }); try { await unlink(socketPath); } catch { /* first start */ }
server.listen(socketPath, async () => { try { await chmod(socketPath, 0o660); } catch { /* permissions may be managed by systemd */ } console.log(`Host Agent listening on ${socketPath}`); });

function loadDotEnv(): void { const path = `${process.cwd()}/.env`; if (!existsSync(path)) return; for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) { const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (!match) continue; const key = match[1]; const raw = match[2]; if (!key || raw === undefined) continue; if (!process.env[key]) process.env[key] = raw.replace(/^['"]|['"]$/g, ''); } }
