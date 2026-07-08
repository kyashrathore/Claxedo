import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const ClaxedoLivingAppTable = sqliteTable(
  "claxedo_living_app",
  {
    id: text().primaryKey(),
    workspace_id: text(),
    name: text().notNull(),
    description: text().notNull().default(""),
    status: text().notNull().default("active"),
    shell_spec_json: text().notNull().default("{}"),
    backend_contract_json: text().notNull().default("{}"),
    action_bindings_json: text().notNull().default("{}"),
    data_schema_json: text().notNull().default("{}"),
    sync_config_json: text().notNull().default("{}"),
    prompt: text().notNull().default(""),
    source_session_id: text(),
    process_ref: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_living_app_workspace_idx").on(table.workspace_id),
    index("claxedo_living_app_status_idx").on(table.status),
    index("claxedo_living_app_updated_idx").on(table.updated_at),
  ],
)

export const ClaxedoLivingAppDataSourceTable = sqliteTable(
  "claxedo_living_app_data_source",
  {
    id: text().primaryKey(),
    app_id: text().notNull(),
    kind: text().notNull(),
    label: text().notNull(),
    config_json: text().notNull().default("{}"),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_living_app_data_source_app_idx").on(table.app_id),
    index("claxedo_living_app_data_source_kind_idx").on(table.kind),
  ],
)

export const ClaxedoLivingAppEventTable = sqliteTable(
  "claxedo_living_app_event",
  {
    id: text().primaryKey(),
    app_id: text().notNull(),
    type: text().notNull(),
    payload_json: text().notNull().default("{}"),
    created_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_living_app_event_app_idx").on(table.app_id),
    index("claxedo_living_app_event_created_idx").on(table.app_id, table.created_at),
  ],
)
