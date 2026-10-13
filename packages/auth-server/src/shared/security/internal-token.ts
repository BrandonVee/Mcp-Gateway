import { bearerTokenMatches } from '@/shared/security/bearer.js';

/** Credential exchange has a separate trust boundary from the routing registry. */
export function internalTokenMatches(header: string | undefined): boolean {
  return bearerTokenMatches(header, process.env.CREDENTIAL_BROKER_TOKEN);
}
