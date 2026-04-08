import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const ClaxedoTabContextTable = sqliteTable(
  "claxedo_tab_context",
  {
    tab_id: text().primaryKey(),
    payload: text().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [index("claxedo_tab_context_updated_idx").on(table.updated_at)],
)

export const ClaxedoTabContextTerminalTable = sqliteTable(
  "claxedo_tab_context_terminal",
  {
    terminal_id: text().primaryKey(),
    tab_id: text().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [index("claxedo_tab_context_terminal_tab_idx").on(table.tab_id)],
)

export const ClaxedoTerminalSessionTable = sqliteTable(
  "claxedo_terminal_session",
  {
    terminal_id: text().primaryKey(),
    tab_id: text(),
    workspace_id: text(),
    provider: text(),
    session_id: text(),
    transcript_path: text(),
    ref_name: text(),
    prompt: text(),
    last_assistant_message: text(),
    event_type: text(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_terminal_session_tab_idx").on(table.tab_id),
    index("claxedo_terminal_session_updated_idx").on(table.updated_at),
  ],
)
