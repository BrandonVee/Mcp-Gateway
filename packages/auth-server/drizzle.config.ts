import { defineConfig } from 'drizzle-kit';
import { loadPlatformConfig } from '@mcp/shared';

const config = loadPlatformConfig();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/database/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? config.auth.postgres.url },
});
