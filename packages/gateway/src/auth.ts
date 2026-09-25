import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env, getServerConfig, refreshServerConfigs } from './config.js';

export const JWKS = createRemoteJWKSet(new URL(env.authJwksUrl));

declare module 'fastify' {
  interface FastifyRequest {
    mcpAuth?: JWTPayload;
  }
}

const RESOURCE_BASE = env.resourceBaseUrl.replace(/\/+$/, "");
// RFC 8707: clients send the gateway URL as `resource`; the auth server uses
// it as the JWT audience. Accept both it (with/without trailing slash) and
// the plain configured audience. A server-specific resource URL is accepted
// only on that server's route.
const BASE_AUDIENCES = [env.jwtAudience, RESOURCE_BASE, RESOURCE_BASE + '/'];

function routeServerName(req: FastifyRequest): string | undefined {
  const match = req.url.split('?')[0].match(/^\/mcp\/([^/]+)/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function resourceMetadataUrl(serverName?: string): string {
  return serverName
    ? `${RESOURCE_BASE}/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(serverName)}`
    : `${RESOURCE_BASE}/.well-known/oauth-protected-resource`;
}

export function unauthorized(reply: FastifyReply, code: string, description: string, serverName?: string): FastifyReply {
  return reply.code(401)
    .header('WWW-Authenticate', `Bearer realm="mcp-gateway", resource_metadata="${resourceMetadataUrl(serverName)}", error="${code}"`)
    .send({ error: code, error_description: description });
}

export function hasServerAccess(payload: JWTPayload | undefined, serverName: string): boolean {
  if (!payload) return false;
  if (payload.role === 'admin') return true;
  const allowed = payload.mcp_servers;
  return Array.isArray(allowed) && allowed.every((name) => typeof name === 'string') && (allowed.includes('*') || allowed.includes(serverName));
}

export function forbidden(reply: FastifyReply, serverName: string): FastifyReply {
  return reply
    .code(403)
    .header(
      'WWW-Authenticate',
      `Bearer realm="mcp-gateway", resource_metadata="${resourceMetadataUrl(serverName)}", error="insufficient_scope"`,
    )
    .send({ error: 'server_access_denied', server: serverName });
}

/**
 * Validates `Authorization: Bearer <JWT>` on all /mcp/* routes.
 * Signature check is local (JWKS cached by jose); no introspection round-trip.
 */
export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = req.url.split('?')[0];
  if (!path.startsWith('/mcp') && path !== '/servers') return;

  const serverName = routeServerName(req);

  // Resolve the logical server before starting OAuth. Challenging for a route
  // that does not exist makes OAuth-capable clients authenticate successfully,
  // retry the same missing route, and enter an authorization loop.
  if (serverName) {
    let server = getServerConfig(serverName);
    if (!server) {
      await refreshServerConfigs().catch(() => undefined);
      server = getServerConfig(serverName);
    }
    if (!server) {
      await reply.code(404).send({ error: 'server_not_found', server: serverName });
      return;
    }
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    await unauthorized(reply, 'missing_token', 'Authorization header with Bearer token is required', serverName);
    return reply;
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const serverResource = serverName ? `${RESOURCE_BASE}/mcp/${encodeURIComponent(serverName)}` : undefined;
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.authIssuer,
      audience: serverResource ? [...BASE_AUDIENCES, serverResource, `${serverResource}/`] : BASE_AUDIENCES,
    });
    req.mcpAuth = payload;
  } catch (err) {
    await unauthorized(reply, 'invalid_token', err instanceof Error ? err.message : 'token validation failed', serverName);
  }
}
