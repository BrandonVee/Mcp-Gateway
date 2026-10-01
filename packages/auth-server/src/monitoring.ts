import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { lt, sql } from 'drizzle-orm';
import { loadPlatformConfig, monitoringStream, monitoringDropped, validCallEvent, latencyHistogram, runtimeSettings } from '@mcp/shared';
import { db } from './db.js';
import { mcpCallEvents, mcpCallMetrics, mcpEventReceipts } from './schema.js';

const redis = new Redis(process.env.REDIS_URL ?? loadPlatformConfig().gateway.redisUrl, { maxRetriesPerRequest:1, connectTimeout:3000 });
redis.on('error', () => { collection.lastError = 'redis_unavailable'; });
const group = 'auth-monitoring';
const consumer = randomUUID();
export const collection = { lastProcessedAt:0, lastError:'' };
let running = false;
let initialized = false;
let claimCursor = '0-0';

export async function storeCallEvent(input: unknown) {
  const event = validCallEvent(input);
  if (!event) return false;
  await db.transaction(async tx => {
    const inserted = await tx.insert(mcpEventReceipts).values({id:event.id,receivedAt:Date.now()})
      .onConflictDoNothing().returning({id:mcpEventReceipts.id});
    if (!inserted.length) return;
    if (event.detail) await tx.insert(mcpCallEvents).values({id:event.id,requestId:event.request_id,
      startedAt:event.started_at,finishedAt:event.finished_at,userId:event.user_id,username:event.username,clientId:event.client_id,
      server:event.server,method:event.method,tool:event.tool,outcome:event.outcome,httpStatus:event.http_status,
      durationMs:event.duration_ms,error:event.error,instance:event.instance,attempts:event.attempts});
    const histogram = latencyHistogram(event.duration_ms);
    await tx.insert(mcpCallMetrics).values({minute:Math.floor(event.started_at/60000)*60000,
      server:event.server,method:event.method,tool:event.tool,userId:event.user_id,username:event.username,clientId:event.client_id,
      outcome:event.outcome,calls:1,durationSum:Math.round(event.duration_ms ?? 0),durationCount:event.duration_ms===null?0:1,histogram})
      .onConflictDoUpdate({target:[mcpCallMetrics.minute,mcpCallMetrics.server,mcpCallMetrics.method,mcpCallMetrics.tool,mcpCallMetrics.userId,mcpCallMetrics.clientId,mcpCallMetrics.outcome],set:{
        calls:sql`${mcpCallMetrics.calls}+1`,durationSum:sql`${mcpCallMetrics.durationSum}+${Math.round(event.duration_ms ?? 0)}`,
        durationCount:sql`${mcpCallMetrics.durationCount}+${event.duration_ms===null?0:1}`,
        histogram:sql`ARRAY(SELECT a+b FROM unnest(${mcpCallMetrics.histogram}, ${sql.raw("ARRAY["+histogram.join(',')+"]::bigint[]")}) AS pair(a,b))`,
        username:event.username,
      }});
  });
  return true;
}

export async function sweepMonitoring() {
  const settings = runtimeSettings(), now = Date.now();
  await Promise.all([
    db.delete(mcpCallEvents).where(lt(mcpCallEvents.startedAt, now-settings.monitoring_retention_days*86400000)),
    db.delete(mcpCallMetrics).where(lt(mcpCallMetrics.minute, now-settings.monitoring_summary_days*86400000)),
    db.delete(mcpEventReceipts).where(lt(mcpEventReceipts.receivedAt, now-7*86400000)),
  ]);
}

async function collect() {
  if (running) return;
  running=true;
  try {
    if (!initialized) {
      try { await redis.xgroup('CREATE',monitoringStream,group,'0','MKSTREAM'); }
      catch(error) { if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error; }
      initialized=true;
    }
    const claimed = await redis.xautoclaim(monitoringStream,group,consumer,60000,claimCursor,'COUNT',100) as [string,[string,string[]][], string[]?];
    claimCursor=claimed[0];
    const fresh = await redis.xreadgroup('GROUP',group,consumer,'COUNT',100,'STREAMS',monitoringStream,'>') as [string,[string,string[]][]][] | null;
    const messages=[...claimed[1],...(fresh?.[0]?.[1] ?? [])];
    for (const [id,fields] of messages) {
      let input: unknown;
      try { input=JSON.parse(fields[fields.indexOf('event')+1]); } catch { input=null; }
      if (!await storeCallEvent(input)) await redis.incr(monitoringDropped);
      // Commit first: replay after an ACK failure is deduplicated in PostgreSQL.
      await redis.multi().xack(monitoringStream,group,id).xdel(monitoringStream,id).exec();
      collection.lastProcessedAt=Date.now();
    }
    collection.lastError='';
  } catch (error) {
    if (error instanceof Error && error.message.includes('NOGROUP')) initialized=false;
    collection.lastError='collection_unavailable';
    console.error('[monitoring] collection failed',error instanceof Error ? error.name : 'UnknownError');
  } finally { running=false; }
}
export function startMonitoring() {
  void collect();
  setInterval(() => void collect(),1000).unref();
  setInterval(() => void sweepMonitoring().catch(() => console.error('[monitoring] retention sweep failed')),600000).unref();
}
export async function monitoringStatus() {
  try {
    const [queued,dropped] = await Promise.all([redis.xlen(monitoringStream),redis.get(monitoringDropped)]);
    return {...collection,queued,dropped:Number(dropped ?? 0)};
  } catch { return {...collection,lastError:'redis_unavailable',queued:null,dropped:null}; }
}
