import { sql } from 'drizzle-orm';
import type { AuthTransaction } from '@/auth/infrastructure/database/client.js';

/** Namespace values are stable across replicas and mixed-version rolling upgrades. */
export const LockNamespace = { Administrator: 762441, LegacyConnection: 80447, UpstreamCredential: 80448 } as const;

/** Transaction locks are released by PostgreSQL on commit/rollback, including exceptions. */
export async function lockTransaction(
  tx: AuthTransaction,
  namespace: number,
  identity: number | string,
): Promise<void> {
  await tx.execute(
    typeof identity === 'string'
      ? sql`select pg_advisory_xact_lock(${namespace}, hashtext(${identity}))`
      : sql`select pg_advisory_xact_lock(${namespace}, ${identity})`,
  );
}
