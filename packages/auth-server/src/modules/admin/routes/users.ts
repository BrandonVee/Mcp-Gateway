import { normalizeEmail } from '@mcp/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import { db } from '../../../infrastructure/database/client.js';
import { LockNamespace, lockTransaction } from '../../../infrastructure/database/locks.js';
import { mcpServers, userServerAccess, users } from '../../../infrastructure/database/schema.js';
import { scryptHash } from '../../../infrastructure/security/password.js';
import { jsonError } from '../../../shared/http/responses.js';
import { listServerNamesForUser } from '../../access/grants.js';
import { revokeUserAuthentication } from '../../identity/authentication.js';
import type { AdminRouter } from '../context.js';
import { SERVER_NAME_RE, userCreateSchema } from '../validation.js';
/** Registers users routes under the shared administrator guard. */
export function registerUsersRoutes(router: AdminRouter) {
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

  router.patch('/admin/users/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return jsonError(c, 'invalid user ID');
    const body = await c.req.json().catch(() => ({}));
    const { password, role, disabled, username, email, email_verified } = body as {
      password?: string;
      role?: string;
      disabled?: boolean;
      username?: string;
      email?: string | null;
      email_verified?: boolean;
    };
    if (password !== undefined && (typeof password !== 'string' || password.length < 12 || password.length > 256))
      return jsonError(c, 'password must be 12-256 characters');
    if (role !== undefined && role !== 'admin' && role !== 'user') return jsonError(c, 'role must be admin or user');
    if (disabled !== undefined && typeof disabled !== 'boolean') return jsonError(c, 'disabled must be a boolean');
    if (
      username !== undefined &&
      (typeof username !== 'string' || (!normalizeEmail(username) && !/^[a-zA-Z0-9._-]{2,64}$/.test(username.trim())))
    )
      return jsonError(c, 'invalid_username');
    // null or '' clears the address; anything else must be a valid email.
    let nextEmail = email === undefined ? undefined : email === null || email === '' ? null : normalizeEmail(email);
    if (email !== undefined && email !== null && email !== '' && nextEmail === null)
      return jsonError(c, 'invalid_email');
    if (email_verified !== undefined && typeof email_verified !== 'boolean')
      return jsonError(c, 'email_verified must be a boolean');
    const passwordHash = password === undefined ? undefined : scryptHash(password);
    const result = await db.transaction(async (tx) => {
      // Serialize all administrator lifecycle changes with bootstrap across replicas.
      await lockTransaction(tx, LockNamespace.Administrator, 2);
      const [row] = await tx.select().from(users).where(eq(users.id, id)).for('update').limit(1);
      if (!row) return 'missing';
      const requestedName = username === undefined ? row.username : username.trim();
      const accountEmail = normalizeEmail(requestedName);
      if (accountEmail) {
        // Email accounts have one identity field; reject contradictory updates.
        if (nextEmail !== undefined && nextEmail !== accountEmail) return 'invalid_email';
        nextEmail = accountEmail;
      }
      const nextUsername = accountEmail ?? requestedName;
      const nextRole = role ?? row.role;
      const nextDisabled = disabled ?? row.disabled;
      if (row.role === 'admin' && !row.disabled && (nextRole !== 'admin' || nextDisabled)) {
        const [{ value }] = await tx
          .select({ value: count() })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.disabled, false)));
        if (value <= 1) return 'last_admin';
      }
      if (nextUsername !== row.username) {
        const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.username, nextUsername)).limit(1);
        if (taken) return 'username_taken';
      }
      const emailChanged = nextEmail !== undefined && nextEmail !== row.email;
      if (emailChanged && nextEmail !== null && nextEmail !== undefined) {
        const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, nextEmail)).limit(1);
        if (taken) return 'email_taken';
      }
      const revoke =
        passwordHash !== undefined ||
        (disabled === true && !row.disabled) ||
        nextRole !== row.role ||
        nextUsername !== row.username;
      await tx
        .update(users)
        .set({
          username: nextUsername,
          role: nextRole as 'admin' | 'user',
          disabled: nextDisabled,
          updatedAt: Date.now(),
          ...(passwordHash === undefined ? {} : { passwordHash }),
          // A changed address falls back to unverified unless the admin says otherwise.
          ...(nextEmail === undefined ? {} : { email: nextEmail }),
          ...(emailChanged ? { emailVerified: email_verified ?? false } : {}),
          ...(!emailChanged && email_verified !== undefined ? { emailVerified: email_verified } : {}),
          ...(revoke ? { authVersion: sql`${users.authVersion} + 1` } : {}),
        })
        .where(eq(users.id, id));
      if (revoke) await revokeUserAuthentication(tx, id);
      return 'updated';
    });
    if (result === 'invalid_email') return jsonError(c, 'invalid_email');
    if (result === 'missing') return jsonError(c, 'user not found', 404);
    if (result === 'last_admin') return jsonError(c, 'last_active_admin_required', 409);
    if (result === 'username_taken') return jsonError(c, 'username already exists', 409);
    if (result === 'email_taken') return jsonError(c, 'email already exists', 409);
    return c.json({ ok: true });
  });

  router.delete('/admin/users/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return jsonError(c, 'invalid user ID');
    const result = await db.transaction(async (tx) => {
      await lockTransaction(tx, LockNamespace.Administrator, 2);
      const [row] = await tx
        .select({ role: users.role, disabled: users.disabled })
        .from(users)
        .where(eq(users.id, id))
        .for('update')
        .limit(1);
      if (!row) return 'missing';
      if (row.role === 'admin' && !row.disabled) {
        const [{ value }] = await tx
          .select({ value: count() })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.disabled, false)));
        if (value <= 1) return 'last_admin';
      }
      // Foreign keys remove every cookie, code and refresh token for this immutable user ID.
      await tx.delete(users).where(eq(users.id, id));
      return 'deleted';
    });
    if (result === 'missing') return jsonError(c, 'user not found', 404);
    if (result === 'last_admin') return jsonError(c, 'last_active_admin_required', 409);
    return c.json({ ok: true });
  });
}
