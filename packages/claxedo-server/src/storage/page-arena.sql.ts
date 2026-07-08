import { sqliteTable, text, integer, real, index, unique } from "drizzle-orm/sqlite-core"
import { ClaxedoPageTable } from "./page.sql"

export const ClaxedoPageArenaTable = sqliteTable(
  "claxedo_page_arena",
  {
    id: text().primaryKey(),
    page_id: text()
      .notNull()
      .references(() => ClaxedoPageTable.id, { onDelete: "cascade" }),
    directory: text().notNull().default(""),
    parent_session_id: text().notNull().default(""),
    status: text().notNull().default("idle"),
    config_json: text().notNull().default("{}"),
    synopsis: text().notNull().default(""),
    active_wave_id: text().notNull().default(""),
    current_round: integer().notNull().default(0),
    stop_reason: text().notNull().default(""),
    last_error: text().notNull().default(""),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [index("claxedo_page_arena_page_idx").on(table.page_id, table.updated_at)],
)

export const ClaxedoPageArenaAgentTable = sqliteTable(
  "claxedo_page_arena_agent",
  {
    id: text().primaryKey(),
    arena_id: text()
      .notNull()
      .references(() => ClaxedoPageArenaTable.id, { onDelete: "cascade" }),
    agent_key: text().notNull(),
    display_name: text().notNull(),
    role: text().notNull().default(""),
    duty: text().notNull().default(""),
    model: text().notNull().default(""),
    style: text().notNull().default(""),
    temperature: real().notNull().default(0),
    session_id: text().notNull().default(""),
    status: text().notNull().default("idle"),
    settled: integer().notNull().default(0),
    last_signal: text().notNull().default(""),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    unique("claxedo_page_arena_agent_unique").on(table.arena_id, table.agent_key),
    index("claxedo_page_arena_agent_arena_idx").on(table.arena_id, table.created_at),
  ],
)

export const ClaxedoPageArenaWaveTable = sqliteTable(
  "claxedo_page_arena_wave",
  {
    id: text().primaryKey(),
    arena_id: text()
      .notNull()
      .references(() => ClaxedoPageArenaTable.id, { onDelete: "cascade" }),
    status: text().notNull().default("running"),
    round_num: integer().notNull().default(0),
    target_json: text().notNull().default("[]"),
    termination: text().notNull().default(""),
    started_at: integer().notNull(),
    finished_at: integer().notNull().default(0),
    updated_at: integer().notNull(),
  },
  (table) => [index("claxedo_page_arena_wave_arena_idx").on(table.arena_id, table.started_at)],
)

export const ClaxedoPageArenaMessageTable = sqliteTable(
  "claxedo_page_arena_message",
  {
    id: text().primaryKey(),
    arena_id: text()
      .notNull()
      .references(() => ClaxedoPageArenaTable.id, { onDelete: "cascade" }),
    wave_id: text().notNull(),
    round_num: integer().notNull().default(0),
    kind: text().notNull(),
    source_agent_key: text().notNull().default(""),
    text: text().notNull().default(""),
    raw_text: text().notNull().default(""),
    control_signal: text().notNull().default("continue"),
    metadata_json: text().notNull().default("{}"),
    created_at: integer().notNull(),
  },
  (table) => [index("claxedo_page_arena_message_arena_idx").on(table.arena_id, table.created_at)],
)

export const ClaxedoPageArenaDeliveryTable = sqliteTable(
  "claxedo_page_arena_delivery",
  {
    id: text().primaryKey(),
    arena_id: text()
      .notNull()
      .references(() => ClaxedoPageArenaTable.id, { onDelete: "cascade" }),
    wave_id: text().notNull(),
    message_id: text().notNull(),
    source_agent_key: text().notNull(),
    target_agent_key: text().notNull(),
    status: text().notNull().default("done"),
    attempt: integer().notNull().default(1),
    error: text().notNull().default(""),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    unique("claxedo_page_arena_delivery_unique").on(
      table.arena_id,
      table.wave_id,
      table.message_id,
      table.target_agent_key,
    ),
    index("claxedo_page_arena_delivery_arena_idx").on(table.arena_id, table.created_at),
  ],
)
