import { loadPlatformConfig } from '@mcp/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

const platformConfig = loadPlatformConfig();

const postgresConfig = platformConfig.auth.postgres;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? postgresConfig.url,
  max: Number(process.env.PG_POOL_MAX ?? postgresConfig.poolMax),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

// Idle client errors must be observed; otherwise a broken PostgreSQL connection can crash Node.
pool.on('error', (error) => console.error('[postgres] idle client error', error));

export const db = drizzle(pool, { schema });

export type AuthTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
