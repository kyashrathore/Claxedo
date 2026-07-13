import { createHash } from "node:crypto"
import { cleanupStreamBeforeRemoval } from "../../application/stream-lifecycle-service"
import type { OperationID, StreamID, WorkGraphContext } from "../../contracts"
import {
  WorkGraphOwnerDeletionError,
  type ChildIsolationID,
  type StreamEnvelopeID,
  type WorkGraphOwnerDeletionPort,
  type WorkGraphOwnerDeletionResult,
  type WorkspaceExecutionPort,
} from "../../ports"
import type { RawDatabase, SqliteInput } from "../../sqlite"
import { initializeWorkGraphSqliteSchema } from "./schema"

const deletionLeaseMs = 5 * 60 * 1_000

const ownerTablesInDeletionOrder = [
  "wg_v2_notifications",
  "wg_v2_decision_work_items",
  "wg_v2_evidence",
  "wg_v2_durable_effect_receipts",
  "wg_v2_record_source_revisions",
  "wg_v2_work_item_dependencies",
  "wg_v2_changes",
  "wg_v2_events",
  "wg_v2_outbox",
  "wg_v2_due_jobs",
  "wg_v2_stream_cleanup_reservations",
  "wg_v2_runtime_effects",
  "wg_v2_leases",
  "wg_v2_attempts",
  "wg_v2_decisions",
  "wg_v2_work_items",
  "wg_v2_outcomes",
  "wg_v2_recaps",
  "wg_v2_stream_sequences",
  "wg_v2_streams",
  "wg_v2_external_identities",
  "wg_v2_admission_proposals",
  "wg_v2_intake_candidates",
  "wg_v2_source_views",
  "wg_v2_work_source_revisions",
  "wg_v2_work_sources",
  "wg_v2_change_cursors",
  "wg_v2_archive_restores",
  "wg_v2_migration_intake",
  "wg_v2_operation_results",
  "wg_v2_workgraphs",
] as const

type CleanupTarget = Readonly<{
  streamId: StreamID
  envelopeId: StreamEnvelopeID
  childIsolationIds: readonly ChildIsolationID[]
}>

type DeletionReceipt = Readonly<{
  state: "cleaning" | "completed"
  target_snapshot_hash: string
  result_json: string | null
  lease_expires_at: number
}>

type PreparedDeletion =
  | Readonly<{ state: "completed"; result: WorkGraphOwnerDeletionResult }>
  | Readonly<{ state: "in_progress" }>
  | Readonly<{ state: "acquired"; targets: readonly CleanupTarget[]; targetSnapshotHash: string }>

export function createSqliteWorkGraphOwnerDeletionPort(
  databaseInput: SqliteInput,
  execution: WorkspaceExecutionPort,
  clock: Readonly<{ now: () => number }> = { now: () => Date.now() },
): WorkGraphOwnerDeletionPort {
  const database = initializeWorkGraphSqliteSchema(databaseInput).raw()
  if (!database) throw new Error("SQLite owner deletion requires direct transactional database access")

  return {
    deleteOwner: async (context, input) => {
      requireOwner(context)
      const prepared = prepareSafely(database, context, input.operationId, clock.now())
      if (prepared.state === "completed") return prepared.result
      if (prepared.state === "in_progress") throw new WorkGraphOwnerDeletionError("in_progress")

      try {
        await cleanupTargets(context, prepared.targets, execution, async () => undefined)
      } catch {
        releaseDeletionSafely(database, context, input.operationId)
        throw new WorkGraphOwnerDeletionError("cleanup_failed")
      }

      let result: WorkGraphOwnerDeletionResult | undefined
      try {
        result = finalizeDeletion(database, context, input.operationId, prepared, clock.now())
      } catch {
        releaseDeletionSafely(database, context, input.operationId)
        throw new WorkGraphOwnerDeletionError("storage_failed")
      }
      if (result) return result
      releaseDeletionSafely(database, context, input.operationId)
      throw new WorkGraphOwnerDeletionError("not_quiescent")
    },
  }
}

function prepareSafely(
  database: RawDatabase,
  context: WorkGraphContext,
  operationId: OperationID,
  occurredAt: number,
) {
  try {
    return prepareDeletion(database, context, operationId, occurredAt)
  } catch (error) {
    if (error instanceof WorkGraphOwnerDeletionError) throw error
    throw new WorkGraphOwnerDeletionError("storage_failed")
  }
}

