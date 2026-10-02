import { randomToken, scryptHash, scryptVerify } from './users.js';
import { loadPlatformConfig } from '@mcp/shared';
import { and, count, eq, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { auditEvents, authCodes, clients, loginSessions, mcpServers, oauthConnectionStates, refreshTokens, userServerAccess, users } from './schema.js';
import * as schema from './schema.js';

const platformConfig = loadPlatformConfig();
const postgresConfig = platformConfig.auth.postgres;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? postgresConfig.url,
  max: Number(process.env.PG_POOL_MAX ?? postgresConfig.poolMax),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (error) => console.error('[postgres] idle client error', error));

export const db = drizzle(pool, { schema });
export type AuthTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AuthIdentity = { userId: number; userAuthVersion: number; sub: string };

/** Lock identity while issuing credentials; reset/disable/delete waits for this transaction. */
export async function withAuthenticatedUser<T>(identity: AuthIdentity, work: (tx: AuthTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, identity.userId), eq(users.username, identity.sub),
        eq(users.authVersion, identity.userAuthVersion), eq(users.disabled, false))).for('share').limit(1);
    if (!user) throw new Error('user identity is no longer valid');
    return work(tx);
  });
}

export async function revokeUserAuthentication(tx: AuthTransaction, userId: number): Promise<void> {
  await tx.delete(loginSessions).where(eq(loginSessions.userId, userId));
  await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  await tx.delete(authCodes).where(eq(authCodes.userId, userId));
  await tx.delete(oauthConnectionStates).where(eq(oauthConnectionStates.userId, userId));
}

/** Apply checked-in Drizzle migrations before serving traffic. */
export async function initializeDatabase(): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  const client = await pool.connect();
  try {
    // Drizzle's migration journal needs one writer when Auth has many replicas.
    await client.query('SELECT pg_advisory_lock(762441, 1)');
    await migrate(drizzle(client, { schema }), { migrationsFolder });
  } finally {
    await client.query('SELECT pg_advisory_unlock(762441, 1)').finally(() => client.release());
  }
}

/** A development database must never be silently promoted with demo credentials. */
export async function assertNoDevelopmentFixtures(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  const [demoUser] = await db.select({ id: users.id }).from(users).where(eq(users.username, 'demo-user')).limit(1);
  const [demoClient] = await db.select({ id: clients.clientId }).from(clients).where(eq(clients.clientId, 'demo-client')).limit(1);
  if (demoUser || demoClient) throw new Error('Production database contains development demo-user or demo-client; remove fixtures before startup');
}

/** Periodically purge expired OAuth state through Drizzle ORM. */
export async function sweepExpired(): Promise<void> {
  const now = Date.now();
  const configuredRetention = Number(process.env.AUDIT_RETENTION_DAYS ?? 90);
  const auditRetentionDays = Number.isFinite(configuredRetention) && configuredRetention > 0 ? configuredRetention : 90;
  await Promise.all([
    db.delete(authCodes).where(lt(authCodes.expiresAt, now)),
    db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, now)),
    db.delete(loginSessions).where(lt(loginSessions.expiresAt, now)),
    db.delete(oauthConnectionStates).where(lt(oauthConnectionStates.expiresAt, now)),
    db.delete(auditEvents).where(lt(auditEvents.createdAt, now - auditRetentionDays * 24 * 3600 * 1000)),
  ]);
}

export function startExpirySweep(): void {
  setInterval(() => void sweepExpired().catch((error) => console.error('[postgres] expiry sweep failed', error)), 10 * 60 * 1000).unref();
}

