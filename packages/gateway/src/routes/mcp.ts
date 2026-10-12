import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request } from 'undici';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env, getServerConfig, refreshServerConfigs } from '../config.js';
import { pickInstance, bindSession, touchSession, removeSession, sessionOwnedBy } from '../lb.js';
import { forbidden, hasServerAccess, tokenAuthVersion, unauthorized } from '../auth.js';
import { filterRequestHeaders, filterResponseHeaders } from './headers.js';
import { reserveUpstreamSlot } from './capacity.js';
import { mcpCorsHeaders } from './origin.js';
import { isRetryableInitialize, orderedAvailableInstances, upstreamHealth } from '../upstream-health.js';

export function registerMcpRoutes(app: FastifyInstance): void {
  app.all('/mcp/:serverName', proxyHandler);
  app.all('/mcp/:serverName/*', proxyHandler);
}

async function proxyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  req.monitoring?.parse();
  try {
    await proxyRequest(req, reply);
  } finally {
    req.monitoring?.finish(reply.raw.statusCode, reply.raw.destroyed && !reply.raw.writableFinished);
  }
}

/**
 * One MCP request: authorize, then resolve the target instance, then proxy.
 * Sessions are pinned to an instance (see lb.ts), so a request carrying a session
 * id can only be retried on the instance that already owns it.
 */
