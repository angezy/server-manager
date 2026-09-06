import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { ToolRequest, ToolResult } from '../../../shared/src/types.js';

export class HostAgentClient {
  async execute(request: ToolRequest): Promise<ToolResult> {
    if (config.HOST_AGENT_MODE === 'disabled') return { ok: false, tool: request.tool, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0, error: { category: 'agent_disabled', message: 'Host Agent is disabled' } };
    if (config.HOST_AGENT_MODE === 'local-dev') return localDevResult(request.tool);
    return new Promise((resolve) => {
      const startedAt = new Date().toISOString();
      const body = JSON.stringify(request);
      const req = httpRequest({ socketPath: config.HOST_AGENT_SOCKET, path: '/v1/execute', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-request-id': request.requestId }, timeout: 35000 }, (res) => {
        let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; if (text.length > 256_000) req.destroy(new Error('oversized agent response')); });
        res.on('end', () => { try { resolve(JSON.parse(text) as ToolResult); } catch { resolve({ ok: false, tool: request.tool, startedAt, finishedAt: new Date().toISOString(), durationMs: 0, error: { category: 'agent_protocol', message: 'Invalid Host Agent response' } }); } });
      });
      req.on('timeout', () => req.destroy(new Error('Host Agent timeout')));
      req.on('error', (error) => resolve({ ok: false, tool: request.tool, startedAt, finishedAt: new Date().toISOString(), durationMs: 0, error: { category: 'agent_unavailable', message: error.message } }));
      req.write(body); req.end();
    });
  }
}

function localDevResult(tool: ToolRequest['tool']): ToolResult {
  const startedAt = new Date().toISOString(); const finishedAt = new Date().toISOString();
  if (tool === 'system.getResources') return { ok: true, tool, startedAt, finishedAt, durationMs: 0, data: { cpuPercent: 0, ramPercent: 0, swapPercent: 0, note: 'local-dev fallback' } };
  if (tool === 'system.getLoad') return { ok: true, tool, startedAt, finishedAt, durationMs: 0, data: { load1: 0, load5: 0, load15: 0 } };
  return { ok: false, tool, startedAt, finishedAt, durationMs: 0, error: { category: 'agent_unavailable', message: 'Set HOST_AGENT_MODE=socket on Ubuntu or use mocked tests.' } };
}
