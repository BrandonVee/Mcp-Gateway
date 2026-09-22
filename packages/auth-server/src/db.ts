import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { scryptHash, scryptVerify, randomToken } from './users.js';

export const DB_PATH = process.env.DB_PATH ?? './data/auth.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  redirect_uris TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  scope          TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource       TEXT,
  sub            TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token      TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  sub        TEXT NOT NULL,
  scope      TEXT NOT NULL,
  resource   TEXT,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_sessions (
  token      TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codes_expiry ON auth_codes (expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_expiry ON refresh_tokens (expires_at);
`);

/** Periodically purge expired rows. */
export function sweepExpired(): void {
  const now = Date.now();
  db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM login_sessions WHERE expires_at < ?').run(now);
}
setInterval(sweepExpired, 10 * 60 * 1000).unref();

/**
 * Admin bootstrap: if no user exists, create the initial admin.
 * Password comes from ADMIN_PASSWORD; if unset, a random one is generated
 * and printed once (it cannot be recovered later).
 */
export function bootstrapAdmin(): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (count > 0) return;

  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const password = process.env.ADMIN_PASSWORD ?? randomToken(12);
  createUserRow(username, password, 'admin');
  if (!process.env.ADMIN_PASSWORD) {
    console.log('='.repeat(60));
    console.log(`[bootstrap] initial admin account created`);
    console.log(`[bootstrap]   username: ${username}`);
    console.log(`[bootstrap]   password: ${password}   <-- shown ONCE, store it now`);
    console.log('='.repeat(60));
  } else {
    console.log(`[bootstrap] initial admin "${username}" created from ADMIN_PASSWORD`);
  }
}

/** Optional demo account for local testing (SEED_DEMO_USER=0 disables). */
export function seedDemoUser(): void {
  if (process.env.SEED_DEMO_USER === '0') return;
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get('demo-user');
  if (exists) return;
  createUserRow('demo-user', process.env.DEMO_PASSWORD ?? 'demo123', 'user');
  console.log('[bootstrap] demo account seeded: demo-user (change/remove for production)');
}


function createUserRow(username: string, password: string, role: 'admin' | 'user'): number {
  const now = Date.now();
  const result = db
    .prepare('INSERT INTO users (username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(username, scryptHash(password), role, now, now);
  return Number(result.lastInsertRowid);
}

export { createUserRow };

/** Validate credentials; returns the user row or null. */
export function verifyUser(username: string, password: string): { id: number; username: string; role: string } | null {
  const row = db
    .prepare('SELECT id, username, password_hash, role, disabled FROM users WHERE username = ?')
    .get(username) as { id: number; username: string; password_hash: string; role: string; disabled: number } | undefined;
  if (!row || row.disabled) return null;
  if (!scryptVerify(password, row.password_hash)) return null;
  return { id: row.id, username: row.username, role: row.role };
}

export function getUserRole(username: string): string {
  const row = db.prepare('SELECT role FROM users WHERE username = ?').get(username) as { role: string } | undefined;
  return row?.role ?? 'user';
}


export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export function createLoginSession(sub: string): string {
  const token = randomToken(32);
  db.prepare('INSERT INTO login_sessions (token, sub, expires_at) VALUES (?, ?, ?)').run(
    token,
    sub,
    Date.now() + SESSION_TTL_MS,
  );
  return token;
}

export function getSessionUser(token: string): { sub: string } | null {
  const row = db
    .prepare('SELECT sub, expires_at FROM login_sessions WHERE token = ?')
    .get(token) as { sub: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  return { sub: row.sub };
}
