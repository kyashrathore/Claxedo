import { createHash } from "node:crypto"
import { client, type SqliteInput } from "../../sqlite"

export type LegacyMigrationTarget = {
  organizationId: string
  ownerUserId: string
  workgraphId: string
  now: () => string
  idFor: (kind: "source" | "revision" | "intake", legacyTable: string, legacyRecordId: string) => string
}

export type LegacyMigrationSource = {
  legacyTable: "sources_current"
  legacyRecordId: string
  sourceId: string
  revisionId: string
  title: string
  content: string
  contentHash: string
}

export type LegacyMigrationIntake = {
  id: string
  legacyTable: string
  legacyRecordId: string
  intakeKind: "source_review" | "work_mapping_review" | "run_mapping_review"
  reason: string
  rawReference: Record<string, string | number | null>
}

export type LegacyMigrationReport = {
  organizationId: string
  ownerUserId: string
  workgraphId: string
  exportedAt: string
  sources: LegacyMigrationSource[]
  intake: LegacyMigrationIntake[]
  skippedCredentialRecords: number
}

type LegacySource = {
  source_id: string
  goal: string
  kind: string
  title: string
  content: string
  provider: string | null
  provider_connection_id: string | null
  import_mode: string | null
}

type LegacyRun = {
  run_id: string
  goal: string
  status: string
  source_id: string | null
  runtime_type: string
}

type LegacyNode = {
  node_id: string
  run_id: string
  kind: string
  title: string
  status: string
  node_type: string
}

type LegacyExecutionRow = {
  attempt_id: string
  run_id: string
  node_id: string
  status: string
  runtime_type: string
}

type LegacyRunSource = {
  run_id: string
  kind: string
  title: string
}

type LegacyRunNodeItem = {
  run_id: string
  node_id: string
  work_item_id: string
}

export function exportLegacyWorkGraphMigration(input: SqliteInput, target: LegacyMigrationTarget): LegacyMigrationReport {
  requireTarget(target)
  const db = client(input)
  const sources = db
    .prepare(
      `SELECT source_id, goal, kind, title, content, provider, provider_connection_id, import_mode
       FROM sources_current ORDER BY source_id`,
    )
    .all() as LegacySource[]
  const migratedSources = sources.filter(isProvableManualSource).map((source) => ({
    legacyTable: "sources_current" as const,
    legacyRecordId: source.source_id,
    sourceId: target.idFor("source", "sources_current", source.source_id),
    revisionId: target.idFor("revision", "sources_current", source.source_id),
    title: source.title,
    content: source.content,
    contentHash: createHash("sha256").update(source.content).digest("hex"),
  }))
  const intake = [
    ...sources.filter((source) => !isProvableManualSource(source)).map((source) => sourceIntake(target, source)),
    ...(db.prepare("SELECT run_id, goal, status, source_id, runtime_type FROM runs_current ORDER BY run_id").all() as LegacyRun[]).map((run) =>
      workIntake(
        target,
        "runs_current",
        run.run_id,
        "A legacy run does not prove whether it is a Stream or Outcome, and its status does not prove completion under an evidence contract.",
        { run_id: run.run_id, goal: run.goal, status: run.status, source_id: run.source_id, runtime_type: run.runtime_type },
      ),
    ),
    ...(db.prepare("SELECT node_id, run_id, kind, title, status, node_type FROM nodes_current ORDER BY node_id").all() as LegacyNode[]).map((node) =>
      workIntake(
        target,
        "nodes_current",
        node.node_id,
        "A legacy node cannot be assigned to a Work Item or Outcome without a user-confirmed mapping; its status is not completion evidence.",
        { node_id: node.node_id, run_id: node.run_id, kind: node.kind, title: node.title, status: node.status, node_type: node.node_type },
      ),
    ),
    ...(db.prepare("SELECT attempt_id, run_id, node_id, status, runtime_type FROM attempts_current ORDER BY attempt_id").all() as LegacyExecutionRow[]).map(
      (execution) => runIntake(target, execution),
    ),
    ...(db.prepare("SELECT run_id, kind, title FROM run_sources_current ORDER BY run_id").all() as LegacyRunSource[]).map((source) =>
      workIntake(
        target,
        "run_sources_current",
        source.run_id,
        "A run-attached source has no stable source identity, so its relationship requires review before creating a Work Source revision.",
        { run_id: source.run_id, kind: source.kind, title: source.title },
      ),
    ),
    ...(db.prepare("SELECT run_id, node_id, work_item_id FROM run_node_items_current ORDER BY run_id, node_id, work_item_id").all() as LegacyRunNodeItem[]).map(
      (row) => {
        const recordId = `${row.run_id}:${row.node_id}:${row.work_item_id}`
        return workIntake(
          target,
          "run_node_items_current",
          recordId,
          "A legacy run/node/item association does not prove the corresponding v2 Stream, Outcome, or Work Item identities.",
          { run_id: row.run_id, node_id: row.node_id, work_item_id: row.work_item_id },
        )
      },
    ),
  ]

  return {
    organizationId: target.organizationId,
    ownerUserId: target.ownerUserId,
    workgraphId: target.workgraphId,
    exportedAt: target.now(),
    sources: migratedSources,
    intake,
    skippedCredentialRecords: (db.prepare("SELECT COUNT(*) AS count FROM provider_connections_current").get() as { count: number }).count,
  }
}

