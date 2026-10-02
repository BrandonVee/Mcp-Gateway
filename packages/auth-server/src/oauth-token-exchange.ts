import { decryptCredential } from './credential-crypto.js';
import type { mcpServers } from './schema.js';

type OAuthServer = Pick<typeof mcpServers.$inferSelect, 'oauthTokenUrl' | 'oauthClientId' | 'oauthClientSecret' | 'oauthClientAuthMethod' | 'oauthResource'>;
export type OAuthTokenBody = Record<string, unknown> & { access_token: string };

export class OAuthTokenError extends Error {
  constructor(readonly permanent: boolean, message: string) {
    super(message);
    this.name = 'OAuthTokenError';
  }
}

/** Preserve rotating refresh tokens unless the provider explicitly rejects the grant. */
export async function exchangeOAuthToken(server: OAuthServer, params: URLSearchParams, request: typeof fetch = fetch): Promise<OAuthTokenBody> {
  if (!server.oauthTokenUrl || !server.oauthClientId) throw new OAuthTokenError(false, 'OAuth token endpoint is not configured');
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (server.oauthResource) params.set('resource', server.oauthResource);
  if (server.oauthClientAuthMethod === 'client_secret_basic' && server.oauthClientSecret) {
    const secret = decryptCredential(server.oauthClientSecret);
    const encode = (value: string) => new URLSearchParams({ value }).toString().slice('value='.length);
    headers.authorization = `Basic ${Buffer.from(`${encode(server.oauthClientId)}:${encode(secret)}`).toString('base64')}`;
  } else {
    params.set('client_id', server.oauthClientId);
    if (server.oauthClientAuthMethod === 'client_secret_post' && server.oauthClientSecret) params.set('client_secret', decryptCredential(server.oauthClientSecret));
  }
  let response: Response;
  try {
    response = await request(server.oauthTokenUrl, { method: 'POST', headers, body: params, signal: AbortSignal.timeout(8_000), redirect: 'error' });
  } catch {
    throw new OAuthTokenError(false, 'OAuth token endpoint is temporarily unavailable');
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const temporary = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new OAuthTokenError(!temporary && body?.error === 'invalid_grant', `OAuth token endpoint HTTP ${response.status}`);
  }
  if (!body || typeof body.access_token !== 'string' || !body.access_token || /[\x00-\x1f\x7f]/.test(body.access_token)
    || (body.token_type !== undefined && String(body.token_type).toLowerCase() !== 'bearer')) {
    throw new OAuthTokenError(false, 'OAuth token endpoint returned an invalid token');
  }
  tokenExpiry(body); // A malformed expiry must not turn an expiring token into an unlimited one.
  return body as OAuthTokenBody;
}

export function tokenExpiry(body: Record<string, unknown>, now = Date.now()): number | null {
  if (body.expires_in === undefined) return null;
  if ((typeof body.expires_in !== 'number' && typeof body.expires_in !== 'string')
    || body.expires_in === '' || !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) < 0) {
    throw new OAuthTokenError(false, 'OAuth token endpoint returned an invalid expiry');
  }
  const expiresAt = now + Number(body.expires_in) * 1000;
  if (!Number.isSafeInteger(Math.floor(expiresAt))) throw new OAuthTokenError(false, 'OAuth token expiry is out of range');
  return Math.floor(expiresAt);
}

export function accessTokenValid(expiresAt: number | null, now = Date.now()): boolean {
  return expiresAt === null || expiresAt > now;
}

export function shouldRefresh(expiresAt: number | null, hasRefresh: boolean, now = Date.now()): boolean {
  return hasRefresh && expiresAt !== null && expiresAt <= now + 60_000;
}
