import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core"

export const ClaxedoSessionMetaTable = sqliteTable(
  "claxedo_session_meta",
  {
    session_id: text().primaryKey(),
    workspace_id: text(),
    project_id: text(),
    directory: text().notNull(),
    title: text(),
    parent_session_id: text(),
    archived_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_session_meta_workspace_idx").on(table.workspace_id),
    index("claxedo_session_meta_project_idx").on(table.project_id),
    index("claxedo_session_meta_parent_idx").on(table.parent_session_id),
    index("claxedo_session_meta_updated_idx").on(table.updated_at),
  ],
)

export const ClaxedoSessionAttachmentTable = sqliteTable(
  "claxedo_session_attachment",
  {
    session_id: text().notNull(),
    kind: text().notNull(),
    target_id: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.kind, table.target_id] }),
    index("claxedo_session_attachment_kind_idx").on(table.kind, table.target_id),
    index("claxedo_session_attachment_session_idx").on(table.session_id),
  ],
)

export const ClaxedoSessionTagTable = sqliteTable(
  "claxedo_session_tag",
  {
    session_id: text().notNull(),
    tag: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.tag] }),
    index("claxedo_session_tag_session_idx").on(table.session_id),
    index("claxedo_session_tag_tag_idx").on(table.tag),
  ],
)
