/** Explicit, idempotent demo-data import. Never runs during normal startup. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';

const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
try {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].trim();
    process.env[match[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !['--docker', '--sync-urls'].includes(arg))) {
  throw new Error('Usage: pnpm db:seed:dev [--docker] [--sync-urls]');
}
const docker = args.has('--docker');
const syncUrls = args.has('--sync-urls');
if (docker && !process.env.CONFIG_FILE) {
  process.env.CONFIG_FILE = fileURLToPath(new URL('../../../config/docker.json', import.meta.url));
}

interface FixtureInstance { id: string; port: number; dockerHost: string }
interface FixtureServer { name: string; displayName: string; instances: FixtureInstance[] }
const fixture = JSON.parse(readFileSync(new URL('../../../scripts/dev-fixtures.json', import.meta.url), 'utf8')) as {
  servers: FixtureServer[];
};
const { createUserRow, db, initializeDatabase, pool } = await import('./db.js');
const { seedDemoClient } = await import('./clients.js');
const { mcpServerInstances, mcpServers, userServerAccess, users } = await import('./schema.js');

try {
  await initializeDatabase();
  const [previousDemoUser] = await db.select({ id: users.id }).from(users).where(eq(users.username, 'demo-user')).limit(1);
  if (!previousDemoUser && process.env.SEED_DEMO_USER !== '0') {
    await createUserRow('demo-user', process.env.DEMO_PASSWORD ?? 'demo123', 'user');
    console.log('[seed-dev] demo account seeded: demo-user (change/remove for production)');
  }
  await seedDemoClient();

  const now = Date.now();
  await db.transaction(async (tx) => {
    for (const server of fixture.servers) {
      await tx.insert(mcpServers).values({
        name: server.name, displayName: server.displayName, enabled: true, createdAt: now, updatedAt: now,
      }).onConflictDoNothing({ target: mcpServers.name });

      for (const instance of server.instances) {
        const url = `http://${docker ? instance.dockerHost : 'localhost'}:${instance.port}/mcp`;
        const [existing] = await tx.select({ serverName: mcpServerInstances.serverName, url: mcpServerInstances.url })
          .from(mcpServerInstances).where(eq(mcpServerInstances.id, instance.id)).limit(1);
        if (existing) {
          if (existing.serverName !== server.name) throw new Error(`Instance ID ${instance.id} belongs to ${existing.serverName}`);
          if (syncUrls && existing.url !== url) {
            await tx.update(mcpServerInstances).set({ url, updatedAt: now }).where(eq(mcpServerInstances.id, instance.id));
          }
        } else {
          await tx.insert(mcpServerInstances).values({
            id: instance.id, serverName: server.name, url, enabled: true, createdAt: now, updatedAt: now,
          });
        }
      }
    }

    // Grant demo access only when the demo user is first created; rerunning
    // the importer must not undo an administrator's later revocation.
    if (!previousDemoUser && fixture.servers.some((server) => server.name === 'demo')) {
      const [demoUser] = await tx.select({ id: users.id }).from(users).where(eq(users.username, 'demo-user')).limit(1);
      if (demoUser) {
        await tx.insert(userServerAccess).values({ userId: demoUser.id, serverName: 'demo', createdAt: now })
          .onConflictDoNothing({ target: [userServerAccess.userId, userServerAccess.serverName] });
      }
    }
  });
  console.log(`[seed-dev] Imported demo data for ${docker ? 'Docker' : 'local'} networking${syncUrls ? ' (fixture URLs synchronized)' : ' (existing records preserved)'}.`);
} finally {
  await pool.end();
}
