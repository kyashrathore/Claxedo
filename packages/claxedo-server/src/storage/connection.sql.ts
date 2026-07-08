import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// Connections framework
// (docs/plans/2026-07-03-004-feat-connections-framework-plan.md): one
// connection per integration (PK = integration id, host-global until signed
// mode). The secret lives in the credential store under provider_id
// `integration:{integration_id}`; this row carries only non-secret state.
export const ClaxedoConnectionTable = sqliteTable("claxedo_connection", {
  integration_id: text().primaryKey(),
  account_label: text(),
  // JSON array of granted capabilities, written at connect time.
  granted_capabilities: text().notNull(),
  // JSON object of non-secret prompt values (e.g. atlassian site_url/email).
  fields: text().notNull().default("{}"),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})
