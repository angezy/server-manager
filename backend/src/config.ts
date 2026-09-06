import { z } from 'zod';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

loadDotEnv();

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_PATH: z.string().default('./data/server-manager.sqlite'),
  SESSION_SECRET: z.string().min(16).default('development-only-change-me-please'),
  COOKIE_NAME: z.string().default('server_manager_session'),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  HOST_AGENT_SOCKET: z.string().default('/run/server-manager/agent.sock'),
  HOST_AGENT_MODE: z.enum(['socket', 'local-dev', 'disabled']).default('socket'),
  LLM_ENABLED: z.enum(['true', 'false']).default('true'),
  LLM_PROVIDER: z.string().default('openrouter'),
  LLM_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('openrouter/free'),
  LLM_FALLBACK_MODELS: z.string().default(''),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  LLM_MAX_TOKENS: z.coerce.number().int().min(128).max(32000).default(4096),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1),
  LLM_MAX_AGENT_STEPS: z.coerce.number().int().min(1).max(20).default(8),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  CPU_WARNING_PERCENT: z.coerce.number().default(80), CPU_CRITICAL_PERCENT: z.coerce.number().default(95),
  RAM_WARNING_PERCENT: z.coerce.number().default(80), RAM_CRITICAL_PERCENT: z.coerce.number().default(95),
  DISK_WARNING_PERCENT: z.coerce.number().default(80), DISK_CRITICAL_PERCENT: z.coerce.number().default(90),
  SSL_WARNING_DAYS: z.coerce.number().default(30), SSL_CRITICAL_DAYS: z.coerce.number().default(7),
  LOAD_WARNING_MULTIPLIER: z.coerce.number().default(1.5),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5), LOGIN_WINDOW_MS: z.coerce.number().int().min(1000).default(900000),
  SESSION_TTL_MS: z.coerce.number().int().min(60000).default(28800000), CONFIRMATION_TTL_MS: z.coerce.number().int().min(1000).default(300000),
  LOG_DIR: z.string().default('./logs')
});

const parsed = EnvSchema.parse(process.env);
export const config = {
  ...parsed,
  DATABASE_PATH: resolve(process.cwd(), parsed.DATABASE_PATH),
  LOG_DIR: resolve(process.cwd(), parsed.LOG_DIR),
  LLM_FALLBACK_MODELS: parsed.LLM_FALLBACK_MODELS.split(',').map((v) => v.trim()).filter(Boolean),
  IS_PRODUCTION: parsed.NODE_ENV === 'production',
  LLM_ENABLED: parsed.LLM_ENABLED === 'true',
  TRUST_PROXY: parsed.TRUST_PROXY === 'true'
};
export type Config = typeof config;

function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (!match) continue;
    const key = match[1]; const raw = match[2]; if (!key || raw === undefined) continue; if (process.env[key]) continue; process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
}
