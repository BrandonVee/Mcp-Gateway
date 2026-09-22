import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request } from 'undici';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getServerConfig } from '../config.js';
import { pickInstance, bindSession } from '../lb.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
]);

function filterHeaders(headers: Record<string, unknown>, extra: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower) || extra.includes(lower)) continue;
    out[lower] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

export function registerMcpRoutes(app: FastifyInstance): void {
  app.all('/mcp/:serverName', proxyHandler);
  app.all('/mcp/:serverName/*', proxyHandler);
}

async function proxyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { serverName } = req.params as { serverName: string };
  const cfg = getServerConfig(serverName);
  if (!cfg) {
    await reply.code(404).send({ error: 'server_not_found', server: serverName });
    return;
  }

  const incomingSessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
  const hashSeed = incomingSessionId ? undefined : Buffer.from((req.body as Buffer | undefined) ?? `${serverName}:${Math.random()}`).toString('base64');
  const target = await pickInstance(cfg, incomingSessionId, hashSeed);

  // Build upstream headers: drop hop-by-hop + client-spoofable internal headers.
  const headers = filterHeaders(req.headers, ['host', 'content-length', 'authorization', 'x-mcp-user', 'x-mcp-client-id', 'x-mcp-scope']);
  const upstreamUrl = new URL(target.url);
  headers['host'] = upstreamUrl.host;
  headers['x-forwarded-for'] = req.ip;
  headers['x-forwarded-host'] = req.headers['host'] ?? '';
  headers['x-forwarded-proto'] = req.protocol;
  if (req.mcpAuth) {
    headers['x-mcp-user'] = String(req.mcpAuth.sub ?? '');
    headers['x-mcp-client-id'] = String(req.mcpAuth.client_id ?? '');
    headers['x-mcp-scope'] = String(req.mcpAuth.scope ?? '');
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const upstream = await request(`${upstreamUrl.origin}/mcp`, {
    method: req.method as 'POST', // fastify gives the uppercase verb; widened by undici at runtime
    headers,
    body: hasBody ? (req.body as Buffer | undefined) : undefined,
  });

  // Session affinity: bind the MCP session id (from initialize response) to
  // the instance that created it. Re-bind on every request to refresh TTL.
  const sessionId = upstream.headers['mcp-session-id'];
  if (typeof sessionId === 'string' && sessionId) {
    await bindSession(cfg.name, sessionId, target.index);
  }

  const resHeaders = filterHeaders(upstream.headers);

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
}
