import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { AppDatabase } from '../backend/src/db/database.js';
import { createAdmin } from '../backend/src/auth/auth.js';
import { createApp, createContext } from '../backend/src/api/server-app.js';

describe('authenticated API', () => {
  let server: Server; let db: AppDatabase; let base = ''; let cookie = ''; let csrf = '';
  afterEach(async () => { await new Promise<void>((resolve) => server?.close(() => resolve())); db?.close(); if (db) { try { unlinkSync((db as unknown as { filename?: string }).filename ?? ''); } catch { /* temporary file cleanup is best effort */ } } });

  it('protects endpoints, creates conversations, and serves deterministic health', async () => {
    const path = join(tmpdir(), `sentinel-api-${randomUUID()}.sqlite`); db = new AppDatabase(path); const user = await createAdmin(db, 'adminapi', 'a sufficiently long test password'); const app = createApp(createContext(db)); server = createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve())); const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address'); base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/conversations`)).status).toBe(401);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user.username, password: 'a sufficiently long test password' }) }); expect(login.status).toBe(200); const setCookie = login.headers.get('set-cookie') ?? ''; cookie = setCookie.split(', ').map((v) => v.split(';')[0]).join('; '); csrf = cookie.match(/server_manager_csrf=([^;]+)/)?.[1] ?? '';
    const conversation = await fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ title: 'Health' }) }); expect(conversation.status).toBe(201); const created = await conversation.json() as { id: string };
    const chat = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ conversationId: created.id, prompt: 'Is my server healthy?' }) }); expect(chat.status).toBe(200); const payload = await chat.json() as { content: string; tools: unknown[] }; expect(payload.content).toContain('HEALTH:'); expect(payload.tools.length).toBeGreaterThan(0);
    const stream = await fetch(`${base}/api/chat/stream/${(payload as { requestId: string }).requestId}`, { headers: { cookie } }); expect(stream.status).toBe(200); expect(await stream.text()).toContain('HEALTH:');
  });
});
