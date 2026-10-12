/** Verify that v0.12.0 data becomes separately scoped upstream configuration. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createIsolatedAuthSchema } from './isolated-auth-schema.js';
const { Pool } = createRequire(new URL('../packages/auth-server/package.json', import.meta.url))('pg');
async function main() {
  const isolated = await createIsolatedAuthSchema({ through: 18 });
  const pool = new Pool({ connectionString: isolated.databaseUrl });
  try {
    await pool.query(
      "INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES ('migration-user', 'unused', 'user', 0, 0)",
    );
    await pool.query(
      "INSERT INTO mcp_servers (name, display_name, auth_mode, api_key_header, api_key_prefix, system_api_key, created_at, updated_at) VALUES ('legacy', 'Legacy', 'system_api_key', 'x-api-key', '', 'encrypted-system-key', 0, 0)",
    );
    await pool.query(
      "INSERT INTO mcp_server_instances (id, server_name, url, created_at, updated_at) VALUES ('one', 'legacy', 'https://one.test/mcp', 0, 0), ('two', 'legacy', 'https://two.test/mcp', 0, 0)",
    );
    await pool.query(
      "INSERT INTO user_server_access (user_id, server_name, created_at) SELECT id, 'legacy', 0 FROM users",
    );
    await pool.query(
      "INSERT INTO user_mcp_credentials (user_id, server_name, mode, secret, refresh_secret, expires_at, updated_at) SELECT id, 'legacy', 'oauth', 'encrypted-access', 'encrypted-refresh', 12345, 0 FROM users",
    );
    const journal = JSON.parse(
      await readFile(new URL('../packages/auth-server/drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    for (const entry of journal.entries.filter((e: any) => e.idx > 18)) {
      const sql = await readFile(new URL(`../packages/auth-server/drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
      await pool.query(sql.replaceAll('"public"', `"${isolated.schema}"`));
    }
    const instances = (await pool.query('SELECT * FROM mcp_server_instances ORDER BY id')).rows;
    assert.equal(instances.length, 2);
    assert.ok(
      instances.every(
        (s: any) =>
          s.auth_mode === 'system_api_key' &&
          s.system_api_key === 'encrypted-system-key' &&
          s.api_key_header === 'x-api-key' &&
          s.api_key_prefix === '',
      ),
    );
    const credentials = (await pool.query('SELECT * FROM upstream_credentials ORDER BY instance_id')).rows;
    assert.equal(credentials.length, 2);
    assert.ok(
      credentials.every(
        (r: any) =>
          r.secret === 'encrypted-access' &&
          r.refresh_secret === 'encrypted-refresh' &&
          Number(r.expires_at) === 12345 &&
          r.owner === `user:${r.user_id}`,
      ),
    );
    assert.equal(
      (await pool.query('SELECT routing_mode FROM mcp_servers')).rows[0].routing_mode,
      'pool',
      'existing replicas retain routing behavior',
    );
    await pool.query("UPDATE mcp_servers SET name='renamed' WHERE name='legacy'");
    assert.equal((await pool.query('SELECT server_name FROM user_server_access')).rows[0].server_name, 'renamed');
    assert.ok(
      (await pool.query('SELECT server_name FROM mcp_server_instances')).rows.every(
        (r: any) => r.server_name === 'renamed',
      ),
    );
    assert.equal((await pool.query('SELECT COUNT(*) FROM upstream_credentials')).rows[0].count, '2');
    await pool.query("DELETE FROM mcp_server_instances WHERE id='one'");
    assert.equal((await pool.query('SELECT COUNT(*) FROM upstream_credentials')).rows[0].count, '1');
    console.log(
      'PASS: migration copies independent upstream auth and encrypted user OAuth credentials, preserves grants and legacy routing, and cascades renames/deletions',
    );
  } finally {
    await pool.end();
    await isolated.cleanup();
  }
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
