import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { json, now, type AppDatabase } from '../db/database.js';
import type { User } from '../../../shared/src/types.js';

const scrypt = promisify(scryptCb);
type Argon2Like = { hash(value: string, options: { type: number; memoryCost: number; timeCost: number; parallelism: number }): Promise<string>; verify(hash: string, value: string): Promise<boolean>; argon2id: number };
let argon2: Argon2Like | null = null;
try { argon2 = await import('argon2') as unknown as Argon2Like; } catch { /* Windows test environments may not have a usable native prebuild; Ubuntu uses Argon2id. */ }

export async function hashPassword(password: string): Promise<string> { if (argon2) return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }); if (config.IS_PRODUCTION) throw new Error('Argon2id runtime is unavailable'); const salt = randomBytes(16); const derived = await scrypt(password, salt, 64) as Buffer; return `$scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`; }
export async function verifyPassword(hash: string, password: string): Promise<boolean> { try { if (argon2 && hash.startsWith('$argon2')) return await argon2.verify(hash, password); if (!hash.startsWith('$scrypt$')) return false; const [, , saltText, keyText] = hash.split('$'); if (!saltText || !keyText) return false; const expected = Buffer.from(keyText, 'base64url'); const actual = await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length) as Buffer; return expected.length === actual.length && timingSafeEqual(expected, actual); } catch { return false; } }
const tokenHash = (token: string) => createHash('sha256').update(`${config.SESSION_SECRET}:${token}`).digest('hex');

export function setSession(db: AppDatabase, res: Response, userId: string): void {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.SESSION_TTL_MS).toISOString();
  db.db.prepare('INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)').run(randomUUID(), userId, tokenHash(token), now(), expires);
  res.cookie(config.COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', secure: config.IS_PRODUCTION, maxAge: config.SESSION_TTL_MS, path: '/' });
}

export function revokeSession(db: AppDatabase, req: Request, res: Response): void {
  const token = req.cookies?.[config.COOKIE_NAME];
  if (token) db.db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(now(), tokenHash(token));
  res.clearCookie(config.COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: config.IS_PRODUCTION, path: '/' });
}

export function userFromRequest(db: AppDatabase, req: Request): User | null {
  const token = req.cookies?.[config.COOKIE_NAME];
  if (!token) return null;
  const row = db.db.prepare(`SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND u.disabled_at IS NULL AND s.expires_at>?`).get(tokenHash(token), now()) as User | undefined;
  return row ?? null;
}

export async function createAdmin(db: AppDatabase, username: string, password: string): Promise<User> {
  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) throw new Error('Invalid username');
  if (password.length < 14) throw new Error('Password must be at least 14 characters');
  const id = randomUUID();
  db.db.prepare('INSERT INTO users (id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)').run(id, username, await hashPassword(password), 'admin', now());
  return { id, username, role: 'admin' };
}
