/** OAuth client registry backed by PostgreSQL + RFC 7591 Dynamic Client Registration. */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../infrastructure/database/client.js';
import { clients } from '../../infrastructure/database/schema.js';
import { isValidRedirectUri } from './redirect.js';

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_basic' | 'client_secret_post';
  client_id_issued_at: number;
}

function rowToClient(row: typeof clients.$inferSelect): OAuthClient {
  return {
    client_id: row.clientId,
    client_name: row.clientName ?? undefined,
    redirect_uris: row.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(row.createdAt / 1000),
  };
}

export async function getClient(clientId: string): Promise<OAuthClient | undefined> {
  const [row] = await db.select().from(clients).where(eq(clients.clientId, clientId)).limit(1);
  return row ? rowToClient(row) : undefined;
}

export function isRedirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

/** RFC 7591 dynamic client registration (public clients only, for the skeleton). */
export async function registerClient(
  body: unknown,
): Promise<{ ok: true; client: OAuthClient } | { ok: false; error: string }> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'invalid_client_metadata' };
  const { redirect_uris, client_name, token_endpoint_auth_method } = body as Record<string, unknown>;
  if (
    !Array.isArray(redirect_uris) ||
    redirect_uris.length === 0 ||
    redirect_uris.length > 10 ||
    new Set(redirect_uris).size !== redirect_uris.length ||
    !redirect_uris.every((u) => typeof u === 'string' && isValidRedirectUri(u))
  ) {
    return { ok: false, error: 'invalid_redirect_uri' };
  }
  const method = token_endpoint_auth_method ?? 'none';
  if (method !== 'none') {
    return { ok: false, error: 'invalid_client_metadata: only public clients ("none") are supported in the skeleton' };
  }

  const client: OAuthClient = {
    client_id: `mcp-${randomUUID()}`,
    client_name: typeof client_name === 'string' ? client_name : undefined,
    redirect_uris: redirect_uris as string[],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  await db.insert(clients).values({
    clientId: client.client_id,
    clientName: client.client_name ?? null,
    redirectUris: client.redirect_uris,
    createdAt: Date.now(),
  });
  return { ok: true, client };
}
