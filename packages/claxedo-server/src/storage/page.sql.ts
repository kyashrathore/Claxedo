import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"

export const ClaxedoPageTable = sqliteTable(
  "claxedo_page",
  {
    id: text().primaryKey(),
    org_id: text().notNull(),
    project_id: text().notNull(),
    title: text().notNull().default("Untitled"),
    content: text().notNull().default(""),
    visibility: text().notNull().default("project"),
    version: integer().notNull().default(0),
    status: text().notNull().default("draft"),
    session_id: text(),
    directory: text(),
    source_kind: text(),
    source_repo_root: text(),
    source_repo_key: text(),
    source_path: text(),
    source_branch: text(),
    base_commit: text(),
    base_blob_sha: text(),
    base_tree_sha: text(),
    last_materialized_commit: text(),
    last_materialized_blob_sha: text(),
    last_commit_at: text(),
    last_commit_author_id: text(),
    commit_status: text().notNull().default("draft"),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    index("claxedo_page_project_idx").on(table.org_id, table.project_id),
    index("claxedo_page_updated_idx").on(table.org_id, table.project_id, table.updated_at),
  ],
)

export const ClaxedoPageStatusTable = sqliteTable(
  "claxedo_page_status",
  {
    id: text().notNull(),
    project_id: text().notNull(),
    name: text().notNull(),
    color: text().notNull().default("#6b7280"),
    position: integer().notNull().default(0),
    transitions: text().notNull().default("[]"),
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.id] }),
    index("claxedo_page_status_project_idx").on(table.project_id),
  ],
)
