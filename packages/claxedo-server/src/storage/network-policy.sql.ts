import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const ClaxedoNetworkPolicyTable = sqliteTable(
  "claxedo_network_policy",
  {
    id: text().primaryKey(),
    workspace_id: text(), // null = global default
    harness: text(), // null = all harnesses
    target: text().notNull(), // exact host, wildcard domain, or provider preset name
    kind: text().notNull(), // host | domain | group
    constraints_json: text().notNull().default("{}"), // port/path restrictions, enabled flag
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_network_policy_workspace_idx").on(table.workspace_id),
    index("claxedo_network_policy_kind_idx").on(table.kind),
    index("claxedo_network_policy_updated_idx").on(table.updated_at),
  ],
)
