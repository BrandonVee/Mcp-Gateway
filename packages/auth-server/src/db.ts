import { randomToken, scryptHash, scryptVerify } from './users.js';
import { loadPlatformConfig } from '@mcp/shared';
import { and, count, eq, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { auditEvents, authCodes, loginSessions, mcpServers, oauthConnectionStates, refreshTokens, userServerAccess, users } from './schema.js';
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

/** Apply checked-in Drizzle migrations before serving traffic. */
export async function initializeDatabase(): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  await migrate(db, { migrationsFolder });
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

/** Create the initial administrator if no administrator exists yet. */
export async function bootstrapAdmin(): Promise<void> {
  const [{ value }] = await db.select({ value: count() }).from(users).where(eq(users.role, 'admin'));
  if (value > 0) return;

  const bootstrap = platformConfig.auth.bootstrap;
  const username = process.env.ADMIN_USERNAME ?? bootstrap.adminUsername;
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
    throw new Error('Production bootstrap requires ADMIN_PASSWORD when the user table is empty');
  }
  const configuredPassword = process.env.ADMIN_PASSWORD ?? bootstrap.adminPassword;
  if (process.env.NODE_ENV === 'production' && configuredPassword && configuredPassword.length < 16) {
    throw new Error('Production ADMIN_PASSWORD must contain at least 16 characters');
  }
  const password = configuredPassword ?? randomToken(12);
  await createUserRow(username, password, 'admin');
  if (!configuredPassword) {
    console.log('='.repeat(60));
    console.log('[bootstrap] initial admin account created');
    console.log(`[bootstrap]   username: ${username}`);
    console.log(`[bootstrap]   password: ${password}   <-- shown ONCE, store it now`);
    console.log('='.repeat(60));
  } else {
    console.log(`[bootstrap] initial admin "${username}" created from configuration`);
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
export async function verifyUser(username: string, password: string): Promise<{ id: number; username: string; role: string } | null> {
  const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!row || row.disabled || !scryptVerify(password, row.passwordHash)) return null;
  return { id: row.id, username: row.username, role: row.role };
}

export async function getUserAuthorization(
  username: string,
): Promise<{ id: number; role: string; disabled: boolean; servers: string[] } | null> {
  const [user] = await db
    .select({ id: users.id, role: users.role, disabled: users.disabled, allServers: users.allServers })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!user) return null;
  if (user.role === 'admin' || user.allServers) {
    return { id: user.id, role: user.role, disabled: user.disabled, servers: ['*'] };
  }
  const rows = await db
    .select({ name: mcpServers.name })
    .from(userServerAccess)
    .innerJoin(mcpServers, eq(mcpServers.name, userServerAccess.serverName))
    .where(and(eq(userServerAccess.userId, user.id), eq(mcpServers.enabled, true)))
    .orderBy(mcpServers.name);
  return { id: user.id, role: user.role, disabled: user.disabled, servers: rows.map((row) => row.name) };
}

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export async function createLoginSession(sub: string): Promise<string> {
  const token = randomToken(32);
  await db.insert(loginSessions).values({ token, sub, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export async function getSessionUser(token: string): Promise<{ sub: string } | null> {
  const [row] = await db.select().from(loginSessions).where(eq(loginSessions.token, token)).limit(1);
  if (!row || row.expiresAt < Date.now()) return null;
  return { sub: row.sub };
}

export async function deleteLoginSession(token: string): Promise<void> {
  await db.delete(loginSessions).where(eq(loginSessions.token, token));
}
