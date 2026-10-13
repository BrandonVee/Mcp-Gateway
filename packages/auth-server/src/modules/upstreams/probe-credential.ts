import type { UpstreamTestAuthInput, UpstreamTestCredential } from '@mcp/shared';
import { upstreamTestCredentialSchema } from '@mcp/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../../infrastructure/database/client.js';
import { mcpServerInstances, users } from '../../infrastructure/database/schema.js';
import { decryptCredential } from '../../infrastructure/security/credential-crypto.js';
import { isValidApiKey } from '../../shared/security/credentials.js';
import { resolveUpstreamCredential } from './connection-service.js';

type ProbeCredentialResult =
  | { credential: UpstreamTestCredential | null }
  | {
      error: 'invalid_api_key' | 'invalid_probe_credentials' | 'connection_required' | 'upstream_changed_before_probe';
    };

/** Resolve draft system keys or the authenticated administrator's saved upstream connection. */
export async function resolveProbeCredential(
  input: UpstreamTestAuthInput,
  endpoint: string,
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
  if (!upstream || upstream.url !== endpoint) return { error: 'upstream_changed_before_probe' };
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
  const result = await resolveUpstreamCredential(
    upstream.id,
    { id: admin.id, authVersion: admin.authVersion, role: 'admin' },
    upstream.serverName,
    endpoint,
  );
  return 'credential' in result ? { credential: result.credential } : { error: 'connection_required' };
}