function prepareDeletion(
  database: RawDatabase,
  context: WorkGraphContext,
  operationId: OperationID,
  occurredAt: number,
): PreparedDeletion {
  return database.transaction(() => {
    const ownerSubjectHash = hash(context.ownerUserId)
    const operationHash = hash(operationId)
    const active = database.prepare(`
      SELECT operation_hash, lease_expires_at FROM wg_owner_deletion_receipts
      WHERE owner_subject_hash = ? AND state = 'cleaning'
    `).get(ownerSubjectHash) as { operation_hash: string; lease_expires_at: number } | undefined
    if (active && active.operation_hash !== operationHash && active.lease_expires_at > occurredAt) {
      return { state: "in_progress" as const }
    }
    if (active && active.operation_hash !== operationHash) {
      database.prepare(`
        DELETE FROM wg_owner_deletion_receipts WHERE owner_subject_hash = ? AND operation_hash = ? AND state = 'cleaning'
      `).run(ownerSubjectHash, active.operation_hash)
    }
    const receipt = database.prepare(`
      SELECT state, target_snapshot_hash, result_json, lease_expires_at
      FROM wg_owner_deletion_receipts WHERE owner_subject_hash = ? AND operation_hash = ?
    `).get(ownerSubjectHash, operationHash) as DeletionReceipt | undefined
    if (receipt?.state === "completed") return { state: "completed" as const, result: parseResult(receipt.result_json) }
    if (receipt?.state === "cleaning" && receipt.lease_expires_at > occurredAt) return { state: "in_progress" as const }
    if (!isQuiescent(database, context)) throw new WorkGraphOwnerDeletionError("not_quiescent")

    const targets = readCleanupTargets(database, context)
    const targetSnapshotHash = hash(JSON.stringify(targets))
    database.prepare(`
      INSERT INTO wg_owner_deletion_receipts
        (owner_subject_hash, operation_hash, state, target_snapshot_hash, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, 'cleaning', ?, ?, ?, ?)
      ON CONFLICT(owner_subject_hash, operation_hash) DO UPDATE SET
        state = 'cleaning', target_snapshot_hash = excluded.target_snapshot_hash, result_json = NULL,
        lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at
    `).run(ownerSubjectHash, operationHash, targetSnapshotHash, occurredAt + deletionLeaseMs, occurredAt, occurredAt)
    return { state: "acquired" as const, targets, targetSnapshotHash }
  })()
}

function finalizeDeletion(
  database: RawDatabase,
  context: WorkGraphContext,
  operationId: OperationID,
  prepared: Extract<PreparedDeletion, { state: "acquired" }>,
  occurredAt: number,
) {
  return database.transaction(() => {
    if (!isQuiescent(database, context)) return undefined
    if (hash(JSON.stringify(readCleanupTargets(database, context))) !== prepared.targetSnapshotHash) return undefined
    const recordCount = countOwnerRecords(database, context)
    database.prepare("UPDATE wg_v2_recaps SET previous_recap_id = NULL WHERE owner_user_id = ?").run(context.ownerUserId)
    ownerTablesInDeletionOrder.forEach((table) => {
      database.prepare(`DELETE FROM ${table} WHERE owner_user_id = ?`).run(context.ownerUserId)
    })
    if (countOwnerRecords(database, context) !== 0) throw new Error("Owner state remains after permanent deletion")

    const result = {
      deleted: true,
      recordCount,
      workspaceCount: prepared.targets.length,
      completedAt: occurredAt,
    } satisfies WorkGraphOwnerDeletionResult
    const updated = database.prepare(`
      UPDATE wg_owner_deletion_receipts SET state = 'completed', result_json = ?, lease_expires_at = 0, updated_at = ?
      WHERE owner_subject_hash = ? AND operation_hash = ? AND state = 'cleaning' AND target_snapshot_hash = ?
    `).run(JSON.stringify(result), occurredAt, hash(context.ownerUserId), hash(operationId), prepared.targetSnapshotHash)
    if (updated.changes !== 1) throw new Error("Owner deletion receipt lost")
    return result
  })()
}

function cleanupTargets(
  context: WorkGraphContext,
  targets: readonly CleanupTarget[],
  execution: WorkspaceExecutionPort,
  remove: () => Promise<void>,
): Promise<void> {
  const [target, ...remaining] = targets
  if (!target) return remove()
  return cleanupStreamBeforeRemoval(context, { ...target, mode: "delete" }, execution, () =>
    cleanupTargets(context, remaining, execution, remove))
}

