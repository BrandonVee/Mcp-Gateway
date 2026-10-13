import { bigint, boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { epoch } from '@/auth/infrastructure/database/schema/helpers.js';
import { users } from '@/auth/infrastructure/database/schema/identity.js';

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
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userAuthVersion: integer('user_auth_version').notNull(),
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
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userAuthVersion: integer('user_auth_version').notNull(),
    scope: text('scope').notNull(),
    resource: text('resource'),
    expiresAt: epoch('expires_at'),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: epoch('created_at'),
  },
  (table) => [index('idx_refresh_expiry').on(table.expiresAt)],
);
