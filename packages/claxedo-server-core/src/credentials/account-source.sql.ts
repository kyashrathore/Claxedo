import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ACCOUNT_SOURCES } from "@claxedo/account-contract/vocabulary"

/** Which account one person's sessions spend for one provider: their own, or the org's. */
export const ClaxedoProviderAccountSourceTable = sqliteTable(
  "claxedo_provider_account_source",
  {
    org_id: text().notNull(),
    user_id: text().notNull(),
    provider_id: text().notNull(),
    source: text({ enum: ACCOUNT_SOURCES }).notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.org_id, table.user_id, table.provider_id] })],
)