function readCleanupTargets(database: RawDatabase, context: WorkGraphContext): readonly CleanupTarget[] {
  const rows = database.prepare(`
    SELECT id, envelope_identity_json FROM wg_v2_streams
    WHERE owner_user_id = ? AND envelope_identity_json IS NOT NULL ORDER BY id
  `).all(context.ownerUserId) as Array<{ id: StreamID; envelope_identity_json: string }>
  return rows.map((row) => {
    const envelope = JSON.parse(row.envelope_identity_json) as { id?: unknown }
    if (typeof envelope.id !== "string" || envelope.id.length === 0) throw new WorkGraphOwnerDeletionError("storage_failed")
    const childIsolationIds = (database.prepare(`
      SELECT DISTINCT child_workspace_id FROM wg_v2_attempts
      WHERE owner_user_id = ? AND stream_id = ? AND child_workspace_id IS NOT NULL
      ORDER BY child_workspace_id
    `).all(context.ownerUserId, row.id) as Array<{ child_workspace_id: ChildIsolationID }>)
      .map((attempt) => attempt.child_workspace_id)
    return { streamId: row.id, envelopeId: envelope.id as StreamEnvelopeID, childIsolationIds }
  })
}

function isQuiescent(database: RawDatabase, context: WorkGraphContext) {
  const checks = [
    "SELECT 1 FROM wg_v2_attempts WHERE owner_user_id = ? AND lifecycle IN ('admitted', 'placing', 'running', 'attention') LIMIT 1",
    "SELECT 1 FROM wg_v2_leases WHERE owner_user_id = ? LIMIT 1",
    "SELECT 1 FROM wg_v2_runtime_effects WHERE owner_user_id = ? AND state != 'completed' LIMIT 1",
    "SELECT 1 FROM wg_v2_stream_cleanup_reservations WHERE owner_user_id = ? AND state = 'reserved' LIMIT 1",
    "SELECT 1 FROM wg_v2_admission_proposals WHERE owner_user_id = ? AND lifecycle = 'planning' LIMIT 1",
    "SELECT 1 FROM wg_v2_outbox WHERE owner_user_id = ? AND status != 'completed' LIMIT 1",
    "SELECT 1 FROM wg_v2_due_jobs WHERE owner_user_id = ? AND status IN ('pending', 'running', 'claimed') LIMIT 1",
  ]
  return checks.every((query) => !database.prepare(query).get(context.ownerUserId))
}

function countOwnerRecords(database: RawDatabase, context: WorkGraphContext) {
  const actualOwnerTables = (database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wg_v2_%' ORDER BY name
  `).all() as Array<{ name: string }>)
    .filter((table) => (database.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>)
      .some((column) => column.name === "owner_user_id"))
    .map((table) => table.name)
  if (actualOwnerTables.some((table) => !ownerTablesInDeletionOrder.includes(table as typeof ownerTablesInDeletionOrder[number]))) {
    throw new WorkGraphOwnerDeletionError("storage_failed")
  }
  return ownerTablesInDeletionOrder.reduce((total, table) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_user_id = ?`)
      .get(context.ownerUserId) as { count: number }
    return total + row.count
  }, 0)
}

function releaseDeletion(database: RawDatabase, context: WorkGraphContext, operationId: OperationID) {
  database.prepare(`
    UPDATE wg_owner_deletion_receipts SET lease_expires_at = 0
    WHERE owner_subject_hash = ? AND operation_hash = ? AND state = 'cleaning'
  `).run(hash(context.ownerUserId), hash(operationId))
}

function releaseDeletionSafely(database: RawDatabase, context: WorkGraphContext, operationId: OperationID) {
  try {
    releaseDeletion(database, context, operationId)
  } catch {
    throw new WorkGraphOwnerDeletionError("storage_failed")
  }
}

function parseResult(value: string | null): WorkGraphOwnerDeletionResult {
  if (!value) throw new WorkGraphOwnerDeletionError("storage_failed")
  const result = JSON.parse(value) as Partial<WorkGraphOwnerDeletionResult>
  if (result.deleted !== true || !Number.isSafeInteger(result.recordCount) || Number(result.recordCount) < 0 ||
    !Number.isSafeInteger(result.workspaceCount) || Number(result.workspaceCount) < 0 ||
    !Number.isSafeInteger(result.completedAt) || Number(result.completedAt) < 0) {
    throw new WorkGraphOwnerDeletionError("storage_failed")
  }
  return result as WorkGraphOwnerDeletionResult
}

function requireOwner(context: WorkGraphContext) {
  if (context.access.mode !== "owner") throw new WorkGraphOwnerDeletionError("forbidden")
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
