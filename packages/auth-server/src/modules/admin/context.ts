import { and, eq } from 'drizzle-orm';
import type { Hono, Context as HonoContext } from 'hono';
import { getCookie } from 'hono/cookie';
import { jwtVerify } from 'jose';
import { db } from '../../infrastructure/database/client.js';
import { users } from '../../infrastructure/database/schema.js';
import { trustedAdminBearerClient } from '../../shared/security/admin-bearer.js';
import { getSessionUser } from '../identity/sessions.js';
import type { SigningKeys } from '../oauth/keys.js';

export interface AdminDeps {
  keys: SigningKeys;
  issuer: string;
}

export async function getAdminActor(c: HonoContext, deps: AdminDeps): Promise<string | null> {
  const isActiveAdmin = async (userId: unknown, username: string, authVersion: unknown): Promise<boolean> => {
    if (
      typeof userId !== 'number' ||
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      typeof authVersion !== 'number' ||
      !Number.isSafeInteger(authVersion) ||
      authVersion < 0
    )
      return false;
    const [row] = await db
      .select({ role: users.role, disabled: users.disabled })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.username, username), eq(users.authVersion, authVersion)))
      .limit(1);
    return row?.role === 'admin' && !row.disabled;
  };
  // 1) Bearer JWT with role=admin
  const header = c.req.header('authorization');
  if (header?.startsWith('Bearer ')) {
    try {
      const { payload } = await jwtVerify(header.slice(7).trim(), deps.keys.publicJwk, {
        issuer: deps.issuer,
        ...(process.env.NODE_ENV === 'production' ? { audience: `${deps.issuer}/admin` } : {}),
      });
      if (
        payload.role === 'admin' &&
        typeof payload.sub === 'string' &&
        trustedAdminBearerClient(payload.client_id) &&
        (await isActiveAdmin(payload.uid, payload.sub, payload.auth_version ?? 0))
      )
        return payload.sub;
    } catch {
      /* An invalid explicit credential must not fall back to a browser cookie. */
    }
    return null;
  }
  // 2) browser session cookie of an admin user
  const cookie = getCookie(c, 'auth_session');
  if (cookie) {
    const session = await getSessionUser(cookie);
    if (session && (await isActiveAdmin(session.userId, session.sub, session.userAuthVersion))) return session.sub;
  }
  return null;
}

/** The guard sets this actor only after current database authorization succeeds. */
export type AdminEnvironment = { Variables: { adminActor: string } };
export type AdminRouter = Hono<AdminEnvironment>;
