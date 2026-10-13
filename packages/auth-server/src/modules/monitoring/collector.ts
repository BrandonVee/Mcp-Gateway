import {
  latencyHistogram,
  loadPlatformConfig,
  monitoringDropped,
  monitoringStream,
  runtimeSettings,
  validCallEvent,
  type CallEvent,
} from '@mcp/shared';
import { lt, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { db } from '@/auth/infrastructure/database/client.js';
import { mcpCallEvents, mcpCallMetrics, mcpEventReceipts } from '@/auth/infrastructure/database/schema.js';
import { currentActiveAlerts, evaluateAlerts } from '@/auth/modules/monitoring/alert-history.js';

const redis = new Redis(process.env.REDIS_URL ?? loadPlatformConfig().gateway.redisUrl, {
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
});
redis.on('error', () => {
  collection.lastError = 'redis_unavailable';
});
const group = 'auth-monitoring';
const consumer = randomUUID();
export const collection = { lastProcessedAt: 0, lastError: '' };
let running = false;
let initialized = false;
let claimCursor = '0-0';

/**
 * Rolling per-minute flow counters feeding the admin topology edges. Runs
 * after the receipt dedup insert succeeded, so stream replays never double
 * count. Best-effort: a Redis hiccup must not fail event persistence.
 */
async function countTopologyFlow(event: CallEvent): Promise<void> {
  const bucket = Math.floor(event.started_at / 60000) * 60000;
  const field = [event.server, event.instance, event.username, event.client_id].join('\x1f');
  const flowKey = `gw:topo:flow:${bucket}`;
  const pipe = redis.pipeline().hincrby(flowKey, field, 1).expire(flowKey, 600);
  if (event.outcome === 'failed') {
    const failKey = `gw:topo:fail:${bucket}`;
    pipe.hincrby(failKey, field, 1).expire(failKey, 600);
  }
  await pipe.exec();
}

/**
 * Persist one call event. The receipt row is the deduplication point: the Redis
 * stream may deliver a message twice, and the insert below is a no-op the second
 * time. Metrics are aggregated per minute so the dashboard never scans events.
 */
export async function storeCallEvent(input: unknown) {
  const event = validCallEvent(input);
  if (!event) return false;
  let fresh = false;
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(mcpEventReceipts)
      .values({ id: event.id, receivedAt: Date.now() })
      .onConflictDoNothing()
      .returning({ id: mcpEventReceipts.id });
    if (!inserted.length) return;
    fresh = true;
    if (event.detail)
      await tx.insert(mcpCallEvents).values({
        id: event.id,
        requestId: event.request_id,
        startedAt: event.started_at,
        finishedAt: event.finished_at,
        userId: event.user_id,
        username: event.username,
        clientId: event.client_id,
        server: event.server,
        method: event.method,
        tool: event.tool,
        outcome: event.outcome,
        httpStatus: event.http_status,
        durationMs: event.duration_ms,
        error: event.error,
        instance: event.instance,
        attempts: event.attempts,
        input: event.input,
        output: event.output,
      });
    const histogram = latencyHistogram(event.duration_ms);
    await tx
      .insert(mcpCallMetrics)
      .values({
        minute: Math.floor(event.started_at / 60000) * 60000,
        server: event.server,
        method: event.method,
        tool: event.tool,
        userId: event.user_id,
        username: event.username,
        clientId: event.client_id,
        outcome: event.outcome,
        calls: 1,
        durationSum: Math.round(event.duration_ms ?? 0),
        durationCount: event.duration_ms === null ? 0 : 1,
        histogram,
      })
      .onConflictDoUpdate({
        target: [
          mcpCallMetrics.minute,
          mcpCallMetrics.server,
          mcpCallMetrics.method,
          mcpCallMetrics.tool,
          mcpCallMetrics.userId,
          mcpCallMetrics.clientId,
          mcpCallMetrics.outcome,
        ],
        set: {
          calls: sql`${mcpCallMetrics.calls}+1`,
          durationSum: sql`${mcpCallMetrics.durationSum}+${Math.round(event.duration_ms ?? 0)}`,
          durationCount: sql`${mcpCallMetrics.durationCount}+${event.duration_ms === null ? 0 : 1}`,
          histogram: sql`ARRAY(SELECT a+b FROM unnest(${mcpCallMetrics.histogram}, ${sql.raw('ARRAY[' + histogram.join(',') + ']::bigint[]')}) AS pair(a,b))`,
          username: event.username,
        },
      });
  });
  if (fresh) await countTopologyFlow(event).catch(() => console.error('[monitoring] topology flow counter failed'));
  return true;
}

