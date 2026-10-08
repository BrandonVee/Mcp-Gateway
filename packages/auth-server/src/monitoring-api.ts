import { monitoringFilters, callLogQuery } from './monitoring-query.js';
import type { Hono, Context } from 'hono';
import { alertEventSchema, histogramP95, runtimeSettings } from '@mcp/shared';
import { pool } from './db.js';
import { monitoringStatus } from './monitoring.js';
import { acknowledgeAlert, listAlertEvents } from './alert-history.js';

const histogramSql =
  'ARRAY[' + Array.from({ length: 16 }, (_, i) => `COALESCE(sum(histogram[${i + 1}]),0)`).join(',') + ']';
const number = (value: unknown) => Number(value ?? 0);
function statistics(row: Record<string, unknown>) {
  const success = number(row.success),
    failed = number(row.failed),
    unknown = number(row.unknown),
    calls = number(row.calls);
  return {
    name: row.name,
    calls,
    success,
    failed,
    unknown,
    success_rate: success + failed ? (success / (success + failed)) * 100 : null,
    avg_ms: number(row.duration_count) ? number(row.duration_sum) / number(row.duration_count) : null,
    p95_ms: histogramP95(((row.histogram as unknown[]) ?? []).map(number)),
  };
}
const totalsSql = `sum(calls) calls, sum(calls) FILTER (WHERE outcome='success') success, sum(calls) FILTER (WHERE outcome='failed') failed,
  sum(calls) FILTER (WHERE outcome='unknown') unknown, sum(duration_sum) duration_sum, sum(duration_count) duration_count, ${histogramSql} histogram`;

