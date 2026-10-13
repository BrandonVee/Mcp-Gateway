import { alertFingerprint, histogramP95, runtimeSettings, type ActiveAlert, type AlertEvent } from '@mcp/shared';
import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { db, pool } from '@/auth/infrastructure/database/client.js';
import { alertEvents } from '@/auth/infrastructure/database/schema.js';
import { sendMail } from '@/auth/infrastructure/mail/mailer.js';
import { currentSystemSettings } from '@/auth/modules/system/settings.js';

function deserialize(row: typeof alertEvents.$inferSelect): AlertEvent {
  return {
    id: row.id,
    server: row.server,
    type: row.type as AlertEvent['type'],
    value: row.value,
    threshold: row.threshold,
    first_seen_at: row.firstSeenAt,
    last_seen_at: row.lastSeenAt,
    resolved_at: row.resolvedAt,
    acknowledged_at: row.acknowledgedAt,
    acknowledged_by: row.acknowledgedBy,
    notified_at: row.notifiedAt,
    notification_error: row.notificationError,
  };
}

/** Uses the same five-minute known-outcome/sample rules as the dashboard. */
export async function currentActiveAlerts(): Promise<ActiveAlert[]> {
  const settings = runtimeSettings();
  const since = Date.now() - 5 * 60_000;
  const histogramSql = Array.from({ length: 16 }, (_, index) => `COALESCE(sum(histogram[${index + 1}]),0)`).join(',');
  const result = await pool.query(
    `
    SELECT server,
           sum(calls) FILTER (WHERE outcome IN ('success','failed')) known,
           sum(calls) FILTER (WHERE outcome='failed') failed,
           sum(duration_count) observed,
           ARRAY[${histogramSql}] histogram
    FROM mcp_call_metrics
    WHERE minute >= $1 AND method='tools/call'
    GROUP BY server
  `,
    [since],
  );
  const alerts: ActiveAlert[] = [];
  for (const raw of result.rows as Array<Record<string, unknown>>) {
    const server = String(raw.server ?? '');
    const known = Number(raw.known ?? 0);
    const failed = Number(raw.failed ?? 0);
    if (known >= 20 && (failed / known) * 100 > settings.monitoring_error_rate)
      alerts.push({
        server,
        type: 'error_rate',
        value: (failed / known) * 100,
        threshold: settings.monitoring_error_rate,
      });
    const observed = Number(raw.observed ?? 0);
    const p95 = histogramP95(((raw.histogram as unknown[]) ?? []).map(Number));
    if (observed >= 20 && p95 !== null && p95 > settings.monitoring_slow_ms)
      alerts.push({ server, type: 'slow_calls', value: p95, threshold: settings.monitoring_slow_ms });
  }
  return alerts;
}

export async function listAlertEvents(status: 'open' | 'all', limit: number): Promise<AlertEvent[]> {
  const rows =
    status === 'open'
      ? await db
          .select()
          .from(alertEvents)
          .where(isNull(alertEvents.resolvedAt))
          .orderBy(desc(alertEvents.lastSeenAt), desc(alertEvents.id))
          .limit(limit)
      : await db.select().from(alertEvents).orderBy(desc(alertEvents.lastSeenAt), desc(alertEvents.id)).limit(limit);
  return rows.map(deserialize);
}

export async function acknowledgeAlert(id: number, actor: string): Promise<AlertEvent | null> {
  const [row] = await db
    .update(alertEvents)
    .set({ acknowledgedAt: Date.now(), acknowledgedBy: actor })
    .where(and(eq(alertEvents.id, id), isNull(alertEvents.acknowledgedAt)))
    .returning();
  if (row) return deserialize(row);
  const [existing] = await db.select().from(alertEvents).where(eq(alertEvents.id, id)).limit(1);
  return existing ? deserialize(existing) : null;
}

async function deliver(active: ActiveAlert): Promise<{ notifiedAt: number | null; error: string | null }> {
  const settings = currentSystemSettings();
  const label = active.type === 'error_rate' ? '错误率过高 / High error rate' : '响应过慢 / Slow calls';
  const message = `${label}: ${active.server}\nvalue=${active.value.toFixed(2)} threshold=${active.threshold}`;
  const recipients = settings.alert_email_recipients ?? [];
  const results = await Promise.allSettled([
    ...(settings.alert_webhook_url
      ? [
          fetch(settings.alert_webhook_url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ event: 'alert_triggered', ...active, message }),
            signal: AbortSignal.timeout(5000),
          }).then((response) => {
            if (!response.ok) throw new Error(`webhook_status_${response.status}`);
          }),
        ]
      : []),
    ...recipients.map((email) => sendMail(email, `MCP Gateway ${label}: ${active.server}`, message)),
  ]);
  if (!results.length) return { notifiedAt: Date.now(), error: null };
  if (results.every((result) => result.status === 'fulfilled')) return { notifiedAt: Date.now(), error: null };
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => (result.reason instanceof Error ? result.reason.message : 'notification_failed'));
  return { notifiedAt: null, error: errors.join(', ').slice(0, 256) };
}

/** Best-effort periodic evaluation. Collection failures must not break MCP traffic. */
export async function evaluateAlerts(active: ActiveAlert[]): Promise<void> {
  const now = Date.now();
  await db.transaction(async (tx) => {
    for (const alert of active) {
      const [row] = await tx
        .insert(alertEvents)
        .values({
          fingerprint: alertFingerprint(alert.server, alert.type),
          server: alert.server,
          type: alert.type,
          value: alert.value,
          threshold: alert.threshold,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: alertEvents.fingerprint,
          set: {
            value: alert.value,
            threshold: alert.threshold,
            lastSeenAt: now,
            resolvedAt: null,
          },
        })
        .returning();
      if (!row || row.notifiedAt || row.notificationError) continue;
      const delivery = await deliver(alert);
      await tx
        .update(alertEvents)
        .set({ notifiedAt: delivery.notifiedAt, notificationError: delivery.error })
        .where(eq(alertEvents.id, row.id));
    }
    await tx
      .update(alertEvents)
      .set({ resolvedAt: now })
      .where(
        and(
          isNull(alertEvents.resolvedAt),
          active.length
            ? notInArray(
                alertEvents.fingerprint,
                active.map((alert) => alertFingerprint(alert.server, alert.type)),
              )
            : undefined,
        ),
      );
  });
}
