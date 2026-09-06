import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export class AppDatabase {
  readonly db: DatabaseSyncType;
  constructor(filename = config.DATABASE_PATH) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }
  private migrate(): void {
    const migration = resolve(process.cwd(), 'migrations/001_initial.sql');
    // Synchronous reads keep startup atomic and migrations deterministic.
    const sql = requireMigration(migration);
    this.db.exec(sql);
  }
  close(): void { this.db.close(); }
}

function requireMigration(path: string): string { return readFileSync(path, 'utf8'); }

export function now(): string { return new Date().toISOString(); }
export function json(value: unknown): string { return JSON.stringify(value ?? {}); }
export function parseJson<T>(value: string): T { return JSON.parse(value) as T; }
