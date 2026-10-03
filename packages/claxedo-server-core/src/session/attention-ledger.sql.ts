import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const ClaxedoSessionAttentionTable = sqliteTable("claxedo_session_attention", {
  ordinal: integer().primaryKey({ autoIncrement: true }),
  session_ref: text().notNull(),
  generation: integer().notNull(),
  sequence: integer().notNull(),
  event_json: text().notNull(),
}, (table) => [uniqueIndex("claxedo_session_attention_position_idx").on(table.session_ref, table.generation, table.sequence)])

export const ClaxedoSessionAttentionScanTable = sqliteTable("claxedo_session_attention_scan", {
  session_ref: text().notNull(),
  generation: integer().notNull(),
  through: integer().notNull(),
}, (table) => [primaryKey({ columns: [table.session_ref, table.generation] })])
