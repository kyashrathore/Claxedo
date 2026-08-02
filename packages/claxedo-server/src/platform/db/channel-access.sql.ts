import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"

/** Pending pairing requests (short-lived codes). One row per (channel, sender). */
export const ClaxedoChannelPairingTable = sqliteTable(
  "claxedo_channel_pairing",
  {
    code: text().primaryKey(),
    channel: text().notNull(),
    external_user_id: text().notNull(),
    created_at: integer().notNull(),
    expires_at: integer().notNull(),
    last_sent_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_channel_pairing_sender_idx").on(table.channel, table.external_user_id),
    index("claxedo_channel_pairing_expires_idx").on(table.expires_at),
  ],
)

/** Approved channel senders (immutable-id allowlist). */
export const ClaxedoChannelAllowTable = sqliteTable(
  "claxedo_channel_allow",
  {
    channel: text().notNull(),
    external_user_id: text().notNull(),
    approved_by: text(),
    approved_at: integer().notNull(),
  },
  (table) => [
    // Matches the live DDL (repair.ts): PRIMARY KEY (channel, external_user_id).
    // The schema previously declared only an index — a drift the raw-SQL
    // consumers never noticed because they bypassed drizzle entirely.
    primaryKey({ columns: [table.channel, table.external_user_id] }),
  ],
)

/** Channel sender → Claxedo account identity binding (multi-user). */
export const ClaxedoChannelIdentityTable = sqliteTable(
  "claxedo_channel_identity",
  {
    channel: text().notNull(),
    external_user_id: text().notNull(),
    account_id: text(),
    status: text().notNull(), // pending | bound | blocked
    bound_at: integer().notNull(),
    bound_by: text(),
  },
  (table) => [
    // Matches the live DDL: PRIMARY KEY (channel, external_user_id).
    primaryKey({ columns: [table.channel, table.external_user_id] }),
    index("claxedo_channel_identity_account_idx").on(table.account_id),
  ],
)
