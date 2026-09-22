/** OAuth client registry backed by SQLite + RFC 7591 Dynamic Client Registration. */
import { randomUUID } from 'node:crypto';
import { db } from './db.js';

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_basic' | 'client_secret_post';
  client_id_issued_at: number;
}

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string;
  created_at: number;
}

function rowToClient(row: ClientRow): OAuthClient {
  return {
    client_id: row.client_id,
    client_name: row.client_name ?? undefined,
    redirect_uris: JSON.parse(row.redirect_uris),
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(row.created_at / 1000),
  };
}

// Seed the demo public client so local clients work out of the box.
export function seedDemoClient(): void {
  const exists = db.prepare('SELECT 1 FROM clients WHERE client_id = ?').get('demo-client');
  if (exists) return;
  db.prepare('INSERT INTO clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(
    'demo-client',
    'Demo Public Client',
    JSON.stringify([
      'http://localhost:8080/callback',
      'http://127.0.0.1:8080/callback',
      'https://claude.ai/api/mcp/auth_callback',
    ]),
    Date.now(),
  );
}

export function getClient(clientId: string): OAuthClient | undefined {
  const row = db.prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId) as ClientRow | undefined;
  return row ? rowToClient(row) : undefined;
}

export function isRedirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    // Allow https everywhere and http only for loopback (native/dev clients).
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

/** RFC 7591 dynamic client registration (public clients only, for the skeleton). */
export function registerClient(body: unknown): { ok: true; client: OAuthClient } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'invalid_client_metadata' };
  const { redirect_uris, client_name, token_endpoint_auth_method } = body as Record<string, unknown>;
  if (
    !Array.isArray(redirect_uris) ||
    redirect_uris.length === 0 ||
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
  db.prepare('INSERT INTO clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(
    client.client_id,
    client.client_name ?? null,
    JSON.stringify(client.redirect_uris),
    Date.now(),
  );
  return { ok: true, client };
}
