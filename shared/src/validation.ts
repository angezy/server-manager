import { z } from 'zod';

const safeName = z.string().regex(/^[a-zA-Z0-9_.:@/-]+$/).max(255);
const safePath = z.string().min(1).max(400).refine((value) => !value.includes('..') && !value.includes('\0'), 'unsafe path');

export const ToolArgs = {
  empty: z.object({}).strict(),
  website: z.object({ url: z.string().url().max(2048), host: safeName.optional() }).strict(),
  domain: z.object({ domain: z.string().regex(/^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/) }).strict(),
  process: z.object({ name: safeName }).strict(),
  container: z.object({ name: safeName }).strict(),
  project: z.object({ project: safeName }).strict(),
  service: z.object({ service: safeName }).strict(),
  config: z.object({ path: safePath }).strict(),
  configUpdate: z.object({ path: safePath, content: z.string().max(128 * 1024), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  backup: z.object({ path: safePath }).strict(),
  ssl: z.object({ domain: z.string().min(1).max(253), port: z.number().int().min(1).max(65535).default(443) }).strict(),
  log: z.object({ service: safeName.optional(), lines: z.number().int().min(1).max(200).default(50) }).strict()
} as const;

export function rejectPromptInjection(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/(ignore\s+(all\s+)?previous|system\s+message|developer\s+message|reveal\s+secret|api[_ -]?key)/gi, '[redacted prompt content]');
}