export function applyLegacyWorkGraphMigration(input: SqliteInput, target: LegacyMigrationTarget) {
  const report = exportLegacyWorkGraphMigration(input, target)
  const exportedAt = Date.parse(report.exportedAt)
  if (!Number.isFinite(exportedAt)) throw new Error("Legacy migration requires a valid export timestamp")
  const db = client(input)
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO wg_v2_workgraphs (organization_id, owner_user_id, id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(report.organizationId, report.ownerUserId, report.workgraphId, exportedAt, exportedAt)

    for (const source of report.sources) {
      db.prepare(
        `INSERT OR IGNORE INTO wg_v2_work_sources
           (organization_id, owner_user_id, id, workgraph_id, title, source_kind, latest_revision_number, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'manual', 1, ?, ?)`,
      ).run(report.organizationId, report.ownerUserId, source.sourceId, report.workgraphId, source.title, exportedAt, exportedAt)
      db.prepare(
        `INSERT OR IGNORE INTO wg_v2_work_source_revisions
           (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, origin_kind, origin_reference_json, created_by_json, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, 'manual', ?, ?, ?)`,
      ).run(
        report.organizationId,
        report.ownerUserId,
        source.revisionId,
        source.sourceId,
        source.content,
        source.contentHash,
        JSON.stringify({ legacyTable: source.legacyTable, legacyRecordId: source.legacyRecordId }),
        JSON.stringify({ type: "system", id: "legacy_migration" }),
        exportedAt,
      )
      assertSourceIdentity(db, report.organizationId, report.ownerUserId, source)
    }

    for (const row of report.intake) {
      db.prepare(
        `INSERT OR IGNORE INTO wg_v2_migration_intake
           (organization_id, owner_user_id, id, legacy_table, legacy_record_id, intake_kind, reason, raw_reference_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        report.organizationId,
        report.ownerUserId,
        row.id,
        row.legacyTable,
        row.legacyRecordId,
        row.intakeKind,
        row.reason,
        JSON.stringify(row.rawReference),
        exportedAt,
        exportedAt,
      )
      assertIntakeIdentity(db, report.organizationId, report.ownerUserId, row)
    }
  })()

  return { applied: true as const, migratedSources: report.sources.length, intakeRecords: report.intake.length, skippedCredentialRecords: report.skippedCredentialRecords }
}

function requireTarget(target: LegacyMigrationTarget) {
  if (!target.organizationId.trim()) throw new Error("Legacy migration requires one trusted organization ID")
  if (!target.ownerUserId.trim()) throw new Error("Legacy migration requires one trusted owner user ID")
  if (!target.workgraphId.trim()) throw new Error("Legacy migration requires one target WorkGraph ID")
}

function isProvableManualSource(source: LegacySource) {
  return source.kind === "manual" && source.provider === null && source.provider_connection_id === null && source.import_mode === null
}

function sourceIntake(target: LegacyMigrationTarget, source: LegacySource): LegacyMigrationIntake {
  return {
    id: target.idFor("intake", "sources_current", source.source_id),
    legacyTable: "sources_current",
    legacyRecordId: source.source_id,
    intakeKind: "source_review",
    reason: "This source is not provably manual and local; its provider ownership and revision semantics require review.",
    rawReference: { source_id: source.source_id, goal: source.goal, kind: source.kind, title: source.title, provider: source.provider },
  }
}

function workIntake(
  target: LegacyMigrationTarget,
  table: string,
  recordId: string,
  reason: string,
  rawReference: Record<string, string | number | null>,
): LegacyMigrationIntake {
  return { id: target.idFor("intake", table, recordId), legacyTable: table, legacyRecordId: recordId, intakeKind: "work_mapping_review", reason, rawReference }
}

function runIntake(target: LegacyMigrationTarget, execution: LegacyExecutionRow): LegacyMigrationIntake {
  return {
    id: target.idFor("intake", "attempts_current", execution.attempt_id),
    legacyTable: "attempts_current",
    legacyRecordId: execution.attempt_id,
    intakeKind: "run_mapping_review",
    reason: "A historical execution cannot be attached until its run and node have user-confirmed Work Item mappings; its status does not prove completion.",
    rawReference: {
      attempt_id: execution.attempt_id,
      run_id: execution.run_id,
      node_id: execution.node_id,
      status: execution.status,
      runtime_type: execution.runtime_type,
    },
  }
}

function assertSourceIdentity(db: ReturnType<typeof client>, organizationId: string, ownerUserId: string, source: LegacyMigrationSource) {
  const parent = db.prepare("SELECT title, source_kind FROM wg_v2_work_sources WHERE organization_id = ? AND owner_user_id = ? AND id = ?").get(organizationId, ownerUserId, source.sourceId) as
    | { title: string; source_kind: string }
    | undefined
  const revision = db.prepare("SELECT work_source_id, content_hash FROM wg_v2_work_source_revisions WHERE organization_id = ? AND owner_user_id = ? AND id = ?").get(
    organizationId,
    ownerUserId,
    source.revisionId,
  ) as { work_source_id: string; content_hash: string } | undefined
  if (parent?.title === source.title && parent.source_kind === "manual" && revision?.work_source_id === source.sourceId && revision.content_hash === source.contentHash) return
  throw new Error(`Legacy migration ID collision for sources_current:${source.legacyRecordId}`)
}

function assertIntakeIdentity(db: ReturnType<typeof client>, organizationId: string, ownerUserId: string, intake: LegacyMigrationIntake) {
  const row = db.prepare(
    `SELECT id, intake_kind, reason, raw_reference_json
     FROM wg_v2_migration_intake
     WHERE organization_id = ? AND owner_user_id = ? AND legacy_table = ? AND legacy_record_id = ?`,
  ).get(organizationId, ownerUserId, intake.legacyTable, intake.legacyRecordId) as
    | { id: string; intake_kind: string; reason: string; raw_reference_json: string }
    | undefined
  if (
    row?.id === intake.id &&
    row.intake_kind === intake.intakeKind &&
    row.reason === intake.reason &&
    row.raw_reference_json === JSON.stringify(intake.rawReference)
  ) return
  throw new Error(`Legacy migration ID collision for ${intake.legacyTable}:${intake.legacyRecordId}`)
}
