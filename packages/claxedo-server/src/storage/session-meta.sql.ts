import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core"

export const ClaxedoSessionMetaTable = sqliteTable(
  "claxedo_session_meta",
  {
    session_ref: text().primaryKey(),
    session_id: text().notNull(),
    workspace_id: text(),
    project_id: text(),
    host: text().notNull().default("workspace"),
    directory: text(),
    tool_sandbox: text(),
    title: text(),
    parent_session_id: text(),
    archived_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_session_meta_workspace_idx").on(table.workspace_id),
    index("claxedo_session_meta_session_idx").on(table.session_id),
    index("claxedo_session_meta_project_idx").on(table.project_id),
    index("claxedo_session_meta_parent_idx").on(table.parent_session_id),
    index("claxedo_session_meta_updated_idx").on(table.updated_at),
    index("claxedo_session_meta_workspace_archive_updated_idx").on(table.workspace_id, table.archived_at, table.updated_at, table.session_ref),
    index("claxedo_session_meta_directory_archive_updated_idx").on(table.directory, table.archived_at, table.updated_at, table.session_ref),
    index("claxedo_session_meta_project_archive_updated_idx").on(table.project_id, table.archived_at, table.updated_at, table.session_ref),
  ],
)

export const ClaxedoSessionAttachmentTable = sqliteTable(
  "claxedo_session_attachment",
  {
    session_ref: text().notNull(),
    session_id: text().notNull(),
    kind: text().notNull(),
    target_id: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_ref, table.kind, table.target_id] }),
    index("claxedo_session_attachment_kind_idx").on(table.kind, table.target_id),
    index("claxedo_session_attachment_ref_idx").on(table.session_ref),
    index("claxedo_session_attachment_session_idx").on(table.session_id),
  ],
)

export const ClaxedoSessionTagTable = sqliteTable(
  "claxedo_session_tag",
  {
    session_ref: text().notNull(),
    session_id: text().notNull(),
    tag: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_ref, table.tag] }),
    index("claxedo_session_tag_ref_idx").on(table.session_ref),
    index("claxedo_session_tag_session_idx").on(table.session_id),
    index("claxedo_session_tag_tag_idx").on(table.tag),
  ],
)
