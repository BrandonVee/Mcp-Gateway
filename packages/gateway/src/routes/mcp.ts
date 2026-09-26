import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request } from 'undici';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env, getServerConfig, refreshServerConfigs } from '../config.js';
import { pickInstance, bindSession, sessionOwnedBy } from '../lb.js';
import { forbidden, hasServerAccess } from '../auth.js';
import { filterRequestHeaders, filterResponseHeaders } from './headers.js';
import { reserveUpstreamSlot } from './capacity.js';
import { mcpCorsHeaders } from './origin.js';

export function registerMcpRoutes(app: FastifyInstance): void {
  app.all('/mcp/:serverName', proxyHandler);
  app.all('/mcp/:serverName/*', proxyHandler);
}

async function proxyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { serverName } = req.params as { serverName: string };
  let cfg = getServerConfig(serverName);
  if (!cfg) {
    await refreshServerConfigs().catch(() => undefined);
    cfg = getServerConfig(serverName);
  }
  if (!cfg) {
    await reply.code(404).send({ error: 'server_not_found', server: serverName });
    return;
  }
  if (!hasServerAccess(req.mcpAuth, serverName)) {
    await forbidden(reply, serverName);
    return;
  }

  const userId = req.mcpAuth?.uid;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
    await reply.code(401).send({ error: 'new_login_required' });
    return;
  }

  // Servers without upstream credentials still need a live access check;
  // otherwise an old JWT could outlive an admin's disable/revoke action.
  if (cfg.authMode === 'none') {
    try {
      const accessUrl = new URL(env.accessCheckUrl);
      accessUrl.searchParams.set('server', serverName);
      accessUrl.searchParams.set('user_id', String(userId));
      const result = await fetch(accessUrl, {
        headers: { authorization: `Bearer ${env.internalApiToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (result.status === 403) {
        await forbidden(reply, serverName);
        return;
      }
      if (!result.ok) throw new Error(`access check HTTP ${result.status}`);
    } catch (error) {
      req.log.error({ err: error, server: serverName }, 'access check failed');
      await reply.code(503).send({ error: 'access_service_unavailable' });
      return;
    }
  }

  let upstreamCredential: { header: string; value: string } | undefined;
  if (cfg.authMode !== 'none') {
    if (!env.credentialBrokerToken) {
      await reply.code(503).send({ error: 'credential_service_unavailable' });
      return;
    }
    try {
      const credentialUrl = new URL(env.credentialUrl);
      credentialUrl.searchParams.set('server', serverName);
      credentialUrl.searchParams.set('user_id', String(userId));
      const result = await fetch(credentialUrl, {
        headers: { authorization: `Bearer ${env.credentialBrokerToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (result.status === 409) {
        await reply.code(409).send({ error: 'connection_required', server: serverName, connect_url: env.connectionsWebUrl });
        return;
      }
      if (result.status === 403) {
        await forbidden(reply, serverName);
        return;
      }
      if (!result.ok) throw new Error(`credential broker HTTP ${result.status}`);
      const body = await result.json() as { header?: unknown; value?: unknown };
      if (typeof body.header !== 'string' || !/^(authorization|x-[a-z0-9-]{1,60})$/i.test(body.header)
        || typeof body.value !== 'string' || !body.value || /[\x00-\x1f\x7f]/.test(body.value)) {
        throw new Error('credential broker returned invalid header');
      }
      upstreamCredential = { header: body.header.toLowerCase(), value: body.value };
    } catch (error) {
      req.log.error({ err: error, server: serverName }, 'credential lookup failed');
      await reply.code(503).send({ error: 'credential_service_unavailable' });
      return;
    }
  }

  const incomingSessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
  const sessionOwner = String(req.mcpAuth?.uid ?? req.mcpAuth?.sub ?? '');
  if (incomingSessionId && !(await sessionOwnedBy(serverName, incomingSessionId, sessionOwner))) {
    await reply.code(404).send({ error: 'session_not_found' });
    return;
  }
  const hashSeed = incomingSessionId ? undefined : Buffer.from((req.body as Buffer | undefined) ?? `${serverName}:${Math.random()}`).toString('base64');
  const target = await pickInstance(cfg, incomingSessionId, hashSeed);

  // Build upstream headers: drop hop-by-hop + client-spoofable internal headers.
  const headers = filterRequestHeaders(req.headers);
  if (upstreamCredential) headers[upstreamCredential.header] = upstreamCredential.value;
  const upstreamUrl = new URL(target.url);
  const upstreamPort = upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? '443' : '80');
  const selfHosts = new Set(['localhost', '127.0.0.1', '::1', 'gateway']);
  if (selfHosts.has(upstreamUrl.hostname) && upstreamPort === String(env.port)) {
    await reply.code(502).send({
      error: 'invalid_upstream',
      server: serverName,
      error_description: 'The registered upstream endpoint points back to the Gateway',
    });
    return;
  }
  headers['host'] = upstreamUrl.host;
  headers['x-forwarded-for'] = req.ip;
  headers['x-forwarded-host'] = req.headers['host'] ?? '';
  headers['x-forwarded-proto'] = req.protocol;
  if (req.mcpAuth && cfg.authMode === 'none') {
    headers['x-mcp-user'] = String(req.mcpAuth.sub ?? '');
    headers['x-mcp-client-id'] = String(req.mcpAuth.client_id ?? '');
    headers['x-mcp-scope'] = String(req.mcpAuth.scope ?? '');
  }

  const releaseSlot = reserveUpstreamSlot();
  if (!releaseSlot) {
    await reply.code(503).header('Retry-After', '1').send({ error: 'upstream_capacity_exceeded' });
    return;
  }

  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const upstream = await request(upstreamUrl.toString(), {
      method: req.method as 'POST', // fastify gives the uppercase verb; widened by undici at runtime
      headers,
      body: hasBody ? (req.body as Buffer | undefined) : undefined,
      headersTimeout: 15_000,
      bodyTimeout: 0, // Streamable HTTP and SSE may keep the body open indefinitely.
    }).catch((error: unknown) => {
      req.log.warn({ error: error instanceof Error ? error.name : 'UnknownError', server: serverName }, 'upstream request failed');
      return null;
    });
    if (!upstream) {
      await reply.code(502).send({ error: 'upstream_unavailable', server: serverName });
      return;
    }

    if (cfg.authMode !== 'none' && (upstream.statusCode === 401 || upstream.statusCode === 403)) {
      await upstream.body.dump();
      await reply.code(409).send({ error: 'upstream_credential_rejected', server: serverName, connect_url: env.connectionsWebUrl });
      return;
    }

    // Session affinity: bind the MCP session id (from initialize response) to
    // the instance that created it. Re-bind on every request to refresh TTL.
    const sessionId = upstream.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && sessionId) {
      await bindSession(cfg.name, sessionId, target.url, sessionOwner);
    }

    const resHeaders = { ...filterResponseHeaders(upstream.headers), ...mcpCorsHeaders(req.headers.origin, env.resourceBaseUrl) };

    // Hand the raw response over so we can stream (SSE-safe).
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(upstream.statusCode, resHeaders);

    if (!upstream.body || req.method === 'HEAD') {
      raw.end();
      return;
    }
    try {
      await pipeline(upstream.body, raw); // undici body is already a Node Readable
    } catch (err) {
      // Client aborted or upstream died mid-stream; nothing sensible to send now.
      req.log.warn({ err }, 'upstream stream ended abnormally');
      raw.destroy();
    }
  } finally {
    releaseSlot();
  }
}
