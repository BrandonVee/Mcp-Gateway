import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadPlatformConfig } from '../packages/shared/src/index.js';

const require = createRequire(new URL('../packages/auth-server/package.json', import.meta.url));
const { Pool } = require('pg');

/** Every migration and fixture is scoped to a random schema; public tables are untouched. */
export async function createIsolatedAuthSchema() {
  const connectionString = process.env.DATABASE_URL ?? loadPlatformConfig().auth.postgres.url;
  const schema = `oauth_test_${randomBytes(12).toString('hex')}`;
  if (!/^[a-z][a-z0-9_]+$/.test(schema)) throw new Error('unsafe schema identifier');
  const adminPool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  let scopedPool: any;
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const databaseUrl = new URL(connectionString);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    scopedPool = new Pool({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 5000 });
    const journal = JSON.parse(await readFile(new URL('../packages/auth-server/drizzle/meta/_journal.json', import.meta.url), 'utf8'));
    for (const entry of journal.entries) {
      const sql = await readFile(new URL(`../packages/auth-server/drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
      // Generated migrations explicitly qualify enums and FKs with "public".
      // Replace that identifier before execution, as search_path cannot redirect it.
      await scopedPool.query(sql.replaceAll('"public"', `"${schema}"`));
    }
    await scopedPool.end();
    scopedPool = undefined;
    return {
      databaseUrl: databaseUrl.toString(),
      async cleanup() { await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`); await adminPool.end(); },
    };
  } catch (error) {
    if (scopedPool) await scopedPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await adminPool.end();
    throw error;
  }
}
