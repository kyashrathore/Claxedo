import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Every table is keyed by `scope_id` first. On this host that value is the
 * constant "local", but the column is not dropped: the same rows, the same
 * migration order and the same conformance suite have to describe the hosted
 * D1 schema, where the scope is an organization.
 */

export const ClaxedoTaskPresetTable = sqliteTable(
  "claxedo_task_preset",
  {
    scope_id: text().notNull(),
    preset_id: text().notNull(),
    revision: integer().notNull(),
    owner_id: text().notNull(),
    name: text().notNull(),
    instructions: text().notNull(),
    execution: text().notNull(),
    configurations: text().notNull(),
    archived_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.preset_id] }),
    index("claxedo_task_preset_page_idx").on(table.scope_id, table.owner_id, table.created_at, table.preset_id),
  ],
)

export const ClaxedoTaskTable = sqliteTable(
  "claxedo_task",
  {
    scope_id: text().notNull(),
    task_id: text().notNull(),
    revision: integer().notNull(),
    project_id: text().notNull(),
    workspace_id: text(),
    parent_task_id: text(),
    title: text().notNull(),
    description: text().notNull(),
    status: text().notNull(),
    child_set_revision: integer().notNull(),
    archived_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.task_id] }),
    index("claxedo_task_project_page_idx").on(table.scope_id, table.project_id, table.created_at, table.task_id),
    index("claxedo_task_child_page_idx").on(table.scope_id, table.parent_task_id, table.created_at, table.task_id),
  ],
)

/**
 * One row per started attempt. The key is the origin the kit reserves, so a
 * second client racing the same `(task, slot, attempt)` collides here rather
 * than acquiring a second session for one slot.
 */
export const ClaxedoTaskSessionLinkTable = sqliteTable(
  "claxedo_task_session_link",
  {
    scope_id: text().notNull(),
    task_id: text().notNull(),
    slot: text().notNull(),
    attempt: integer().notNull(),
    session_id: text().notNull(),
    session_workspace_id: text(),
    continued_from_session_id: text(),
    continued_from_workspace_id: text(),
    preset_id: text().notNull(),
    preset_revision: integer().notNull(),
    preset_name_at_start: text().notNull(),
    configuration_digest: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.task_id, table.slot, table.attempt] })],
)

export const ClaxedoTaskCommandReceiptTable = sqliteTable(
  "claxedo_task_command_receipt",
  {
    scope_id: text().notNull(),
    client_request_id: text().notNull(),
    command_name: text().notNull(),
    request_hash: text().notNull(),
    result: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope_id, table.client_request_id] })],
)
