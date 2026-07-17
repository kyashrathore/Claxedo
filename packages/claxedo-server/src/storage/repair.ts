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
  `CREATE TABLE IF NOT EXISTS \`claxedo_document_index\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`org_id\` text NOT NULL,
    \`project_id\` text NOT NULL,
    \`display_name\` text NOT NULL,
    \`origin_kind\` text NOT NULL,
    \`placement_kind\` text NOT NULL,
    \`placement_id\` text NOT NULL,
    \`managed_relative_path\` text,
    \`repository_id\` text,
    \`workspace_id\` text,
    \`repository_relative_path\` text,
    \`branch\` text,
    \`status\` text NOT NULL DEFAULT 'draft',
    \`session_id\` text,
    \`archived_at\` text,
    \`created_at\` text NOT NULL,
    \`updated_at\` text NOT NULL,
    \`last_opened_at\` text,
    \`last_known_file_version\` text,
    CONSTRAINT \`claxedo_document_index_origin_check\` CHECK (
      (\`origin_kind\` = 'managed'
        AND \`managed_relative_path\` IS NOT NULL
        AND length(\`managed_relative_path\`) > 0
        AND \`repository_id\` IS NULL
        AND \`workspace_id\` IS NULL
        AND \`repository_relative_path\` IS NULL
        AND \`branch\` IS NULL)
      OR
      (\`origin_kind\` = 'repository'
        AND \`managed_relative_path\` IS NULL
        AND \`repository_id\` IS NOT NULL
        AND length(\`repository_id\`) > 0
        AND \`workspace_id\` IS NOT NULL
        AND length(\`workspace_id\`) > 0
        AND \`repository_relative_path\` IS NOT NULL
        AND length(\`repository_relative_path\`) > 0
        AND (\`branch\` IS NULL OR length(\`branch\`) > 0))
    ),
    CONSTRAINT \`claxedo_document_index_placement_check\` CHECK (\`placement_kind\` IN ('local', 'hosted')),
    CONSTRAINT \`claxedo_document_index_common_nonempty_check\` CHECK (
      length(\`id\`) > 0
      AND length(\`org_id\`) > 0
      AND length(\`project_id\`) > 0
      AND length(\`display_name\`) > 0
      AND length(\`placement_id\`) > 0
      AND length(\`status\`) > 0
      AND length(\`created_at\`) > 0
      AND length(\`updated_at\`) > 0
    ),
    CONSTRAINT \`claxedo_document_index_optional_nonempty_check\` CHECK (
      (\`session_id\` IS NULL OR length(\`session_id\`) > 0)
      AND (\`archived_at\` IS NULL OR length(\`archived_at\`) > 0)
      AND (\`last_opened_at\` IS NULL OR length(\`last_opened_at\`) > 0)
      AND (\`last_known_file_version\` IS NULL OR length(\`last_known_file_version\`) > 0)
    )
  )`,
  "CREATE INDEX IF NOT EXISTS `claxedo_document_index_project_idx` ON `claxedo_document_index` (`org_id`, `project_id`, `archived_at`, `updated_at`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `claxedo_document_index_managed_path_unique` ON `claxedo_document_index` (`org_id`, `project_id`, `managed_relative_path`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `claxedo_document_index_repository_path_unique` ON `claxedo_document_index` (`org_id`, `project_id`, `repository_id`, `repository_relative_path`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_local_project` (`directory` text PRIMARY KEY NOT NULL, `project_id` text NOT NULL, `created_at` text NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `claxedo_local_project_id_unique` ON `claxedo_local_project` (`project_id`)",
  "CREATE TABLE IF NOT EXISTS `claxedo_page_status` (`id` text NOT NULL, `project_id` text NOT NULL, `name` text NOT NULL, `color` text NOT NULL DEFAULT '#6b7280', `position` integer NOT NULL DEFAULT 0, `transitions` text NOT NULL DEFAULT '[]', PRIMARY KEY(`project_id`, `id`))",
  "CREATE INDEX IF NOT EXISTS `claxedo_page_status_project_idx` ON `claxedo_page_status` (`project_id`)",
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
  "claxedo_document_index",
  "claxedo_local_project",
  "claxedo_page_status",
  "claxedo_terminal_session",
  "claxedo_channel_delivery",
  "claxedo_channel_state",
  "claxedo_channel_run_audit",
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

function rebuildSessionMeta(
  db: SqliteInstance,
  existing: { host: boolean; directory: boolean; toolSandbox: boolean; model: boolean },
) {
  const host = existing.host ? "COALESCE(NULLIF(`host`, ''), 'workspace')" : "'workspace'"
  const directory = existing.directory ? "NULLIF(`directory`, '')" : "NULL"
  const toolSandbox = existing.toolSandbox ? "`tool_sandbox`" : "NULL"
  const modelProviderID = existing.model ? "`model_provider_id`" : "NULL"
  const modelID = existing.model ? "`model_id`" : "NULL"

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
        \`model_provider_id\` text,
        \`model_id\` text,
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
        \`model_provider_id\`,
        \`model_id\`,
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
        ${modelProviderID},
        ${modelID},
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

function ensureSessionMetaModelColumns(db: SqliteInstance, out: string[]) {
  if (!hasTable(db, "claxedo_session_meta")) return
  if (!hasColumn(db, "claxedo_session_meta", "model_provider_id")) {
    db.exec("ALTER TABLE `claxedo_session_meta` ADD COLUMN `model_provider_id` text")
    out.push("claxedo_session_meta.model_provider_id")
  }
  if (!hasColumn(db, "claxedo_session_meta", "model_id")) {
    db.exec("ALTER TABLE `claxedo_session_meta` ADD COLUMN `model_id` text")
    out.push("claxedo_session_meta.model_id")
  }
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
  const sessionMetaHasHost = hasTable(db, "claxedo_session_meta") && hasColumn(db, "claxedo_session_meta", "host")
  const sessionMetaHasDirectory = hasTable(db, "claxedo_session_meta") && hasColumn(db, "claxedo_session_meta", "directory")
  const sessionMetaHasToolSandbox = hasTable(db, "claxedo_session_meta") && hasColumn(db, "claxedo_session_meta", "tool_sandbox")
  const sessionMetaHasModel = hasTable(db, "claxedo_session_meta")
    && hasColumn(db, "claxedo_session_meta", "model_provider_id")
    && hasColumn(db, "claxedo_session_meta", "model_id")
  const sessionMetaHasRef = hasTable(db, "claxedo_session_meta") && hasColumn(db, "claxedo_session_meta", "session_ref")
  const sessionMetaNeedsPlacement = hasTable(db, "claxedo_session_meta")
    && (!sessionMetaHasHost || !sessionMetaHasDirectory || !sessionMetaHasRef || column(db, "claxedo_session_meta", "directory")?.notnull === 1)

  sqls.forEach((sql) => db.exec(sql))

  if (sessionMetaNeedsPlacement) {
    rebuildSessionMeta(db, {
      host: sessionMetaHasHost,
      directory: sessionMetaHasDirectory,
      toolSandbox: sessionMetaHasToolSandbox,
      model: sessionMetaHasModel,
    })
    out.push("claxedo_session_meta.placement")
  }
  ensureSessionMetaToolSandboxColumn(db, out)
  ensureSessionMetaModelColumns(db, out)
  rebuildSessionAttachmentRefs(db)
  rebuildSessionTagRefs(db)
  ensureSessionMetaIndexes(db)
  ensureSessionAssociationIndexes(db)
  ensureNetworkPolicyHarnessColumn(db, out)
  ensureWorkspaceLeaseDriverColumns(db, out)
  return out
}
