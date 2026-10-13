import {
  bigint,
  bigserial,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { epoch } from './helpers.js';

/** Metadata-only admin audit trail. Never store request bodies, tokens or secrets. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actor: text('actor').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    requestId: text('request_id').notNull(),
    createdAt: epoch('created_at'),
  },
  (table) => [
    index('idx_audit_created_at').on(table.createdAt),
    index('idx_audit_actor_created_at').on(table.actor, table.createdAt),
  ],
);

export const mcpEventReceipts = pgTable(
  'mcp_event_receipts',
  {
    id: text('id').primaryKey(),
    receivedAt: epoch('received_at'),
  },
  (table) => [index('idx_mcp_receipts_time').on(table.receivedAt)],
);

export const mcpCallEvents = pgTable(
  'mcp_call_events',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    startedAt: epoch('started_at'),
    finishedAt: epoch('finished_at'),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    username: text('username').notNull(),
    clientId: text('client_id').notNull(),
    server: text('server').notNull(),
    method: text('method').notNull(),
    tool: text('tool').notNull(),
    outcome: text('outcome').notNull(),
    httpStatus: integer('http_status').notNull(),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    error: text('error').notNull(),
    instance: text('instance').notNull(),
    attempts: integer('attempts').notNull(),
    input: text('input'),
    output: text('output'),
  },
  (table) => [
    index('idx_mcp_calls_user_time').on(table.userId, table.startedAt),
    index('idx_mcp_calls_time').on(table.startedAt),
    index('idx_mcp_calls_server_time').on(table.server, table.startedAt),
  ],
);

export const mcpCallMetrics = pgTable(
  'mcp_call_metrics',
  {
    minute: epoch('minute'),
    server: text('server').notNull(),
    method: text('method').notNull(),
    tool: text('tool').notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    clientId: text('client_id').notNull(),
    username: text('username').notNull(),
    outcome: text('outcome').notNull(),
    calls: bigint('calls', { mode: 'number' }).notNull(),
    durationSum: bigint('duration_sum', { mode: 'number' }).notNull(),
    durationCount: bigint('duration_count', { mode: 'number' }).notNull(),
    histogram: bigint('histogram', { mode: 'number' }).array().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.minute, table.server, table.method, table.tool, table.userId, table.clientId, table.outcome],
    }),
    index('idx_mcp_metrics_time').on(table.minute),
  ],
);

/** Persisted alert lifecycle; fingerprints collapse repeated 5-minute windows. */
export const alertEvents = pgTable(
  'alert_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    server: text('server').notNull(),
    type: text('type').notNull(),
    value: doublePrecision('value').notNull(),
    threshold: doublePrecision('threshold').notNull(),
    firstSeenAt: bigint('first_seen_at', { mode: 'number' }).notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
    acknowledgedAt: bigint('acknowledged_at', { mode: 'number' }),
    acknowledgedBy: text('acknowledged_by'),
    notifiedAt: bigint('notified_at', { mode: 'number' }),
    notificationError: text('notification_error'),
  },
  (table) => [
    uniqueIndex('uq_alert_fingerprint').on(table.fingerprint),
    index('idx_alert_last_seen').on(table.lastSeenAt),
    index('idx_alert_open').on(table.resolvedAt, table.lastSeenAt),
  ],
);
