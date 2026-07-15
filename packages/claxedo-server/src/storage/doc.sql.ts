import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const ClaxedoDocumentTable = sqliteTable(
  "claxedo_document",
  {
    id: text().primaryKey(),
    org_id: text().notNull(),
    project_id: text().notNull(),
    title: text().notNull(),
    head_revision_id: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_document_project_idx").on(table.org_id, table.project_id, table.updated_at),
    uniqueIndex("claxedo_document_org_id_unique").on(table.org_id, table.id),
  ],
)

export const ClaxedoDocumentRevisionTable = sqliteTable(
  "claxedo_document_revision",
  {
    id: text().primaryKey(),
    document_id: text().notNull().references(() => ClaxedoDocumentTable.id, { onDelete: "cascade" }),
    revision_number: integer().notNull(),
    parent_revision_id: text(),
    title: text().notNull(),
    markdown: text().notNull(),
    content_hash: text().notNull(),
    authored_at: integer().notNull(),
    authored_by_type: text().notNull(),
    authored_by_id: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("claxedo_document_revision_number_unique").on(table.document_id, table.revision_number),
    index("claxedo_document_revision_document_idx").on(table.document_id, table.created_at),
  ],
)
