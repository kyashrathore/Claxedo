import type { Database as BunDatabase } from "bun:sqlite"

const sqls = [
  "CREATE TABLE IF NOT EXISTS `claxedo_page` (`id` text PRIMARY KEY NOT NULL, `project_id` text NOT NULL, `title` text NOT NULL DEFAULT 'Untitled', `content` text NOT NULL DEFAULT '', `status` text NOT NULL DEFAULT 'draft', `session_id` text, `file_path` text, `directory` text, `created_at` text NOT NULL, `updated_at` text NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_project_idx` ON `claxedo_page` (`project_id`)",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_updated_idx` ON `claxedo_page` (`project_id`, `updated_at`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_page_status` (`id` text NOT NULL, `project_id` text NOT NULL, `name` text NOT NULL, `color` text NOT NULL DEFAULT '#6b7280', `position` integer NOT NULL DEFAULT 0, `transitions` text NOT NULL DEFAULT '[]', PRIMARY KEY(`project_id`, `id`))",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_status_project_idx` ON `claxedo_page_status` (`project_id`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_page_arena` (`id` text PRIMARY KEY NOT NULL, `page_id` text NOT NULL REFERENCES `claxedo_page`(`id`) ON DELETE CASCADE, `directory` text NOT NULL DEFAULT '', `parent_session_id` text NOT NULL DEFAULT '', `status` text NOT NULL DEFAULT 'idle', `config_json` text NOT NULL DEFAULT '{}', `synopsis` text NOT NULL DEFAULT '', `active_wave_id` text NOT NULL DEFAULT '', `current_round` integer NOT NULL DEFAULT 0, `stop_reason` text NOT NULL DEFAULT '', `last_error` text NOT NULL DEFAULT '', `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_arena_page_idx` ON `claxedo_page_arena` (`page_id`, `updated_at`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_page_arena_agent` (`id` text PRIMARY KEY NOT NULL, `arena_id` text NOT NULL REFERENCES `claxedo_page_arena`(`id`) ON DELETE CASCADE, `agent_key` text NOT NULL, `display_name` text NOT NULL, `role` text NOT NULL DEFAULT '', `duty` text NOT NULL DEFAULT '', `model` text NOT NULL DEFAULT '', `style` text NOT NULL DEFAULT '', `temperature` real NOT NULL DEFAULT 0, `session_id` text NOT NULL DEFAULT '', `status` text NOT NULL DEFAULT 'idle', `settled` integer NOT NULL DEFAULT 0, `last_signal` text NOT NULL DEFAULT '', `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `claxedo_page_arena_agent_unique` ON `claxedo_page_arena_agent` (`arena_id`, `agent_key`)",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_arena_agent_arena_idx` ON `claxedo_page_arena_agent` (`arena_id`, `created_at`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_page_arena_wave` (`id` text PRIMARY KEY NOT NULL, `arena_id` text NOT NULL REFERENCES `claxedo_page_arena`(`id`) ON DELETE CASCADE, `status` text NOT NULL DEFAULT 'running', `round_num` integer NOT NULL DEFAULT 0, `target_json` text NOT NULL DEFAULT '[]', `termination` text NOT NULL DEFAULT '', `started_at` integer NOT NULL, `finished_at` integer NOT NULL DEFAULT 0, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_arena_wave_arena_idx` ON `claxedo_page_arena_wave` (`arena_id`, `started_at`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_page_arena_message` (`id` text PRIMARY KEY NOT NULL, `arena_id` text NOT NULL REFERENCES `claxedo_page_arena`(`id`) ON DELETE CASCADE, `wave_id` text NOT NULL, `round_num` integer NOT NULL DEFAULT 0, `kind` text NOT NULL, `source_agent_key` text NOT NULL DEFAULT '', `text` text NOT NULL DEFAULT '', `raw_text` text NOT NULL DEFAULT '', `control_signal` text NOT NULL DEFAULT 'continue', `metadata_json` text NOT NULL DEFAULT '{}', `created_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_arena_message_arena_idx` ON `claxedo_page_arena_message` (`arena_id`, `created_at`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_page_arena_delivery` (`id` text PRIMARY KEY NOT NULL, `arena_id` text NOT NULL REFERENCES `claxedo_page_arena`(`id`) ON DELETE CASCADE, `wave_id` text NOT NULL, `message_id` text NOT NULL, `source_agent_key` text NOT NULL, `target_agent_key` text NOT NULL, `status` text NOT NULL DEFAULT 'done', `attempt` integer NOT NULL DEFAULT 1, `error` text NOT NULL DEFAULT '', `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `claxedo_page_arena_delivery_unique` ON `claxedo_page_arena_delivery` (`arena_id`, `wave_id`, `message_id`, `target_agent_key`)",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_arena_delivery_arena_idx` ON `claxedo_page_arena_delivery` (`arena_id`, `created_at`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_tab_context` (`tab_id` text PRIMARY KEY NOT NULL, `payload` text NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_tab_context_updated_idx` ON `claxedo_tab_context` (`updated_at`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_tab_context_terminal` (`terminal_id` text PRIMARY KEY NOT NULL, `tab_id` text NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_tab_context_terminal_tab_idx` ON `claxedo_tab_context_terminal` (`tab_id`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_terminal_session` (`terminal_id` text PRIMARY KEY NOT NULL, `tab_id` text, `workspace_id` text, `provider` text, `session_id` text, `transcript_path` text, `ref_name` text, `prompt` text, `last_assistant_message` text, `event_type` text, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_terminal_session_tab_idx` ON `claxedo_terminal_session` (`tab_id`)",
  "CREATE INDEX IF NOT EXISTS `claxedo_terminal_session_updated_idx` ON `claxedo_terminal_session` (`updated_at`)",
] as const

const tabs = [
  "claxedo_page",
  "claxedo_page_status",
  "claxedo_page_arena",
  "claxedo_page_arena_agent",
  "claxedo_page_arena_wave",
  "claxedo_page_arena_message",
  "claxedo_page_arena_delivery",
  "claxedo_tab_context",
  "claxedo_tab_context_terminal",
  "claxedo_terminal_session",
] as const

function hasTable(db: BunDatabase, name: string) {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function hasColumn(db: BunDatabase, table: string, name: string) {
  const rows = db.query(`PRAGMA table_info(\`${table}\`)`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === name)
}

export function repair(db: BunDatabase) {
  const out = tabs.filter((name) => !hasTable(db, name))
  const file = hasTable(db, "claxedo_page") && !hasColumn(db, "claxedo_page", "file_path")
  const dir = hasTable(db, "claxedo_page") && !hasColumn(db, "claxedo_page", "directory")

  sqls.forEach((sql) => db.run(sql))

  if (file) {
    db.run("ALTER TABLE `claxedo_page` ADD COLUMN `file_path` text")
    out.push("claxedo_page.file_path")
  }

  if (dir) {
    db.run("ALTER TABLE `claxedo_page` ADD COLUMN `directory` text")
    out.push("claxedo_page.directory")
  }

  return out
}
