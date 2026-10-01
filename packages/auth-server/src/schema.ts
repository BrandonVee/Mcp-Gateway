import { bigint, bigserial, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';

const epoch = (name: string) => bigint(name, { mode: 'number' }).notNull();
export const userRole = pgEnum('user_role', ['admin', 'user']);

export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('user'),
  disabled: boolean('disabled').notNull().default(false),
  allServers: boolean('all_servers').notNull().default(false),
  createdAt: epoch('created_at'),
  updatedAt: epoch('updated_at'),
});

export const clients = pgTable('clients', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name'),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  createdAt: epoch('created_at'),
});

export const authCodes = pgTable(
  'auth_codes',
  {
    code: text('code').primaryKey(),
    clientId: text('client_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    scope: text('scope').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    resource: text('resource'),
    sub: text('sub').notNull(),
    expiresAt: epoch('expires_at'),
  },
  (table) => [index('idx_codes_expiry').on(table.expiresAt)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    token: text('token').primaryKey(),
    clientId: text('client_id').notNull(),
    sub: text('sub').notNull(),
    scope: text('scope').notNull(),
    resource: text('resource'),
    expiresAt: epoch('expires_at'),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: epoch('created_at'),
  },
  (table) => [index('idx_refresh_expiry').on(table.expiresAt)],
);

export const loginSessions = pgTable('login_sessions', {
  token: text('token').primaryKey(),
  sub: text('sub').notNull(),
  expiresAt: epoch('expires_at'),
});

export const mcpServers = pgTable('mcp_servers', {
  name: text('name').primaryKey(),
  displayName: text('display_name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  signupAccess: boolean('signup_access').notNull().default(false),
  authMode: text('auth_mode').$type<'none' | 'api_key' | 'oauth'>().notNull().default('none'),
  apiKeyHeader: text('api_key_header').notNull().default('authorization'),
  apiKeyPrefix: text('api_key_prefix').notNull().default('Bearer '),
  oauthAuthorizeUrl: text('oauth_authorize_url'),
  oauthTokenUrl: text('oauth_token_url'),
  oauthClientId: text('oauth_client_id'),
  oauthClientSecret: text('oauth_client_secret'),
  oauthScopes: text('oauth_scopes'),
  oauthResource: text('oauth_resource'),
  oauthIssuer: text('oauth_issuer'),
  oauthClientAuthMethod: text('oauth_client_auth_method').$type<'none' | 'client_secret_basic' | 'client_secret_post'>().notNull().default('none'),
  createdAt: epoch('created_at'),
  updatedAt: epoch('updated_at'),
});

export const userMcpCredentials = pgTable(
  'user_mcp_credentials',
  {
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
    serverName: text('server_name').notNull().references(() => mcpServers.name, { onDelete: 'cascade' }),
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
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
    serverName: text('server_name').notNull().references(() => mcpServers.name, { onDelete: 'cascade' }),
    verifier: text('verifier').notNull(),
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
      .references(() => mcpServers.name, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: epoch('created_at'),
    updatedAt: epoch('updated_at'),
  },
  (table) => [
    index('idx_mcp_instance_server').on(table.serverName),
    uniqueIndex('uq_mcp_instance_server_url').on(table.serverName, table.url),
  ],
);

export const userServerAccess = pgTable(
  'user_server_access',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverName: text('server_name')
      .notNull()
      .references(() => mcpServers.name, { onDelete: 'cascade' }),
    createdAt: epoch('created_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.serverName] }),
    index('idx_user_server_name').on(table.serverName),
  ],
);

export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** Metadata-only admin audit trail. Never store request bodies, tokens or secrets. */
export const auditEvents = pgTable('audit_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actor: text('actor').notNull(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  statusCode: integer('status_code').notNull(),
  requestId: text('request_id').notNull(),
  createdAt: epoch('created_at'),
}, (table) => [
  index('idx_audit_created_at').on(table.createdAt),
  index('idx_audit_actor_created_at').on(table.actor, table.createdAt),
]);

export const mcpEventReceipts = pgTable('mcp_event_receipts', {
  id: text('id').primaryKey(), receivedAt: epoch('received_at'),
}, table => [index('idx_mcp_receipts_time').on(table.receivedAt)]);
export const mcpCallEvents = pgTable('mcp_call_events', {
  id: text('id').primaryKey(), requestId: text('request_id').notNull(), startedAt: epoch('started_at'), finishedAt: epoch('finished_at'),
  userId: bigint('user_id', { mode: 'number' }).notNull(), username: text('username').notNull(), clientId: text('client_id').notNull(),
  server: text('server').notNull(), method: text('method').notNull(), tool: text('tool').notNull(), outcome: text('outcome').notNull(),
  httpStatus: integer('http_status').notNull(), durationMs: bigint('duration_ms', { mode: 'number' }),
  error: text('error').notNull(), instance: text('instance').notNull(), attempts: integer('attempts').notNull(),
}, table => [index('idx_mcp_calls_time').on(table.startedAt), index('idx_mcp_calls_server_time').on(table.server, table.startedAt)]);
export const mcpCallMetrics = pgTable('mcp_call_metrics', {
  minute: epoch('minute'), server: text('server').notNull(), method: text('method').notNull(), tool: text('tool').notNull(),
  userId: bigint('user_id', { mode: 'number' }).notNull(), clientId: text('client_id').notNull(), username: text('username').notNull(),
  outcome: text('outcome').notNull(), calls: bigint('calls', { mode: 'number' }).notNull(),
  durationSum: bigint('duration_sum', { mode: 'number' }).notNull(), durationCount: bigint('duration_count', { mode: 'number' }).notNull(),
  histogram: bigint('histogram', { mode: 'number' }).array().notNull(),
}, table => [primaryKey({ columns: [table.minute, table.server, table.method, table.tool, table.userId, table.clientId, table.outcome] }), index('idx_mcp_metrics_time').on(table.minute)]);
