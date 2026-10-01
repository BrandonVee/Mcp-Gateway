/** Metadata-only monitoring contract. Never accept argument/result objects. */
export const latencyBounds = [25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000, 3600000, 86400000, 604800000, 1000000000];
export const monitoringStream = 'mcp:monitoring:events';
export const monitoringDropped = 'mcp:monitoring:dropped';
export interface CallEvent {
  id: string; request_id: string; started_at: number; finished_at: number;
  user_id: number; username: string; client_id: string; server: string; method: string; tool: string;
  outcome: 'success' | 'failed' | 'unknown'; http_status: number; duration_ms: number | null;
  error: string; instance: string; attempts: number; detail: boolean;
}
export function safeLabel(value: unknown, length = 128): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, length) : '';
}
export function validCallEvent(value: unknown, now = Date.now()): CallEvent | null {
  if (!value || typeof value !== 'object') return null;
  const e = value as CallEvent;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (!uuid.test(e.id) || !uuid.test(e.request_id)
    || !Number.isSafeInteger(e.started_at) || e.started_at > now + 60000 || e.started_at < now - 6 * 86400000
    || !Number.isSafeInteger(e.finished_at) || e.finished_at < e.started_at || e.finished_at > now + 60000
    || !Number.isSafeInteger(e.user_id) || e.user_id < 0
    || !['success', 'failed', 'unknown'].includes(e.outcome)
    || !Number.isInteger(e.http_status) || e.http_status < 0 || e.http_status > 599
    || (e.duration_ms !== null && (!Number.isFinite(e.duration_ms) || e.duration_ms < 0 || e.duration_ms > 1000000000))
    || !Number.isInteger(e.attempts) || e.attempts < 0 || e.attempts > 100
    || typeof e.detail !== 'boolean') return null;
  for (const key of ['username', 'client_id', 'server', 'method', 'tool', 'error', 'instance'] as const) {
    if (typeof e[key] !== 'string' || e[key].length > 128 || /[\x00-\x1f\x7f]/.test(e[key])) return null;
  }
  // Explicit projection prevents extra payload/credential fields reaching storage.
  return { id:e.id, request_id:e.request_id, started_at:e.started_at, finished_at:e.finished_at,
    user_id:e.user_id, username:e.username, client_id:e.client_id, server:e.server, method:e.method, tool:e.tool,
    outcome:e.outcome, http_status:e.http_status, duration_ms:e.duration_ms, error:e.error,
    instance:e.instance, attempts:e.attempts, detail:e.detail };
}
export function latencyHistogram(duration: number | null): number[] {
  const histogram = latencyBounds.map(() => 0);
  if (duration !== null) {
    const index = latencyBounds.findIndex(bound => duration <= bound);
    histogram[index < 0 ? histogram.length - 1 : index] = 1;
  }
  return histogram;
}
export function histogramP95(histogram: number[]): number | null {
  const count = histogram.reduce((sum, value) => sum + value, 0);
  if (!count) return null;
  const rank = Math.ceil(count * .95);
  let seen = 0;
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i];
    if (seen >= rank) return latencyBounds[i];
  }
  return null;
}