/** Retention differs per table: raw events are the expensive rows to keep. */
export async function sweepMonitoring() {
  const settings = runtimeSettings(),
    now = Date.now();
  await Promise.all([
    db.delete(mcpCallEvents).where(lt(mcpCallEvents.startedAt, now - settings.monitoring_retention_days * 86400000)),
    db.delete(mcpCallMetrics).where(lt(mcpCallMetrics.minute, now - settings.monitoring_summary_days * 86400000)),
    db.delete(mcpEventReceipts).where(lt(mcpEventReceipts.receivedAt, now - 7 * 86400000)),
  ]);
}

/**
 * Drain the Redis stream as a consumer group. Pending messages are reclaimed
 * first (another replica may have died after reading but before acknowledging),
 * then new ones are read; every replica shares the group name so each message is
 * handled once across the fleet.
 */
async function collect() {
  if (running) return;
  running = true;
  try {
    if (!initialized) {
      try {
        await redis.xgroup('CREATE', monitoringStream, group, '0', 'MKSTREAM');
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error;
      }
      initialized = true;
    }
    const claimed = (await redis.xautoclaim(monitoringStream, group, consumer, 60000, claimCursor, 'COUNT', 100)) as [
      string,
      [string, string[]][],
      string[]?,
    ];
    claimCursor = claimed[0];
    const fresh = (await redis.xreadgroup('GROUP', group, consumer, 'COUNT', 100, 'STREAMS', monitoringStream, '>')) as
      [string, [string, string[]][]][] | null;
    const messages = [...claimed[1], ...(fresh?.[0]?.[1] ?? [])];
    for (const [id, fields] of messages) {
      let input: unknown;
      try {
        input = JSON.parse(fields[fields.indexOf('event') + 1]);
      } catch {
        input = null;
      }
      if (!(await storeCallEvent(input))) await redis.incr(monitoringDropped);
      // Commit first: replay after an ACK failure is deduplicated in PostgreSQL.
      await redis.multi().xack(monitoringStream, group, id).xdel(monitoringStream, id).exec();
      collection.lastProcessedAt = Date.now();
    }
    collection.lastError = '';
  } catch (error) {
    if (error instanceof Error && error.message.includes('NOGROUP')) initialized = false;
    collection.lastError = 'collection_unavailable';
    console.error('[monitoring] collection failed', error instanceof Error ? error.name : 'UnknownError');
  } finally {
    running = false;
  }
}
export function startMonitoring() {
  void collect();
  setInterval(() => void collect(), 1000).unref();
  setInterval(
    () => void sweepMonitoring().catch(() => console.error('[monitoring] retention sweep failed')),
    600000,
  ).unref();
  setInterval(
    () =>
      void currentActiveAlerts()
        .then(evaluateAlerts)
        .catch(() => console.error('[monitoring] alert evaluation failed')),
    60000,
  ).unref();
}
export async function monitoringStatus() {
  try {
    const [queued, dropped] = await Promise.all([redis.xlen(monitoringStream), redis.get(monitoringDropped)]);
    return { ...collection, queued, dropped: Number(dropped ?? 0) };
  } catch {
    return { ...collection, lastError: 'redis_unavailable', queued: null, dropped: null };
  }
}
