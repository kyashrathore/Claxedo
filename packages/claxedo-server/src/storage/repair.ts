type SqliteInstance = {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

type ColumnInfo = {
  name: string
  notnull?: number
}

const sqls = [
  "CREATE TABLE IF NOT EXISTS `claxedo_page` (`id` text PRIMARY KEY NOT NULL, `org_id` text NOT NULL, `project_id` text NOT NULL, `title` text NOT NULL DEFAULT 'Untitled', `content` text NOT NULL DEFAULT '', `visibility` text NOT NULL DEFAULT 'project', `version` integer NOT NULL DEFAULT 0, `status` text NOT NULL DEFAULT 'draft', `session_id` text, `directory` text, `source_kind` text, `source_repo_root` text, `source_repo_key` text, `source_path` text, `source_branch` text, `base_commit` text, `base_blob_sha` text, `base_tree_sha` text, `last_materialized_commit` text, `last_materialized_blob_sha` text, `last_commit_at` text, `last_commit_author_id` text, `commit_status` text NOT NULL DEFAULT 'draft', `created_at` text NOT NULL, `updated_at` text NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_project_idx` ON `claxedo_page` (`org_id`, `project_id`)",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_updated_idx` ON `claxedo_page` (`org_id`, `project_id`, `updated_at`)",
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
  "CREATE TABLE IF NOT EXISTS `claxedo_terminal_session` (`terminal_id` text PRIMARY KEY NOT NULL, `tab_id` text, `workspace_id` text, `driver` text, `session_id` text, `transcript_path` text, `ref_name` text, `prompt` text, `last_assistant_message` text, `event_type` text, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_terminal_session_tab_idx` ON `claxedo_terminal_session` (`tab_id`)",
  "CREATE INDEX IF NOT EXISTS `claxedo_terminal_session_updated_idx` ON `claxedo_terminal_session` (`updated_at`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_channel_delivery` (`channel` text NOT NULL, `idempotency_key` text NOT NULL, `external_user_id` text NOT NULL, `received_at` integer NOT NULL, `first_seen_at` integer NOT NULL, `session_id` text, `session_create` integer NOT NULL DEFAULT 0, PRIMARY KEY (`channel`, `idempotency_key`))",
  "CREATE INDEX IF NOT EXISTS `claxedo_channel_delivery_user_day_idx` ON `claxedo_channel_delivery` (`channel`, `external_user_id`, `first_seen_at`)",
  "CREATE INDEX IF NOT EXISTS `claxedo_channel_delivery_session_idx` ON `claxedo_channel_delivery` (`session_id`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_channel_state` (`key` text PRIMARY KEY NOT NULL, `value` text NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `claxedo_channel_run_audit` (`session_id` text PRIMARY KEY NOT NULL, `channel` text NOT NULL, `external_user_id` text NOT NULL, `thread_key` text NOT NULL, `workspace_id` text, `cost` real, `created_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_channel_run_audit_channel_created_idx` ON `claxedo_channel_run_audit` (`channel`, `created_at`)",
  "CREATE INDEX IF NOT EXISTS `claxedo_channel_run_audit_user_created_idx` ON `claxedo_channel_run_audit` (`channel`, `external_user_id`, `created_at`)",
  "CREATE INDEX IF NOT EXISTS `claxedo_channel_run_audit_workspace_created_idx` ON `claxedo_channel_run_audit` (`workspace_id`, `created_at`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_channel_pairing` (`code` text PRIMARY KEY NOT NULL, `channel` text NOT NULL, `external_user_id` text NOT NULL, `created_at` integer NOT NULL, `expires_at` integer NOT NULL, `last_sent_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `claxedo_channel_pairing_sender_idx` ON `claxedo_channel_pairing` (`channel`, `external_user_id`)",
  "CREATE INDEX IF NOT EXISTS `claxedo_channel_pairing_expires_idx` ON `claxedo_channel_pairing` (`expires_at`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_channel_allow` (`channel` text NOT NULL, `external_user_id` text NOT NULL, `approved_by` text, `approved_at` integer NOT NULL, PRIMARY KEY (`channel`, `external_user_id`))",
  "CREATE TABLE IF NOT EXISTS `claxedo_channel_identity` (`channel` text NOT NULL, `external_user_id` text NOT NULL, `account_id` text, `status` text NOT NULL, `bound_at` integer NOT NULL, `bound_by` text, PRIMARY KEY (`channel`, `external_user_id`))",
  "CREATE INDEX IF NOT EXISTS `claxedo_channel_identity_account_idx` ON `claxedo_channel_identity` (`account_id`)",
] as const

const tabs = [
  "claxedo_page",
  "claxedo_page_status",
  "claxedo_page_arena",
  "claxedo_page_arena_agent",
  "claxedo_page_arena_wave",
  "claxedo_page_arena_message",
  "claxedo_page_arena_delivery",
  "claxedo_terminal_session",
  "claxedo_channel_delivery",
  "claxedo_channel_state",
  "claxedo_channel_run_audit",
] as const

const pageTabsDropOrder = [
  "claxedo_page_arena_delivery",
  "claxedo_page_arena_message",
  "claxedo_page_arena_wave",
  "claxedo_page_arena_agent",
  "claxedo_page_arena",
  "claxedo_page_status",
  "claxedo_page",
] as const

function hasTable(db: SqliteInstance, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function hasColumn(db: SqliteInstance, table: string, name: string) {
  const rows = db.prepare(`PRAGMA table_info(\`${table}\`)`).all() as ColumnInfo[]
  return rows.some((row) => row.name === name)
}

function column(db: SqliteInstance, table: string, name: string) {
  const rows = db.prepare(`PRAGMA table_info(\`${table}\`)`).all() as ColumnInfo[]
  return rows.find((row) => row.name === name)
}

function dropTable(db: SqliteInstance, name: string, out: string[]) {
  if (!hasTable(db, name)) return
  db.exec(`DROP TABLE \`${name}\``)
  out.push(name)
}

function rebuildSessionMeta(
  db: SqliteInstance,
  existing: { host: boolean; directory: boolean; toolSandbox: boolean },
) {
  const host = existing.host ? "COALESCE(NULLIF(`host`, ''), 'workspace')" : "'workspace'"
  const directory = existing.directory ? "NULLIF(`directory`, '')" : "NULL"
  const toolSandbox = existing.toolSandbox ? "`tool_sandbox`" : "NULL"

  db.exec("SAVEPOINT claxedo_session_meta_repair")
  try {
    db.exec("ALTER TABLE `claxedo_session_meta` RENAME TO `claxedo_session_meta_old_repair`")
    db.exec(`
      CREATE TABLE IF NOT EXISTS \`claxedo_session_meta\` (
        \`session_ref\` text PRIMARY KEY NOT NULL,
        \`session_id\` text NOT NULL,
        \`workspace_id\` text,
        \`project_id\` text,
        \`host\` text NOT NULL DEFAULT 'workspace',
        \`directory\` text,
        \`tool_sandbox\` text,
        \`title\` text,
        \`parent_session_id\` text,
        \`archived_at\` integer,
        \`created_at\` integer NOT NULL,
        \`updated_at\` integer NOT NULL
      )
    `)
    db.exec(`
      INSERT INTO \`claxedo_session_meta\` (
        \`session_ref\`,
        \`session_id\`,
        \`workspace_id\`,
        \`project_id\`,
        \`host\`,
        \`directory\`,
        \`tool_sandbox\`,
        \`title\`,
        \`parent_session_id\`,
        \`archived_at\`,
        \`created_at\`,
        \`updated_at\`
      )
      SELECT
        CASE
          WHEN \`workspace_id\` IS NOT NULL AND \`workspace_id\` <> '' THEN 'workspace:' || \`workspace_id\` || ':session:' || \`session_id\`
          WHEN ${host} = 'central' THEN 'central:' || \`session_id\`
          ELSE 'local:' || COALESCE(${directory}, 'global') || ':session:' || \`session_id\`
        END,
        \`session_id\`,
        \`workspace_id\`,
        \`project_id\`,
        ${host},
        ${directory},
        ${toolSandbox},
        \`title\`,
        \`parent_session_id\`,
        \`archived_at\`,
        \`created_at\`,
        \`updated_at\`
      FROM \`claxedo_session_meta_old_repair\`
    `)
    db.exec("DROP TABLE `claxedo_session_meta_old_repair`")
    ensureSessionMetaIndexes(db)
    db.exec("RELEASE SAVEPOINT claxedo_session_meta_repair")
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT claxedo_session_meta_repair")
    db.exec("RELEASE SAVEPOINT claxedo_session_meta_repair")
    throw error
  }
}

function ensureSessionMetaToolSandboxColumn(db: SqliteInstance, out: string[]) {
  if (!hasTable(db, "claxedo_session_meta")) return
  if (hasColumn(db, "claxedo_session_meta", "tool_sandbox")) return
  db.exec("ALTER TABLE `claxedo_session_meta` ADD COLUMN `tool_sandbox` text")
  out.push("claxedo_session_meta.tool_sandbox")
}

function ensureSessionMetaIndexes(db: SqliteInstance) {
  if (!hasTable(db, "claxedo_session_meta")) return
  db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_meta_workspace_idx` ON `claxedo_session_meta` (`workspace_id`)")
  db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_meta_session_idx` ON `claxedo_session_meta` (`session_id`)")
  db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_meta_project_idx` ON `claxedo_session_meta` (`project_id`)")
  db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_meta_parent_idx` ON `claxedo_session_meta` (`parent_session_id`)")
  db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_meta_updated_idx` ON `claxedo_session_meta` (`updated_at`)")
  db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_meta_workspace_archive_updated_idx` ON `claxedo_session_meta` (`workspace_id`, `archived_at`, `updated_at`, `session_ref`)")
  db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_meta_directory_archive_updated_idx` ON `claxedo_session_meta` (`directory`, `archived_at`, `updated_at`, `session_ref`)")
  db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_meta_project_archive_updated_idx` ON `claxedo_session_meta` (`project_id`, `archived_at`, `updated_at`, `session_ref`)")
}

function rebuildSessionAttachmentRefs(db: SqliteInstance) {
  if (!hasTable(db, "claxedo_session_meta") || !hasColumn(db, "claxedo_session_meta", "session_ref")) return
  if (!hasTable(db, "claxedo_session_attachment") || hasColumn(db, "claxedo_session_attachment", "session_ref")) return
  db.exec("ALTER TABLE `claxedo_session_attachment` RENAME TO `claxedo_session_attachment_old_repair`")
  db.exec(`
    CREATE TABLE IF NOT EXISTS \`claxedo_session_attachment\` (
      \`session_ref\` text NOT NULL,
      \`session_id\` text NOT NULL,
      \`kind\` text NOT NULL,
      \`target_id\` text NOT NULL,
      \`created_at\` integer NOT NULL,
      \`updated_at\` integer NOT NULL,
      PRIMARY KEY(\`session_ref\`, \`kind\`, \`target_id\`)
    )
  `)
  db.exec(`
    INSERT OR REPLACE INTO \`claxedo_session_attachment\` (
      \`session_ref\`,
      \`session_id\`,
      \`kind\`,
      \`target_id\`,
      \`created_at\`,
      \`updated_at\`
    )
    SELECT
      m.\`session_ref\`,
      a.\`session_id\`,
      a.\`kind\`,
      a.\`target_id\`,
      a.\`created_at\`,
      a.\`updated_at\`
    FROM \`claxedo_session_attachment_old_repair\` a
    JOIN \`claxedo_session_meta\` m ON m.\`session_id\` = a.\`session_id\`
  `)
  db.exec("DROP TABLE `claxedo_session_attachment_old_repair`")
}

function rebuildSessionTagRefs(db: SqliteInstance) {
  if (!hasTable(db, "claxedo_session_meta") || !hasColumn(db, "claxedo_session_meta", "session_ref")) return
  if (!hasTable(db, "claxedo_session_tag") || hasColumn(db, "claxedo_session_tag", "session_ref")) return
  db.exec("ALTER TABLE `claxedo_session_tag` RENAME TO `claxedo_session_tag_old_repair`")
  db.exec(`
    CREATE TABLE IF NOT EXISTS \`claxedo_session_tag\` (
      \`session_ref\` text NOT NULL,
      \`session_id\` text NOT NULL,
      \`tag\` text NOT NULL,
      \`created_at\` integer NOT NULL,
      \`updated_at\` integer NOT NULL,
      PRIMARY KEY(\`session_ref\`, \`tag\`)
    )
  `)
  db.exec(`
    INSERT OR REPLACE INTO \`claxedo_session_tag\` (
      \`session_ref\`,
      \`session_id\`,
      \`tag\`,
      \`created_at\`,
      \`updated_at\`
    )
    SELECT
      m.\`session_ref\`,
      t.\`session_id\`,
      t.\`tag\`,
      t.\`created_at\`,
      t.\`updated_at\`
    FROM \`claxedo_session_tag_old_repair\` t
    JOIN \`claxedo_session_meta\` m ON m.\`session_id\` = t.\`session_id\`
  `)
  db.exec("DROP TABLE `claxedo_session_tag_old_repair`")
}

function ensureSessionAssociationIndexes(db: SqliteInstance) {
  if (hasTable(db, "claxedo_session_attachment") && hasColumn(db, "claxedo_session_attachment", "session_ref")) {
    db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_attachment_kind_idx` ON `claxedo_session_attachment` (`kind`, `target_id`)")
    db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_attachment_ref_idx` ON `claxedo_session_attachment` (`session_ref`)")
    db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_attachment_session_idx` ON `claxedo_session_attachment` (`session_id`)")
  }
  if (hasTable(db, "claxedo_session_tag") && hasColumn(db, "claxedo_session_tag", "session_ref")) {
    db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_tag_ref_idx` ON `claxedo_session_tag` (`session_ref`)")
    db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_tag_session_idx` ON `claxedo_session_tag` (`session_id`)")
    db.exec("CREATE INDEX IF NOT EXISTS `claxedo_session_tag_tag_idx` ON `claxedo_session_tag` (`tag`)")
  }
}

function ensureNetworkPolicyHarnessColumn(db: SqliteInstance, out: string[]) {
  if (!hasTable(db, "claxedo_network_policy")) return
  if (hasColumn(db, "claxedo_network_policy", "harness")) return
  db.exec("ALTER TABLE `claxedo_network_policy` ADD COLUMN `harness` text")
  if (hasColumn(db, "claxedo_network_policy", "runner")) {
    db.exec("UPDATE `claxedo_network_policy` SET `harness` = `runner` WHERE `harness` IS NULL")
  }
  out.push("claxedo_network_policy.harness")
}

function renameColumn(db: SqliteInstance, table: string, from: string, to: string, out: string[]) {
  if (!hasTable(db, table)) return
  if (!hasColumn(db, table, from) || hasColumn(db, table, to)) return
  db.exec(`ALTER TABLE \`${table}\` RENAME COLUMN \`${from}\` TO \`${to}\``)
  out.push(`${table}.${to}`)
}

function ensureWorkspaceLeaseDriverColumns(db: SqliteInstance, out: string[]) {
  renameColumn(db, "claxedo_workspace_lease", "provider", "driver", out)
  renameColumn(db, "claxedo_workspace_lease", "provider_object_id", "driver_resource_id", out)
  renameColumn(db, "claxedo_workspace_lease", "provider_snapshot_id", "driver_snapshot_id", out)
  renameColumn(db, "claxedo_runtime_snapshot", "provider_snapshot_id", "driver_snapshot_id", out)
  renameColumn(db, "claxedo_cloud_session", "provider", "driver", out)
  renameColumn(db, "claxedo_terminal_session", "provider", "driver", out)
}

export function repair(db: SqliteInstance) {
  const out: string[] = tabs.filter((name) => !hasTable(db, name))
  const pageNeedsRebuild = hasTable(db, "claxedo_page")
    && (!hasColumn(db, "claxedo_page", "org_id") || hasColumn(db, "claxedo_page", "file_path"))
  const sessionMetaHasHost = hasTable(db, "claxedo_session_meta") && hasColumn(db, "claxedo_session_meta", "host")
  const sessionMetaHasDirectory = hasTable(db, "claxedo_session_meta") && hasColumn(db, "claxedo_session_meta", "directory")
  const sessionMetaHasToolSandbox = hasTable(db, "claxedo_session_meta") && hasColumn(db, "claxedo_session_meta", "tool_sandbox")
  const sessionMetaHasRef = hasTable(db, "claxedo_session_meta") && hasColumn(db, "claxedo_session_meta", "session_ref")
  const sessionMetaNeedsPlacement = hasTable(db, "claxedo_session_meta")
    && (!sessionMetaHasHost || !sessionMetaHasDirectory || !sessionMetaHasRef || column(db, "claxedo_session_meta", "directory")?.notnull === 1)

  if (pageNeedsRebuild) {
    for (const name of pageTabsDropOrder) dropTable(db, name, out)
  }

  sqls.forEach((sql) => db.exec(sql))

  if (sessionMetaNeedsPlacement) {
    rebuildSessionMeta(db, {
      host: sessionMetaHasHost,
      directory: sessionMetaHasDirectory,
      toolSandbox: sessionMetaHasToolSandbox,
    })
    out.push("claxedo_session_meta.placement")
  }
  ensureSessionMetaToolSandboxColumn(db, out)
  rebuildSessionAttachmentRefs(db)
  rebuildSessionTagRefs(db)
  ensureSessionMetaIndexes(db)
  ensureSessionAssociationIndexes(db)
  ensureNetworkPolicyHarnessColumn(db, out)
  ensureWorkspaceLeaseDriverColumns(db, out)

  return out
}
