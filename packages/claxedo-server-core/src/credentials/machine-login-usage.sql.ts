import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"

/**
 * The last quota windows a harness on THIS machine reported for its own login.
 *
 * No `org_id` and no `owner`: a machine login belongs to the CLI installed
 * beside the process, the route that reads it is loopback-only, and there is
 * one such login per harness per address no matter who asks.
 *
 * `account` is the address the harness named, or `''` where it names none —
 * a value rather than NULL, because it is half the primary key and SQLite
 * treats NULLs as distinct, which would let one harness accumulate a row per
 * read.
 */
export const ClaxedoMachineLoginUsageTable = sqliteTable(
  "claxedo_machine_login_usage",
  {
    harness: text().notNull(),
    account: text().notNull(),
    usage_windows: text().notNull(),
    usage_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.harness, table.account] })],
)
