import { and, eq } from 'drizzle-orm';
import { db } from '@/auth/infrastructure/database/client.js';
import { mcpServerInstances, upstreamCredentials, userMcpCredentials } from '@/auth/infrastructure/database/schema.js';
import { lockUpstream, lockOwner, ownerFor, type Identity } from '@/auth/modules/upstreams/connection-service.js';
import { lockAccessibleConnection } from '@/auth/modules/connections/lifecycle.js';
import { credentialVersion } from '@/auth/infrastructure/security/credential-crypto.js';

export async function recordCredentialValidation(input: {
  instance_id?: string;
  server?: string;
  upstream_url: string;
  credential_version: string;
  user_id: number;
  auth_version: number;
  status: 'verified' | 'rejected';
}) {
  const identity: Identity = { id: input.user_id, authVersion: input.auth_version, role: 'user' };
  return db.transaction(async (tx) => {
    if (input.instance_id) {
      const locked = await lockUpstream(tx, input.instance_id, identity);
      if (!locked || locked.upstream.url !== input.upstream_url) return false;
      const system = locked.upstream.authMode === 'system_oauth';
      const owner = ownerFor(system, identity.id);
      await lockOwner(tx, locked.upstream.id, owner);
      const [row] = await tx
        .select()
        .from(upstreamCredentials)
        .where(and(eq(upstreamCredentials.instanceId, locked.upstream.id), eq(upstreamCredentials.owner, owner)))
        .for('update');
      if (!row || credentialVersion(row.secret) !== input.credential_version) return false;
      await tx
        .update(upstreamCredentials)
        .set({ validationStatus: input.status, validatedAt: Date.now() })
        .where(and(eq(upstreamCredentials.instanceId, row.instanceId), eq(upstreamCredentials.owner, owner)));
      return true;
    }
    const server = await lockAccessibleConnection(tx, identity.id, input.server ?? '', undefined, identity.authVersion);
    if (!server || server.routingMode !== 'pool') return false;
    const [instance] = await tx
      .select({ id: mcpServerInstances.id })
      .from(mcpServerInstances)
      .where(
        and(
          eq(mcpServerInstances.serverName, server.name),
          eq(mcpServerInstances.url, input.upstream_url),
          eq(mcpServerInstances.enabled, true),
        ),
      );
    if (!instance) return false;
    const [row] = await tx
      .select()
      .from(userMcpCredentials)
      .where(and(eq(userMcpCredentials.userId, identity.id), eq(userMcpCredentials.serverName, server.name)))
      .for('update');
    if (!row || credentialVersion(row.secret) !== input.credential_version) return false;
    await tx
      .update(userMcpCredentials)
      .set({ validationStatus: input.status, validatedAt: Date.now() })
      .where(and(eq(userMcpCredentials.userId, identity.id), eq(userMcpCredentials.serverName, server.name)));
    return true;
  });
}
