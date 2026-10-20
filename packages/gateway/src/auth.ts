import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { gatewayApiKeyPattern, gatewayIdentitySchema } from '@/shared/security/gateway-access.js';
import { resolveClientIp } from '@/shared/security/client-ip.js';
import { env, getServerConfig, refreshServerConfigs, serverConfigs } from '@/gateway/config.js';

export const JWKS = createRemoteJWKSet(new URL(env.authJwksUrl));

declare module 'fastify' {
  interface FastifyRequest {
    mcpAuth?: JWTPayload;
    mcpAccessMode?: 'none' | 'api_key' | 'oauth';
    mcpAnonymousId?: string;
  }
}

const resourceBase = () => env.resourceBaseUrl.replace(/\/+$/, '');
// RFC 8707: clients send the gateway URL as `resource`; the auth server uses
// it as the JWT audience. Accept both it (with/without trailing slash) and
// the plain configured audience. A server-specific resource URL is accepted
// only on that server's route.
const baseAudiences = () => [env.jwtAudience, resourceBase(), resourceBase() + '/'];

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
    ? `${resourceBase()}/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(serverName)}`
    : `${resourceBase()}/.well-known/oauth-protected-resource`;
}

export function unauthorized(
  reply: FastifyReply,
  code: string,
  description: string,
  serverName?: string,
): FastifyReply {
  return reply
    .code(401)
    .header(
      'WWW-Authenticate',
      `Bearer realm="mcp-gateway", resource_metadata="${resourceMetadataUrl(serverName)}", error="${code}"`,
    )
    .send({ error: code, error_description: description });
}

export function hasServerAccess(payload: JWTPayload | undefined, serverName: string): boolean {
  if (!payload) return false;
  if (payload.role === 'admin') return true;
  const allowed = payload.mcp_servers;
  return (
    Array.isArray(allowed) &&
    allowed.every((name) => typeof name === 'string') &&
    (allowed.includes('*') || allowed.includes(serverName))
  );
}

/** Tokens issued before credential revisions were introduced belong to revision zero. */
export function tokenAuthVersion(payload: JWTPayload | undefined): number | null {
  const version = payload?.auth_version;
  if (version === undefined) return 0;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : null;
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

/** Anonymous sessions and configured limits are isolated by the connecting IP. */
export function accessIdentity(req: FastifyRequest): string {
  return req.mcpAccessMode === 'none' ? `anonymous:${req.mcpAnonymousId}` : String(req.mcpAuth?.uid ?? '');
}

function anonymous(req: FastifyRequest, servers: string[]) {
  req.mcpAccessMode = 'none';
  const forwarded = req.headers['x-forwarded-for'];
  const ip = resolveClientIp(
    req.ip,
    typeof forwarded === 'string' ? forwarded : undefined,
    process.env.AUTH_TRUSTED_PROXY_IPS ?? '',
  );
  req.mcpAnonymousId = createHash('sha256').update(ip).digest('hex');
  req.mcpAuth = { uid: 0, sub: 'anonymous', role: 'anonymous', auth_version: 0, mcp_servers: servers };
}

function keyRequired(reply: FastifyReply, code = 'api_key_required') {
  return reply
    .code(401)
    .header('WWW-Authenticate', `Bearer realm="mcp-gateway", error="${code}"`)
    .send({ error: code });
}

/**
 * Gateway access policy is independent from upstream authentication.
 * OAuth stays the default; user API keys are checked live and public routes have no account.
 */
export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = req.url.split('?')[0];
  if (!path.startsWith('/mcp') && path !== '/servers') return;

  const serverName = routeServerName(req);
  let accessMode: 'none' | 'api_key' | 'oauth' | undefined;

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
    accessMode = server.accessAuthMode ?? 'oauth';
    if (accessMode === 'none') {
      anonymous(req, [serverName]);
      return;
    }
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    if (!serverName && !header) {
      const publicNames = [...serverConfigs.values()]
        .filter((server) => server.accessAuthMode === 'none')
        .map((server) => server.name);
      if (publicNames.length) {
        anonymous(req, publicNames);
        return;
      }
    }
    if (accessMode === 'api_key') {
      await keyRequired(reply);
      return;
    }
    await unauthorized(reply, 'missing_token', 'Authorization header with Bearer token is required', serverName);
    return reply;
  }
  const token = header.slice('Bearer '.length).trim();
  if (accessMode === 'api_key' || (!serverName && gatewayApiKeyPattern.test(token))) {
    if (!gatewayApiKeyPattern.test(token)) {
      await keyRequired(reply, 'invalid_api_key');
      return;
    }
    try {
      const result = await fetch(env.apiKeyAuthUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.internalApiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ key: token, ...(serverName ? { server: serverName } : {}) }),
        signal: AbortSignal.timeout(5000),
      });
      if (result.status === 401) {
        await keyRequired(reply, 'invalid_api_key');
        return;
      }
      if (result.status === 403) {
        await reply.code(403).send({ error: 'server_access_denied', server: serverName });
        return;
      }
      if (!result.ok) throw new Error('key validation unavailable');
      const parsed = gatewayIdentitySchema.safeParse(((await result.json()) as { payload?: unknown }).payload);
      if (!parsed.success) throw new Error('invalid key identity');
      req.mcpAuth = parsed.data;
      req.mcpAccessMode = 'api_key';
    } catch {
      await reply.code(503).send({ error: 'authentication_service_unavailable' });
    }
    return;
  }
  try {
    const serverResource = serverName ? `${resourceBase()}/mcp/${encodeURIComponent(serverName)}` : undefined;
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.authIssuer,
      audience: serverResource ? [...baseAudiences(), serverResource, `${serverResource}/`] : baseAudiences(),
    });
    if (tokenAuthVersion(payload) === null) throw new Error('invalid auth_version claim');
    req.mcpAuth = payload;
    req.mcpAccessMode = 'oauth';
  } catch (err) {
    await unauthorized(
      reply,
      'invalid_token',
      err instanceof Error ? err.message : 'token validation failed',
      serverName,
    );
  }
}
