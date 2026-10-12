/** Fixtures for disposable smoke-test databases only; never used during normal startup. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a disposable smoke-test database');

if (process.env.NODE_ENV === 'production') throw new Error('Smoke fixtures cannot be seeded in production');

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !['--docker', '--sync-urls'].includes(arg))) {
  throw new Error('Usage: pnpm --filter @mcp/test-upstream seed [--docker] [--sync-urls]');
}
const docker = args.has('--docker');
const syncUrls = args.has('--sync-urls');
if (docker && !process.env.CONFIG_FILE) {
  process.env.CONFIG_FILE = fileURLToPath(new URL('../../../config/docker.json', import.meta.url));
}

interface FixtureInstance {
  id: string;
  port: number;
  dockerHost: string;
}
interface FixtureServer {
  name: string;
  displayName: string;
  instances: FixtureInstance[];
}
const fixture = JSON.parse(readFileSync(new URL('../servers.json', import.meta.url), 'utf8')) as {
  servers: FixtureServer[];
};
const { createUserRow, db, initializeDatabase, pool } = await import('../../../packages/auth-server/src/db.js');
const { clients, mcpServerInstances, mcpServers, userServerAccess, users } =
  await import('../../../packages/auth-server/src/schema.js');

try {
  await initializeDatabase();
  const [previousDemoUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, 'demo-user'))
    .limit(1);
  if (!previousDemoUser && process.env.SEED_DEMO_USER !== '0') {
    await createUserRow('demo-user', process.env.DEMO_PASSWORD ?? 'demo123', 'user');
    console.log('[seed-smoke] demo account seeded: demo-user (change/remove for production)');
  }
  await db
    .insert(clients)
    .values({
      clientId: 'demo-client',
      clientName: 'Smoke Test Client',
      redirectUris: ['http://localhost:8080/callback', 'http://127.0.0.1:8080/callback'],
      createdAt: Date.now(),
    })
    .onConflictDoNothing({ target: clients.clientId });

  const now = Date.now();
  await db.transaction(async (tx) => {
    for (const server of fixture.servers) {
      await tx
        .insert(mcpServers)
        .values({
          name: server.name,
          displayName: server.displayName,
          routingMode: 'pool',
          enabled: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: mcpServers.name });

      for (const instance of server.instances) {
        const url = `http://${docker ? instance.dockerHost : 'localhost'}:${instance.port}/mcp`;
        const [existing] = await tx
          .select({ serverName: mcpServerInstances.serverName, url: mcpServerInstances.url })
          .from(mcpServerInstances)
          .where(eq(mcpServerInstances.id, instance.id))
          .limit(1);
        if (existing) {
          if (existing.serverName !== server.name)
            throw new Error(`Instance ID ${instance.id} belongs to ${existing.serverName}`);
          if (syncUrls && existing.url !== url) {
            await tx
              .update(mcpServerInstances)
              .set({ url, updatedAt: now })
              .where(eq(mcpServerInstances.id, instance.id));
          }
        } else {
          await tx.insert(mcpServerInstances).values({
            id: instance.id,
            serverName: server.name,
            url,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }

    // Grant demo access only when the demo user is first created; rerunning
    // the importer must not undo an administrator's later revocation.
    if (!previousDemoUser && fixture.servers.some((server) => server.name === 'demo')) {
      const [demoUser] = await tx.select({ id: users.id }).from(users).where(eq(users.username, 'demo-user')).limit(1);
      if (demoUser) {
        await tx
          .insert(userServerAccess)
          .values({ userId: demoUser.id, serverName: 'demo', createdAt: now })
          .onConflictDoNothing({ target: [userServerAccess.userId, userServerAccess.serverName] });
      }
    }
  });
  console.log(
    `[seed-smoke] Imported demo data for ${docker ? 'Docker' : 'local'} networking${syncUrls ? ' (fixture URLs synchronized)' : ' (existing records preserved)'}.`,
  );
} finally {
  await pool.end();
}
