import { pgTable, text } from 'drizzle-orm/pg-core';

export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
