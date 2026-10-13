import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';

export const SESSION_COOKIE = 'auth_session';
export const cookieName = SESSION_COOKIE;
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

/** A browser session never exposes its token to application JavaScript. */
export function setSessionCookie(c: Context, token: string, issuer: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production' || issuer.startsWith('https:'),
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Delete with the same path used when the session was issued. */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
