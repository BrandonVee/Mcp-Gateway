import type { Context as HonoContext } from 'hono';
import { randomUUID } from 'node:crypto';
import { db } from '@/auth/infrastructure/database/client.js';
import { auditEvents } from '@/auth/infrastructure/database/schema.js';

export async function recordAudit(c: HonoContext, actor: string, statusCode: number): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      actor,
      method: c.req.method,
      path: c.req.path,
      statusCode,
      requestId: c.res.headers.get('x-request-id') ?? randomUUID(),
      createdAt: Date.now(),
    });
  } catch (error) {
    // A failed audit insert must be visible in runtime logs, even if the
    // already-executed admin operation cannot be rolled back here.
    console.error('[audit] insert failed', error);
  }
}
