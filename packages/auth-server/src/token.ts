import { createHash, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { Hono, type Context } from 'hono';
import type { SigningKeys } from './keys.js';
import { getClient } from './clients.js';
import { consumeAuthCode, consumeRefreshToken, saveRefreshToken } from './stores.js';
import { getUserAuthorization } from './db.js';

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
    const authorization = await getUserAuthorization(sub);
    if (!authorization || authorization.disabled) throw new Error('user is missing or disabled');
    const mcpServers = authorization.role === 'admin' ? ['*'] : authorization.servers;
    return new SignJWT({ scope, client_id: clientId, uid: authorization.id, role: authorization.role, mcp_servers: mcpServers })
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
      const entry = code ? await consumeAuthCode(code) : undefined;
      if (!entry) return jsonError(c, 'invalid_grant', 'authorization code is invalid or expired');
      if (entry.client_id !== client_id || !(await getClient(client_id))) return jsonError(c, 'invalid_grant', 'client_id mismatch');
      if (entry.redirect_uri !== redirect_uri) return jsonError(c, 'invalid_grant', 'redirect_uri mismatch');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier ?? '') || s256(code_verifier) !== entry.code_challenge) {
        return jsonError(c, 'invalid_grant', 'PKCE verification failed');
      }

      let accessToken: string;
      try {
        accessToken = await issueAccessToken(entry.sub, entry.scope, client_id, entry.resource);
      } catch {
        return jsonError(c, 'invalid_grant', 'user is missing or disabled');
      }
      const refresh = await saveRefreshToken({ client_id, scope: entry.scope, resource: entry.resource, sub: entry.sub });
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
      const entry = refresh_token ? await consumeRefreshToken(refresh_token) : undefined;
      if (!entry) return jsonError(c, 'invalid_grant', 'refresh token is invalid');
      if (entry.client_id !== client_id) return jsonError(c, 'invalid_grant', 'client_id mismatch');

      // Rotation: consumeRefreshToken atomically revokes the old token.
      let accessToken: string;
      try {
        accessToken = await issueAccessToken(entry.sub, entry.scope, client_id, entry.resource);
      } catch {
        return jsonError(c, 'invalid_grant', 'user is missing or disabled');
      }
      const refresh = await saveRefreshToken({ ...entry });
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
