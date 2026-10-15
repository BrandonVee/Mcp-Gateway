import { upstreamCredentialResponseSchema } from '@/shared/security/credentials.js';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { McpServerConfig } from '@mcp/shared';
import { env } from '@/gateway/config.js';
import { redis } from '@/gateway/lb.js';
import { AggregateConnection, AggregateError, upstreamRpc, type AggregateSession } from '@/gateway/aggregate.js';
import { reserveUpstreamSlot } from '@/gateway/routes/capacity.js';
import { tokenAuthVersion } from '@/gateway/auth.js';
import { AggregateSessionStore } from '@/gateway/aggregate-session.js';
import { reportCredentialStatus } from '@/gateway/credential-status.js';

export async function aggregateRequest(req: FastifyRequest, reply: FastifyReply, cfg: McpServerConfig) {
  const owner = req.mcpAuth?.uid,
    authVersion = tokenAuthVersion(req.mcpAuth);
  if (typeof owner !== 'number' || authVersion === null) return reply.code(401).send({ error: 'new_login_required' });
  // Live endpoint grants are checked even for pings, lists, DELETE and stateless members.
  const access = new URL(env.accessCheckUrl);
  access.searchParams.set('server', cfg.name);
  access.searchParams.set('user_id', String(owner));
  access.searchParams.set('auth_version', String(authVersion));
  try {
    const check = await fetch(access, {
      headers: { authorization: `Bearer ${env.internalApiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (check.status === 403) return reply.code(403).send({ error: 'server_access_denied', server: cfg.name });
    if (!check.ok) throw new Error('access check unavailable');
  } catch {
    return reply.code(503).send({ error: 'access_service_unavailable' });
  }
  // No independent server-to-client notifications are advertised by the aggregator.
  if (req.method === 'GET')
    return reply.code(405).header('Allow', 'POST, DELETE').send({ error: 'stream_not_supported' });
  if (req.method !== 'POST' && req.method !== 'DELETE') return reply.code(405).send({ error: 'method_not_allowed' });
  let message: any;
  if (req.method === 'POST') {
    try {
      message = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body));
    } catch {
      return reply.code(400).send({ error: 'invalid_json_rpc' });
    }
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return reply.code(400).send({ error: 'invalid_json_rpc' });
  }
  const incoming = req.headers['mcp-session-id'];
  if (incoming !== undefined && (typeof incoming !== 'string' || !/^[a-f0-9-]{36}$/.test(incoming)))
    return reply.code(404).send({ error: 'session_not_found' });
  const initializing = message?.method === 'initialize';
  if (initializing && incoming) return reply.code(400).send({ error: 'session_already_initialized' });
  if (!initializing && !incoming) return reply.code(404).send({ error: 'session_not_found' });
  const sid = typeof incoming === 'string' ? incoming : randomUUID();
  const key = `gw:aggregate:${cfg.name}:${sid}`;
  const store = new AggregateSessionStore(redis, key, owner, authVersion, env.sessionTtlSeconds);
  const releaseSlot = reserveUpstreamSlot();
  if (!releaseSlot) return reply.code(503).send({ error: 'upstream_capacity_exceeded' });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const credentials = new Map<string, { credential_version?: string; validation_status?: string }>();
  try {
    if (initializing) {
      const session: AggregateSession = { owner, authVersion, members: {} };
      await redis.set(key, JSON.stringify(session), 'EX', env.sessionTtlSeconds, 'NX');
    }
    const session = await store.read();
    heartbeat = setInterval(
      () => {
        void store.touch().catch(() => undefined);
      },
      Math.max(250, Math.min(15_000, (env.sessionTtlSeconds * 1000) / 3)),
    );
    heartbeat.unref();
    if (req.method === 'DELETE') {
      await redis.del(key);
      await Promise.allSettled(
        (cfg.upstreams ?? []).map(async (u) => {
          const member = session.members[u.id];
          if (!member?.sessionId) return;
          // Resolve again, so even cleanup never transmits another upstream's key.
          const resolved = await credential(u.id);
          const headers: Record<string, string> = { 'mcp-session-id': member.sessionId };
          if (resolved.credential) headers[resolved.credential.header] = resolved.credential.value;
          const response = await fetch(u.url, {
            method: 'DELETE',
            headers,
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
          });
          await response.body?.cancel();
        }),
      );
      return reply.code(204).send();
    }
    async function credential(id: string) {
      const url = new URL('/internal/upstream-credential', env.credentialUrl);
      url.searchParams.set('instance_id', id);
      const upstream = cfg.upstreams?.find((u) => u.id === id);
      if (!upstream) throw new AggregateError('unknown_upstream', 404, id);
      url.searchParams.set('upstream_url', upstream.url);
      url.searchParams.set('endpoint', cfg.name);
      url.searchParams.set('user_id', String(owner));
      url.searchParams.set('auth_version', String(authVersion));
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${env.credentialBrokerToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AggregateError(
          response.status === 409
            ? 'connection_required'
            : response.status === 403
              ? 'server_access_denied'
              : 'system_credential_unavailable',
          response.status === 403 ? 403 : response.status === 409 ? 409 : 503,
          id,
        );
      }
      const parsed = upstreamCredentialResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new AggregateError('invalid_upstream_credential');
      credentials.set(id, parsed.data);
      return parsed.data;
    }
    const connection = new AggregateConnection(cfg.upstreams ?? [], session, {
      credential: (u) => credential(u.id),
      prepareMember: (id, revision, initialize, version) => store.member(id, revision, initialize, version),
      updateSession: async (change) => {
        const updated = await store.update(change);
        Object.assign(session, updated.session);
        return updated.value;
      },
      rpc: async (u, rpc, header, member) => {
        req.monitoring?.target(u.url);
        const saved = credentials.get(u.id);
        const report = async (status: 'verified' | 'rejected') => {
          if (!saved?.credential_version || saved.validation_status === status) return;
          if (
            await reportCredentialStatus({
              instance_id: u.id,
              upstream_url: u.url,
              user_id: owner,
              auth_version: authVersion,
              credential_version: saved.credential_version,
              status,
            })
          )
            saved.validation_status = status;
        };
        try {
          const response = await upstreamRpc(u, rpc, header, member);
          if (rpc.id !== undefined) await report('verified');
          return response;
        } catch (error) {
          if (
            error instanceof AggregateError &&
            ['upstream_credential_rejected', 'system_credential_rejected'].includes(error.code)
          )
            await report('rejected');
          throw error;
        }
      },
    });
    const response = initializing ? { result: await connection.initialize() } : await connection.handle(message);
    await store.touch();
    if (message.id === undefined) return reply.code(202).send();
    req.monitoring?.rpcResponse(message.id, response);
    return reply.header('mcp-session-id', sid).send({
      jsonrpc: '2.0',
      id: message.id,
      ...(response.error ? { error: response.error } : { result: response.result }),
    });
  } catch (error) {
    if (initializing) await redis.del(key).catch(() => undefined);
    const failure = error instanceof AggregateError ? error : new AggregateError('upstream_unavailable', 502);
    if (req.monitoring) req.monitoring.error = failure.code;
    return reply.code(failure.status).send({
      error: failure.code,
      ...(failure.upstream ? { upstream_id: failure.upstream } : {}),
      ...(['connection_required', 'upstream_credential_rejected'].includes(failure.code)
        ? { connect_url: env.connectionsWebUrl }
        : {}),
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    releaseSlot();
  }
}
