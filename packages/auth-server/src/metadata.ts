import { Hono } from 'hono';
import type { SigningKeys } from './keys.js';
import { registerClient } from './clients.js';

/** OAuth 2.0 Authorization Server Metadata (RFC 8414) + JWKS + DCR (RFC 7591). */
export function createMetadataRouter(keys: SigningKeys, issuer: string): Hono {
  const router = new Hono();

  const serverMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    jwks_uri: `${issuer}/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: false,
    scopes_supported: ['mcp', 'openid'],
  };

  // RFC 8414 discovery path + common alias.
  router.get('/.well-known/oauth-authorization-server', (c) => c.json(serverMetadata));
  router.get('/.well-known/openid-configuration', (c) => c.json(serverMetadata));

  router.get('/jwks.json', (c) => c.json({ keys: [keys.publicJwk] }));

  router.post('/register', async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const result = registerClient(body);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.client, 201);
  });

  return router;
}
