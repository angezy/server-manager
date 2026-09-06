import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

const secretKey = /(key|token|secret|password|cookie|authorization|private)/i;
const redact = (value: unknown): unknown => {
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretKey.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
};

export type LogKind = 'application' | 'ai' | 'tool' | 'security' | 'audit';
export async function log(kind: LogKind, event: string, fields: Record<string, unknown> = {}): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...(redact(fields) as Record<string, unknown>) }) + '\n';
  try { await mkdir(config.LOG_DIR, { recursive: true, mode: 0o750 }); await appendFile(join(config.LOG_DIR, `${kind}.jsonl`), line, { mode: 0o640 }); } catch { /* logging must not crash a request */ }
}

export const redactForLog = redact;
