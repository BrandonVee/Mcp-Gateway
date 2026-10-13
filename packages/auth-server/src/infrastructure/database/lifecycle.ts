import { eq, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { authServerPaths } from '../runtime/paths.js';
import { db, pool } from './client.js';
import * as schema from './schema.js';
import {
  auditEvents,
  authCodes,
  clients,
  loginSessions,
  oauthConnectionStates,
  refreshTokens,
  signupEmailCodes,
  users,
} from './schema.js';

/** Apply checked-in Drizzle migrations before serving traffic. */
export async function initializeDatabase(): Promise<void> {
  const migrationsFolder = authServerPaths.migrations;
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
  const [demoClient] = await db
    .select({ id: clients.clientId })
    .from(clients)
    .where(eq(clients.clientId, 'demo-client'))
    .limit(1);
  if (demoUser || demoClient)
    throw new Error(
      'Production database contains development demo-user or demo-client; remove fixtures before startup',
    );
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
    db.delete(signupEmailCodes).where(lt(signupEmailCodes.expiresAt, now)),
    db.delete(auditEvents).where(lt(auditEvents.createdAt, now - auditRetentionDays * 24 * 3600 * 1000)),
  ]);
}

export function startExpirySweep(): void {
  setInterval(
    () => void sweepExpired().catch((error) => console.error('[postgres] expiry sweep failed', error)),
    10 * 60 * 1000,
  ).unref();
}
