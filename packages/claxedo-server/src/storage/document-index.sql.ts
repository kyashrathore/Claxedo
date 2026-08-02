import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const ClaxedoDocumentIndexTable = sqliteTable(
  "claxedo_document_index",
  {
    id: text().primaryKey(),
    org_id: text().notNull(),
    project_id: text().notNull(),
    display_name: text().notNull(),
    origin_kind: text({ enum: ["managed", "repository"] }).notNull(),
    placement_kind: text({ enum: ["local", "hosted"] }).notNull(),
    placement_id: text().notNull(),
    managed_relative_path: text(),
    repository_id: text(),
    workspace_id: text(),
    repository_relative_path: text(),
    branch: text(),
    status: text().notNull().default("draft"),
    session_id: text(),
    archived_at: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
    last_opened_at: text(),
    last_known_file_version: text(),
  },
  (table) => [
    index("claxedo_document_index_project_idx").on(table.org_id, table.project_id, table.archived_at, table.updated_at),
    uniqueIndex("claxedo_document_index_managed_path_unique").on(
      table.org_id,
      table.project_id,
      table.managed_relative_path,
    ),
    uniqueIndex("claxedo_document_index_repository_path_unique").on(
      table.org_id,
      table.project_id,
      table.repository_id,
      table.repository_relative_path,
    ),
    check("claxedo_document_index_origin_check", sql`
      (${table.origin_kind} = 'managed'
        AND ${table.managed_relative_path} IS NOT NULL
        AND length(${table.managed_relative_path}) > 0
        AND ${table.repository_id} IS NULL
        AND ${table.workspace_id} IS NULL
        AND ${table.repository_relative_path} IS NULL
        AND ${table.branch} IS NULL)
      OR
      (${table.origin_kind} = 'repository'
        AND ${table.managed_relative_path} IS NULL
        AND ${table.repository_id} IS NOT NULL
        AND length(${table.repository_id}) > 0
        AND ${table.workspace_id} IS NOT NULL
        AND length(${table.workspace_id}) > 0
        AND ${table.repository_relative_path} IS NOT NULL
        AND length(${table.repository_relative_path}) > 0
        AND (${table.branch} IS NULL OR length(${table.branch}) > 0))
    `),
    check("claxedo_document_index_placement_check", sql`${table.placement_kind} IN ('local', 'hosted')`),
    check("claxedo_document_index_common_nonempty_check", sql`
      length(${table.id}) > 0
      AND length(${table.org_id}) > 0
      AND length(${table.project_id}) > 0
      AND length(${table.display_name}) > 0
      AND length(${table.placement_id}) > 0
      AND length(${table.status}) > 0
      AND length(${table.created_at}) > 0
      AND length(${table.updated_at}) > 0
    `),
    check("claxedo_document_index_optional_nonempty_check", sql`
      (${table.session_id} IS NULL OR length(${table.session_id}) > 0)
      AND (${table.archived_at} IS NULL OR length(${table.archived_at}) > 0)
      AND (${table.last_opened_at} IS NULL OR length(${table.last_opened_at}) > 0)
      AND (${table.last_known_file_version} IS NULL OR length(${table.last_known_file_version}) > 0)
    `),
  ],
)

export const ClaxedoLocalProjectTable = sqliteTable(
  "claxedo_local_project",
  {
    directory: text().primaryKey(),
    project_id: text().notNull(),
    created_at: text().notNull(),
  },
  (table) => [uniqueIndex("claxedo_local_project_id_unique").on(table.project_id)],
)

export const ClaxedoDocumentStatusTable = sqliteTable(
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
