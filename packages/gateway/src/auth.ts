import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './config.js';

export const JWKS = createRemoteJWKSet(new URL(env.authJwksUrl));

declare module 'fastify' {
  interface FastifyRequest {
    mcpAuth?: JWTPayload;
  }
}

const RESOURCE_BASE = env.resourceBaseUrl.replace(/\/+$/, "");
const RESOURCE_METADATA_URL = `${RESOURCE_BASE}/.well-known/oauth-protected-resource`;
// RFC 8707: clients send the gateway URL as `resource`; the auth server uses
// it as the JWT audience. Accept both it (with/without trailing slash) and
// the plain configured audience.
const ACCEPTED_AUDIENCES = [env.jwtAudience, RESOURCE_BASE, RESOURCE_BASE + "/"];

export function unauthorized(reply: FastifyReply, code: string, description: string): FastifyReply {
  return reply.code(401)
    .header('WWW-Authenticate', `Bearer realm="mcp-gateway", resource_metadata="${RESOURCE_METADATA_URL}", error="${code}"`)
    .send({ error: code, error_description: description });
}

/**
 * Validates `Authorization: Bearer <JWT>` on all /mcp/* routes.
 * Signature check is local (JWKS cached by jose); no introspection round-trip.
 */
export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = req.url.split('?')[0];
  if (!path.startsWith('/mcp')) return; // only guard MCP proxy routes

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    await unauthorized(reply, 'missing_token', 'Authorization header with Bearer token is required');
    return reply;
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.authIssuer,
      audience: ACCEPTED_AUDIENCES,
    });
    req.mcpAuth = payload;
  } catch (err) {
    await unauthorized(reply, 'invalid_token', err instanceof Error ? err.message : 'token validation failed');
  }
}
