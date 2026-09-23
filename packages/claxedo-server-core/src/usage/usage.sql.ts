import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { TURN_USAGE_LOCATIONS, TURN_USAGE_SETTLEMENTS, TURN_USAGE_STATUSES } from "./contracts"

const usageColumns = () => ({
  host_id: text().notNull(),
  session_ref: text().notNull(),
  session_id: text().notNull(),
  message_id: text().notNull(),
  revision: integer().notNull(),
  payload_hash: text().notNull(),
  observed_at: integer().notNull(),
  completed_at: integer(),
  settlement: text({ enum: TURN_USAGE_SETTLEMENTS }).notNull(),
  status: text({ enum: TURN_USAGE_STATUSES }).notNull(),
  location: text({ enum: TURN_USAGE_LOCATIONS }).notNull(),
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
  cache_write_1h_tokens: integer(),
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

/**
 * The account that produced each turn, where one did. A turn with no row is
 * the machine's own, which only the machine's operator reads. `turn_id` is
 * the admitted session turn a cloud sandbox reported the message under.
 */
export const ClaxedoUsageTurnOwnerTable = sqliteTable(
  "claxedo_usage_turn_owner",
  {
    host_id: text().notNull(),
    session_ref: text().notNull(),
    message_id: text().notNull(),
    org_id: text().notNull(),
    user_id: text().notNull(),
    turn_id: text(),
  },
  (table) => [
    primaryKey({ columns: [table.host_id, table.session_ref, table.message_id] }),
    index("claxedo_usage_turn_owner_account_idx").on(table.org_id, table.user_id),
    index("claxedo_usage_turn_owner_turn_idx").on(table.host_id, table.session_ref, table.turn_id),
  ],
)

/** The turn meter's per-scope streams (`TurnMeterState`), kept beside the facts it sums them into. */
export const ClaxedoUsageTurnMeterStateTable = sqliteTable(
  "claxedo_usage_turn_meter_state",
  {
    session_id: text().notNull(),
    message_id: text().notNull(),
    streams_json: text().notNull(),
    observation_keys_json: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.message_id] })],
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
