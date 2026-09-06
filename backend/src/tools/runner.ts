import { randomUUID } from 'node:crypto';
import { getToolDefinition, validateToolArgs } from './registry.js';
import { ToolRequestSchema, type ToolName, type ToolResult } from '../../../shared/src/types.js';
import type { AppDatabase } from '../db/database.js';
import { json, now } from '../db/database.js';
import { log } from '../logging/logger.js';
import type { HostAgentClient } from './host-client.js';

export class ToolRunner {
  constructor(private readonly db: AppDatabase, private readonly host: HostAgentClient) {}

  async run(userId: string, requestId: string, tool: ToolName, args: unknown, confirmationId?: string, operationIdOverride?: string): Promise<ToolResult> {
    const definition = getToolDefinition(tool);
    if (!definition) throw new Error('UNKNOWN_TOOL');
    const operationId = operationIdOverride ?? randomUUID();
    const safeArgs = validateToolArgs(tool, args);
    const request = ToolRequestSchema.parse({ requestId, operationId, tool, args: safeArgs, confirmationId });
    const user = this.db.db.prepare('SELECT role,disabled_at FROM users WHERE id=?').get(userId) as { role?: string; disabled_at?: string | null } | undefined;
    if (!user || user.disabled_at) throw new Error('USER_NOT_ALLOWED');
    if (definition.requiresConfirmation && user.role === 'viewer') throw new Error('PERMISSION_DENIED');
    if (definition.requiresConfirmation && !confirmationId) throw new Error('CONFIRMATION_REQUIRED');
    if (definition.requiresConfirmation && confirmationId) {
      const confirmation = this.db.db.prepare('SELECT user_id,tool_name,operation_id,approved_at,used_at,expires_at FROM confirmations WHERE id=?').get(confirmationId) as { user_id?: string; tool_name?: string; operation_id?: string; approved_at?: string | null; used_at?: string | null; expires_at?: string } | undefined;
      if (!confirmation || confirmation.user_id !== userId || confirmation.tool_name !== tool || confirmation.operation_id !== operationId || !confirmation.approved_at || confirmation.used_at || !confirmation.expires_at || Date.parse(confirmation.expires_at) <= Date.now()) throw new Error('CONFIRMATION_INVALID');
    }
    const startedAt = now();
    const runId = randomUUID();
    this.db.db.prepare('INSERT INTO tool_runs (id,request_id,operation_id,user_id,tool_name,args_json,risk,status,started_at) VALUES (?,?,?,?,?,?,?,?,?)').run(runId, requestId, operationId, userId, tool, json(safeArgs), definition.risk, 'running', startedAt);
    await log('tool', 'tool.start', { requestId, operationId, userId, tool, args: safeArgsForLog(tool, safeArgs), risk: definition.risk });
    try {
      const result = await this.host.execute(request);
      const finishedAt = now();
      this.db.db.prepare('UPDATE tool_runs SET status=?,result_json=?,finished_at=? WHERE id=?').run(result.ok ? 'succeeded' : 'failed', json(result), finishedAt, runId);
      await log('tool', 'tool.finish', { requestId, operationId, userId, tool, ok: result.ok, durationMs: result.durationMs });
      return result;
    } catch (error) {
      const finishedAt = now();
      const result: ToolResult = { ok: false, tool, startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt), error: { category: 'tool_error', message: error instanceof Error ? error.message : 'Tool failed' } };
      this.db.db.prepare('UPDATE tool_runs SET status=?,result_json=?,finished_at=? WHERE id=?').run('failed', json(result), finishedAt, runId);
      await log('security', 'tool.error', { requestId, operationId, tool, error: result.error });
      return result;
    }
  }
}

function safeArgsForLog(tool: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  if (tool === 'write_file' || tool === 'nginx.updateAllowlistedConfig') {
    const content = typeof args.content === 'string' ? args.content : '';
    return { ...args, content: `[REDACTED ${content.length} bytes]` };
  }
  return args;
}
