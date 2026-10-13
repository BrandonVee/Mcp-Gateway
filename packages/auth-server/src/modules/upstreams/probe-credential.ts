import type { UpstreamTestAuthInput, UpstreamTestCredential } from '@mcp/shared';
import { upstreamTestCredentialSchema } from '@mcp/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '@/auth/infrastructure/database/client.js';
import { mcpServerInstances, upstreamCredentials, users } from '@/auth/infrastructure/database/schema.js';
import { decryptCredential } from '@/auth/infrastructure/security/credential-crypto.js';
import { isValidApiKey } from '@/shared/security/credentials.js';
import { ownerFor } from '@/auth/modules/upstreams/connection-service.js';
import { accessTokenValid } from '@/auth/modules/upstreams/token-exchange.js';

type ProbeCredentialResult =
  | { credential: UpstreamTestCredential | null }
  | {
      error: 'invalid_api_key' | 'invalid_probe_credentials' | 'connection_required';
    };

/**
 * Resolve only the draft probe's headers. URL/header/key overrides are ephemeral.
 * Blank secret fields retain saved secrets; probes never save configuration or refresh stored tokens.
 */
export async function resolveProbeCredential(
  input: UpstreamTestAuthInput,
  actor: string,
): Promise<ProbeCredentialResult> {
  if (input.auth_mode === 'none') return { credential: null };
  if (input.system_api_key !== undefined && input.auth_mode !== 'system_api_key')
    return { error: 'invalid_probe_credentials' };
  if (input.auth_mode === 'system_api_key' && input.system_api_key !== undefined) {
    if (!isValidApiKey(input.system_api_key)) return { error: 'invalid_api_key' };
    const credential = upstreamTestCredentialSchema.safeParse({
      header: input.api_key_header ?? 'authorization',
      value: (input.api_key_prefix ?? 'Bearer ') + input.system_api_key,
    });
    return credential.success ? { credential: credential.data } : { error: 'invalid_probe_credentials' };
  }
  if (!input.instance_id) return input.auth_mode ? { error: 'connection_required' } : { credential: null };
  const [upstream] = await db.select().from(mcpServerInstances).where(eq(mcpServerInstances.id, input.instance_id));
  if (!upstream) return { error: 'connection_required' };
  if (input.auth_mode !== undefined && input.auth_mode !== upstream.authMode) return { error: 'connection_required' };
  if (upstream.authMode === 'none') return { credential: null };
  if (upstream.authMode === 'system_api_key') {
    if (!upstream.systemApiKey) return { error: 'connection_required' };
    const credential = upstreamTestCredentialSchema.safeParse({
      header: input.api_key_header ?? upstream.apiKeyHeader,
      value: (input.api_key_prefix ?? upstream.apiKeyPrefix) + decryptCredential(upstream.systemApiKey),
    });
    return credential.success ? { credential: credential.data } : { error: 'invalid_probe_credentials' };
  }
  const [admin] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, actor), eq(users.role, 'admin'), eq(users.disabled, false)));
  if (!admin) return { error: 'connection_required' };
  const owner = ownerFor(upstream.authMode === 'system_oauth', admin.id);
  const [connection] = await db
    .select()
    .from(upstreamCredentials)
    .where(and(eq(upstreamCredentials.instanceId, upstream.id), eq(upstreamCredentials.owner, owner)));
  const mode = upstream.authMode === 'api_key' ? 'api_key' : 'oauth';
  if (!connection || connection.mode !== mode || !accessTokenValid(connection.expiresAt))
    return { error: 'connection_required' };
  // A probe must not rotate refresh tokens or overwrite the production connection.
  const credential = upstreamTestCredentialSchema.safeParse({
    header: mode === 'api_key' ? (input.api_key_header ?? upstream.apiKeyHeader) : 'authorization',
    value:
      mode === 'api_key'
        ? (input.api_key_prefix ?? upstream.apiKeyPrefix) + decryptCredential(connection.secret)
        : `Bearer ${decryptCredential(connection.secret)}`,
  });
  return credential.success ? { credential: credential.data } : { error: 'invalid_probe_credentials' };
}
