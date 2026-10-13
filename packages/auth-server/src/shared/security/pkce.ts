import { createHash, randomBytes } from 'node:crypto';

/** Independent 256-bit state and verifier; persist the verifier only on the server. */
export function createPkceAuthorization() {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  return { state, verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
