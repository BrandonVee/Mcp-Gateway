import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { jwtVerify } from 'jose';
import { db, getSessionUser } from './db.js';
import { scryptHash } from './users.js';
import type { SigningKeys } from './keys.js';
import type { Context as HonoContext } from 'hono';

const ADMIN_WEB_URL = process.env.ADMIN_WEB_URL ?? 'http://localhost:5173';

export interface AdminDeps {
  keys: SigningKeys;
  issuer: string;
}

interface UserRow {
  id: number;
  username: string;
  role: string;
  disabled: number;
  created_at: number;
}

async function isAdminRequest(c: HonoContext, deps: AdminDeps): Promise<boolean> {
  // 1) Bearer JWT with role=admin
  const header = c.req.header('authorization');
  if (header?.startsWith('Bearer ')) {
    try {
      const { payload } = await jwtVerify(header.slice(7).trim(), deps.keys.publicJwk, { issuer: deps.issuer });
      if (payload.role === 'admin') return true;
    } catch {
      /* fall through to cookie */
    }
  }
  // 2) browser session cookie of an admin user
  const cookie = getCookie(c, 'auth_session');
  if (cookie) {
    const session = getSessionUser(cookie);
    if (session) {
      const row = db.prepare('SELECT role FROM users WHERE username = ?').get(session.sub) as { role: string } | undefined;
      if (row?.role === 'admin') return true;
    }
  }
  return false;
}

function jsonError(c: HonoContext, message: string, status: 400 | 403 | 404 | 409 = 400) {
  return c.json({ error: message }, status);
}

export function createAdminRouter(deps: AdminDeps): Hono {
  const router = new Hono();

  // Guard everything under /admin.
  router.use('/admin/*', async (c, next) => {
    if (c.req.path === '/admin') {
      await next();
      return;
    }
    if (!(await isAdminRequest(c, deps))) return jsonError(c, 'admin privileges required', 403);
    await next();
  });

  router.get('/admin/users', (c) => {
    const rows = db.prepare('SELECT id, username, role, disabled, created_at FROM users ORDER BY id').all() as unknown as UserRow[];
    return c.json({
      users: rows.map((u) => ({ id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, created_at: u.created_at })),
    });
  });

  router.post('/admin/users', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { username, password, role } = body as { username?: string; password?: string; role?: string };
    if (!username || !/^[a-zA-Z0-9._-]{2,64}$/.test(username)) return jsonError(c, 'username must be 2-64 chars [a-zA-Z0-9._-]');
    if (!password || password.length < 6) return jsonError(c, 'password must be at least 6 characters');
    const userRole = role ?? 'user';
    if (userRole !== 'admin' && userRole !== 'user') return jsonError(c, 'role must be admin or user');
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) return jsonError(c, 'username already exists', 409);
    const now = Date.now();
    const result = db
      .prepare('INSERT INTO users (username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(username, scryptHash(password), userRole, now, now);
    return c.json({ id: Number(result.lastInsertRowid), username, role: userRole, disabled: false }, 201);
  });

  router.patch('/admin/users/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const row = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as { id: number; username: string } | undefined;
    if (!row) return jsonError(c, 'user not found', 404);
    const body = await c.req.json().catch(() => ({}));
    const { password, role, disabled } = body as { password?: string; role?: string; disabled?: boolean };
    if (password !== undefined) {
      if (password.length < 6) return jsonError(c, 'password must be at least 6 characters');
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(scryptHash(password), Date.now(), id);
    }
    if (role !== undefined) {
      if (role !== 'admin' && role !== 'user') return jsonError(c, 'role must be admin or user');
      if (row.username === 'admin' && role !== 'admin') return jsonError(c, 'cannot demote the bootstrap admin');
      db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, Date.now(), id);
    }
    if (disabled !== undefined) {
      if (row.username === 'admin' && disabled) return jsonError(c, 'cannot disable the bootstrap admin');
      db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?').run(disabled ? 1 : 0, Date.now(), id);
    }
    return c.json({ ok: true });
  });

  router.delete('/admin/users/:id', (c) => {
    const id = Number(c.req.param('id'));
    const row = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as { id: number; username: string } | undefined;
    if (!row) return jsonError(c, 'user not found', 404);
    if (row.username === 'admin') return jsonError(c, 'cannot delete the bootstrap admin');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  // Keep a single entry point; the React application owns login and UI rendering.
  router.get('/admin', (c) => c.redirect(ADMIN_WEB_URL, 302));

  return router;
}
