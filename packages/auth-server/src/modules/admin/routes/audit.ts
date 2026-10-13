import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../../../infrastructure/database/client.js';
import { auditEvents } from '../../../infrastructure/database/schema.js';
import { jsonError } from '../../../shared/http/responses.js';
import type { AdminRouter } from '../context.js';
/** Registers audit routes under the shared administrator guard. */
export function registerAuditRoutes(router: AdminRouter) {
  /** Paginated, metadata-only admin audit stream. No request bodies or secrets. */
  router.get('/admin/audit-events', async (c) => {
    c.header('Cache-Control', 'no-store');
    const limit = c.req.query('limit') === undefined ? 50 : Number(c.req.query('limit'));
    const before = c.req.query('before') === undefined ? undefined : Number(c.req.query('before'));
    const actor = c.req.query('actor')?.trim();
    const method = c.req.query('method')?.trim().toUpperCase();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return jsonError(c, 'limit must be an integer from 1 to 100');
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      return jsonError(c, 'before must be a positive event ID');
    if (actor !== undefined && (actor.length < 1 || actor.length > 64))
      return jsonError(c, 'actor must be 1-64 characters');
    if (method !== undefined && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
      return jsonError(c, 'invalid method');
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          before === undefined ? undefined : lt(auditEvents.id, before),
          actor === undefined ? undefined : eq(auditEvents.actor, actor),
          method === undefined ? undefined : eq(auditEvents.method, method),
        ),
      )
      .orderBy(desc(auditEvents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json({
      events: page.map((row) => ({
        id: row.id,
        actor: row.actor,
        method: row.method,
        path: row.path,
        status_code: row.statusCode,
        request_id: row.requestId,
        created_at: row.createdAt,
      })),
      next_before: rows.length > limit ? page[page.length - 1].id : null,
    });
  });
}