/** Create the initial administrator; recovering an existing account requires an explicit operator opt-in. */
export async function bootstrapAdmin(): Promise<void> {
  const bootstrap = platformConfig.auth.bootstrap;
  const username = process.env.ADMIN_USERNAME ?? bootstrap.adminUsername;
  const configuredPassword = process.env.ADMIN_PASSWORD ?? bootstrap.adminPassword;
  let recovered = false;
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(762441, 2)`);
    const [{ value }] = await tx.select({ value: count() }).from(users).where(and(eq(users.role, 'admin'), eq(users.disabled, false)));
    if (value > 0) return null;
    if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
      throw new Error('Production bootstrap requires ADMIN_PASSWORD when no active administrator exists');
    }
    if (process.env.NODE_ENV === 'production' && configuredPassword && configuredPassword.length < 16) {
      throw new Error('Production ADMIN_PASSWORD must contain at least 16 characters');
    }
    const password = configuredPassword ?? randomToken(12);
    const now = Date.now();
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.username, username)).for('update').limit(1);
    if (existing) {
      if (process.env.ADMIN_BOOTSTRAP_RECOVERY !== 'true' || !process.env.ADMIN_PASSWORD) {
        throw new Error('No active administrator exists. To recover the configured administrator, explicitly set ADMIN_BOOTSTRAP_RECOVERY=true and ADMIN_PASSWORD');
      }
      await tx.update(users).set({ passwordHash: scryptHash(password), role: 'admin', disabled: false,
        authVersion: sql`${users.authVersion} + 1`, updatedAt: now }).where(eq(users.id, existing.id));
      await revokeUserAuthentication(tx, existing.id);
      recovered = true;
      return password;
    }
    await tx.insert(users).values({ username, passwordHash: scryptHash(password), role: 'admin', disabled: false, createdAt: now, updatedAt: now });
    return password;
  });
  if (created === null) return;
  if (!configuredPassword) {
    console.log('='.repeat(60));
    console.log('[bootstrap] initial admin account created');
    console.log(`[bootstrap]   username: ${username}`);
    console.log(`[bootstrap]   password: ${created}   <-- shown ONCE, store it now`);
    console.log('='.repeat(60));
  } else {
    console.log(`[bootstrap] administrator "${username}" ${recovered ? 'recovered' : 'created'} from configuration`);
  }
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
export async function verifyUser(username: string, password: string): Promise<{ id: number; username: string; role: string; authVersion: number } | null> {
  const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!row || row.disabled || !scryptVerify(password, row.passwordHash)) return null;
  return { id: row.id, username: row.username, role: row.role, authVersion: row.authVersion };
}

export async function getUserAuthorization(
  userId: number,
  executor: typeof db | AuthTransaction = db,
): Promise<{ id: number; username: string; authVersion: number; role: string; disabled: boolean; servers: string[] } | null> {
  const [user] = await executor
    .select({ id: users.id, username: users.username, authVersion: users.authVersion, role: users.role, disabled: users.disabled, allServers: users.allServers })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  if (user.role === 'admin' || user.allServers) {
    return { id: user.id, username: user.username, authVersion: user.authVersion, role: user.role, disabled: user.disabled, servers: ['*'] };
  }
  const rows = await executor
    .select({ name: mcpServers.name })
    .from(userServerAccess)
    .innerJoin(mcpServers, eq(mcpServers.name, userServerAccess.serverName))
    .where(and(eq(userServerAccess.userId, user.id), eq(mcpServers.enabled, true)))
    .orderBy(mcpServers.name);
  return { id: user.id, username: user.username, authVersion: user.authVersion, role: user.role, disabled: user.disabled, servers: rows.map((row) => row.name) };
}

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export async function createLoginSession(userId: number, userAuthVersion: number): Promise<string> {
  const token = randomToken(32);
  const [user] = await db.select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error('user identity is no longer valid');
  return withAuthenticatedUser({ userId, userAuthVersion, sub: user.username }, async (tx) => {
    await tx.insert(loginSessions).values({ token, userId, userAuthVersion, sub: user.username, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  });
}

export async function getSessionUser(token: string): Promise<AuthIdentity | null> {
  const [row] = await db.select({ sub: users.username, userId: users.id, userAuthVersion: users.authVersion, expiresAt: loginSessions.expiresAt })
    .from(loginSessions).innerJoin(users, and(eq(users.id, loginSessions.userId), eq(users.authVersion, loginSessions.userAuthVersion)))
    .where(and(eq(loginSessions.token, token), eq(users.disabled, false))).limit(1);
  if (!row || row.expiresAt < Date.now()) return null;
  return { sub: row.sub, userId: row.userId, userAuthVersion: row.userAuthVersion };
}

export async function deleteLoginSession(token: string): Promise<void> {
  await db.delete(loginSessions).where(eq(loginSessions.token, token));
}
