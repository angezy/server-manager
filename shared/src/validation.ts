import { z } from 'zod';

const safeName = z.string().regex(/^[a-zA-Z0-9_.:@/-]+$/).max(255);
const safePath = z.string().min(1).max(400)
  .refine((value) => !value.includes('..') && !value.includes('\0') && !/[\r\n]/.test(value), 'unsafe path')
  .refine((value) => !['/', '/etc', '/opt', '/var', '/var/lib/docker'].includes(value.replace(/[\\/]$/, '') || value) && !/^[a-zA-Z]:[\\/]?$/.test(value), 'broad path is not allowed');
const safeSearchPattern = z.string().min(1).max(200).refine((value) => !/[\0\r\n]/.test(value), 'unsafe search pattern');
const optionalPath = safePath.optional();
const hiddifyKind = z.enum(['file', 'directory', 'service', 'container', 'volume', 'cron', 'nginx_reference']);
const safeDomain = z.string().regex(/^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/);
const safeProcessName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

export const ToolArgs = {
  empty: z.object({}).strict(),
  listDirectory: z.object({ path: safePath, includeHidden: z.boolean().default(false) }).strict(),
  searchFiles: z.object({ path: safePath, pattern: safeSearchPattern, maxResults: z.number().int().min(1).max(200).default(50) }).strict(),
  readFile: z.object({ path: safePath, maxBytes: z.number().int().min(1).max(128 * 1024).default(128 * 1024) }).strict(),
  git: z.object({ path: optionalPath }).strict(),
  systemdStatus: z.object({ service: safeName.optional() }).strict(),
  journal: z.object({ service: safeName.optional(), lines: z.number().int().min(1).max(200).default(50) }).strict(),
  writeFile: z.object({ path: safePath, content: z.string().max(128 * 1024), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  deleteFile: z.object({ path: safePath }).strict(),
  deleteDirectory: z.object({ path: safePath }).strict(),
  restartService: z.object({ service: safeName }).strict(),
  removeDockerContainer: z.object({ name: safeName }).strict(),
  removeSystemdUnit: z.object({ unit: safeName }).strict(),
  removeHiddifyArtifact: z.object({ kind: hiddifyKind.default('file'), path: z.string().min(1).max(400).refine((value) => !value.includes('..') && !value.includes('\0') && !/[\r\n]/.test(value), 'unsafe artifact identifier') }).strict(),
  deployNodeApp: z.object({
    path: safePath,
    processName: safeProcessName,
    domain: safeDomain,
    port: z.number().int().min(1024).max(65535),
    certbotEmail: z.string().email().max(254)
  }).strict(),
  // Used by the compatibility tools and retained for existing clients.
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
