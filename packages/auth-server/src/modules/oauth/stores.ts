/**
 * Authorization codes and refresh tokens, persisted in PostgreSQL.
 */
import { and, eq, gte } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, type AuthTransaction } from '@/auth/infrastructure/database/client.js';
import { authCodes, refreshTokens } from '@/auth/infrastructure/database/schema.js';
import { withAuthenticatedUser, type AuthIdentity } from '@/auth/modules/identity/authentication.js';

export interface AuthCodeEntry extends AuthIdentity {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string; // S256
  resource?: string; // RFC 8707 resource indicator -> becomes JWT audience
  sub: string;
  expiresAt: number;
}

export interface RefreshTokenEntry extends AuthIdentity {
  client_id: string;
  scope: string;
  resource?: string;
  sub: string;
}

export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

export async function saveAuthCode(entry: AuthCodeEntry): Promise<string> {
  const code = randomBytes(32).toString('hex');
  await withAuthenticatedUser(entry, async (tx) =>
    tx.insert(authCodes).values({
      code,
      clientId: entry.client_id,
      redirectUri: entry.redirect_uri,
      scope: entry.scope,
      codeChallenge: entry.code_challenge,
      resource: entry.resource ?? null,
      sub: entry.sub,
      userId: entry.userId,
      userAuthVersion: entry.userAuthVersion,
      expiresAt: entry.expiresAt,
    }),
  );
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
    userId: row.userId,
    userAuthVersion: row.userAuthVersion,
    expiresAt: row.expiresAt,
  };
}

export async function saveRefreshToken(entry: RefreshTokenEntry, transaction?: AuthTransaction): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const insert = async (tx: AuthTransaction) =>
    tx.insert(refreshTokens).values({
      token,
      clientId: entry.client_id,
      sub: entry.sub,
      userId: entry.userId,
      userAuthVersion: entry.userAuthVersion,
      scope: entry.scope,
      resource: entry.resource ?? null,
      expiresAt: Date.now() + REFRESH_TTL_MS,
      revoked: false,
      createdAt: Date.now(),
    });
  if (transaction) await insert(transaction);
  else await withAuthenticatedUser(entry, insert);
  return token;
}

/** Atomically revoke and return a refresh token so concurrent reuse fails. */
export async function consumeRefreshToken(token: string): Promise<RefreshTokenEntry | undefined> {
  const [row] = await db
    .update(refreshTokens)
    .set({ revoked: true })
    .where(
      and(eq(refreshTokens.token, token), eq(refreshTokens.revoked, false), gte(refreshTokens.expiresAt, Date.now())),
    )
    .returning();
  if (!row) return undefined;
  return {
    client_id: row.clientId,
    scope: row.scope,
    resource: row.resource ?? undefined,
    sub: row.sub,
    userId: row.userId,
    userAuthVersion: row.userAuthVersion,
  };
}
