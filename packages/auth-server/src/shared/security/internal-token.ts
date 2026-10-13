import { timingSafeEqual } from 'node:crypto';

/** Compare only nonempty expected tokens; never fall back to accepting anonymous internal calls. */
export function bearerTokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!header?.startsWith('Bearer ') || !expected) return false;
  const actual = Buffer.from(header.slice(7).trim()),
    configured = Buffer.from(expected);
  return actual.length === configured.length && timingSafeEqual(actual, configured);
}

/** Credential exchange has a separate trust boundary from the routing registry. */
export function internalTokenMatches(header: string | undefined): boolean {
  return bearerTokenMatches(header, process.env.CREDENTIAL_BROKER_TOKEN);
}
