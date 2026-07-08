import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core"

export const ClaxedoChannelDeliveryTable = sqliteTable(
  "claxedo_channel_delivery",
  {
    channel: text().notNull(),
    idempotency_key: text().notNull(),
    external_user_id: text().notNull(),
    received_at: integer().notNull(),
    first_seen_at: integer().notNull(),
    session_id: text(),
    session_create: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.channel, table.idempotency_key] }),
    index("claxedo_channel_delivery_user_day_idx").on(table.channel, table.external_user_id, table.first_seen_at),
    index("claxedo_channel_delivery_session_idx").on(table.session_id),
  ],
)

export const ClaxedoChannelStateTable = sqliteTable(
  "claxedo_channel_state",
  {
    key: text().primaryKey(),
    value: text().notNull(),
    updated_at: integer().notNull(),
  },
)
