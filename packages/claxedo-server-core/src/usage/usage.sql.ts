import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

const usageColumns = () => ({
  host_id: text().notNull(),
  session_ref: text().notNull(),
  session_id: text().notNull(),
  message_id: text().notNull(),
  revision: integer().notNull(),
  payload_hash: text().notNull(),
  observed_at: integer().notNull(),
  completed_at: integer(),
  settlement: text().notNull(),
  status: text().notNull(),
  location: text().notNull(),
  harness: text().notNull(),
  provider_id: text().notNull(),
  model_id: text().notNull(),
  native_session_id: text(),
  workspace_id: text(),
  input_tokens: integer(),
  output_tokens: integer(),
  reasoning_tokens: integer(),
  cache_read_tokens: integer(),
  cache_write_tokens: integer(),
  quality_json: text().notNull(),
})

export const ClaxedoUsageTurnRevisionTable = sqliteTable("claxedo_usage_turn_revision", usageColumns(), (table) => [
  primaryKey({ columns: [table.host_id, table.session_ref, table.message_id, table.revision] }),
  index("claxedo_usage_turn_revision_observed_idx").on(table.observed_at),
])

export const ClaxedoUsageTurnCurrentTable = sqliteTable("claxedo_usage_turn_current", usageColumns(), (table) => [
  primaryKey({ columns: [table.host_id, table.session_ref, table.message_id] }),
  index("claxedo_usage_turn_current_settlement_idx").on(table.settlement),
  index("claxedo_usage_turn_current_session_message_idx").on(table.session_id, table.message_id),
  index("claxedo_usage_turn_current_observed_idx").on(table.observed_at),
  index("claxedo_usage_turn_current_workspace_idx").on(table.workspace_id, table.observed_at),
])

export const ClaxedoUsageOutboxTable = sqliteTable(
  "claxedo_usage_outbox",
  {
    host_id: text().notNull(),
    session_ref: text().notNull(),
    message_id: text().notNull(),
    revision: integer().notNull(),
    payload_hash: text().notNull(),
    org_id: text(),
    user_id: text(),
    state: text({ enum: ["pending", "delivered", "conflict"] })
      .notNull()
      .default("pending"),
    attempts: integer().notNull().default(0),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.host_id, table.session_ref, table.message_id, table.revision] }),
    index("claxedo_usage_outbox_state_created_idx").on(table.state, table.created_at),
    index("claxedo_usage_outbox_tenant_state_created_idx").on(
      table.org_id,
      table.user_id,
      table.state,
      table.created_at,
    ),
  ],
)

/**
 * The instant after which every Claxedo-owned native session for a scanner
 * source is guaranteed to be represented in the local usage facts. History
 * before this boundary stays quarantined instead of being guessed external.
 */
export const ClaxedoUsageSourceCoverageTable = sqliteTable("claxedo_usage_source_coverage", {
  source: text().primaryKey(),
  started_at: integer().notNull(),
})
