import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"

export const ClaxedoPageTable = sqliteTable(
  "claxedo_page",
  {
    id: text().primaryKey(),
    project_id: text().notNull(),
    title: text().notNull().default("Untitled"),
    content: text().notNull().default(""),
    status: text().notNull().default("draft"),
    session_id: text(),
    file_path: text(),
    directory: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    index("claxedo_page_project_idx").on(table.project_id),
    index("claxedo_page_updated_idx").on(table.project_id, table.updated_at),
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
