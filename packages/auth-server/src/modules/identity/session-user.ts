import { eq } from 'drizzle-orm';
import { type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { db } from '../../infrastructure/database/client.js';
import { users } from '../../infrastructure/database/schema.js';
import { SESSION_COOKIE } from '../../shared/http/session-cookie.js';
import { getSessionUser } from './sessions.js';

/** 浏览器身份快照来自当前用户行；禁用、账号更名或认证版本变化立即使旧会话失效。 */
export type User = {
  id: number;
  username: string;
  role: 'admin' | 'user';
  allServers: boolean;
  authVersion: number;
  email: string | null;
  emailVerified: boolean;
};

/** 业务路由共用这项身份解析能力，不依赖任何路由注册模块。 */
export async function currentUser(c: Context): Promise<User | null> {
  const token = getCookie(c, SESSION_COOKIE);
  const session = token ? await getSessionUser(token) : null;
  if (!session) return null;
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      disabled: users.disabled,
      allServers: users.allServers,
      authVersion: users.authVersion,
      email: users.email,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  return user && !user.disabled && user.username === session.sub && user.authVersion === session.userAuthVersion
    ? {
        id: user.id,
        username: user.username,
        role: user.role,
        allServers: user.allServers,
        authVersion: user.authVersion,
        email: user.email,
        emailVerified: user.emailVerified,
      }
    : null;
}
