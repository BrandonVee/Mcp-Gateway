import { normalizeEmail } from '@mcp/shared';
import { and, eq } from 'drizzle-orm';
import { db, type AuthTransaction } from '../../infrastructure/database/client.js';
import {
  authCodes,
  loginSessions,
  mcpServers,
  oauthConnectionStates,
  refreshTokens,
  upstreamOAuthStates,
  users,
  userServerAccess,
} from '../../infrastructure/database/schema.js';
import { scryptHash, scryptVerify } from '../../infrastructure/security/password.js';

export type AuthIdentity = { userId: number; userAuthVersion: number; sub: string };

/** Lock identity while issuing credentials; reset/disable/delete waits for this transaction. */
export async function withAuthenticatedUser<T>(
  identity: AuthIdentity,
  work: (tx: AuthTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, identity.userId),
          eq(users.username, identity.sub),
          eq(users.authVersion, identity.userAuthVersion),
          eq(users.disabled, false),
        ),
      )
      .for('share')
      .limit(1);
    if (!user) throw new Error('user identity is no longer valid');
    return work(tx);
  });
}

export async function revokeUserAuthentication(tx: AuthTransaction, userId: number): Promise<void> {
  await tx.delete(loginSessions).where(eq(loginSessions.userId, userId));
  await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  await tx.delete(authCodes).where(eq(authCodes.userId, userId));
  await tx.delete(oauthConnectionStates).where(eq(oauthConnectionStates.userId, userId));
  await tx.delete(upstreamOAuthStates).where(eq(upstreamOAuthStates.userId, userId));
}

export async function createUserRow(username: string, password: string, role: 'admin' | 'user'): Promise<number> {
  const now = Date.now();
  const [created] = await db
    .insert(users)
    .values({ username, passwordHash: scryptHash(password), role, disabled: false, createdAt: now, updatedAt: now })
    .returning({ id: users.id });
  return created.id;
}

/** Validate credentials; returns the user row or null. */
export async function verifyUser(
  username: string,
  password: string,
): Promise<{
  id: number;
  username: string;
  role: string;
  authVersion: number;
  email: string | null;
  emailVerified: boolean;
} | null> {
  const email = normalizeEmail(username);
  let [row] = await db
    .select()
    .from(users)
    .where(eq(email ? users.email : users.username, email ?? username))
    .limit(1);
  if (!row && email) [row] = await db.select().from(users).where(eq(users.username, email)).limit(1);
  if (!row || row.disabled || !scryptVerify(password, row.passwordHash)) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    authVersion: row.authVersion,
    email: row.email,
    emailVerified: row.emailVerified,
  };
}

export async function getUserAuthorization(
  userId: number,
  executor: typeof db | AuthTransaction = db,
): Promise<{
  id: number;
  username: string;
  authVersion: number;
  role: string;
  disabled: boolean;
  servers: string[];
} | null> {
  const [user] = await executor
    .select({
      id: users.id,
      username: users.username,
      authVersion: users.authVersion,
      role: users.role,
      disabled: users.disabled,
      allServers: users.allServers,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  if (user.role === 'admin' || user.allServers) {
    return {
      id: user.id,
      username: user.username,
      authVersion: user.authVersion,
      role: user.role,
      disabled: user.disabled,
      servers: ['*'],
    };
  }
  const rows = await executor
    .select({ name: mcpServers.name })
    .from(userServerAccess)
    .innerJoin(mcpServers, eq(mcpServers.name, userServerAccess.serverName))
    .where(and(eq(userServerAccess.userId, user.id), eq(mcpServers.enabled, true)))
    .orderBy(mcpServers.name);
  return {
    id: user.id,
    username: user.username,
    authVersion: user.authVersion,
    role: user.role,
    disabled: user.disabled,
    servers: rows.map((row) => row.name),
  };
}
