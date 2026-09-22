/**
 * Authorization codes and refresh tokens, persisted in SQLite.
 */
import { randomBytes } from 'node:crypto';
import { db } from './db.js';

export interface AuthCodeEntry {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string; // S256
  resource?: string; // RFC 8707 resource indicator -> becomes JWT audience
  sub: string;
  expiresAt: number;
}

export interface RefreshTokenEntry {
  client_id: string;
  scope: string;
  resource?: string;
  sub: string;
}

const CODE_TTL_MS = 10 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

export function saveAuthCode(entry: AuthCodeEntry): string {
  const code = randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO auth_codes (code, client_id, redirect_uri, scope, code_challenge, resource, sub, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(code, entry.client_id, entry.redirect_uri, entry.scope, entry.code_challenge, entry.resource ?? null, entry.sub, entry.expiresAt);
  return code;
}

export function consumeAuthCode(code: string): AuthCodeEntry | undefined {
  const row = db
    .prepare('SELECT code, client_id, redirect_uri, scope, code_challenge, resource, sub, expires_at FROM auth_codes WHERE code = ?')
    .get(code) as AuthCodeEntry | undefined;
  if (!row) return undefined;
  db.prepare('DELETE FROM auth_codes WHERE code = ?').run(code); // one-time use
  if (row.expiresAt < Date.now()) return undefined;
  return row;
}

export function saveRefreshToken(entry: RefreshTokenEntry): string {
  const token = randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO refresh_tokens (token, client_id, sub, scope, resource, expires_at, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
  ).run(token, entry.client_id, entry.sub, entry.scope, entry.resource ?? null, Date.now() + REFRESH_TTL_MS, Date.now());
  return token;
}

export function consumeRefreshToken(token: string): RefreshTokenEntry | undefined {
  const row = db
    .prepare('SELECT token, client_id, sub, scope, resource, expires_at, revoked FROM refresh_tokens WHERE token = ?')
    .get(token) as { token: string; client_id: string; sub: string; scope: string; resource: string | null; expires_at: number; revoked: number } | undefined;
  if (!row || row.revoked || row.expires_at < Date.now()) return undefined;
  return { client_id: row.client_id, scope: row.scope, resource: row.resource ?? undefined, sub: row.sub };
}

export function deleteRefreshToken(token: string): void {
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token = ?').run(token);
}
