import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { AppDatabase, json, now, parseJson } from '../db/database.js';
import { hashPassword, revokeSession, setSession, userFromRequest, verifyPassword } from '../auth/auth.js';
import { log } from '../logging/logger.js';
import { HostAgentClient } from '../tools/host-client.js';
import { ToolRunner } from '../tools/runner.js';
import { Orchestrator, streamEvents } from '../agent/orchestrator.js';
import { LLMProvider } from '../llm/provider.js';
import { approveConfirmation, getConfirmation, markUsed, rejectConfirmation } from '../agent/confirmations.js';
import type { User } from '../../../shared/src/types.js';

declare global { namespace Express { interface Locals { user?: User; requestId?: string } } }

export type AppContext = { db: AppDatabase; llm: LLMProvider; host: HostAgentClient; runner: ToolRunner; orchestrator: Orchestrator };

export function createContext(db = new AppDatabase()): AppContext { const llm = new LLMProvider(); const host = new HostAgentClient(); const runner = new ToolRunner(db, host); return { db, llm, host, runner, orchestrator: new Orchestrator(db, runner, llm) }; }

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.FRONTEND_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
  app.use(express.json({ limit: '64kb', strict: true })); app.use(cookieParser());
  app.use((req, res, next) => { const requestId = req.header('x-request-id')?.slice(0, 80) || randomUUID(); res.locals.requestId = requestId; res.setHeader('x-request-id', requestId); void log('application', 'request.start', { requestId, method: req.method, path: req.path }); next(); });
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'server-manager', at: now() }));
  app.get('/api/status', (_req, res) => res.json({ ok: true, llmConfigured: config.LLM_ENABLED && Boolean(config.LLM_API_KEY), hostAgentMode: config.HOST_AGENT_MODE, at: now() }));

  const loginLimiter = rateLimit({ windowMs: config.LOGIN_WINDOW_MS, limit: config.LOGIN_MAX_ATTEMPTS, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts' } });
  app.post('/api/auth/login', loginLimiter, async (req, res) => { try { const body = loginSchema(req.body); const row = ctx.db.db.prepare('SELECT id,username,password_hash,role,disabled_at FROM users WHERE username=?').get(body.username) as { id: string; username: string; password_hash: string; role: User['role']; disabled_at: string | null } | undefined; const ok = row && !row.disabled_at && await verifyPassword(row.password_hash, body.password); if (!ok) { await log('security', 'auth.login.failure', { requestId: res.locals.requestId, username: body.username }); return res.status(401).json({ error: 'Invalid credentials' }); } setSession(ctx.db, res, row.id); res.cookie('server_manager_csrf', randomBytes(24).toString('base64url'), { httpOnly: false, sameSite: 'lax', secure: config.IS_PRODUCTION, maxAge: config.SESSION_TTL_MS, path: '/' }); await log('audit', 'auth.login.success', { requestId: res.locals.requestId, userId: row.id }); return res.json({ user: { id: row.id, username: row.username, role: row.role } }); } catch { return res.status(400).json({ error: 'Invalid request' }); } });

  app.use('/api', (req, res, next) => { const user = userFromRequest(ctx.db, req); if (!user) return res.status(401).json({ error: 'Authentication required' }); res.locals.user = user; if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !csrfValid(req)) return res.status(403).json({ error: 'CSRF validation failed' }); next(); });
  app.post('/api/auth/logout', (req, res) => { revokeSession(ctx.db, req, res); return res.json({ ok: true }); });
  app.get('/api/auth/me', (_req, res) => res.json({ user: res.locals.user }));

  app.get('/api/conversations', (req, res) => res.json(ctx.db.db.prepare('SELECT id,title,created_at,updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC').all(res.locals.user!.id)));
  app.post('/api/conversations', (req, res) => { const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 120) : 'New conversation'; const id = randomUUID(); const timestamp = now(); ctx.db.db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, res.locals.user!.id, title, timestamp, timestamp); return res.status(201).json({ id, title, created_at: timestamp, updated_at: timestamp }); });
  app.get('/api/conversations/:id', (req, res) => { const row = ctx.db.db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(req.params.id, res.locals.user!.id); return row ? res.json(row) : res.status(404).json({ error: 'Conversation not found' }); });
  app.patch('/api/conversations/:id', (req, res) => { const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 120) : ''; if (!title) return res.status(400).json({ error: 'Title is required' }); const result = ctx.db.db.prepare('UPDATE conversations SET title=?,updated_at=? WHERE id=? AND user_id=?').run(title, now(), req.params.id, res.locals.user!.id); return result.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Conversation not found' }); });
  app.delete('/api/conversations/:id', (req, res) => { const result = ctx.db.db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(req.params.id, res.locals.user!.id); return result.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Conversation not found' }); });
  app.get('/api/conversations/:id/messages', (req, res) => res.json(ctx.db.db.prepare('SELECT id,role,content,metadata_json,created_at FROM messages WHERE conversation_id=? AND conversation_id IN (SELECT id FROM conversations WHERE user_id=?) ORDER BY created_at').all(req.params.id, res.locals.user!.id)));

  app.post('/api/chat', async (req, res) => { try { const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim().slice(0, 12000) : ''; if (!prompt) return res.status(400).json({ error: 'Prompt is required' }); const conversationId = await ensureConversation(ctx, res.locals.user!.id, typeof req.body?.conversationId === 'string' ? req.body.conversationId : undefined, prompt); const requestId = res.locals.requestId!; ctx.db.db.prepare('INSERT INTO messages (id,conversation_id,role,content,metadata_json,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), conversationId, 'user', prompt, '{}', now()); const result = await ctx.orchestrator.chat(res.locals.user!.id, prompt, requestId, conversationId); ctx.db.db.prepare('INSERT INTO messages (id,conversation_id,role,content,metadata_json,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), conversationId, 'assistant', result.content, json({ requestId, tools: result.tools, confirmation: result.confirmation }), now()); ctx.db.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), conversationId); return res.json({ ...result, conversationId }); } catch (error) { await log('application', 'chat.error', { requestId: res.locals.requestId, error: error instanceof Error ? error.message : 'unknown' }); return res.status(500).json({ error: 'Unable to process chat request' }); } });
  app.get('/api/chat/stream/:requestId', (req, res) => { res.setHeader('content-type', 'text/event-stream'); res.setHeader('cache-control', 'no-cache'); res.setHeader('connection', 'keep-alive'); const event = (awaitEvent(req.params.requestId)); res.write(`data: ${JSON.stringify(event ?? { content: '', done: false })}\n\n`); if (event?.done) res.end(); else { const timer = setInterval(() => { const next = awaitEvent(req.params.requestId); res.write(`data: ${JSON.stringify(next ?? { content: '', done: false })}\n\n`); if (next?.done) { clearInterval(timer); res.end(); } }, 250); req.on('close', () => clearInterval(timer)); } });

  app.get('/api/confirmations', (req, res) => res.json(ctx.db.db.prepare('SELECT id,operation_id,action_hash,tool_name,args_json,risk,impact,backup_path,expires_at,approved_at,rejected_at,used_at FROM confirmations WHERE user_id=? ORDER BY expires_at DESC').all(res.locals.user!.id)));
  app.post('/api/confirmations/:id/approve', async (req, res) => { try { const expected = typeof req.body?.actionHash === 'string' ? req.body.actionHash : ''; const confirmation = approveConfirmation(ctx.db, res.locals.user!.id, req.params.id, expected); const result = await ctx.runner.run(res.locals.user!.id, res.locals.requestId!, confirmation.toolName, confirmation.args, confirmation.id, confirmation.operationId); markUsed(ctx.db, confirmation.id); const verification = confirmation.toolName === 'remove_hiddify_artifact' && result.ok ? await verifyHiddifyCleanup(ctx, res.locals.user!.id, res.locals.requestId!) : []; await audit(ctx, 'confirmation.approved', res.locals.user!.id, { confirmationId: confirmation.id, result: result.ok, verificationTools: verification.length }); return res.json({ confirmation, result, ...(verification.length ? { verification } : {}) }); } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Confirmation failed' }); } });
  app.post('/api/confirmations/:id/reject', (req, res) => { rejectConfirmation(ctx.db, res.locals.user!.id, req.params.id); return res.json({ ok: true }); });

  app.get('/api/system/health', async (_req, res) => res.json(await ctx.orchestrator.health(res.locals.user!.id, res.locals.requestId!)));
  app.post('/api/system/diagnose', async (req, res) => { const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : 'Why is my website down?'; return res.json(await ctx.orchestrator.chat(res.locals.user!.id, prompt, res.locals.requestId!)); });
  app.get('/api/audit', (req, res) => { if (res.locals.user!.role !== 'admin') return res.status(403).json({ error: 'Admin role required' }); return res.json(ctx.db.db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500').all()); });
  app.get('/api/admin/llm/status', async (_req, res) => res.json(await ctx.llm.health()));
  app.post('/api/admin/llm/test', async (_req, res) => { if (res.locals.user!.role !== 'admin') return res.status(403).json({ error: 'Admin role required' }); try { const output = await ctx.llm.complete([{ role: 'user', content: 'Return JSON with exactly one field: ok=true.' }], res.locals.requestId!, true); return res.json({ ok: true, model: output.model, content: output.content }); } catch { return res.status(503).json({ ok: false, error: 'LLM test failed' }); } });

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { void log('application', 'request.error', { requestId: res.locals.requestId, error: error instanceof Error ? error.message : 'unknown' }); res.status(500).json({ error: 'Internal server error' }); });
  return app;
}

function loginSchema(value: unknown): { username: string; password: string } { if (!value || typeof value !== 'object') throw new Error('invalid'); const v = value as Record<string, unknown>; if (typeof v.username !== 'string' || typeof v.password !== 'string' || v.username.length > 64 || v.password.length > 512) throw new Error('invalid'); return { username: v.username, password: v.password }; }
function csrfValid(req: Request): boolean { const cookie = req.cookies?.server_manager_csrf; const header = req.header('x-csrf-token'); return Boolean(cookie && header && cookie === header); }
async function ensureConversation(ctx: AppContext, userId: string, requested: string | undefined, prompt: string): Promise<string> { if (requested) { const exists = ctx.db.db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(requested, userId); if (exists) return requested; } const id = randomUUID(); const timestamp = now(); const title = prompt.slice(0, 80) || 'New conversation'; ctx.db.db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, userId, title, timestamp, timestamp); return id; }
function awaitEvent(requestId: string): { content: string; done: boolean; error?: string } | undefined { return streamEvents.get(requestId); }
async function audit(ctx: AppContext, eventType: string, userId: string, detail: Record<string, unknown>): Promise<void> { ctx.db.db.prepare('INSERT INTO audit_logs (id,user_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)').run(randomUUID(), userId, eventType, json(detail), now()); await log('audit', eventType, { userId, ...detail }); }
async function verifyHiddifyCleanup(ctx: AppContext, userId: string, requestId: string): Promise<unknown[]> { const checks: Array<[import('../../../shared/src/types.js').ToolName, Record<string, unknown>]> = [['systemd_status', { service: 'server-manager-api' }], ['nginx_test', {}], ['docker_status', {}], ['pm2_status', {}], ['systemd_status', { service: 'ssh' }], ['nginx_config_inventory', {}]]; const verification = await Promise.all(checks.map(([tool, args]) => ctx.runner.run(userId, requestId, tool, args))); const nginx = verification.find((item) => item.tool === 'nginx_config_inventory')?.data as { serverNames?: unknown[] } | undefined; const domains = (nginx?.serverNames ?? []).filter((domain): domain is string => typeof domain === 'string').slice(0, 5); const websites = await Promise.all(domains.map((domain) => ctx.runner.run(userId, requestId, 'http.checkWebsite', { url: `https://${domain}` }))); return [...verification, ...websites]; }
