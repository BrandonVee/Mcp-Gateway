import { loadPlatformConfig } from '@mcp/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import { db } from '@/auth/infrastructure/database/client.js';
import { LockNamespace, lockTransaction } from '@/auth/infrastructure/database/locks.js';
import { users } from '@/auth/infrastructure/database/schema.js';
import { randomToken, scryptHash } from '@/auth/infrastructure/security/password.js';
import { revokeUserAuthentication } from '@/auth/modules/identity/authentication.js';
const platformConfig = loadPlatformConfig();

/** Create the initial administrator; recovering an existing account requires an explicit operator opt-in. */
export async function bootstrapAdmin(): Promise<void> {
  const bootstrap = platformConfig.auth.bootstrap;
  const username = process.env.ADMIN_USERNAME ?? bootstrap.adminUsername;
  const configuredPassword = process.env.ADMIN_PASSWORD ?? bootstrap.adminPassword;
  let recovered = false;
  const created = await db.transaction(async (tx) => {
    await lockTransaction(tx, LockNamespace.Administrator, 2);
    const [{ value }] = await tx
      .select({ value: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.disabled, false)));
    if (value > 0) return null;
    if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
      throw new Error('Production bootstrap requires ADMIN_PASSWORD when no active administrator exists');
    }
    if (process.env.NODE_ENV === 'production' && configuredPassword && configuredPassword.length < 16) {
      throw new Error('Production ADMIN_PASSWORD must contain at least 16 characters');
    }
    const password = configuredPassword ?? randomToken(12);
    const now = Date.now();
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .for('update')
      .limit(1);
    if (existing) {
      if (process.env.ADMIN_BOOTSTRAP_RECOVERY !== 'true' || !process.env.ADMIN_PASSWORD) {
        throw new Error(
          'No active administrator exists. To recover the configured administrator, explicitly set ADMIN_BOOTSTRAP_RECOVERY=true and ADMIN_PASSWORD',
        );
      }
      await tx
        .update(users)
        .set({
          passwordHash: scryptHash(password),
          role: 'admin',
          disabled: false,
          authVersion: sql`${users.authVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(users.id, existing.id));
      await revokeUserAuthentication(tx, existing.id);
      recovered = true;
      return password;
    }
    await tx.insert(users).values({
      username,
      passwordHash: scryptHash(password),
      role: 'admin',
      disabled: false,
      createdAt: now,
      updatedAt: now,
    });
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
