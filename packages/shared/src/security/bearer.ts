import { timingSafeEqual } from 'node:crypto';

/** Internal server-to-server authentication. Empty configured tokens never authorize a request. */
export function bearerTokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!header?.startsWith('Bearer ') || !expected) return false;
  const actual = Buffer.from(header.slice(7).trim());
  const configured = Buffer.from(expected);
  return actual.length === configured.length && timingSafeEqual(actual, configured);
}
