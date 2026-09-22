import { createHash, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { Hono, type Context } from 'hono';
import type { SigningKeys } from './keys.js';
import { getClient } from './clients.js';
import { consumeAuthCode, consumeRefreshToken, deleteRefreshToken, saveRefreshToken } from './stores.js';
import { getUserRole } from './db.js';

export interface TokenRouteDeps {
  keys: SigningKeys;
  issuer: string;
  accessTokenTtlSeconds: number;
  defaultAudience: string;
}

export function createTokenRouter(deps: TokenRouteDeps): Hono {
  const router = new Hono();
  const { keys, issuer, defaultAudience } = deps;
  const ttl = Number.isFinite(deps.accessTokenTtlSeconds) && deps.accessTokenTtlSeconds > 0 ? deps.accessTokenTtlSeconds : 3600;

  async function issueAccessToken(sub: string, scope: string, clientId: string, resource?: string): Promise<string> {
    return new SignJWT({ scope, client_id: clientId, role: getUserRole(sub) })
      .setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(resource ?? defaultAudience)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
      .setJti(randomBytes(8).toString('hex'))
      .sign(keys.privateKey);
  }

  const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

  function jsonError(c: Context, error: string, description?: string) {
    return c.json({ error, ...(description ? { error_description: description } : {}) }, 400);
  }

  router.post('/token', async (c: Context) => {
    let params: Record<string, string>;
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json')) {
      params = await c.req.json().catch(() => ({}));
    } else {
      const body = await c.req.parseBody();
      params = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
    }

    const grantType = params.grant_type;
    if (grantType === 'authorization_code') {
      const { code, code_verifier, client_id, redirect_uri } = params;
      const entry = code ? consumeAuthCode(code) : undefined;
      if (!entry) return jsonError(c, 'invalid_grant', 'authorization code is invalid or expired');
      if (entry.client_id !== client_id || !getClient(client_id)) return jsonError(c, 'invalid_grant', 'client_id mismatch');
      if (entry.redirect_uri !== redirect_uri) return jsonError(c, 'invalid_grant', 'redirect_uri mismatch');
      if (!code_verifier || s256(code_verifier) !== entry.code_challenge) return jsonError(c, 'invalid_grant', 'PKCE verification failed');

      const accessToken = await issueAccessToken(entry.sub, entry.scope, client_id, entry.resource);
      const refresh = saveRefreshToken({ client_id, scope: entry.scope, resource: entry.resource, sub: entry.sub });
      return c.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ttl,
        refresh_token: refresh,
        scope: entry.scope,
      });
    }

    if (grantType === 'refresh_token') {
      const { refresh_token, client_id } = params;
      const entry = refresh_token ? consumeRefreshToken(refresh_token) : undefined;
      if (!entry) return jsonError(c, 'invalid_grant', 'refresh token is invalid');
      if (entry.client_id !== client_id) return jsonError(c, 'invalid_grant', 'client_id mismatch');

      // Rotation: refresh tokens are single-use.
      deleteRefreshToken(refresh_token!);
      const accessToken = await issueAccessToken(entry.sub, entry.scope, client_id, entry.resource);
      const refresh = saveRefreshToken({ ...entry });
      return c.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ttl,
        refresh_token: refresh,
        scope: entry.scope,
      });
    }

    return jsonError(c, 'unsupported_grant_type');
  });

  return router;
}
