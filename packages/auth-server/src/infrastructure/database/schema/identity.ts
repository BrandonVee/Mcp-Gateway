import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { epoch } from '@/auth/infrastructure/database/schema/helpers.js';

export const userRole = pgEnum('user_role', ['admin', 'user']);

export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('user'),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    disabled: boolean('disabled').notNull().default(false),
    allServers: boolean('all_servers').notNull().default(false),
    authVersion: integer('auth_version').notNull().default(0),
    createdAt: epoch('created_at'),
    updatedAt: epoch('updated_at'),
  },
  // Postgres treats NULLs as distinct, so only real addresses are unique.
  (table) => [uniqueIndex('uq_users_email').on(table.email)],
);

/** One active verification code per user; replaced on every resend. */
export const emailVerificationCodes = pgTable(
  'email_verification_codes',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: epoch('expires_at'),
    createdAt: epoch('created_at'),
  },
  (table) => [primaryKey({ columns: [table.userId] })],
);

export const loginSessions = pgTable('login_sessions', {
  token: text('token').primaryKey(),
  sub: text('sub').notNull(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  userAuthVersion: integer('user_auth_version').notNull(),
  expiresAt: epoch('expires_at'),
});

/** Pending verification belongs to an email address before an account exists. */
export const signupEmailCodes = pgTable(
  'signup_email_codes',
  {
    email: text('email').primaryKey(),
    codeHash: text('code_hash').notNull(),
    expiresAt: epoch('expires_at'),
    createdAt: epoch('created_at'),
  },
  (table) => [index('idx_signup_email_codes_expiry').on(table.expiresAt)],
);
