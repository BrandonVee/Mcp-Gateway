import type { Context } from 'hono';

export function monitoringFilters(c: Context, table: 'metrics' | 'events', fixedMinutes?: number) {
  const hours = c.req.query('hours') === undefined ? 24 : Number(c.req.query('hours'));
  if (![1, 24, 168, 720, 8760].includes(hours)) throw new Error('invalid hours');
  const params: unknown[] = [Date.now() - (fixedMinutes ?? hours * 60) * 60000];
  const clauses = [`${table === 'metrics' ? 'minute' : 'started_at'} >= $1`];
  for (const key of [
    'server',
    'tool',
    'client_id',
    'user_id',
    'outcome',
    ...(table === 'events' ? (['method', 'request_id'] as const) : []),
  ] as const) {
    const value = c.req.query(key);
    if (value === undefined || value === '') continue;
    if (value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid filter');
    if (key === 'user_id' && (!Number.isSafeInteger(Number(value)) || Number(value) < 0))
      throw new Error('invalid user');
    if (key === 'outcome' && !['success', 'failed', 'unknown'].includes(value)) throw new Error('invalid outcome');
    params.push(key === 'user_id' ? Number(value) : value);
    clauses.push(`${key}=$${params.length}`);
  }
  if (table === 'events') {
    const query = c.req.query('q');
    if (query) {
      if (query.length > 256 || /[\x00-\x1f\x7f]/.test(query)) throw new Error('invalid search');
      params.push('%' + query.replace(/[\\%_]/g, '\\$&') + '%');
      clauses.push(
        `(input ILIKE $${params.length} OR output ILIKE $${params.length} OR error ILIKE $${params.length})`,
      );
    }
  }
  return { where: clauses.join(' AND '), params, hours };
}

/** Scope comes from the authenticated user, independently of submitted filters. */
export function callLogQuery(c: Context, userId?: number) {
  const filter = monitoringFilters(c, 'events');
  const params = [...filter.params],
    clauses = [filter.where];
  if (userId !== undefined) {
    params.push(userId);
    clauses.push(`user_id=$${params.length}`);
  }
  const cursor = c.req.query('cursor');
  if (cursor) {
    try {
      if (cursor.length > 200) throw new Error();
      const [time, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (
        !Number.isSafeInteger(time) ||
        typeof id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
      )
        throw new Error();
      params.push(time, id);
      clauses.push(`(started_at,id)<($${params.length - 1},$${params.length})`);
    } catch {
      throw new Error('invalid_cursor');
    }
  }
  return { params, clauses };
}
