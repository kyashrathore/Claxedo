import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const ClaxedoCloudSessionTable = sqliteTable(
  "claxedo_cloud_session",
  {
    session_id: text().primaryKey(),
    workspace_id: text().notNull(),
    project_id: text(),
    directory: text().notNull(),
    title: text(),
    driver: text(),
    repo_name: text(),
    git_branch: text(),
    git_remote: text(),
    data: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    deleted_at: integer(),
  },
  (table) => [
    index("claxedo_cloud_session_workspace_idx").on(table.workspace_id),
    index("claxedo_cloud_session_updated_idx").on(table.updated_at),
  ],
)

export const ClaxedoCloudMessageTable = sqliteTable(
  "claxedo_cloud_message",
  {
    message_id: text().primaryKey(),
    session_id: text().notNull(),
    workspace_id: text().notNull(),
    role: text(),
    ordinal: integer().notNull(),
    event_ordinal: integer().notNull().default(0),
    data: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_cloud_message_session_idx").on(table.session_id, table.ordinal),
    index("claxedo_cloud_message_event_ordinal_idx").on(table.session_id, table.event_ordinal),
    index("claxedo_cloud_message_workspace_idx").on(table.workspace_id),
  ],
)

export const ClaxedoCloudMessageEventTable = sqliteTable(
  "claxedo_cloud_message_event",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    directory: text(),
    event_ordinal: integer().notNull(),
    type: text().notNull(),
    data: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_cloud_message_event_session_idx").on(table.session_id, table.event_ordinal),
  ],
)
