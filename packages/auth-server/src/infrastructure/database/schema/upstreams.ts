import { bigint, boolean, index, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { epoch } from '@/auth/infrastructure/database/schema/helpers.js';
import { users } from '@/auth/infrastructure/database/schema/identity.js';
import { upstreamAuthColumns } from '@/auth/infrastructure/database/schema/upstream-auth.js';

export const mcpServers = pgTable('mcp_servers', {
  routingMode: text('routing_mode').$type<'pool' | 'aggregate'>().notNull().default('aggregate'),
  name: text('name').primaryKey(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  signupAccess: boolean('signup_access').notNull().default(false),
  ...upstreamAuthColumns(),
  createdAt: epoch('created_at'),
  updatedAt: epoch('updated_at'),
});

export const userMcpCredentials = pgTable(
  'user_mcp_credentials',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverName: text('server_name')
      .notNull()
      .references(() => mcpServers.name, { onDelete: 'cascade', onUpdate: 'cascade' }),
    mode: text('mode').$type<'api_key' | 'oauth'>().notNull(),
    secret: text('secret').notNull(),
    refreshSecret: text('refresh_secret'),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    updatedAt: epoch('updated_at'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.serverName] })],
);

export const oauthConnectionStates = pgTable(
  'oauth_connection_states',
  {
    state: text('state').primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverName: text('server_name')
      .notNull()
      .references(() => mcpServers.name, { onDelete: 'cascade', onUpdate: 'cascade' }),
    verifier: text('verifier').notNull(),
    authRevision: bigint('auth_revision', { mode: 'number' }).notNull().default(0),
    expiresAt: epoch('expires_at'),
  },
  (table) => [index('idx_oauth_connection_state_expiry').on(table.expiresAt)],
);

export const mcpServerInstances = pgTable(
  'mcp_server_instances',
  {
    id: text('id').primaryKey(),
    serverName: text('server_name')
      .notNull()
      .references(() => mcpServers.name, { onDelete: 'cascade', onUpdate: 'cascade' }),
    url: text('url').notNull(),
    displayName: text('display_name').notNull().default(''),
    ...upstreamAuthColumns(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: epoch('created_at'),
    updatedAt: epoch('updated_at'),
  },
  (table) => [
    index('idx_mcp_instance_server').on(table.serverName),
    uniqueIndex('uq_mcp_instance_server_url').on(table.serverName, table.url),
  ],
);

/** Credentials belong to a concrete upstream, never to the endpoint group. */
export const upstreamCredentials = pgTable(
  'upstream_credentials',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => mcpServerInstances.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(), // "system" or "user:<id>"
    userId: bigint('user_id', { mode: 'number' }).references(() => users.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<'api_key' | 'oauth'>().notNull(),
    secret: text('secret').notNull(),
    refreshSecret: text('refresh_secret'),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    updatedAt: epoch('updated_at'),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.owner] })],
);

export const upstreamOAuthStates = pgTable(
  'upstream_oauth_states',
  {
    state: text('state').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => mcpServerInstances.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    system: boolean('system').notNull().default(false),
    exchanging: boolean('exchanging').notNull().default(false),
    verifier: text('verifier').notNull(),
    authRevision: bigint('auth_revision', { mode: 'number' }).notNull(),
    expiresAt: epoch('expires_at'),
  },
  (table) => [index('idx_upstream_oauth_state_expiry').on(table.expiresAt)],
);

export const userServerAccess = pgTable(
  'user_server_access',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverName: text('server_name')
      .notNull()
      .references(() => mcpServers.name, { onDelete: 'cascade', onUpdate: 'cascade' }),
    createdAt: epoch('created_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.serverName] }),
    index('idx_user_server_name').on(table.serverName),
  ],
);