/** Mounted inside the administrator-only router. */
export function registerMonitoringRoutes(router: Hono) {
  router.get('/admin/monitoring/summary', async (c) => {
    c.header('Cache-Control', 'no-store');
    let filter: ReturnType<typeof monitoringFilters>, recent: ReturnType<typeof monitoringFilters>;
    try {
      filter = monitoringFilters(c, 'metrics');
      recent = monitoringFilters(c, 'metrics', 5);
    } catch {
      return c.json({ error: 'invalid_monitoring_filter' }, 400);
    }
    const { where, params, hours } = filter;
    const dimension = c.req.query('dimension') ?? 'server';
    if (!['server', 'tool', 'user', 'client'].includes(dimension)) return c.json({ error: 'invalid_dimension' }, 400);
    const group = { server: 'server', tool: 'server, tool', user: 'user_id', client: 'client_id' }[dimension]!;
    const label = {
      server: 'server',
      tool: "server || ' / ' || tool",
      user: "max(username) || ' (#' || user_id || ')'",
      client: 'client_id',
    }[dimension]!;
    const bucket = hours === 1 ? 60000 : hours <= 24 ? 3600000 : 86400000;
    const [total, requests, ranking, trend, peak, alerts, status] = await Promise.all([
      pool.query(
        `SELECT ${totalsSql},count(DISTINCT user_id) FILTER (WHERE user_id>0) users FROM mcp_call_metrics WHERE ${where} AND method='tools/call'`,
        params,
      ),
      pool.query(`SELECT COALESCE(sum(calls),0) requests FROM mcp_call_metrics WHERE ${where}`, params),
      pool.query(
        `SELECT ${label} name,${totalsSql} FROM mcp_call_metrics WHERE ${where} AND method='tools/call' GROUP BY ${group} ORDER BY sum(calls) DESC LIMIT 20`,
        params,
      ),
      pool.query(
        `SELECT floor(minute/${bucket})*${bucket} time,sum(calls) calls,sum(calls) FILTER(WHERE outcome='failed') failed FROM mcp_call_metrics WHERE ${where} AND method='tools/call' GROUP BY 1 ORDER BY 1`,
        params,
      ),
      pool.query(
        `SELECT COALESCE(max(n),0) peak FROM (SELECT sum(calls) n FROM mcp_call_metrics WHERE ${where} AND method='tools/call' GROUP BY minute) counts`,
        params,
      ),
      pool.query(
        `SELECT server name,${totalsSql},sum(duration_count) observed FROM mcp_call_metrics WHERE ${recent.where} AND method='tools/call' GROUP BY server`,
        recent.params,
      ),
      monitoringStatus(),
    ]);
    const settings = runtimeSettings();
    const events = alerts.rows.flatMap((row) => {
      const data = statistics(row),
        events = [];
      if (
        data.success + data.failed >= 20 &&
        (data.failed / (data.success + data.failed)) * 100 > settings.monitoring_error_rate
      )
        events.push({
          server: row.name,
          type: 'error_rate',
          value: (data.failed / (data.success + data.failed)) * 100,
          threshold: settings.monitoring_error_rate,
        });
      if (number(row.observed) >= 20 && data.p95_ms !== null && data.p95_ms > settings.monitoring_slow_ms)
        events.push({
          server: row.name,
          type: 'slow_calls',
          value: data.p95_ms,
          threshold: settings.monitoring_slow_ms,
        });
      return events;
    });
    const observed = new Map(
      trend.rows.map((row) => [
        number(row.time),
        { time: number(row.time), calls: number(row.calls), failed: number(row.failed) },
      ]),
    );
    const trendRows = [];
    const end = Math.floor(Date.now() / bucket) * bucket,
      start = Math.floor((Date.now() - hours * 3600000) / bucket) * bucket;
    for (let time = start; time <= end; time += bucket)
      trendRows.push(observed.get(time) ?? { time, calls: 0, failed: 0 });
    return c.json({
      enabled: settings.monitoring_enabled,
      summary: {
        ...statistics(total.rows[0]),
        requests: number(requests.rows[0].requests),
        active_users: number(total.rows[0].users),
        peak_per_minute: number(peak.rows[0].peak),
      },
      ranking: ranking.rows.map(statistics),
      trend: trendRows,
      bucket_ms: bucket,
      alerts: events,
      collection: status,
    });
  });
  router.get('/admin/monitoring/calls', async (c) => {
    return listMonitoringCalls(c);
  });
  router.get('/admin/monitoring/alerts', async (c) => {
    c.header('Cache-Control', 'no-store');
    const status = c.req.query('status') ?? 'open';
    const limitRaw = c.req.query('limit') ?? '50';
    if (!['open', 'all'].includes(status) || !/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100)
      return c.json({ error: 'invalid_alert_filter' }, 400);
    try {
      const events = await listAlertEvents(status as 'open' | 'all', Number(limitRaw));
      return c.json({ events });
    } catch {
      return c.json({ error: 'alert_history_unavailable' }, 503);
    }
  });
  router.post('/admin/monitoring/alerts/:id/ack', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'invalid_alert_id' }, 400);
    const actor = (c as unknown as { get(key: string): unknown }).get('adminActor');
    const event = await acknowledgeAlert(id, typeof actor === 'string' && actor ? actor : 'admin');
    if (!event) return c.json({ error: 'alert_not_found' }, 404);
    return c.json({ event });
  });
}

/** userId is supplied by authenticated server identity, never by a query parameter. */
export async function listMonitoringCalls(c: Context, userId?: number) {
  c.header('Cache-Control', 'no-store');
  let query: ReturnType<typeof callLogQuery>;
  try {
    query = callLogQuery(c, userId);
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error && error.message === 'invalid_cursor' ? 'invalid_cursor' : 'invalid_monitoring_filter',
      },
      400,
    );
  }
  const { params, clauses } = query;
  const result = await pool.query(
    `SELECT * FROM mcp_call_events WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC,id DESC LIMIT 51`,
    params,
  );
  const rows = result.rows.slice(0, 50).map((row) => ({
    ...row,
    started_at: number(row.started_at),
    finished_at: number(row.finished_at),
    user_id: number(row.user_id),
    duration_ms: row.duration_ms === null ? null : number(row.duration_ms),
  }));
  const last = rows.at(-1);
  return c.json({
    events: rows,
    next_cursor:
      result.rows.length > 50 && last
        ? Buffer.from(JSON.stringify([last.started_at, last.id])).toString('base64url')
        : null,
  });
}
