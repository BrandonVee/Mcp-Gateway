import { normalizeEmail } from '@mcp/shared';
import { eq } from 'drizzle-orm';
import { db } from '@/auth/infrastructure/database/client.js';
import { mcpServers, userServerAccess, users } from '@/auth/infrastructure/database/schema.js';
import { scryptHash } from '@/auth/infrastructure/security/password.js';
import { jsonError } from '@/auth/shared/http/responses.js';
import { listServerNamesForUser, replaceUserServers } from '@/auth/modules/access/grants.js';
import type { AdminRouter } from '@/auth/modules/admin/context.js';
import { SERVER_NAME_RE, userCreateSchema } from '@/auth/modules/admin/validation.js';
/** Registers grants routes under the shared administrator guard. */
export function registerGrantsRoutes(router: AdminRouter) {
  router.get('/admin/users', async (c) => {
    const userRows = await db.select().from(users).orderBy(users.id);
    const activeAdminCount = userRows.filter((user) => user.role === 'admin' && !user.disabled).length;
    const userDtos = await Promise.all(
      userRows.map(async (u) => {
        const protectedAdmin = u.role === 'admin' && !u.disabled && activeAdminCount <= 1;
        return {
          id: u.id,
          username: u.username,
          role: u.role,
          email: u.email,
          email_verified: u.emailVerified,
          disabled: u.disabled,
          can_disable: !protectedAdmin,
          can_delete: !protectedAdmin,
          servers: u.role === 'admin' || u.allServers ? ['*'] : await listServerNamesForUser(u.id),
          created_at: u.createdAt,
        };
      }),
    );
    return c.json({
      users: userDtos,
    });
  });

  router.post('/admin/users', async (c) => {
    const parsed = userCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      return jsonError(
        c,
        field === 'username' ? 'invalid_username' : field === 'password' ? 'invalid_password' : 'invalid_user_payload',
      );
    }
    const { username: rawUsername, password, role: userRole, servers } = parsed.data;
    const username = normalizeEmail(rawUsername)!;
    const rawEmail = username;
    const email = rawEmail === undefined || rawEmail === '' ? null : normalizeEmail(rawEmail);
    if (rawEmail !== undefined && rawEmail !== '' && !email) return jsonError(c, 'invalid_email');
    const requestedServers = userRole === 'admin' ? [] : [...new Set(servers ?? [])];
    if (requestedServers.includes('*') && requestedServers.length !== 1)
      return jsonError(c, 'wildcard must be the only server grant');
    for (const name of requestedServers) {
      if (name === '*') continue;
      const [server] = await db
        .select({ name: mcpServers.name })
        .from(mcpServers)
        .where(eq(mcpServers.name, name))
        .limit(1);
      if (!SERVER_NAME_RE.test(name) || !server) {
        return c.json({ error: 'unknown_server', server: name }, 400);
      }
    }
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing) {
      return jsonError(c, 'username already exists', 409);
    }
    if (email) {
      const [emailOwner] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (emailOwner) return jsonError(c, 'email already exists', 409);
    }
    const now = Date.now();
    const created = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          username,
          passwordHash: scryptHash(password),
          role: userRole,
          email,
          emailVerified: false,
          allServers: userRole !== 'admin' && requestedServers.includes('*'),
          disabled: false,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: users.username })
        .returning({ id: users.id });
      if (!created) return null;
      if (userRole !== 'admin' && !requestedServers.includes('*') && requestedServers.length)
        await tx
          .insert(userServerAccess)
          .values(requestedServers.map((serverName) => ({ userId: created.id, serverName, createdAt: now })));
      return created;
    });
    if (!created) return jsonError(c, 'username already exists', 409);
    const id = created.id;
    return c.json(
      {
        id,
        username,
        role: userRole,
        email,
        email_verified: false,
        disabled: false,
        servers: userRole === 'admin' ? ['*'] : requestedServers,
      },
      201,
    );
  });

  router.get('/admin/users/:id/servers', async (c) => {
    const id = Number(c.req.param('id'));
    const [row] = await db
      .select({ id: users.id, role: users.role, allServers: users.allServers })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!row) return jsonError(c, 'user not found', 404);
    return c.json({
      user_id: id,
      servers: row.role === 'admin' || row.allServers ? ['*'] : await listServerNamesForUser(id),
    });
  });

  /** Replace all grants for a user. This is the user <-> server many-to-many edge API. */
  router.put('/admin/users/:id/servers', async (c) => {
    const id = Number(c.req.param('id'));
    const [user] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id)).limit(1);
    if (!user) return jsonError(c, 'user not found', 404);
    if (user.role === 'admin') return jsonError(c, 'admins already have access to every server');
    const body = (await c.req.json().catch(() => ({}))) as { servers?: unknown };
    if (!Array.isArray(body.servers) || !body.servers.every((name) => typeof name === 'string')) {
      return jsonError(c, 'servers must be an array of server names');
    }
    const names = [...new Set(body.servers as string[])];
    if (names.includes('*') && names.length !== 1) return jsonError(c, 'wildcard must be the only server grant');
    for (const name of names) {
      if (name === '*') continue;
      const [server] = await db
        .select({ name: mcpServers.name })
        .from(mcpServers)
        .where(eq(mcpServers.name, name))
        .limit(1);
      if (!SERVER_NAME_RE.test(name) || !server) {
        return c.json({ error: 'unknown_server', server: name }, 400);
      }
    }
    await replaceUserServers(id, names);
    return c.json({ user_id: id, servers: names });
  });

  /** Server-centric view of the same user <-> server grants. Admins have implicit access. */
  router.get('/admin/servers/:name/users', async (c) => {
    const name = c.req.param('name');
    const [server] = await db
      .select({ name: mcpServers.name, signupAccess: mcpServers.signupAccess })
      .from(mcpServers)
      .where(eq(mcpServers.name, name))
      .limit(1);
    if (!server) return jsonError(c, 'server not found', 404);
    const grants = await db
      .select({ userId: userServerAccess.userId })
      .from(userServerAccess)
      .where(eq(userServerAccess.serverName, name))
      .orderBy(userServerAccess.userId);
    return c.json({
      server_name: name,
      signup_access: server.signupAccess,
      user_ids: grants.map((grant) => grant.userId),
    });
  });

  router.put('/admin/servers/:name/users', async (c) => {
    const name = c.req.param('name');
    const [server] = await db
      .select({ name: mcpServers.name })
      .from(mcpServers)
      .where(eq(mcpServers.name, name))
      .limit(1);
    if (!server) return jsonError(c, 'server not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as { user_ids?: unknown; signup_access?: unknown };
    if (body.signup_access !== undefined && typeof body.signup_access !== 'boolean')
      return jsonError(c, 'signup_access must be a boolean');
    if (!Array.isArray(body.user_ids) || !body.user_ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
      return jsonError(c, 'user_ids must be an array of positive integer IDs');
    }
    const ids = [...new Set(body.user_ids as number[])];
    const candidates = await db.select({ id: users.id, role: users.role, allServers: users.allServers }).from(users);
    const ordinaryIds = new Set(
      candidates.filter((user) => user.role === 'user' && !user.allServers).map((user) => user.id),
    );
    if (ids.some((id) => !ordinaryIds.has(id)))
      return jsonError(c, 'user_ids must refer to ordinary users without wildcard access');
    await db.transaction(async (tx) => {
      if (typeof body.signup_access === 'boolean')
        await tx
          .update(mcpServers)
          .set({ signupAccess: body.signup_access, updatedAt: Date.now() })
          .where(eq(mcpServers.name, name));
      await tx.delete(userServerAccess).where(eq(userServerAccess.serverName, name));
      if (ids.length)
        await tx
          .insert(userServerAccess)
          .values(ids.map((userId) => ({ userId, serverName: name, createdAt: Date.now() })));
    });
    return c.json({ server_name: name, signup_access: body.signup_access, user_ids: ids });
  });
}
