import { randomUUID, createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { runtimeSettings, monitoringStream, monitoringDropped, safeLabel, type CallEvent } from '@mcp/shared';
import { env } from './config.js';
import { requestMetadata, ResponseObserver, type RpcMetadata } from './response-observer.js';

const redis = new Redis(env.redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000 });
export const collectionStatus = { dropped: 0, lastQueuedAt: 0, lastError: '' };
redis.on('error', () => {
  collectionStatus.lastError = 'redis_unavailable';
});
let pending = 0;
const enqueueScript = `
if redis.call('XLEN', KEYS[1]) >= 20000 then redis.call('INCR', KEYS[2]); return 0 end
redis.call('XADD', KEYS[1], '*', 'event', ARGV[1]); return 1
`;
function enqueue(event: CallEvent) {
  if (pending >= 256 || redis.status !== 'ready') {
    collectionStatus.dropped++;
    collectionStatus.lastError = 'queue_unavailable';
    return;
  }
  pending++;
  void redis
    .eval(enqueueScript, 2, monitoringStream, monitoringDropped, JSON.stringify(event))
    .then((result) => {
      if (Number(result) === 0) {
        collectionStatus.dropped++;
        collectionStatus.lastError = 'queue_full';
      } else {
        collectionStatus.lastQueuedAt = Date.now();
        collectionStatus.lastError = '';
      }
    })
    .catch(() => {
      collectionStatus.dropped++;
      collectionStatus.lastError = 'queue_unavailable';
    })
    .finally(() => {
      pending--;
    });
}
declare module 'fastify' {
  interface FastifyRequest {
    monitoring?: RequestMonitor;
  }
}
export class RequestMonitor {
  private id = randomUUID();
  private started = Date.now();
  private items: { rpc: RpcMetadata; done: boolean }[] = [];
  private done = false;
  attempts = 0;
  instance = '';
  error = '';
  status = 0;
  constructor(
    private req: FastifyRequest,
    private detail: boolean,
  ) {}
  parse() {
    this.items = requestMetadata(this.req.body, this.req.method).map((rpc) => ({ rpc, done: false }));
  }
  target(url: string) {
    this.attempts++;
    this.instance = createHash('sha256').update(url).digest('hex').slice(0, 12);
  }
  observer(contentType: string) {
    return new ResponseObserver(contentType, (id, failed, error, output) => {
      const item = this.items.find((item) => !item.done && item.rpc.id !== null && item.rpc.id === id);
      if (item)
        this.record(
          item,
          failed || this.status >= 400 ? 'failed' : 'success',
          error,
          Date.now() - this.started,
          output,
        );
    });
  }
  private record(
    item: { rpc: RpcMetadata; done: boolean },
    outcome: CallEvent['outcome'],
    error: string,
    duration: number | null,
    output: string | null = null,
  ) {
    item.done = true;
    if (!runtimeSettings().monitoring_enabled) return;
    enqueue({
      id: randomUUID(),
      request_id: this.id,
      started_at: this.started,
      finished_at: Date.now(),
      user_id: typeof this.req.mcpAuth?.uid === 'number' ? this.req.mcpAuth.uid : 0,
      username: safeLabel(this.req.mcpAuth?.sub),
      client_id: safeLabel(this.req.mcpAuth?.client_id),
      server: safeLabel(decodeServer(this.req.url)),
      method: item.rpc.method,
      tool: item.rpc.tool,
      outcome,
      http_status: this.status,
      duration_ms: duration === null ? null : Math.min(1000000000, duration),
      error: safeLabel(error),
      instance: this.instance,
      attempts: this.attempts,
      input: this.detail ? (item.rpc.input ?? null) : null,
      output: this.detail ? output : null,
      detail: this.detail && runtimeSettings().monitoring_logs_enabled,
    });
  }
  finish(status: number, aborted = false) {
    if (this.done) return;
    this.done = true;
    this.status = status;
    if (!this.items.length) this.parse();
    for (const item of this.items.filter((item) => !item.done)) {
      const failed = status >= 400 || status === 0 || aborted;
      const outcome = failed
        ? 'failed'
        : item.rpc.id !== null || item.rpc.method === 'tools/call'
          ? 'unknown'
          : 'success';
      const error =
        this.error ||
        (aborted ? 'stream_interrupted' : failed ? 'http_' + status : outcome === 'unknown' ? 'result_unobserved' : '');
      // HTTP/GET connection duration is not tool execution latency.
      this.record(
        item,
        outcome,
        error,
        outcome === 'unknown' || item.rpc.method === 'http/GET' ? null : Date.now() - this.started,
      );
    }
  }
}
function decodeServer(url: string) {
  try {
    return decodeURIComponent(url.split('?')[0].split('/')[2] || '');
  } catch {
    return '';
  }
}
export function registerMonitoring(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    if (req.url.split('?')[0].startsWith('/mcp/') && req.method !== 'OPTIONS' && runtimeSettings().monitoring_enabled)
      req.monitoring = new RequestMonitor(req, runtimeSettings().monitoring_logs_enabled);
  });
  app.addHook('onResponse', async (req, reply) => req.monitoring?.finish(reply.statusCode));
  app.addHook('onError', async (req) => {
    if (req.monitoring) req.monitoring.error = 'gateway_error';
  });
}
