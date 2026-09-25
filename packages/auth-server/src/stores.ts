/**
 * Authorization codes and refresh tokens, persisted in PostgreSQL.
 */
import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { authCodes, refreshTokens } from './schema.js';
import { and, eq, gte } from 'drizzle-orm';

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

export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

export async function saveAuthCode(entry: AuthCodeEntry): Promise<string> {
  const code = randomBytes(32).toString('hex');
  await db.insert(authCodes).values({
    code,
    clientId: entry.client_id,
    redirectUri: entry.redirect_uri,
    scope: entry.scope,
    codeChallenge: entry.code_challenge,
    resource: entry.resource ?? null,
    sub: entry.sub,
    expiresAt: entry.expiresAt,
  });
  return code;
}

export async function consumeAuthCode(code: string): Promise<AuthCodeEntry | undefined> {
  const [row] = await db.delete(authCodes).where(eq(authCodes.code, code)).returning();
  if (!row) return undefined;
  if (row.expiresAt < Date.now()) return undefined;
  return {
    client_id: row.clientId,
    redirect_uri: row.redirectUri,
    scope: row.scope,
    code_challenge: row.codeChallenge,
    resource: row.resource ?? undefined,
    sub: row.sub,
    expiresAt: row.expiresAt,
  };
}

export async function saveRefreshToken(entry: RefreshTokenEntry): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db.insert(refreshTokens).values({
    token,
    clientId: entry.client_id,
    sub: entry.sub,
    scope: entry.scope,
    resource: entry.resource ?? null,
    expiresAt: Date.now() + REFRESH_TTL_MS,
    revoked: false,
    createdAt: Date.now(),
  });
  return token;
}

/** Atomically revoke and return a refresh token so concurrent reuse fails. */
export async function consumeRefreshToken(token: string): Promise<RefreshTokenEntry | undefined> {
  const [row] = await db
    .update(refreshTokens)
    .set({ revoked: true })
    .where(and(eq(refreshTokens.token, token), eq(refreshTokens.revoked, false), gte(refreshTokens.expiresAt, Date.now())))
    .returning();
  if (!row) return undefined;
  return { client_id: row.clientId, scope: row.scope, resource: row.resource ?? undefined, sub: row.sub };
}
