import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core"

export const ClaxedoSessionReaderTable = sqliteTable("claxedo_session_reader", {
  session_ref: text().notNull(),
  reader_id: text().notNull(),
  state_json: text().notNull(),
}, (table) => [primaryKey({ columns: [table.session_ref, table.reader_id] })])
