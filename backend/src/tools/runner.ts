import { randomUUID } from 'node:crypto';
import { TOOL_REGISTRY, validateToolArgs } from './registry.js';
import { ToolRequestSchema, type ToolName, type ToolResult } from '../../../shared/src/types.js';
import type { AppDatabase } from '../db/database.js';
import { json, now } from '../db/database.js';
import { log } from '../logging/logger.js';
import type { HostAgentClient } from './host-client.js';

export class ToolRunner {
  constructor(private readonly db: AppDatabase, private readonly host: HostAgentClient) {}

  async run(userId: string, requestId: string, tool: ToolName, args: unknown, confirmationId?: string, operationIdOverride?: string): Promise<ToolResult> {
    const definition = TOOL_REGISTRY[tool];
    const operationId = operationIdOverride ?? randomUUID();
    const safeArgs = validateToolArgs(tool, args);
    const request = ToolRequestSchema.parse({ requestId, operationId, tool, args: safeArgs, confirmationId });
    if (definition.requiresConfirmation && !confirmationId) throw new Error('CONFIRMATION_REQUIRED');
    const startedAt = now();
    const runId = randomUUID();
    this.db.db.prepare('INSERT INTO tool_runs (id,request_id,operation_id,user_id,tool_name,args_json,risk,status,started_at) VALUES (?,?,?,?,?,?,?,?,?)').run(runId, requestId, operationId, userId, tool, json(safeArgs), definition.risk, 'running', startedAt);
    await log('tool', 'tool.start', { requestId, operationId, userId, tool, args: safeArgs, risk: definition.risk });
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
