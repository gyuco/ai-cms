import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './identity.ts';

/**
 * Encrypted secrets (API keys, site secrets). Values are AES-256-GCM encrypted by the
 * application with the `ai_keys_master` key; the database never sees plaintext.
 * Agents can never read them (TECHNICAL §6.3, I4).
 */
export const secrets = pgTable('secrets', {
  name: text('name').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  hint: text('hint'),
  createdBy: integer('created_by')
    .notNull()
    .references(() => users.uid),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
