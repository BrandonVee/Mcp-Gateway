import { and, eq } from 'drizzle-orm';
import { db } from '../../infrastructure/database/client.js';
import { loginSessions, users } from '../../infrastructure/database/schema.js';
import { randomToken } from '../../infrastructure/security/password.js';
import { SESSION_TTL_SECONDS } from '../../shared/http/session-cookie.js';
import { withAuthenticatedUser, type AuthIdentity } from './authentication.js';

export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export async function createLoginSession(userId: number, userAuthVersion: number): Promise<string> {
  const token = randomToken(32);
  const [user] = await db.select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error('user identity is no longer valid');
  return withAuthenticatedUser({ userId, userAuthVersion, sub: user.username }, async (tx) => {
    await tx
      .insert(loginSessions)
      .values({ token, userId, userAuthVersion, sub: user.username, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  });
}

export async function getSessionUser(token: string): Promise<AuthIdentity | null> {
  const [row] = await db
    .select({
      sub: users.username,
      userId: users.id,
      userAuthVersion: users.authVersion,
      expiresAt: loginSessions.expiresAt,
    })
    .from(loginSessions)
    .innerJoin(users, and(eq(users.id, loginSessions.userId), eq(users.authVersion, loginSessions.userAuthVersion)))
    .where(and(eq(loginSessions.token, token), eq(users.disabled, false)))
    .limit(1);
  if (!row || row.expiresAt < Date.now()) return null;
  return { sub: row.sub, userId: row.userId, userAuthVersion: row.userAuthVersion };
}

export async function deleteLoginSession(token: string): Promise<void> {
  await db.delete(loginSessions).where(eq(loginSessions.token, token));
}