async function proxyRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
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
  const authVersion = tokenAuthVersion(req.mcpAuth);
  if (authVersion === null) {
    await unauthorized(reply, 'invalid_token', 'invalid auth_version claim', serverName);
    return;
  }

  // Servers without upstream credentials still need a live access check;
  // otherwise an old JWT could outlive an admin's disable/revoke action.
  if (cfg.authMode === 'none') {
    try {
      const accessUrl = new URL(env.accessCheckUrl);
      accessUrl.searchParams.set('server', serverName);
      accessUrl.searchParams.set('user_id', String(userId));
      accessUrl.searchParams.set('auth_version', String(authVersion));
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
      credentialUrl.searchParams.set('auth_version', String(authVersion));
      const result = await fetch(credentialUrl, {
        headers: { authorization: `Bearer ${env.credentialBrokerToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (result.status === 409) {
        if (cfg.authMode === 'system_api_key') {
          await reply.code(503).send({ error: 'system_credential_unavailable', server: serverName });
          return;
        }
        await reply
          .code(409)
          .send({ error: 'connection_required', server: serverName, connect_url: env.connectionsWebUrl });
        return;
      }
      if (result.status === 403) {
        await forbidden(reply, serverName);
        return;
      }
      if (!result.ok) throw new Error(`credential broker HTTP ${result.status}`);
      const body = (await result.json()) as { header?: unknown; value?: unknown };
      if (
        typeof body.header !== 'string' ||
        !/^(authorization|x-[a-z0-9-]{1,60})$/i.test(body.header) ||
        typeof body.value !== 'string' ||
        !body.value ||
        /[\x00-\x1f\x7f]/.test(body.value)
      ) {
        throw new Error('credential broker returned invalid header');
      }
      upstreamCredential = { header: body.header.toLowerCase(), value: body.value };
    } catch (error) {
      req.log.error({ err: error, server: serverName }, 'credential lookup failed');
      await reply.code(503).send({ error: 'credential_service_unavailable' });
      return;
    }
  }

  const incomingSessionId =
    typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
  const sessionOwner = String(req.mcpAuth?.uid ?? req.mcpAuth?.sub ?? '');
  if (incomingSessionId && !(await sessionOwnedBy(serverName, incomingSessionId, sessionOwner))) {
    await reply.code(404).send({ error: 'session_not_found' });
    return;
  }
  // New sessions are hashed to an instance. Without a body (GET/SSE handshake)
  // every replica must still agree on the instance, so the seed stays random per
  // request rather than derived from nothing.
  const hashSeed = incomingSessionId
    ? undefined
    : Buffer.from((req.body as Buffer | undefined) ?? `${serverName}:${Math.random()}`).toString('base64');
  const target = await pickInstance(cfg, incomingSessionId, hashSeed);
  if (incomingSessionId && !target.sticky) {
    await reply.code(404).send({ error: 'session_not_found' });
    return;
  }
  if (incomingSessionId && !(await touchSession(serverName, incomingSessionId, sessionOwner))) {
    await reply.code(404).send({ error: 'session_not_found' });
    return;
  }
  const candidates = incomingSessionId
    ? [target.url] // Existing sessions cannot move; still try their bound instance.
    : orderedAvailableInstances(cfg.instances, target.index);
  if (!candidates.length) {
    await reply.code(503).header('Retry-After', '1').send({ error: 'upstream_unavailable', server: serverName });
    return;
  }
  const retryInitialize = isRetryableInitialize(req.method, incomingSessionId, req.body);
  const attempts = retryInitialize ? candidates : candidates.slice(0, 1);

  // Build upstream headers: drop hop-by-hop + client-spoofable internal headers.
  const baseHeaders = filterRequestHeaders(req.headers);
  if (upstreamCredential) baseHeaders[upstreamCredential.header] = upstreamCredential.value;
  baseHeaders['x-forwarded-for'] = req.ip;
  baseHeaders['x-forwarded-host'] = req.headers['host'] ?? '';
  baseHeaders['x-forwarded-proto'] = req.protocol;
  if (req.mcpAuth && cfg.authMode === 'none') {
    baseHeaders['x-mcp-user'] = String(req.mcpAuth.sub ?? '');
    baseHeaders['x-mcp-client-id'] = String(req.mcpAuth.client_id ?? '');
    baseHeaders['x-mcp-scope'] = String(req.mcpAuth.scope ?? '');
  }

  const releaseSlot = reserveUpstreamSlot();
  if (!releaseSlot) {
    await reply.code(503).header('Retry-After', '1').send({ error: 'upstream_capacity_exceeded' });
    return;
  }

  let stopSessionRenewal: (() => void) | undefined;
  // Sessions expire on a TTL, so a long-lived SSE or streamable HTTP response has
  // to renew its own binding while the client keeps it open.
  const renewWhileActive = (sessionId: string): void => {
    stopSessionRenewal?.();
    if (reply.raw.destroyed) return;
    let renewing = false;
    const timer = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        void touchSession(serverName, sessionId, sessionOwner)
          .then((renewed) => {
            if (!renewed) clearInterval(timer);
          })
          .catch((error) => {
            req.log.warn({ err: error, server: serverName }, 'active session renewal failed');
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(250, Math.min(30_000, (env.sessionTtlSeconds * 1000) / 3)),
    );
    timer.unref();
    stopSessionRenewal = () => clearInterval(timer);
  };
  reply.raw.once('close', () => stopSessionRenewal?.());

  try {
    if (incomingSessionId) renewWhileActive(incomingSessionId);
    for (const targetUrl of attempts) {
      req.monitoring?.target(targetUrl);
      const upstreamUrl = new URL(targetUrl);
      const upstreamPort = upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? '443' : '80');
      const selfHosts = new Set(['localhost', '127.0.0.1', '::1', 'gateway']);
      if (selfHosts.has(upstreamUrl.hostname.replace(/^\[|\]$/g, '')) && upstreamPort === String(env.port)) {
        upstreamHealth.recordFailure(targetUrl, 'http');
        continue;
      }
      const headers = { ...baseHeaders, host: upstreamUrl.host };
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const upstream = await request(upstreamUrl.toString(), {
        method: req.method as 'POST', // fastify gives the uppercase verb; widened by undici at runtime
        headers,
        body: hasBody ? (req.body as Buffer | undefined) : undefined,
        headersTimeout: 15_000,
        bodyTimeout: 0, // Streamable HTTP and SSE may keep the body open indefinitely.
      }).catch((error: unknown) => {
        if (req.monitoring) req.monitoring.error = 'upstream_transport_error';
        upstreamHealth.recordFailure(targetUrl, 'transport');
        req.log.warn(
          { error: error instanceof Error ? error.name : 'UnknownError', server: serverName },
          'upstream request failed',
        );
        return null;
      });
      if (!upstream) continue;

      if (upstream.statusCode === 502 || upstream.statusCode === 503 || upstream.statusCode === 504) {
        upstreamHealth.recordFailure(targetUrl, 'http');
        if (retryInitialize) {
          await upstream.body.dump().catch(() => undefined);
          continue;
        }
      } else {
        upstreamHealth.recordSuccess(targetUrl);
      }

      if (cfg.authMode !== 'none' && (upstream.statusCode === 401 || upstream.statusCode === 403)) {
        await upstream.body.dump();
        if (cfg.authMode === 'system_api_key') {
          await reply.code(503).send({ error: 'system_credential_rejected', server: serverName });
          return;
        }
        await reply
          .code(409)
          .send({ error: 'upstream_credential_rejected', server: serverName, connect_url: env.connectionsWebUrl });
        return;
      }

      // A successful DELETE or upstream 404 ends the session. Otherwise renew
      // the verified incoming ID even when subsequent responses do not echo it.
      const sessionEnded =
        incomingSessionId &&
        (upstream.statusCode === 404 ||
          (req.method === 'DELETE' && upstream.statusCode >= 200 && upstream.statusCode < 300));
      const sessionId = upstream.headers['mcp-session-id'];
      try {
        if (sessionEnded) {
          stopSessionRenewal?.();
          await removeSession(serverName, incomingSessionId, sessionOwner);
        } else if (
          !incomingSessionId &&
          typeof sessionId === 'string' &&
          sessionId &&
          upstream.statusCode >= 200 &&
          upstream.statusCode < 300
        ) {
          await bindSession(cfg.name, sessionId, targetUrl, sessionOwner);
          renewWhileActive(sessionId);
        }
      } catch (error) {
        upstream.body.destroy();
        throw error;
      }

      const resHeaders = {
        ...filterResponseHeaders(upstream.headers),
        ...mcpCorsHeaders(req.headers.origin, env.resourceBaseUrl),
      };
      if (req.monitoring) {
        req.monitoring.status = upstream.statusCode;
        req.monitoring.error = '';
      }

      // Hand the raw response over so we can stream (SSE-safe).
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(upstream.statusCode, resHeaders);

      if (!upstream.body || req.method === 'HEAD') {
        raw.end();
        return;
      }
      try {
        const observer = req.monitoring?.observer(String(upstream.headers['content-type'] || ''));
        if (observer) {
          upstream.body.on('data', (chunk) => observer.write(Buffer.from(chunk)));
          upstream.body.once('end', () => observer.end());
        }
        await pipeline(upstream.body, raw); // undici body is already a Node Readable
      } catch (err) {
        // Client aborted or upstream died mid-stream; nothing sensible to send now.
        req.log.warn({ err }, 'upstream stream ended abnormally');
        raw.destroy();
      }
      return;
    }
    await reply.code(502).send({ error: 'upstream_unavailable', server: serverName });
  } finally {
    stopSessionRenewal?.();
    releaseSlot();
  }
}
