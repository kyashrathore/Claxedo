import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// One row per integration in each opaque owner partition. The row id is the
// durable credential and route identity; owner absence denotes team scope.
export const ClaxedoConnectionTable = sqliteTable("claxedo_connection", {
  id: text().primaryKey(),
  integration_id: text().notNull(),
  owner: text(),
  account_label: text(),
  // JSON array of granted capabilities, written at connect time.
  granted_capabilities: text().notNull(),
  // JSON object of non-secret prompt values (e.g. atlassian site_url/email).
  fields: text().notNull().default("{}"),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})
