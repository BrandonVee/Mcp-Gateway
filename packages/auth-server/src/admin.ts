import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { jwtVerify } from 'jose';
import { db, getSessionUser } from './db.js';
import { scryptHash } from './users.js';
import type { SigningKeys } from './keys.js';
import type { Context as HonoContext } from 'hono';

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

  // Minimal admin UI (browser, session-cookie auth).
  router.get('/admin', async (c) => {
    if (!(await isAdminRequest(c, deps))) {
      return c.html('<html><body><p>Admin privileges required. <a href="/authorize">Sign in</a> as an admin first.</p></body></html>');
    }
    return c.html(adminPage());
  });

  return router;
}

function adminPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP Auth - Admin</title>
<style>
body{font-family:system-ui;max-width:46rem;margin:3rem auto;color:#222}
table{border-collapse:collapse;width:100%;margin:1rem 0}
td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;font-size:.9rem}
input,select{padding:.35rem;margin:.15rem}
button{padding:.35rem .8rem;cursor:pointer}
.row-actions button{margin-right:.3rem}
.small{color:#777;font-size:.85rem}
</style></head><body>
<h2>User management</h2>
<p class="small">Create users, reset passwords, disable accounts. Changes apply immediately.</p>

<h3>Create user</h3>
<form id="create">
  <input id="username" placeholder="username" required>
  <input id="password" placeholder="password (min 6)" type="password" required>
  <select id="role"><option value="user">user</option><option value="admin">admin</option></select>
  <button type="submit">Create</button>
</form>

<h3>Users</h3>
<table id="users"><thead><tr><th>ID</th><th>Username</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody></tbody></table>
<div class="small" id="msg"></div>

<script>
const msg = (t) => document.getElementById('msg').textContent = t;
async function load() {
  const res = await fetch('/admin/users');
  if (res.status === 403) { document.body.innerHTML = '<p>Admin privileges required.</p>'; return; }
  const { users } = await res.json();
  const tbody = document.querySelector('#users tbody');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + u.id + '</td><td>' + u.username + '</td><td>' + u.role + '</td><td>' + (u.disabled ? 'disabled' : 'active') + '</td>' +
      '<td class="row-actions">' +
      '<button onclick="resetPwd(' + u.id + ')">reset password</button>' +
      '<button onclick="toggle(' + u.id + ',' + u.disabled + ')">' + (u.disabled ? 'enable' : 'disable') + '</button>' +
      (u.username !== 'admin' ? '<button onclick="del(' + u.id + ')">delete</button>' : '') +
      '</td>';
    tbody.appendChild(tr);
  }
}
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) msg((await res.json()).error ?? 'request failed');
  else msg('OK');
  load();
}
function resetPwd(id) { const p = prompt('new password (min 6)'); if (p) api('PATCH', '/admin/users/' + id, { password: p }); }
function toggle(id, disabled) { api('PATCH', '/admin/users/' + id, { disabled: !disabled }); }
function del(id) { if (confirm('delete user?')) api('DELETE', '/admin/users/' + id); }
document.getElementById('create').addEventListener('submit', (e) => {
  e.preventDefault();
  api('POST', '/admin/users', { username: username.value, password: password.value, role: role.value });
});
load();
</script>
</body></html>`;
}
