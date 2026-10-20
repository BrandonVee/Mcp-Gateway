import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { gatewayApiKeyPattern } from '@/shared/security/gateway-access.js';
import { db } from '@/auth/infrastructure/database/client.js';
import { userApiKeys, users } from '@/auth/infrastructure/database/schema.js';
import { getUserAuthorization } from '@/auth/modules/identity/authentication.js';
import type { User } from '@/auth/modules/identity/session-user.js';

const digest = (key: string) => createHash('sha256').update(key).digest('hex');

export async function createUserApiKey(user: User, name: string) {
  return db.transaction(async (tx) => {
    // Serialize key creation with account disable/reset and the per-user key cap.
    const [account] = await tx.select().from(users).where(eq(users.id, user.id)).for('update');
    if (!account || account.disabled || account.authVersion !== user.authVersion) return { error: 'session_changed' };
    const [{ total }] = await tx.select({ total: count() }).from(userApiKeys).where(eq(userApiKeys.userId, user.id));
    if (total >= 20) return { error: 'api_key_limit_reached' };
    const key = `mcp_key_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID(),
      createdAt = Date.now(),
      prefix = key.slice(0, 16);
    await tx.insert(userApiKeys).values({
      id,
      userId: user.id,
      name,
      keyHash: digest(key),
      prefix,
      userAuthVersion: user.authVersion,
      createdAt,
    });
    return { id, name, prefix, created_at: createdAt, last_used_at: null, key };
  });
}

/** Never cache: revocation and account/grant changes apply to the next request. */
export async function authenticateUserApiKey(key: string) {
  if (!gatewayApiKeyPattern.test(key)) return null;
  return db.transaction(async (tx) => {
    const [saved] = await tx
      .select()
      .from(userApiKeys)
      .where(eq(userApiKeys.keyHash, digest(key)))
      .limit(1);
    if (!saved) return null;
    const user = await getUserAuthorization(saved.userId, tx);
    if (!user || user.disabled || user.authVersion !== saved.userAuthVersion) return null;
    // Updating an existing row also prevents a concurrently deleted key from succeeding.
    const updated = await tx
      .update(userApiKeys)
      .set({ lastUsedAt: Date.now() })
      .where(eq(userApiKeys.id, saved.id))
      .returning({ id: userApiKeys.id });
    if (!updated.length) return null;
    return {
      uid: user.id,
      sub: user.username,
      role: user.role,
      auth_version: user.authVersion,
      mcp_servers: user.servers,
      client_id: `api_key:${saved.id}`,
      scope: 'mcp',
    };
  });
}
