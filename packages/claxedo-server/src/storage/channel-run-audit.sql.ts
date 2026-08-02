import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core"

export const ClaxedoChannelRunAuditTable = sqliteTable(
  "claxedo_channel_run_audit",
  {
    session_id: text().primaryKey(),
    channel: text().notNull(),
    external_user_id: text().notNull(),
    thread_key: text().notNull(),
    workspace_id: text(),
    cost: real(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_channel_run_audit_channel_created_idx").on(table.channel, table.created_at),
    index("claxedo_channel_run_audit_user_created_idx").on(table.channel, table.external_user_id, table.created_at),
    index("claxedo_channel_run_audit_workspace_created_idx").on(table.workspace_id, table.created_at),
  ],
)
