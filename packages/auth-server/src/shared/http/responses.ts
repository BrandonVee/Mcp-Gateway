import type { Context } from 'hono';

/** Preserve the public error envelope and status vocabulary across route modules. */
export function jsonError(c: Context, message: string, status: 400 | 403 | 404 | 409 = 400) {
  return c.json({ error: message }, status);
}
