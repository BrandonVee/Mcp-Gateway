import { bigint } from 'drizzle-orm/pg-core';

/** Epoch timestamps are stored as milliseconds; changing the unit requires a migration. */
export const epoch = (name: string) => bigint(name, { mode: 'number' }).notNull();
