import { Hono, type Context } from 'hono';
import { SignJWT } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { getUserAuthorization, withAuthenticatedUser } from '../identity/authentication.js';
import { getClient } from './clients.js';
import type { SigningKeys } from './keys.js';
import { consumeAuthCode, consumeRefreshToken, saveRefreshToken, type RefreshTokenEntry } from './stores.js';

export interface TokenRouteDeps {
  keys: SigningKeys;
  issuer: string;
  accessTokenTtlSeconds: number;
  defaultAudience: string;
}

/** OAuth token endpoint: authorization_code (PKCE) and rotating refresh_token grants. */
export function createTokenRouter(deps: TokenRouteDeps): Hono {
  const router = new Hono();
  const { keys, defaultAudience } = deps;
  // An access token must always expire, even when configuration omits the TTL.
  const ttl =
    Number.isFinite(deps.accessTokenTtlSeconds) && deps.accessTokenTtlSeconds > 0 ? deps.accessTokenTtlSeconds : 3600;

  /**
   * Mint the access token and rotate the refresh token inside one transaction so
   * a user disabled mid-flight cannot end up with a usable new pair.
   */
  async function issueTokens(entry: RefreshTokenEntry) {
    return withAuthenticatedUser(entry, async (tx) => {
      const authorization = await getUserAuthorization(entry.userId, tx);
      if (!authorization || authorization.disabled) throw new Error('user is missing or disabled');
      // '*' authorizes administrators for every server without a grant row.
      const mcpServers = authorization.role === 'admin' ? ['*'] : authorization.servers;
      // Claims are the only thing the Gateway and the admin API see: mcp_servers
      // scopes the token to granted servers, and auth_version lets both reject
      // tokens minted before an administrator revoked the user's authentication.
      const accessToken = await new SignJWT({
        scope: entry.scope,
        client_id: entry.client_id,
        uid: authorization.id,
        auth_version: authorization.authVersion,
        role: authorization.role,
        mcp_servers: mcpServers,
      })
        .setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' })
        .setIssuer(deps.issuer)
        .setAudience(entry.resource ?? defaultAudience)
        .setSubject(authorization.username)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
        .setJti(randomBytes(8).toString('hex'))
        .sign(keys.privateKey);
      const refresh = await saveRefreshToken(entry, tx);
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ttl,
        refresh_token: refresh,
        scope: entry.scope,
      };
    });
  }

  /** PKCE S256: the verifier is hashed, never compared in plaintext. */
  const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

  function jsonError(c: Context, error: string, description?: string) {
    return c.json({ error, ...(description ? { error_description: description } : {}) }, 400);
  }

  router.post('/token', async (c: Context) => {
    // RFC 6749 allows both encodings; clients disagree on which one they send.
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
      if (entry.client_id !== client_id || !(await getClient(client_id)))
        return jsonError(c, 'invalid_grant', 'client_id mismatch');
      if (entry.redirect_uri !== redirect_uri) return jsonError(c, 'invalid_grant', 'redirect_uri mismatch');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier ?? '') || s256(code_verifier) !== entry.code_challenge) {
        return jsonError(c, 'invalid_grant', 'PKCE verification failed');
      }

      try {
        return c.json(await issueTokens(entry));
      } catch {
        return jsonError(c, 'invalid_grant', 'user is missing or disabled');
      }
    }

    if (grantType === 'refresh_token') {
      const { refresh_token, client_id } = params;
      const entry = refresh_token ? await consumeRefreshToken(refresh_token) : undefined;
      if (!entry) return jsonError(c, 'invalid_grant', 'refresh token is invalid');
      if (entry.client_id !== client_id) return jsonError(c, 'invalid_grant', 'client_id mismatch');

      // Rotation: consumeRefreshToken atomically revokes the old token.
      try {
        return c.json(await issueTokens(entry));
      } catch {
        return jsonError(c, 'invalid_grant', 'user is missing or disabled');
      }
    }

    return jsonError(c, 'unsupported_grant_type');
  });

  return router;
}
