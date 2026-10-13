import { createHash, randomInt } from 'node:crypto';

/** Email verification codes contain six decimal digits; store only the SHA-256 digest. */
export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
export function hashVerificationCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
