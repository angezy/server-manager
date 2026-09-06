import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { json, now, type AppDatabase } from '../db/database.js';
import { getToolDefinition, validateToolArgs } from '../tools/registry.js';
import type { RiskLevel, ToolName } from '../../../shared/src/types.js';

export type Confirmation = { id: string; operationId: string; actionHash: string; toolName: ToolName; args: Record<string, unknown>; risk: RiskLevel; impact: string; backupPath: string | null; expiresAt: string };
const canonical = (tool: ToolName, args: Record<string, unknown>, operationId: string) => JSON.stringify({ tool, args, operationId });
export const actionHash = (tool: ToolName, args: Record<string, unknown>, operationId: string): string => createHash('sha256').update(canonical(tool, args, operationId)).digest('hex');

export function createConfirmation(db: AppDatabase, userId: string, tool: ToolName, rawArgs: unknown, impact: string, backupPath: string | null = null): Confirmation {
  const definition = getToolDefinition(tool); if (!definition?.requiresConfirmation) throw new Error('Tool does not require confirmation');
  const args = validateToolArgs(tool, rawArgs); const id = randomUUID(); const operationId = randomUUID(); const expiresAt = new Date(Date.now() + config.CONFIRMATION_TTL_MS).toISOString(); const hash = actionHash(tool, args, operationId);
  db.db.prepare('INSERT INTO confirmations (id,user_id,operation_id,action_hash,tool_name,args_json,risk,impact,backup_path,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, userId, operationId, hash, tool, json(args), definition.risk, impact, backupPath, expiresAt);
  return { id, operationId, actionHash: hash, toolName: tool, args, risk: definition.risk, impact, backupPath, expiresAt };
}

export function getConfirmation(db: AppDatabase, userId: string, id: string): Confirmation | null {
  const row = db.db.prepare('SELECT * FROM confirmations WHERE id=? AND user_id=?').get(id, userId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { id: String(row.id), operationId: String(row.operation_id), actionHash: String(row.action_hash), toolName: String(row.tool_name) as ToolName, args: JSON.parse(String(row.args_json)) as Record<string, unknown>, risk: String(row.risk) as RiskLevel, impact: String(row.impact), backupPath: row.backup_path ? String(row.backup_path) : null, expiresAt: String(row.expires_at) };
}

export function approveConfirmation(db: AppDatabase, userId: string, id: string, expectedHash: string): Confirmation {
  const row = db.db.prepare('SELECT * FROM confirmations WHERE id=? AND user_id=?').get(id, userId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Confirmation not found');
  if (row.used_at || row.approved_at || row.rejected_at) throw new Error('Confirmation already consumed');
  if (Date.parse(String(row.expires_at)) <= Date.now()) throw new Error('Confirmation expired');
  if (String(row.action_hash) !== expectedHash) throw new Error('Action hash mismatch');
  db.db.prepare('UPDATE confirmations SET approved_at=? WHERE id=? AND used_at IS NULL').run(now(), id);
  return getConfirmation(db, userId, id)!;
}

export function markUsed(db: AppDatabase, id: string): void { db.db.prepare('UPDATE confirmations SET used_at=? WHERE id=? AND used_at IS NULL').run(now(), id); }
export function rejectConfirmation(db: AppDatabase, userId: string, id: string): void { db.db.prepare('UPDATE confirmations SET rejected_at=? WHERE id=? AND user_id=? AND used_at IS NULL').run(now(), id, userId); }
