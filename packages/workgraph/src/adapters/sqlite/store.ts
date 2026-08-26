import { createHash } from "node:crypto"
import type BetterSqlite3 from "better-sqlite3"
import {
  AdmissionAgentPlanSchema,
  AdmissionProposalDtoSchema,
  AdmissionProposalGenerationSchema,
  AttentionItemSchema,
  AttentionPageSchema,
  RunDtoSchema,
  AuthoringSourceRevisionSchema,
  ChangeEnvelopeSchema,
  compareSnapshotCursorPosition,
  createAttentionCursor,
  createChangeCursor,
  createEvidencePageCursor,
  decodeSnapshotResumeCursor,
  createSnapshotResumeCursor,
  createWorkSourcePageCursor,
  DecisionDtoSchema,
  EvidenceDtoSchema,
  EvidencePageSchema,
  ExecutionProfileDefaultsSchema,
  masterSessionId,
  modelUsageCostUsd,
  nextDailyMasterRun,
  PARKED_LEASE_TTL_MS,
  isRunResumeCapExceeded,
  OutcomeDtoSchema,
  readAttentionCursor,
  readChangeCursor,
  readEvidencePageCursor,
  resolvedPlacement,
  SnapshotResumeCursorError,
  readWorkSourcePageCursor,
  ReplacementReviewSchema,
  ResolvedExecutionProfileSchema,
  StreamDtoSchema,
  StreamMasterStatusSchema,
  WorkGraphDefaultsDtoSchema,
  WorkItemDtoSchema,
  WorkSourceDtoSchema,
  WorkSourceOriginSchema,
  WorkSourceRevisionDtoSchema,
  type ExecutionCapabilities,
  type ExecutionProfileDefaults,
  type AgentProfile,
  type StreamProfileSpend,
} from "../../contracts"
import type {
  AttentionListInput,
  AttentionPage,
  ChangeCursor,
  SnapshotResumeCursor,
  ChangeEnvelope,
  CommandError,
  CommandErrorCode,
  CommandResult,
  CompletionContract,
  EvidenceDto,
  EvidenceListInput,
  EvidencePage,
  EvidenceReadInput,
  EvidenceInput,
  EvidenceSubject,
  OperationID,
  OutcomeID,
  StreamID,
  StreamDto,
  WorkSourceRevisionRef,
  WorkSourceDto,
  WorkSourceID,
  WorkSourcePageCursor,
  WorkSourceRevisionDto,
  WorkSourceRevisionID,
  WorkGraphPublicRecord,
  WorkGraphDefaultsDto,
  WorkGraphRecordReference,
  WorkGraphSnapshotPage,
  StreamLifecycleState,
  WorkGraphCommandRequest,
  WorkGraphContext,
  RunID,
  WorkItemID,
  AdmissionProposalDto,
  DecisionDto,
  ReplacementReview,
  ReplacementReviewInput,
  WorkItemDto,
  WorkGraphEventType,
  ChangeResource,
} from "../../contracts"
import { carveExecutionBudget, dependencyGraphHasCycle, renderStreamNotes } from "../../domain"
import { RunDetailDtoSchema, WorkItemRunPageSchema, createWorkItemRunPageCursor, readWorkItemRunPageCursor } from "../../contracts/details"
import type { RunDetailDto, WorkItemRunListInput, WorkItemRunPage } from "../../contracts/details"
import { createWorkGraphService, type WorkGraphService } from "../../application/workgraph-service"
import { rankDuplicateMatches, rankStreamMatches, type DuplicateCandidate, type MatchableStream } from "../../application/matching-service"
import { placeAdmittedRun, type PlacementCompensation } from "../../application/execution-service"
import type { RunResultStore } from "../../application/completion-service"
import { completeOutcome, evaluateCompletionContract, reopenOutcome } from "../../domain/completion"
import { transitionDecision, transitionStream, transitionStreamVisibility } from "../../domain/transitions"
import { resolveExecutionProfile } from "../../domain/execution-profile"
import { validateExecutionProfileDefaultsAgainstCapabilities, validateResolvedExecutionProfileAgainstCapabilities } from "../../domain/execution-capability-policy"
import { defineAtomicWorkGraphStore, type AtomicWorkGraphStore, type WorkGraphCommandHandler, type WorkGraphCommandHandlers } from "../../ports/store"
import type { ExecutionSessionID, StreamEnvelopeID, WorkspaceExecutionPort } from "../../ports/workspace-execution"
import { buildRunPrompt } from "../../application/run-prompt"
import type { RunRuntimePort } from "../../ports/run-runtime"
import type { ExecutionCapabilitiesPort } from "../../ports/execution-capabilities"
import type { SqliteInput } from "../../sqlite"
import { assertNoSqliteWorkGraphOwnerDeletion, SqliteWorkGraphOwnerDeletionInProgressError } from "./deletion-barrier"
import { initializeWorkGraphSqliteSchema } from "./schema"
import { createSqliteWorkGraphActivityPorts } from "./activity-store"
import { allocateSqliteChangeCursor } from "./change-cursor"
import type { TaskActivityListInput, TaskActivityPage } from "../../contracts/activity"

const rootId = "workgraph_default"
const ownerEventScopeId = "__workgraph_owner_events__"
const sqliteAttentionRows = `
  SELECT 'admission_proposal' AS kind, id, CAST(updated_at AS INTEGER) AS updated_at,
    NULL AS job_type, NULL AS subject_id, NULL AS stream_id, NULL AS last_error, NULL AS payload_json
  FROM wg_v2_admission_proposals WHERE organization_id = @organization AND owner_user_id = @owner AND lifecycle = 'proposed'
  UNION ALL
  SELECT 'decision', id, CAST(updated_at AS INTEGER), NULL, NULL, NULL, NULL, NULL
  FROM wg_v2_decisions WHERE organization_id = @organization AND owner_user_id = @owner AND lifecycle IN ('proposed', 'pending')
  UNION ALL
  SELECT 'work_item', id, CAST(updated_at AS INTEGER), NULL, NULL, NULL, NULL, NULL
  FROM wg_v2_work_items
  WHERE organization_id = @organization AND owner_user_id = @owner AND lifecycle IN ('pending_approval', 'result_ready', 'blocked', 'review_needed', 'integration_needed', 'verification_failed', 'failed')
  UNION ALL
  SELECT 'run', id, CAST(updated_at AS INTEGER), NULL, NULL, NULL, NULL, NULL
  FROM wg_v2_runs WHERE organization_id = @organization AND owner_user_id = @owner AND lifecycle = 'parked'
  UNION ALL
  SELECT 'unorganized_ai_work', 'unorganized_ai_work', CAST(MAX(updated_at) AS INTEGER), NULL, NULL, NULL, NULL, NULL
  FROM wg_v2_intake_candidates WHERE organization_id = @organization AND owner_user_id = @owner
  HAVING SUM(CASE WHEN status = 'unorganized' THEN 1 ELSE 0 END) > 0
  UNION ALL
  SELECT 'configuration_required', id, CAST(updated_at AS INTEGER), job_type, subject_id, stream_id, last_error, payload_json
  FROM wg_v2_due_jobs
  WHERE organization_id = @organization AND owner_user_id = @owner AND job_type = 'source_plan'
    AND status IN ('pending', 'failed', 'failed_terminal', 'attention')
    AND last_error IS NOT NULL
    AND json_extract(payload_json, '$.configurationRequirement.type') = 'generation'
  UNION ALL
  SELECT 'master_escalation', id, CAST(updated_at AS INTEGER), NULL, id, id,
    json_extract(master_status_json, '$.message'), NULL
  FROM wg_v2_streams
  WHERE organization_id = @organization AND owner_user_id = @owner
    AND json_extract(master_status_json, '$.state') = 'attention'
`

export const SQLITE_WORKGRAPH_SUPPORTED_COMMANDS = [
  "update_workgraph_defaults",
  "create_work_source",
  "revise_work_source",
  "create_stream",
  "update_stream",
  "set_stream_charter",
  "call_master",
  "record_landing_conflict",
  "update_stream_notes",
  "request_public_pr_confirmation",
  "confirm_public_pr",
  "record_master_audit",
  "set_stream_lifecycle",
  "create_outcome",
  "update_outcome",
  "create_work_item",
  "update_work_item",
  "approve_work_item",
  "reject_work_item",
  "approve_work_items",
  "arm_work_item",
  "arm_work_items",
  "retry_work_item",
  "propose_admission",
  "retry_admission_planning",
  "dismiss_admission",
  "reopen_admission",
  "confirm_admission",
  "set_stream_visibility",
  "propose_decision",
  "answer_decision",
  "dismiss_decision",
  "record_run_checkpoint",
  "complete_run",
  "record_evidence",
  "close_outcome",
  "reopen_outcome",
  "close_stream",
  "delete_stream",
  "cancel_work_item",
] as const

const SUBTASK_SEAT_FORBIDDEN_COMMANDS = new Set(["create_work_item", "propose_admission", "propose_decision"])

export const SQLITE_WORKGRAPH_UNSUPPORTED_COMMANDS = ["cancel_run", "restart_run"] as const

type Database = BetterSqlite3.Database

export type SqliteWorkGraphStoreInput = Readonly<{
  database: Database
  clock?: Readonly<{ now: () => number }>
  ids?: Readonly<{ next: (kind: string) => string }>
  execution?: WorkspaceExecutionPort
  executionCapabilities?: ExecutionCapabilitiesPort
  leaseDurationMs?: number
  replacementRetryDelayMs?: number
}>

type SqliteCommands = WorkGraphCommandHandlers
type SqliteQueries = Readonly<{
  defaults: Readonly<{
    read: (context: WorkGraphContext, input: Readonly<Record<string, never>>) => Promise<WorkGraphDefaultsDto>
  }>
  snapshot: Readonly<{
    page: (context: WorkGraphContext, input: Readonly<{ after?: SnapshotResumeCursor; limit: number }>) => Promise<WorkGraphSnapshotPage>
  }>
  attention: Readonly<{ list: (context: WorkGraphContext, input: AttentionListInput) => Promise<AttentionPage> }>
  streams: Readonly<{
    read: (context: WorkGraphContext, input: Readonly<{ streamId: StreamID }>) => Promise<StreamDto | undefined>
  }>
  sources: Readonly<{
    list: (
      context: WorkGraphContext,
      input: Readonly<{ after?: WorkSourcePageCursor; limit: number }>,
    ) => Promise<Readonly<{ sources: WorkSourceDto[]; hasMore: boolean; nextCursor?: WorkSourcePageCursor }>>
    read: (context: WorkGraphContext, input: Readonly<{ workSourceId: WorkSourceID }>) => Promise<WorkSourceDto | undefined>
    readRevision: (context: WorkGraphContext, input: Readonly<{ workSourceId: WorkSourceID; revisionId: WorkSourceRevisionID }>) => Promise<WorkSourceRevisionDto | undefined>
  }>
  changes: Readonly<{
    list: (context: WorkGraphContext, input: Readonly<{ after?: ChangeCursor; limit?: number }>) => Promise<readonly ChangeEnvelope[]>
    listStream: (context: WorkGraphContext, input: Readonly<{ streamId: StreamID; after?: ChangeCursor }>) => Promise<readonly ChangeEnvelope[]>
  }>
  proposals: Readonly<{
    read: (context: WorkGraphContext, input: Readonly<{ proposalId: string }>) => Promise<AdmissionProposalDto | undefined>
    replacementReview: (context: WorkGraphContext, input: ReplacementReviewInput) => Promise<ReplacementReview | undefined>
  }>
  workItems: Readonly<{
    read: (context: WorkGraphContext, input: Readonly<{ workItemId: string }>) => Promise<Readonly<{ id: string; completionSatisfied: boolean }> | undefined>
    readDetail: (context: WorkGraphContext, input: Readonly<{ workItemId: string }>) => Promise<WorkItemDto | undefined>
    listRuns: (context: WorkGraphContext, input: WorkItemRunListInput) => Promise<WorkItemRunPage>
    listActivity: (context: WorkGraphContext, input: TaskActivityListInput) => Promise<TaskActivityPage>
  }>
  runs: Readonly<{
    read: (context: WorkGraphContext, input: Readonly<{ runId: string }>) => Promise<RunDetailDto | undefined>
  }>
  decisions: Readonly<{
    read: (context: WorkGraphContext, input: Readonly<{ decisionId: string }>) => Promise<DecisionDto | undefined>
  }>
  evidence: Readonly<{
    read: (context: WorkGraphContext, input: EvidenceReadInput) => Promise<EvidenceDto | undefined>
    list: (context: WorkGraphContext, input: EvidenceListInput) => Promise<EvidencePage>
  }>
}>

type SqliteStoreResult = Readonly<{
  store: AtomicWorkGraphStore<SqliteCommands, SqliteQueries>
  /** Re-drives launch reconciliation (admit + launch ready Work Items) — safe to call from a periodic reconciler. */
  drainReadyStreams: () => Promise<void>
  scheduleResumeDrain: (delayMs: number) => void
  faults: Readonly<{ failNextAppend: () => void }>
}>

/**
 * Creates one adapter over a caller-owned database. The caller decides whether
 * that database is request-, process-, or test-scoped and remains responsible
 * for closing it.
 */
export function createSqliteWorkGraphStore(input: SqliteWorkGraphStoreInput): SqliteStoreResult {
  const database = initializeWorkGraphSqliteSchema(input.database).raw()
  if (!database) throw new Error("The WorkGraph SQLite adapter requires a real better-sqlite3 database")

  const clock = input.clock ?? { now: () => Date.now() }
  let nextId = 0
  const ids = input.ids ?? { next: (kind: string) => `${kind}_${Date.now()}_${++nextId}` }
  let failNextAppend = false
  let replacementRetryTimer: ReturnType<typeof setTimeout> | undefined
  let placementCompensationRetryTimer: ReturnType<typeof setTimeout> | undefined
  let resumeRetryTimer: ReturnType<typeof setTimeout> | undefined
  let resumeRetryAt: number | undefined
  let readyStreamsDrain: Promise<void> | undefined
  let readyStreamsDrainRequested = false
  const scheduleReplacementDrain = () => {
    if (!input.execution || replacementRetryTimer || !database.open) return
    replacementRetryTimer = setTimeout(() => void drainReplacementEffects(), Math.max(1, input.replacementRetryDelayMs ?? 1_000))
    replacementRetryTimer.unref()
  }
  const drainReplacementEffects = async () => {
    replacementRetryTimer = undefined
    if (!input.execution || !database.open) return
    await drainSqliteReplacementEffects(database, input.execution, clock.now)
    const pending = database
      .prepare(
        `
      SELECT 1 FROM wg_v2_runtime_effects WHERE effect_kind = 'reset_stream' AND state = 'pending' LIMIT 1
    `,
      )
      .get()
    if (pending) scheduleReplacementDrain()
  }
  const schedulePlacementCompensationDrain = () => {
    if (!input.execution || placementCompensationRetryTimer || !database.open) return
    placementCompensationRetryTimer = setTimeout(() => void drainPlacementCompensationEffects(), Math.max(1, input.replacementRetryDelayMs ?? 1_000))
    placementCompensationRetryTimer.unref()
  }
  const drainPlacementCompensationEffects = async () => {
    placementCompensationRetryTimer = undefined
    if (!input.execution || !database.open) return
    await drainSqlitePlacementCompensationEffects(database, input.execution, clock.now)
    const pending = database
      .prepare(
        `
      SELECT 1 FROM wg_v2_runtime_effects
      WHERE effect_kind = 'compensate_run_placement' AND state = 'pending' LIMIT 1
    `,
      )
      .get()
    if (pending) schedulePlacementCompensationDrain()
  }
  const drainReadyStreams = () => {
    if (!input.execution || !input.executionCapabilities || !database.open) return Promise.resolve()
    readyStreamsDrainRequested = true
    if (readyStreamsDrain) return readyStreamsDrain
    readyStreamsDrain = (async () => {
      while (readyStreamsDrainRequested) {
        readyStreamsDrainRequested = false
        await drainSqliteReadyStreams(database, input.execution!, input.executionCapabilities!, ids, clock.now, schedulePlacementCompensationDrain, scheduleResumeDrain)
      }
    })().finally(() => {
      readyStreamsDrain = undefined
    })
    return readyStreamsDrain
  }
  const scheduleResumeDrain = (delayMs: number) => {
    if (!input.execution || !database.open) return
    const delay = Math.max(1, delayMs)
    const retryAt = Date.now() + delay
    if (resumeRetryTimer && resumeRetryAt !== undefined && resumeRetryAt <= retryAt) return
    if (resumeRetryTimer) clearTimeout(resumeRetryTimer)
    resumeRetryAt = retryAt
    resumeRetryTimer = setTimeout(() => {
      resumeRetryTimer = undefined
      resumeRetryAt = undefined
      void drainReadyStreams()
    }, delay)
    resumeRetryTimer.unref()
  }

  const execute: WorkGraphCommandHandler = async (context, request) => {
    if (context.access.mode !== "owner") return failure(request.operationId, "forbidden", "Owner access is required")

    const requestHash = hash(stableJson(request.command))
    const previous = database
      .prepare("SELECT request_hash, result_json FROM wg_v2_operation_results WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
      .get(context.organizationId, context.ownerUserId, request.operationId) as OperationRow | undefined
    if (previous?.request_hash === requestHash) return JSON.parse(previous.result_json) as CommandResult
    if (previous) return failure(request.operationId, "idempotency_conflict", "Operation ID already used")
    const capabilityCheck = await validateCommandCapabilities(input.executionCapabilities, context, request, clock.now)
    if (!capabilityCheck.ok) return failure(request.operationId, capabilityCheck.code, capabilityCheck.message, capabilityCheck.retryable)
    try {
      assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
    } catch (error) {
      if (error instanceof SqliteWorkGraphOwnerDeletionInProgressError) {
        return failure(request.operationId, "blocked", error.message)
      }
      throw error
    }

    try {
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const occurredAt = clock.now()
        ensureOwnerRoot(database, context, occurredAt)
        database
          .prepare(
            `
          INSERT INTO wg_v2_operation_results
            (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
          VALUES (?, ?, ?, ?, ?, 0, '{}', ?)
        `,
          )
          .run(context.organizationId, context.ownerUserId, request.operationId, request.command.type, requestHash, occurredAt)

        const pending = applyCommand(database, context, request, occurredAt, ids, capabilityCheck.capabilities)
        if (!pending.ok) {
          saveResult(database, context, request.operationId, pending.result)
          return pending.result
        }

        if (failNextAppend) {
          failNextAppend = false
          throw new AppendFailure()
        }

        const cursorPosition = allocateSqliteChangeCursor(database, context, occurredAt)
        const cursor = createChangeCursor({
          organizationId: context.organizationId,
          ownerUserId: context.ownerUserId,
          position: cursorPosition,
        })
        const sequence = allocateEventSequence(database, context, pending.streamId ?? ownerEventScopeId, occurredAt)
        const eventId = ids.next("event")
        const payload = { ...pending.value, ...(pending.streamId ? { streamId: pending.streamId } : {}) }
        database
          .prepare(
            `
          INSERT INTO wg_v2_events
            (organization_id, owner_user_id, id, stream_id, sequence, schema_version, operation_id, event_type, actor_type, actor_id, request_id, payload_json, occurred_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            context.organizationId,
            context.ownerUserId,
            eventId,
            pending.streamId ?? null,
            sequence,
            request.operationId,
            pending.type,
            context.actor.type,
            context.actor.id,
            context.requestId,
            JSON.stringify(payload),
            occurredAt,
          )
        database
          .prepare(
            `
          INSERT INTO wg_v2_changes
            (organization_id, owner_user_id, cursor, id, stream_id, operation_id, resource_type, resource_id, change_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            context.organizationId,
            context.ownerUserId,
            cursorPosition,
            ids.next("change"),
            pending.streamId ?? null,
            request.operationId,
            pending.resourceType,
            pending.resourceId,
            pending.type,
            JSON.stringify(payload),
            occurredAt,
          )
        const result = success(request.operationId, cursor, pending.value)
        saveResult(database, context, request.operationId, result)
        return result
      })()
    } catch (error) {
      if (error instanceof AppendFailure) return failure(request.operationId, "internal_error", "Event/change append failed")
      throw error
    }
  }

  const executeWithRuntime: WorkGraphCommandHandler = async (context, request) => {
    if (!input.execution) return unavailable(context, request)
    const replay = !!database
      .prepare("SELECT 1 FROM wg_v2_operation_results WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
      .get(context.organizationId, context.ownerUserId, request.operationId)
    if (replay) return execute(context, request)
    try {
      assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
    } catch (error) {
      if (error instanceof SqliteWorkGraphOwnerDeletionInProgressError) {
        return failure(request.operationId, "blocked", error.message)
      }
      throw error
    }
    const cancelledSession =
      request.command.type === "cancel_run" || request.command.type === "restart_run"
        ? (database
            .prepare("SELECT session_id, lifecycle, row_version FROM wg_v2_runs WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
            .get(context.organizationId, context.ownerUserId, request.command.runId) as { session_id: string | null; lifecycle: string; row_version: number } | undefined)
        : undefined
    if (request.command.type === "cancel_run" || request.command.type === "restart_run") {
      if (!cancelledSession) return failure(request.operationId, "not_found", "Run not found")
      if (cancelledSession.row_version !== request.command.expectedVersion) return failure(request.operationId, "version_conflict", "Run version changed")
      if (request.command.type === "restart_run" && context.actor.type !== "user") return failure(request.operationId, "forbidden", "Only the owner can restart a parked Run")
      if (request.command.type === "restart_run" && cancelledSession.lifecycle !== "parked")
        return failure(request.operationId, "invalid_transition", "Only a parked Run can be restarted")
      if (request.command.type === "cancel_run" && ["result", "failed", "cancelled"].includes(cancelledSession.lifecycle))
        return failure(request.operationId, "invalid_transition", "Run is already terminal")
    }
    if ((request.command.type === "cancel_run" || request.command.type === "restart_run") && cancelledSession?.session_id) {
      reserveRuntimeEffect(
        database,
        context,
        {
          operationId: request.operationId,
          kind: "cancel_run",
          resourceType: "run",
          resourceId: request.command.runId,
          payload: { sessionId: cancelledSession.session_id, reason: request.command.reason },
        },
        clock.now(),
      )
      try {
        await input.execution.cancel(context, {
          runId: request.command.runId,
          sessionId: cancelledSession.session_id as never,
          reason: request.command.reason,
        })
        completeRuntimeEffect(database, context, request.operationId, clock.now())
      } catch (error) {
        failRuntimeEffect(database, context, request.operationId, error, clock.now())
        return failure(request.operationId, "execution_unavailable", error instanceof Error ? error.message : String(error), true)
      }
    }
    const result = await execute(context, request)
    if (!result.ok) return result
    // Cancelling lands the Work Item in `failed` (Needs-you). The drain re-derives
    // the stream hold so no new Run launches until the owner retries.
    await drainReadyStreams()
    return result
  }

  const executeWithAutonomousContinuation: WorkGraphCommandHandler = async (context, request) => {
    const result = await execute(context, request)
    if (result.ok) await drainReadyStreams()
    return result
  }

  const executeAdmissionWithRuntime: WorkGraphCommandHandler = async (context, request) => {
    const result = await execute(context, request)
    if (!result.ok) return result
    if (request.command.type === "confirm_admission" && request.command.selection.mode === "replace") {
      queueMicrotask(() => void drainReplacementEffects())
    }
    await drainReadyStreams()
    return result
  }

  const unavailable: WorkGraphCommandHandler = async (context, request) => {
    if (context.access.mode !== "owner") return failure(request.operationId, "forbidden", "Owner access is required")
    return failure(request.operationId, "execution_unavailable", "WorkGraph execution runtime is not configured")
  }

  const executeLifecycleWithRuntime: WorkGraphCommandHandler = async (context, request) => {
    if (!input.execution || (request.command.type !== "delete_stream" && request.command.type !== "close_stream")) return execute(context, request)
    const command = request.command
    const replay = !!database
      .prepare("SELECT 1 FROM wg_v2_operation_results WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
      .get(context.organizationId, context.ownerUserId, request.operationId)
    if (replay) return execute(context, request)
    try {
      assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
    } catch (error) {
      if (error instanceof SqliteWorkGraphOwnerDeletionInProgressError) {
        return failure(request.operationId, "blocked", error.message)
      }
      throw error
    }
    const reservation = reserveStreamCleanup(database, context, { operationId: request.operationId, command }, clock.now())
    if (!reservation.ok) return reservation.result
    const stream = reservation.stream
    const envelope = stream?.envelope_identity_json ? (JSON.parse(stream.envelope_identity_json) as { id?: string }) : undefined
    const running = database
      .prepare(
        `
      SELECT id, session_id FROM wg_v2_runs WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
        AND lifecycle IN ('admitted', 'placing', 'running', 'parked')
    `,
      )
      .all(context.organizationId, context.ownerUserId, command.streamId) as Array<{
      id: RunID
      session_id: ExecutionSessionID | null
    }>
    for (const run of running.filter((candidate) => candidate.session_id)) {
      await input.execution.cancel(context, {
        runId: run.id,
        sessionId: run.session_id!,
        reason: command.reason,
      })
    }
    if (command.type === "delete_stream" && envelope?.id) {
      await input.execution.cleanup(context, {
        streamId: command.streamId,
        envelopeId: envelope.id as StreamEnvelopeID,
        reason: "delete",
      })
    }
    const result = await execute(context, request)
    if (!result.ok) releaseStreamCleanup(database, context, request.operationId)
    if (result.ok && command.type === "close_stream") completeStreamCleanup(database, context, request.operationId, clock.now())
    return result
  }

  const commands = {
    update_workgraph_defaults: executeWithAutonomousContinuation,
    create_work_source: executeWithAutonomousContinuation,
    revise_work_source: executeWithAutonomousContinuation,
    create_stream: executeWithAutonomousContinuation,
    update_stream: executeWithAutonomousContinuation,
    set_stream_charter: executeWithAutonomousContinuation,
    call_master: executeWithAutonomousContinuation,
    record_landing_conflict: executeWithAutonomousContinuation,
    update_stream_notes: executeWithAutonomousContinuation,
    request_public_pr_confirmation: executeWithAutonomousContinuation,
    confirm_public_pr: executeWithAutonomousContinuation,
    record_master_audit: execute,
    set_stream_lifecycle: executeWithAutonomousContinuation,
    create_outcome: executeWithAutonomousContinuation,
    update_outcome: executeWithAutonomousContinuation,
    create_work_item: executeWithAutonomousContinuation,
    update_work_item: executeWithAutonomousContinuation,
    approve_work_item: executeWithAutonomousContinuation,
    reject_work_item: executeWithAutonomousContinuation,
    approve_work_items: executeWithAutonomousContinuation,
    arm_work_item: executeWithAutonomousContinuation,
    arm_work_items: executeWithAutonomousContinuation,
    cancel_work_item: executeWithAutonomousContinuation,
    propose_admission: executeWithAutonomousContinuation,
    retry_admission_planning: executeWithAutonomousContinuation,
    dismiss_admission: executeWithAutonomousContinuation,
    reopen_admission: executeWithAutonomousContinuation,
    confirm_admission: executeAdmissionWithRuntime,
    set_stream_visibility: executeWithAutonomousContinuation,
    propose_decision: executeWithAutonomousContinuation,
    answer_decision: executeWithAutonomousContinuation,
    dismiss_decision: executeWithAutonomousContinuation,
    record_run_checkpoint: execute,
    complete_run: executeWithAutonomousContinuation,
    record_evidence: executeWithAutonomousContinuation,
    close_outcome: executeWithAutonomousContinuation,
    reopen_outcome: executeWithAutonomousContinuation,
    close_stream: executeLifecycleWithRuntime,
    delete_stream: executeLifecycleWithRuntime,
    cancel_run: executeWithRuntime,
    restart_run: executeWithRuntime,
    retry_work_item: executeWithAutonomousContinuation,
  } satisfies SqliteCommands

  if (input.execution)
    queueMicrotask(() => {
      void drainReplacementEffects()
      void drainPlacementCompensationEffects()
      void drainReadyStreams()
    })

  return {
    store: defineAtomicWorkGraphStore({ commands, queries: createQueries(database, clock) }),
    // Exposed so a periodic reconciler can re-drive launch reconciliation: the
    // per-command drain is one-shot, and a pass that skips a Stream (transient
    // capability-read failure, a worktree busy with a master turn, a crash
    // between settle and drain) otherwise leaves launchable pending Work Items
    // stranded until the next unrelated command happens to run.
    drainReadyStreams,
    scheduleResumeDrain,
    faults: {
      failNextAppend: () => {
        failNextAppend = true
      },
    },
  }
}

export function createSqliteWorkGraphService(input: SqliteWorkGraphStoreInput): Readonly<{
  service: WorkGraphService<SqliteCommands, SqliteQueries>
  runRuntime: RunRuntimePort
  runResults: RunResultStore
  /** Re-drives launch reconciliation (admit + launch ready Work Items); see the store's `drainReadyStreams`. */
  drainReadyStreams: () => Promise<void>
  faults: Readonly<{ failNextAppend: () => void }>
}> {
  const adapter = createSqliteWorkGraphStore(input)
  const runRuntime = createSqliteRunRuntime(input.database, input.clock, adapter.scheduleResumeDrain)
  return {
    service: createWorkGraphService(adapter.store),
    runRuntime,
    runResults: runRuntime,
    drainReadyStreams: adapter.drainReadyStreams,
    faults: adapter.faults,
  }
}

export function createSqliteRunRuntime(
  database: Database,
  clock: Readonly<{ now: () => number }> = { now: () => Date.now() },
  scheduleResumeDrain?: (delayMs: number) => void,
): RunRuntimePort {
  return {
    listReconcilable: async (context) => listSqliteReconcilableRuns(database, context),
    renewLease: async (context, input) => renewSqliteRunLease(database, context, input),
    park: async (context, input) => parkSqliteRunningRun(database, context, input, clock.now(), scheduleResumeDrain),
    requestCompletionRetry: async (context, input) => requestSqliteRunCompletionRetry(database, context, input),
    recordResult: async (context, input) => {
      if (input.state === "result") {
        if (!input.summary.trim()) throw new Error("Run result summary must be non-empty")
        if (!Array.isArray(input.artifacts) || input.artifacts.some((artifact) => typeof artifact !== "string" || !artifact.trim())) {
          throw new Error("Run result artifacts must be an explicit array of non-empty references")
        }
      }
      const occurredAt = clock.now()
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const run = database
          .prepare(
            `
          SELECT stream_id, work_item_id, lifecycle, terminal_result_json, generation FROM wg_v2_runs
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND work_item_id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.runId, input.workItemId) as
          | {
              stream_id: StreamID
              work_item_id: WorkItemID
              lifecycle: string
              terminal_result_json: string | null
              generation: number
            }
          | undefined
        if (!run || run.generation !== input.leaseEpoch) return false
        const terminalResult = input.state === "result" ? JSON.stringify({ summary: input.summary, artifactRefs: input.artifacts, finishedAt: occurredAt }) : null
        if (["result", "failed", "cancelled"].includes(run.lifecycle)) {
          if (run.lifecycle === "result" && input.state === "result" && run.terminal_result_json) {
            const previous = JSON.parse(run.terminal_result_json) as { summary: string; artifactRefs: string[] }
            if (previous.summary === input.summary && stableJson(previous.artifactRefs) === stableJson(input.artifacts)) return true
          }
          if (run.lifecycle === input.state && input.state !== "result") return true
          return false
        }
        const lease = database
          .prepare(
            `
          SELECT 1 FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
            AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.workItemId, input.runId, input.leaseEpoch, occurredAt)
        if (!lease) return false
        const changed = database
          .prepare(
            `
          UPDATE wg_v2_runs SET lifecycle = ?, terminal_result_json = ?, parked_reason = ?,
            resume_available_at = NULL, finished_at = ?,
            updated_at = ?, row_version = row_version + 1
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND generation = ? AND lifecycle IN ('placing', 'running', 'parked')
        `,
          )
          .run(
            input.state,
            terminalResult,
            input.state === "result" ? null : (input.reason ?? null),
            occurredAt,
            occurredAt,
            context.organizationId,
            context.ownerUserId,
            input.runId,
            input.leaseEpoch,
          )
        if (changed.changes !== 1) return false
        database
          .prepare(
            `
          UPDATE wg_v2_work_items SET lifecycle = ?, updated_at = ?, row_version = row_version + 1
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle NOT IN ('completed', 'abandoned')
        `,
          )
          .run(input.state === "result" ? "result_ready" : "failed", occurredAt, context.organizationId, context.ownerUserId, input.workItemId)
        releaseSqliteRunLeases(database, context, {
          runId: input.runId,
          streamId: run.stream_id,
          workItemId: input.workItemId,
        })
        appendRuntimeChange(
          database,
          context,
          {
            type: "run_state_changed",
            runId: input.runId,
            streamId: run.stream_id,
            state: input.state,
          },
          occurredAt,
        )
        enqueueSqliteMasterWake(database, context, run.stream_id, occurredAt, "task_settled")
        return true
      })()
    },
  }
}

export function requestSqliteRunCompletionRetry(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{ runId: RunID; leaseEpoch: number; terminalSeq: number; occurredAt: number }>,
) {
  return database.transaction(() => {
    assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
    const row = database
      .prepare(
        `
      SELECT runs.completion_retry_json, runs.generation, leases.epoch, CAST(leases.expires_at AS INTEGER) AS expires_at
      FROM wg_v2_runs runs
      JOIN wg_v2_leases leases ON leases.organization_id = runs.organization_id
        AND leases.owner_user_id = runs.owner_user_id
        AND leases.resource_type = 'work_item'
        AND leases.resource_id = runs.work_item_id
      WHERE runs.organization_id = ? AND runs.owner_user_id = ? AND runs.id = ?
        AND runs.lifecycle = 'running' AND runs.session_id IS NOT NULL
        AND leases.holder_id = runs.id
    `,
      )
      .get(context.organizationId, context.ownerUserId, input.runId) as { completion_retry_json: string | null; generation: number; epoch: number; expires_at: number } | undefined
    if (!row || row.generation !== input.leaseEpoch || row.epoch !== row.generation || row.expires_at <= input.occurredAt) return { accepted: false as const }
    if (row.completion_retry_json) {
      const retry = JSON.parse(row.completion_retry_json) as { terminalSeq: number; requestedAt: number }
      return { accepted: true as const, ...retry }
    }
    const retry = { terminalSeq: input.terminalSeq, requestedAt: input.occurredAt }
    const updated = database
      .prepare(
        `UPDATE wg_v2_runs SET completion_retry_json = ?, updated_at = ?, row_version = row_version + 1
       WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND generation = ?
         AND lifecycle = 'running' AND completion_retry_json IS NULL`,
      )
      .run(JSON.stringify(retry), input.occurredAt, context.organizationId, context.ownerUserId, input.runId, input.leaseEpoch)
    return updated.changes === 1 ? { accepted: true as const, ...retry } : { accepted: false as const }
  })()
}

function releaseSqliteRunLeases(
  database: Database,
  context: Pick<WorkGraphContext, "organizationId" | "ownerUserId">,
  input: Readonly<{ runId: RunID; streamId: StreamID; workItemId: WorkItemID }>,
) {
  database
    .prepare(
      `
    DELETE FROM wg_v2_leases
    WHERE organization_id = ? AND owner_user_id = ? AND holder_id = ?
      AND (
        (resource_type = 'work_item' AND resource_id = ?)
        OR (resource_type = 'stream' AND resource_id = ?)
      )
  `,
    )
    .run(context.organizationId, context.ownerUserId, input.runId, input.workItemId, input.streamId)
}

export function listSqliteReconcilableRuns(database: Database, context: WorkGraphContext) {
  return database
    .prepare(
      `
    SELECT runs.id AS runId, runs.stream_id AS streamId, runs.work_item_id AS workItemId,
      runs.session_id AS sessionId, runs.envelope_id AS envelopeId,
      runs.child_workspace_id AS childIsolationId, runs.resolved_execution_profile_json AS profileJson,
      runs.generation AS leaseEpoch, CAST(leases.expires_at AS INTEGER) AS leaseExpiresAt
    FROM wg_v2_runs runs
    JOIN wg_v2_leases leases ON leases.organization_id = runs.organization_id AND leases.owner_user_id = runs.owner_user_id AND leases.resource_type = 'work_item'
      AND leases.resource_id = runs.work_item_id AND leases.holder_id = runs.id AND leases.epoch = runs.generation
    WHERE runs.organization_id = ? AND runs.owner_user_id = ? AND runs.lifecycle = 'running' AND runs.session_id IS NOT NULL
    ORDER BY runs.created_at, runs.id
  `,
    )
    .all(context.organizationId, context.ownerUserId) as Array<{
    runId: RunID
    streamId: StreamID
    workItemId: WorkItemID
    sessionId: ExecutionSessionID
    envelopeId: StreamEnvelopeID
    childIsolationId: string | null
    profileJson: string
    leaseEpoch: number
    leaseExpiresAt: number
  }>
}

/** Renews an owned lease or adopts the same durable Run after expiry. */
export function renewSqliteRunLease(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{ runId: RunID; expectedLeaseEpoch: number; occurredAt: number; durationMs: number }>,
) {
  return database.transaction(() => {
    assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
    const row = database
      .prepare(
        `
      SELECT runs.stream_id, runs.work_item_id, runs.generation, leases.holder_id, leases.epoch,
        CAST(leases.expires_at AS INTEGER) AS expires_at
      FROM wg_v2_runs runs
      JOIN wg_v2_leases leases ON leases.organization_id = runs.organization_id AND leases.owner_user_id = runs.owner_user_id AND leases.resource_type = 'work_item'
        AND leases.resource_id = runs.work_item_id
      WHERE runs.organization_id = ? AND runs.owner_user_id = ? AND runs.id = ? AND runs.lifecycle IN ('admitted', 'placing', 'running', 'parked')
    `,
      )
      .get(context.organizationId, context.ownerUserId, input.runId) as
      | {
          stream_id: StreamID
          work_item_id: WorkItemID
          generation: number
          holder_id: RunID
          epoch: number
          expires_at: number
        }
      | undefined
    if (!row || row.holder_id !== input.runId || row.epoch !== row.generation || row.epoch !== input.expectedLeaseEpoch) return undefined
    const epoch = row.expires_at <= input.occurredAt ? row.epoch + 1 : row.epoch
    const expiresAt = input.occurredAt + input.durationMs
    const renewed = database
      .prepare(
        `
      UPDATE wg_v2_leases SET epoch = ?, expires_at = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ? AND holder_id = ? AND epoch = ?
    `,
      )
      .run(epoch, expiresAt, input.occurredAt, context.organizationId, context.ownerUserId, row.work_item_id, input.runId, row.epoch)
    if (renewed.changes !== 1) return undefined
    database
      .prepare(
        `
      UPDATE wg_v2_leases SET epoch = ?, expires_at = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'stream' AND resource_id = ?
        AND holder_id = ? AND epoch = ?
    `,
      )
      .run(epoch, expiresAt, input.occurredAt, context.organizationId, context.ownerUserId, row.stream_id, input.runId, row.epoch)
    if (epoch !== row.epoch) {
      database
        .prepare(
          `
        UPDATE wg_v2_runs SET generation = ?, updated_at = ?, row_version = row_version + 1
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND generation = ?
      `,
        )
        .run(epoch, input.occurredAt, context.organizationId, context.ownerUserId, input.runId, row.epoch)
      appendRuntimeChange(database, context, { type: "run_lease_recovered", runId: input.runId, streamId: row.stream_id, state: "running" }, input.occurredAt)
    }
    return { leaseEpoch: epoch, expiresAt, recovered: epoch !== row.epoch }
  })()
}

function parkSqliteRunningRun(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{
    runId: RunID
    workItemId: WorkItemID
    sessionId: ExecutionSessionID
    leaseEpoch: number
    reason: string
  }>,
  occurredAt: number,
  scheduleResumeDrain?: (delayMs: number) => void,
) {
  return database.transaction(() => {
    assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
    const run = database
      .prepare(
        `
      SELECT stream_id, lifecycle, session_id, generation, resume_attempts
      FROM wg_v2_runs
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND work_item_id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, input.runId, input.workItemId) as
      | {
          stream_id: StreamID
          lifecycle: string
          session_id: string | null
          generation: number
          resume_attempts: number
        }
      | undefined
    if (!run || run.session_id !== input.sessionId || run.generation !== input.leaseEpoch || !["running", "parked"].includes(run.lifecycle)) {
      return undefined
    }
    if (run.lifecycle === "parked") return { state: "parked" as const }
    const lease = database
      .prepare(
        `
      SELECT 1 FROM wg_v2_leases
      WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item'
        AND resource_id = ? AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, input.workItemId, input.runId, input.leaseEpoch, occurredAt)
    if (!lease) return undefined
    const resumeAttempts = run.resume_attempts + 1
    if (isRunResumeCapExceeded(resumeAttempts)) {
      const failed = database
        .prepare(
          `
        UPDATE wg_v2_runs
        SET lifecycle = 'failed', parked_reason = ?, resume_attempts = ?, resume_available_at = NULL,
          finished_at = ?, updated_at = ?, row_version = row_version + 1
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND work_item_id = ?
          AND generation = ? AND lifecycle = 'running'
      `,
        )
        .run(input.reason, resumeAttempts, occurredAt, occurredAt, context.organizationId, context.ownerUserId, input.runId, input.workItemId, input.leaseEpoch)
      if (failed.changes !== 1) return undefined
      database
        .prepare(
          `
        UPDATE wg_v2_work_items SET lifecycle = 'failed', updated_at = ?, row_version = row_version + 1
        WHERE organization_id = ? AND owner_user_id = ? AND id = ?
          AND lifecycle NOT IN ('completed', 'abandoned')
      `,
        )
        .run(occurredAt, context.organizationId, context.ownerUserId, input.workItemId)
      releaseSqliteRunLeases(database, context, {
        runId: input.runId,
        streamId: run.stream_id,
        workItemId: input.workItemId,
      })
      appendRuntimeChange(database, context, { type: "run_state_changed", runId: input.runId, streamId: run.stream_id, state: "failed" }, occurredAt)
      enqueueSqliteMasterWake(database, context, run.stream_id, occurredAt, "task_settled")
      return { state: "failed" as const }
    }
    const retryAfterMs = Math.min(60_000, 1_000 * 2 ** (resumeAttempts - 1))
    const parked = database
      .prepare(
        `
      UPDATE wg_v2_runs
      SET lifecycle = 'parked', parked_reason = ?, resume_attempts = ?, resume_available_at = ?,
        updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND work_item_id = ?
        AND generation = ? AND lifecycle = 'running'
    `,
      )
      .run(input.reason, resumeAttempts, occurredAt + retryAfterMs, occurredAt, context.organizationId, context.ownerUserId, input.runId, input.workItemId, input.leaseEpoch)
    if (parked.changes !== 1) return undefined
    database
      .prepare(
        `
      UPDATE wg_v2_leases SET expires_at = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND holder_id = ? AND epoch = ?
        AND (
          (resource_type = 'work_item' AND resource_id = ?)
          OR (resource_type = 'stream' AND resource_id = ?)
        )
    `,
      )
      .run(occurredAt + PARKED_LEASE_TTL_MS, occurredAt, context.organizationId, context.ownerUserId, input.runId, input.leaseEpoch, input.workItemId, run.stream_id)
    appendRuntimeChange(database, context, { type: "run_state_changed", runId: input.runId, streamId: run.stream_id, state: "parked" }, occurredAt)
    scheduleResumeDrain?.(retryAfterMs)
    return { state: "parked" as const, retryAfterMs }
  })()
}

async function drainSqliteReadyStreams(
  database: Database,
  execution: WorkspaceExecutionPort,
  capabilityPort: ExecutionCapabilitiesPort,
  ids: Readonly<{ next: (kind: string) => string }>,
  now: () => number,
  schedulePlacementCompensationDrain?: () => void,
  scheduleResumeDrain?: (delayMs: number) => void,
) {
  const streams = database
    .prepare(
      `
    SELECT streams.organization_id, streams.owner_user_id, streams.id FROM wg_v2_streams streams
    WHERE streams.lifecycle = 'active' AND streams.visibility <> 'archived'
      AND (
        EXISTS (
          SELECT 1 FROM wg_v2_work_items items
          WHERE items.organization_id = streams.organization_id AND items.owner_user_id = streams.owner_user_id
            AND items.stream_id = streams.id AND items.lifecycle = 'pending'
        )
        OR EXISTS (
          SELECT 1 FROM wg_v2_runs att
          WHERE att.organization_id = streams.organization_id AND att.owner_user_id = streams.owner_user_id
            AND att.stream_id = streams.id AND att.lifecycle IN ('admitted', 'parked')
        )
      )
    ORDER BY streams.updated_at, streams.id LIMIT 100
  `,
    )
    .all() as Array<{ organization_id: string; owner_user_id: string; id: StreamID }>
  for (const stream of streams) {
    const context = {
      organizationId: stream.organization_id,
      ownerUserId: stream.owner_user_id,
      actor: { type: "system", id: "workgraph_launch_runtime" },
      requestId: `launch_${stream.id}`,
      access: { mode: "owner" },
    } as WorkGraphContext
    const occurredAt = now()
    if (foldAndGateSqliteStreamBudget(database, context, stream.id, occurredAt)) continue
    // A capability-read failure holds this Stream for the current pass only; the
    // next drain (or an explicit capability refresh) retries it. Pause/resume,
    // not a persisted stop, is the durable launch gate now.
    let capabilities: ExecutionCapabilities
    try {
      capabilities = await capabilityPort.read(context, {})
    } catch {
      continue
    }
    database
      .prepare(
        `
      UPDATE wg_v2_leases SET expires_at = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item'
        AND holder_id IN (
          SELECT id FROM wg_v2_runs
          WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
            AND lifecycle = 'parked' AND generation = wg_v2_leases.epoch
        )
    `,
      )
      .run(occurredAt + PARKED_LEASE_TTL_MS, occurredAt, context.organizationId, context.ownerUserId, context.organizationId, context.ownerUserId, stream.id)
    database
      .prepare(
        `
      UPDATE wg_v2_runs SET lifecycle = 'admitted', resume_available_at = NULL, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle = 'parked'
        AND COALESCE(CAST(resume_available_at AS INTEGER), 0) <= ?
        AND EXISTS (
          SELECT 1 FROM wg_v2_leases leases
          WHERE leases.organization_id = wg_v2_runs.organization_id
            AND leases.owner_user_id = wg_v2_runs.owner_user_id
            AND leases.resource_type = 'work_item'
            AND leases.resource_id = wg_v2_runs.work_item_id
            AND leases.holder_id = wg_v2_runs.id
            AND leases.epoch = wg_v2_runs.generation
            AND CAST(leases.expires_at AS INTEGER) > ?
        )
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, stream.id, occurredAt, occurredAt)
    database.transaction(() => continueSqliteStream(database, context, stream.id, occurredAt, ids, capabilities))()
    const admitted = database
      .prepare(
        `
      SELECT id FROM wg_v2_runs
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle = 'admitted'
      ORDER BY created_at, id
    `,
      )
      .all(context.organizationId, context.ownerUserId, stream.id) as Array<{ id: RunID }>
    await Promise.all(admitted.map((run) => launchRun(database, execution, context, run.id, now(), ids, schedulePlacementCompensationDrain, scheduleResumeDrain)))
  }
}

function foldAndGateSqliteStreamBudget(database: Database, context: WorkGraphContext, streamId: StreamID, occurredAt: number) {
  const stream = database
    .prepare(
      `
    SELECT execution_defaults_json, spend_json, master_status_json FROM wg_v2_streams
    WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId) as { execution_defaults_json: string; spend_json: string | null; master_status_json: string | null } | undefined
  if (!stream) return false
  const streamExecution = ExecutionProfileDefaultsSchema.parse(JSON.parse(stream.execution_defaults_json))
  const budget = streamExecution.budget
  const status = stream.master_status_json ? StreamMasterStatusSchema.parse(JSON.parse(stream.master_status_json)) : undefined
  if (!budget) {
    if (status?.state !== "attention" || status.escalation !== "budget_exhausted") return false
    database
      .prepare(
        `
      UPDATE wg_v2_streams
      SET master_status_json = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .run(
        JSON.stringify(
          status.budgetPriorStatus ?? {
            state: "hibernating",
            sessionId: masterSessionId(streamId),
            message: "Stream budget is available",
            receiptRefs: [],
            updatedAt: occurredAt,
          },
        ),
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        streamId,
      )
    return false
  }
  const previous = stream.spend_json
    ? (JSON.parse(stream.spend_json) as {
        totalTokens: number
        totalUsd?: number
        asOf: number
        asOfMessageId?: string
        dayStart?: number
        dayTokens?: number
        dayUsd?: number
        byProfile?: StreamProfileSpend[]
      })
    : { totalTokens: 0, asOf: 0 }
  const rows = database
    .prepare(
      `
    SELECT usage.id, usage.run_id, usage.provider_id, usage.model_id, usage.input_tokens, usage.output_tokens,
      usage.reasoning_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.created_at,
      runs.resolved_execution_profile_json
    FROM wg_v2_llm_usage_events usage
    LEFT JOIN wg_v2_runs runs
      ON runs.organization_id = usage.organization_id
      AND runs.owner_user_id = usage.owner_user_id
      AND runs.id = usage.run_id
    WHERE usage.organization_id = ? AND usage.owner_user_id = ? AND usage.stream_id = ?
      AND (usage.created_at > ? OR (usage.created_at = ? AND usage.id > ?))
    ORDER BY usage.created_at, usage.id LIMIT 5000
  `,
    )
    .all(context.organizationId, context.ownerUserId, streamId, previous.asOf, previous.asOf, previous.asOfMessageId ?? "") as SqliteUsageRow[]
  const dayStart = Date.UTC(new Date(occurredAt).getUTCFullYear(), new Date(occurredAt).getUTCMonth(), new Date(occurredAt).getUTCDate())
  const totals = sqliteUsageSpend(rows, previous)
  const daily = sqliteUsageSpend(
    rows.filter((row) => row.created_at >= dayStart),
    previous.dayStart === dayStart ? { totalTokens: previous.dayTokens ?? 0, totalUsd: previous.dayUsd, asOf: previous.asOf } : { totalTokens: 0, totalUsd: 0, asOf: 0 },
  )
  const spend = {
    ...totals,
    byProfile: sqliteUsageByProfile(rows, streamExecution.agents ?? [], previous.byProfile ?? []),
    ...(rows.at(-1) ? { asOf: rows.at(-1)!.created_at, asOfMessageId: rows.at(-1)!.id } : {}),
    dayStart,
    dayTokens: daily.totalTokens,
    ...(daily.totalUsd === undefined ? {} : { dayUsd: daily.totalUsd }),
  }
  const measured = budget.window === "stream" ? spend : { totalTokens: spend.dayTokens, totalUsd: spend.dayUsd }
  const exhausted = (budget.unit === "tokens" ? measured.totalTokens : (measured.totalUsd ?? 0)) >= budget.amount
  if (rows.length === 5_000) {
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET spend_json = ?, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .run(JSON.stringify(spend), occurredAt, context.organizationId, context.ownerUserId, streamId)
    return true
  }
  if (exhausted) {
    if (status?.state !== "attention" || status.escalation !== "budget_exhausted") {
      database
        .prepare(
          `
        UPDATE wg_v2_streams
        SET spend_json = ?, master_status_json = ?, updated_at = ?, row_version = row_version + 1
        WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .run(
          JSON.stringify(spend),
          JSON.stringify({
            state: "attention",
            escalation: "budget_exhausted",
            sessionId: masterSessionId(streamId),
            message: `Stream budget exhausted (${budget.amount} ${budget.unit}/${budget.window})`,
            receiptRefs: [],
            ...(status ? { budgetPriorStatus: status } : {}),
            updatedAt: occurredAt,
          }),
          occurredAt,
          context.organizationId,
          context.ownerUserId,
          streamId,
        )
      return true
    }
    if (rows.length > 0)
      database
        .prepare(
          `
        UPDATE wg_v2_streams SET spend_json = ?, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .run(JSON.stringify(spend), occurredAt, context.organizationId, context.ownerUserId, streamId)
    return true
  }
  if (status?.state === "attention" && status.escalation === "budget_exhausted") {
    database
      .prepare(
        `
      UPDATE wg_v2_streams
      SET spend_json = ?, master_status_json = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .run(
        JSON.stringify(spend),
        JSON.stringify(
          status.budgetPriorStatus ?? {
            state: "hibernating",
            sessionId: masterSessionId(streamId),
            message: "Stream budget is available",
            receiptRefs: [],
            updatedAt: occurredAt,
          },
        ),
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        streamId,
      )
    return false
  }
  if (rows.length > 0)
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET spend_json = ?, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .run(JSON.stringify(spend), occurredAt, context.organizationId, context.ownerUserId, streamId)
  return false
}

function sqliteUsageSpend(rows: readonly SqliteUsageRow[], initial: { totalTokens: number; totalUsd?: number; asOf: number } = { totalTokens: 0, asOf: 0 }) {
  return rows.reduce((spend, row) => {
    const cost = sqliteUsageCost(row)
    return {
      totalTokens: spend.totalTokens + usageTokens(row),
      ...(spend.totalUsd !== undefined || cost !== undefined ? { totalUsd: (spend.totalUsd ?? 0) + (cost ?? 0) } : {}),
      asOf: Math.max(spend.asOf, row.created_at),
    }
  }, initial)
}

function sqliteUsageByProfile(rows: readonly SqliteUsageRow[], agents: readonly AgentProfile[], initial: readonly StreamProfileSpend[]) {
  return Array.from(
    rows
      .reduce(
        (totals, row) => {
          const profile = sqliteUsageProfile(row, agents)
          const current = totals.get(profile) ?? { profile, totalTokens: 0 }
          const cost = sqliteUsageCost(row)
          totals.set(profile, {
            profile,
            totalTokens: current.totalTokens + usageTokens(row),
            ...(current.totalUsd !== undefined || cost !== undefined ? { totalUsd: (current.totalUsd ?? 0) + (cost ?? 0) } : {}),
          })
          return totals
        },
        new Map(initial.map((spend) => [spend.profile, spend])),
      )
      .values(),
  ).sort((left, right) => left.profile.localeCompare(right.profile))
}

function sqliteUsageProfile(row: SqliteUsageRow, agents: readonly AgentProfile[]) {
  if (!row.run_id || !row.resolved_execution_profile_json) return "Default"
  const resolved = ResolvedExecutionProfileSchema.parse(JSON.parse(row.resolved_execution_profile_json))
  return (
    agents.find(
      (profile) =>
        profile.generation.harness === resolved.harness &&
        profile.generation.agent === resolved.agent &&
        profile.generation.model.providerId === resolved.model.providerId &&
        profile.generation.model.modelId === resolved.model.modelId &&
        profile.generation.effort === resolved.effort &&
        JSON.stringify(profile.generation.tools) === JSON.stringify(resolved.tools) &&
        JSON.stringify(profile.generation.connectionIds) === JSON.stringify(resolved.connectionIds),
    )?.name ?? "Default"
  )
}

function sqliteUsageCost(row: SqliteUsageRow) {
  return modelUsageCostUsd({
    providerId: row.provider_id,
    modelId: row.model_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  })
}

function usageTokens(row: SqliteUsageRow) {
  return row.input_tokens + row.output_tokens + row.reasoning_tokens + row.cache_read_tokens + row.cache_write_tokens
}

function continueSqliteStream(
  database: Database,
  context: WorkGraphContext,
  streamId: StreamID,
  occurredAt: number,
  ids: Readonly<{ next: (kind: string) => string }>,
  capabilities: ExecutionCapabilities,
) {
  try {
    assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
  } catch (error) {
    if (error instanceof SqliteWorkGraphOwnerDeletionInProgressError) return []
    throw error
  }
  const cleanup = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_stream_cleanup_reservations
    WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
    LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId)
  if (cleanup) return []
  const stream = database
    .prepare(
      `
    SELECT lifecycle, visibility FROM wg_v2_streams
    WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId) as { lifecycle: string; visibility: string } | undefined
  // Stream pause/resume is the launch gate: only `active`, non-archived Streams
  // admit new Runs. `reopened` Streams hold until the owner resumes.
  if (!stream || stream.lifecycle !== "active" || stream.visibility === "archived") return []
  // Derived stream hold (never persisted, re-evaluated every pass): a Needs-you
  // condition — any parked Run or failed Work Item — holds all
  // new launches until the owner resolves or retries, exactly as autonomous mode
  // halted before. This replaces the mode-gated `execution_state = 'stopped'` writes.
  const held = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_runs WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle = 'parked'
    UNION ALL
    SELECT 1 FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle = 'failed'
    LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId, context.organizationId, context.ownerUserId, streamId)
  if (held) return []
  const ready = database
    .prepare(
      `
    ${SQLITE_READY_WORK_ITEMS_FRAGMENT}
    ORDER BY items.priority DESC, items.created_at, items.id
  `,
    )
    .all(context.organizationId, context.ownerUserId, streamId) as Array<{ id: WorkItemID }>
  const admissions = ready.flatMap((item) => {
    const admitted = admitRun(database, context, item.id, occurredAt, ids, capabilities)
    if (!admitted.ok) return []
    appendRuntimeChange(
      database,
      context,
      {
        type: "run_admitted",
        runId: admitted.runId as RunID,
        streamId,
        state: "admitted",
      },
      occurredAt,
    )
    return [admitted.runId as RunID]
  })
  return admissions
}

/**
 * The single launchability predicate shared by every drain consumer (fixing the
 * former drain-vs-execute divergence). A `pending` (approved) Work Item is ready
 * when: no blocker is outstanding — `completed` AND `abandoned` both satisfy, so
 * a rejected dependency never deadlocks its dependents — and no `proposed`/
 * `pending` Decision blocks it. Stream-level gates (pause, archive, hold) and the
 * per-item lease/capability checks live in `continueSqliteStream` / `admitRun`.
 */
const SQLITE_READY_WORK_ITEMS_FRAGMENT = `
    SELECT items.id FROM wg_v2_work_items items
    WHERE items.organization_id = ? AND items.owner_user_id = ? AND items.stream_id = ? AND items.lifecycle = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM wg_v2_work_item_dependencies dependencies
        JOIN wg_v2_work_items blockers ON blockers.organization_id = dependencies.organization_id AND blockers.owner_user_id = dependencies.owner_user_id
          AND blockers.id = dependencies.depends_on_work_item_id
        WHERE dependencies.organization_id = items.organization_id AND dependencies.owner_user_id = items.owner_user_id
          AND dependencies.work_item_id = items.id AND blockers.lifecycle NOT IN ('completed', 'abandoned')
      )
      AND NOT EXISTS (
        SELECT 1 FROM wg_v2_decision_work_items affected
        JOIN wg_v2_decisions decisions ON decisions.organization_id = affected.organization_id AND decisions.owner_user_id = affected.owner_user_id
          AND decisions.id = affected.decision_id
        WHERE affected.organization_id = items.organization_id AND affected.owner_user_id = items.owner_user_id
          AND affected.work_item_id = items.id AND decisions.lifecycle IN ('proposed', 'pending')
      )
`

async function validateCommandCapabilities(
  port: ExecutionCapabilitiesPort | undefined,
  context: WorkGraphContext,
  request: WorkGraphCommandRequest,
  now: () => number,
): Promise<Readonly<{ ok: true; capabilities?: ExecutionCapabilities }> | Readonly<{ ok: false; code: CommandErrorCode; message: string; retryable?: boolean }>> {
  const profiles = executionDefaults(request)
  // Admission (Run launch) now happens in the drain, which reads capabilities
  // itself; no command forces a capability read beyond validating its own profile.
  if (profiles.length === 0) return { ok: true }
  if (!port) return { ok: false, code: "execution_unavailable", message: "Execution capability catalog is not configured" }
  let capabilities: ExecutionCapabilities
  try {
    capabilities = await port.read(context, {})
  } catch (error) {
    return {
      ok: false,
      code: "execution_unavailable",
      message: error instanceof Error ? error.message : "Execution capability catalog is unavailable",
      retryable: true,
    }
  }
  const validatedAt = now()
  const diagnostics = profiles.flatMap((profile) => {
    const result = validateExecutionProfileDefaultsAgainstCapabilities({
      organizationId: context.organizationId,
      ownerUserId: context.ownerUserId,
      now: validatedAt,
      capabilities,
      profile,
    })
    return result.ok ? [] : result.diagnostics
  })
  if (diagnostics.length > 0) return { ok: false, code: "validation_error", message: capabilityMessage(diagnostics) }
  return { ok: true, capabilities }
}

function executionDefaults(request: WorkGraphCommandRequest): readonly ExecutionProfileDefaults[] {
  const command = request.command
  if (command.type === "update_workgraph_defaults") return [command.defaults.execution]
  if (command.type === "set_stream_charter") return command.compiled ? [command.compiled] : []
  if (
    ["create_stream", "update_stream", "create_outcome", "update_outcome", "create_work_item", "update_work_item"].includes(command.type) &&
    "execution" in command &&
    command.execution
  ) {
    return [command.execution]
  }
  return []
}

function capabilityMessage(diagnostics: readonly Readonly<{ path: string; reason: string }>[]) {
  return `Execution profile is not available: ${diagnostics.map((diagnostic) => `${diagnostic.path} (${diagnostic.reason})`).join(", ")}`
}

function applyCommand(
  database: Database,
  context: WorkGraphContext,
  request: WorkGraphCommandRequest,
  occurredAt: number,
  ids: Readonly<{ next: (kind: string) => string }>,
  capabilities: ExecutionCapabilities | undefined,
): PendingResult {
  const command = request.command
  if (
    context.actor.type === "agent" &&
    SUBTASK_SEAT_FORBIDDEN_COMMANDS.has(command.type) &&
    database
      .prepare(
        `
      SELECT 1
      FROM wg_v2_session_bindings bindings
      JOIN wg_v2_runs runs ON runs.organization_id = bindings.organization_id
        AND runs.owner_user_id = bindings.owner_user_id AND runs.id = bindings.current_run_id
      JOIN wg_v2_work_items items ON items.organization_id = runs.organization_id
        AND items.owner_user_id = runs.owner_user_id AND items.id = runs.work_item_id
      WHERE bindings.organization_id = ? AND bindings.owner_user_id = ?
        AND bindings.session_id = ? AND bindings.state = 'active' AND items.parent_task_id IS NOT NULL
      LIMIT 1
    `,
      )
      .get(context.organizationId, context.ownerUserId, context.actor.id)
  ) {
    return rejected(request.operationId, "forbidden_for_subtask", "Subtask execution seats cannot create or propose work")
  }
  if (command.type === "update_workgraph_defaults") {
    const root = database
      .prepare(
        `
      SELECT row_version FROM wg_v2_workgraphs WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, rootId) as { row_version: number }
    if (root.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "WorkGraph defaults version changed")
    database
      .prepare(
        `
      UPDATE wg_v2_workgraphs SET defaults_json = ?, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(JSON.stringify(command.defaults.execution), occurredAt, context.organizationId, context.ownerUserId, rootId, command.expectedVersion)
    return pending("workgraph_defaults_updated", "workgraph", rootId, { workGraphId: rootId })
  }
  if (command.type === "create_stream") {
    const parent = command.parentStreamId ? ownedStream(database, context, command.parentStreamId) : undefined
    if (command.parentStreamId && !parent) return rejected(request.operationId, "not_found", "Parent Stream not found")
    const parentExecution = parent ? ExecutionProfileDefaultsSchema.parse(JSON.parse(parent.execution_defaults_json)) : undefined
    if (parent && context.actor.type === "agent" && parentExecution?.mayPromote !== true)
      return rejected(request.operationId, "forbidden", "Parent Stream does not allow child promotion")
    const existingChildren = parent
      ? (
          database
            .prepare(
              `
            SELECT COUNT(*) AS value FROM wg_v2_streams
            WHERE organization_id = ? AND owner_user_id = ? AND parent_stream_id = ?
          `,
            )
            .get(context.organizationId, context.ownerUserId, parent.id) as { value: number }
        ).value
      : 0
    if (parent && existingChildren === 0 && (context.actor.type !== "user" || command.confirmAutonomy !== true)) {
      return rejected(request.operationId, "promotion_confirmation_required", "The first child Stream requires explicit owner confirmation")
    }
    if (command.execution?.autonomy === "autonomous" && (context.actor.type !== "user" || command.confirmAutonomy !== true))
      return rejected(request.operationId, "autonomy_confirmation_required", "Autonomous Streams require explicit owner confirmation")
    if (command.execution?.budget && context.actor.type !== "user") return rejected(request.operationId, "forbidden", "Only the owner can configure a Stream budget")
    if (command.charter && !charterMatchesHash(command.charter)) return rejected(request.operationId, "validation_error", "Stream charter text does not match its declared hash")
    if (command.source) {
      const source = exactSourceHead(database, context, command.source)
      if (!source.exists) return rejected(request.operationId, "not_found", "Work Source revision not found")
      if (!source.current) return rejected(request.operationId, "version_conflict", "Stream requires the current Work Source head")
    }
    const carved = parentExecution ? carveExecutionBudget(parentExecution, command.execution, command.budgetCarve) : undefined
    if (carved && !carved.ok) {
      return rejected(
        request.operationId,
        "validation_error",
        {
          parent_budget_required: "Parent Stream has no budget to carve",
          budget_shape_mismatch: "Child budget carve must use the parent budget unit and window",
          insufficient_parent_budget: "Child budget carve must leave a positive parent budget",
        }[carved.error],
      )
    }
    const profileCheck = resolveExecutionProfile({
      workgraph: JSON.parse(
        (
          database
            .prepare("SELECT defaults_json FROM wg_v2_workgraphs WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
            .get(context.organizationId, context.ownerUserId, rootId) as { defaults_json: string }
        ).defaults_json,
      ) as ExecutionProfileDefaults,
      stream: carved?.child ?? command.execution ?? {},
    })
    if (!profileCheck.ok && profileCheck.error.code === "unknown_agent_profile")
      return rejected(request.operationId, "unknown_agent_profile", `Unknown agent profile: ${profileCheck.error.profileName}`)
    const streamId = ids.next("stream")
    if (parent && carved && command.budgetCarve) {
      database
        .prepare(
          `
        UPDATE wg_v2_streams SET execution_defaults_json = ?, row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .run(JSON.stringify(carved.parent), occurredAt, context.organizationId, context.ownerUserId, parent.id)
    }
    database
      .prepare(
        `
      INSERT INTO wg_v2_streams
        (organization_id, owner_user_id, id, workgraph_id, parent_stream_id, title, purpose, charter_json, lifecycle, execution_defaults_json, activity_granularity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        streamId,
        rootId,
        command.parentStreamId ?? null,
        command.title,
        command.description ?? command.title,
        command.charter ? JSON.stringify(command.charter) : null,
        JSON.stringify(carved?.child ?? command.execution ?? {}),
        command.activityGranularity ?? "progress",
        occurredAt,
        occurredAt,
      )
    enqueueSqliteMasterSchedule(database, context, streamId, occurredAt)
    if (command.source) addSourceReference(database, context, ids, "stream", streamId, command.source, occurredAt)
    return pending("stream_created", "stream", streamId, { streamId }, streamId)
  }
  if (command.type === "update_stream") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    const executionError = streamExecutionChangeError(stream.execution_defaults_json, command.execution, context.actor.type, command.confirmAutonomy)
    if (executionError) return rejected(request.operationId, executionError.code, executionError.message)
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET
        title = COALESCE(?, title), purpose = COALESCE(?, purpose),
        execution_defaults_json = COALESCE(?, execution_defaults_json),
        activity_granularity = COALESCE(?, activity_granularity),
        row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        command.title ?? null,
        command.description ?? null,
        command.execution === undefined ? null : JSON.stringify(command.execution),
        command.activityGranularity ?? null,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.streamId,
        command.expectedVersion,
      )
    return pending("stream_updated", "stream", command.streamId, { streamId: command.streamId }, command.streamId)
  }
  if (command.type === "set_stream_charter") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    if (!charterMatchesHash(command.charter)) return rejected(request.operationId, "validation_error", "Stream charter text does not match its declared hash")
    // Budget is the load-bearing safety rail for autonomous Streams (plan
    // 2026-07-28-003): owner confirmation gates ENTERING autonomy, but only a
    // budget bounds what a COMPILED autonomous charter can spend once running.
    // Scoped to the compiled-charter path on purpose — `update_stream` may set
    // autonomy without a budget (see sqlite-store-commands "enforces autonomous
    // born-state"), so this deliberately does NOT live in the shared helper.
    if (command.compiled?.autonomy === "autonomous" && !command.compiled.budget)
      return rejected(request.operationId, "validation_error", "Autonomous compiled charters require a budget")
    const executionError = streamExecutionChangeError(stream.execution_defaults_json, command.compiled, context.actor.type, command.confirmAutonomy)
    if (executionError) return rejected(request.operationId, executionError.code, executionError.message)
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET charter_json = ?, execution_defaults_json = COALESCE(?, execution_defaults_json),
        row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        JSON.stringify(command.charter),
        command.compiled === undefined ? null : JSON.stringify(command.compiled),
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.streamId,
        command.expectedVersion,
      )
    return pending("stream_charter_updated", "stream", command.streamId, { streamId: command.streamId, charterHash: command.charter.hash }, command.streamId)
  }
  if (command.type === "call_master") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    if (stream.lifecycle === "closed") return rejected(request.operationId, "invalid_transition", "Closed Streams cannot receive master messages")
    const messageId = ids.next("master_message")
    database
      .prepare(
        `
      INSERT INTO wg_v2_master_mailbox
        (organization_id, owner_user_id, stream_id, id, message, provenance_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        stream.id,
        messageId,
        command.message,
        JSON.stringify({ actor: context.actor, operationId: request.operationId }),
        occurredAt,
        occurredAt,
      )
    // An owner message to a halted ('attention') master is the explicit
    // resume: it clears the escalation and the failure counter. Agent
    // messages park in the mailbox and never un-halt an escalated master.
    if (context.actor.type === "user") resumeSqliteMaster(database, context, stream.id, occurredAt)
    enqueueSqliteMasterWake(database, context, stream.id, occurredAt, "mailbox")
    return pending("master_called", "stream", stream.id, { streamId: stream.id, mailboxMessageId: messageId }, stream.id)
  }
  if (command.type === "record_landing_conflict") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (context.actor.type !== "agent" || context.actor.id !== masterSessionId(stream.id))
      return rejected(request.operationId, "forbidden", "Only the Stream master can record landing conflicts")
    const item = ownedWorkItem(database, context, command.workItemId)
    if (!item || item.stream_id !== stream.id) return rejected(request.operationId, "not_found", "Work Item not found")
    if (!["result_ready", "review_needed", "integration_needed"].includes(item.lifecycle))
      return rejected(request.operationId, "invalid_transition", "Only completed candidate work can require integration")
    const messageId = ids.next("master_message")
    database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'integration_needed', row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, item.id)
    database
      .prepare(
        `
      INSERT INTO wg_v2_master_mailbox
        (organization_id, owner_user_id, stream_id, id, message, provenance_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        stream.id,
        messageId,
        `Landing conflict for ${database
          .prepare("SELECT title FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
          .pluck()
          .get(context.organizationId, context.ownerUserId, item.id)} (${item.id}): ${command.reason}`,
        JSON.stringify({ actor: context.actor, operationId: request.operationId }),
        occurredAt,
        occurredAt,
      )
    enqueueSqliteMasterWake(database, context, stream.id, occurredAt, "mailbox")
    return pending(
      "work_item_state_changed",
      "work_item",
      item.id,
      { workItemId: item.id, state: "integration_needed", reason: command.reason, mailboxMessageId: messageId },
      stream.id,
    )
  }
  if (command.type === "update_stream_notes") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    if (context.actor.type !== "agent" || context.actor.id !== masterSessionId(stream.id))
      return rejected(request.operationId, "forbidden", "Only the Stream master can update Stream notes")
    const invalidReference = command.externalReferences.find((reference) => {
      const revision = database
        .prepare(
          `
        SELECT content_hash, origin_kind FROM wg_v2_work_source_revisions
        WHERE organization_id = ? AND owner_user_id = ? AND work_source_id = ? AND id = ?
      `,
        )
        .get(context.organizationId, context.ownerUserId, reference.source.workSourceId, reference.source.revisionId) as { content_hash: string; origin_kind: string } | undefined
      return !revision || revision.content_hash !== reference.source.contentHash || revision.origin_kind !== "external"
    })
    if (invalidReference) {
      return rejected(request.operationId, "validation_error", "Stream notes external references require exact externally-originated Work Source revisions")
    }
    const content = renderStreamNotes(command)
    const contentHash = hash(content)
    const existing = stream.notes_source_json ? (JSON.parse(stream.notes_source_json) as WorkSourceRevisionRef) : undefined
    const sourceId = existing?.workSourceId ?? (ids.next("source") as WorkSourceID)
    const revisionId = ids.next("revision") as WorkSourceRevisionID
    if (existing) {
      const source = database
        .prepare(
          `
        SELECT latest_revision_number FROM wg_v2_work_sources
        WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .get(context.organizationId, context.ownerUserId, sourceId) as { latest_revision_number: number } | undefined
      if (!source) return rejected(request.operationId, "not_found", "Stream notes Work Source not found")
      database
        .prepare(
          `
        INSERT INTO wg_v2_work_source_revisions
          (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, origin_kind, origin_reference_json, created_by_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          revisionId,
          sourceId,
          source.latest_revision_number + 1,
          content,
          contentHash,
          command.externalReferences.length ? JSON.stringify({ derivedFromExternal: true }) : null,
          JSON.stringify(context.actor),
          occurredAt,
        )
      database
        .prepare(
          `
        UPDATE wg_v2_work_sources SET latest_revision_number = latest_revision_number + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .run(occurredAt, context.organizationId, context.ownerUserId, sourceId)
    } else {
      database
        .prepare(
          `
        INSERT INTO wg_v2_work_sources
          (organization_id, owner_user_id, id, workgraph_id, title, source_kind, metadata_json, latest_revision_number, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'manual', ?, 1, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          sourceId,
          rootId,
          `Notes · ${stream.title}`,
          JSON.stringify({ kind: "stream_notes", streamId: stream.id }),
          occurredAt,
          occurredAt,
        )
      database
        .prepare(
          `
        INSERT INTO wg_v2_work_source_revisions
          (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, origin_kind, origin_reference_json, created_by_json, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, 'manual', ?, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          revisionId,
          sourceId,
          content,
          contentHash,
          command.externalReferences.length ? JSON.stringify({ derivedFromExternal: true }) : null,
          JSON.stringify(context.actor),
          occurredAt,
        )
    }
    const notesSource = { workSourceId: sourceId, revisionId, contentHash }
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET notes_source_json = ?, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(JSON.stringify(notesSource), occurredAt, context.organizationId, context.ownerUserId, stream.id, command.expectedVersion)
    return pending("stream_notes_updated", "stream", stream.id, { streamId: stream.id, notesSource }, stream.id)
  }
  if (command.type === "request_public_pr_confirmation") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    if (context.actor.type !== "agent" || context.actor.id !== masterSessionId(stream.id))
      return rejected(request.operationId, "forbidden", "Only the Stream master can request public PR confirmation")
    if (stream.public_pr_confirmed_at !== null) {
      return pending("public_pr_confirmed", "stream", stream.id, { streamId: stream.id, alreadyConfirmed: true }, stream.id)
    }
    // Idempotent: a confirmation already awaiting the owner is a success
    // no-op — retries must not rewrite the escalation or conflict.
    const currentStatus = database
      .prepare(
        `
      SELECT master_status_json FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, stream.id) as { master_status_json: string | null }
    const parsedStatus = currentStatus.master_status_json ? (JSON.parse(currentStatus.master_status_json) as { state?: unknown; escalation?: unknown }) : undefined
    if (parsedStatus?.state === "attention" && parsedStatus.escalation === "public_pr_confirmation") {
      return pending(
        "public_pr_confirmation_requested",
        "stream",
        stream.id,
        { streamId: stream.id, repository: command.repository, title: command.title, alreadyPending: true },
        stream.id,
      )
    }
    const reason = `Confirm the first non-draft pull request to public repository ${command.repository}: ${command.title}`
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET master_status_json = ?, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .run(
        JSON.stringify({
          state: "attention",
          escalation: "public_pr_confirmation",
          sessionId: masterSessionId(stream.id),
          message: reason,
          receiptRefs: [],
          updatedAt: occurredAt,
        }),
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        stream.id,
      )
    // Upsert: the escalation must exist even when no wake job has ever been
    // armed for the Stream — the attention projector reads this row.
    database
      .prepare(
        `
      INSERT INTO wg_v2_due_jobs
        (organization_id, owner_user_id, id, stream_id, job_type, subject_id, due_at, status, last_error, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'master_wake', ?, ?, 'attention', ?, ?, ?, ?)
      ON CONFLICT(organization_id, owner_user_id, job_type, subject_id) DO UPDATE SET
        status = 'attention', last_error = excluded.last_error, claimed_by = NULL, claim_expires_at = NULL,
        row_version = wg_v2_due_jobs.row_version + 1, updated_at = excluded.updated_at
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        `master_wake_${stream.id}`,
        stream.id,
        stream.id,
        occurredAt,
        reason,
        JSON.stringify({ streamId: stream.id, trigger: "mailbox" }),
        occurredAt,
        occurredAt,
      )
    return pending("public_pr_confirmation_requested", "stream", stream.id, { streamId: stream.id, repository: command.repository, title: command.title }, stream.id)
  }
  if (command.type === "confirm_public_pr") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    if (context.actor.type !== "user") return rejected(request.operationId, "forbidden", "Public PR confirmation requires the owner")
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET public_pr_confirmed_at = ?, master_status_json = ?, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        occurredAt,
        JSON.stringify({
          state: "hibernating",
          sessionId: masterSessionId(stream.id),
          message: "Public PR action confirmed",
          receiptRefs: [],
          updatedAt: occurredAt,
        }),
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        stream.id,
        command.expectedVersion,
      )
    resumeSqliteMaster(database, context, stream.id, occurredAt)
    enqueueSqliteMasterWake(database, context, stream.id, occurredAt, "mailbox")
    return pending("public_pr_confirmed", "stream", stream.id, { streamId: stream.id, confirmedAt: occurredAt }, stream.id)
  }
  if (command.type === "record_master_audit") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    if (context.actor.type !== "agent" || context.actor.id !== command.sessionId || command.sessionId !== masterSessionId(stream.id))
      return rejected(request.operationId, "forbidden", "Only the Stream master can record master audit events")
    return pending(
      "master_audit_recorded",
      "stream",
      stream.id,
      {
        streamId: stream.id,
        sessionId: command.sessionId,
        wakeTrigger: command.wakeTrigger,
        charterHash: command.charterHash,
        citedCharterClause: command.citedCharterClause,
        modelVersion: command.modelVersion,
        reasoningSummary: command.reasoningSummary,
        toolCalls: command.toolCalls,
        resultingDiffs: command.resultingDiffs,
        evidenceIds: command.evidenceIds,
        outcome: command.outcome,
      },
      stream.id,
    )
  }
  if (command.type === "set_stream_lifecycle") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    const transition = transitionStream(stream.lifecycle as StreamLifecycleState, command.state)
    if (!transition.ok) return rejected(request.operationId, "invalid_transition", "Invalid stream transition")
    if (transition.state === "closed") {
      database
        .prepare(
          `
        UPDATE wg_v2_work_items SET lifecycle = 'abandoned', abandoned_reason = ?, abandoned_at = ?,
          row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle NOT IN ('completed', 'abandoned')
      `,
        )
        .run(command.reason, occurredAt, occurredAt, context.organizationId, context.ownerUserId, command.streamId)
      cancelSqliteMasterJobs(database, context, command.streamId, occurredAt)
    }
    // Reopening revives the master's retired daily schedule.
    if (transition.state === "reopened") enqueueSqliteMasterSchedule(database, context, command.streamId, occurredAt)
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET lifecycle = ?, row_version = row_version + 1, updated_at = ?, closed_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(transition.state, occurredAt, transition.state === "closed" ? occurredAt : null, context.organizationId, context.ownerUserId, command.streamId, command.expectedVersion)
    return pending("stream_lifecycle_changed", "stream", command.streamId, { streamId: command.streamId }, command.streamId)
  }
  if (command.type === "create_work_source") {
    const contentHash = hash(command.content)
    if (command.authoring && contentHash !== command.authoring.contentHash) {
      return rejected(request.operationId, "validation_error", "Authoring revision content does not match its declared content hash")
    }
    const workSourceId = ids.next("source")
    const revisionId = ids.next("revision")
    database
      .prepare(
        `
      INSERT INTO wg_v2_work_sources
        (organization_id, owner_user_id, id, workgraph_id, title, source_kind, metadata_json, latest_revision_number, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        workSourceId,
        rootId,
        command.title,
        command.authoring ? "authoring" : "manual",
        JSON.stringify(command.authoring ?? {}),
        occurredAt,
        occurredAt,
      )
    database
      .prepare(
        `
      INSERT INTO wg_v2_work_source_revisions
        (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, origin_kind, origin_reference_json, created_by_json, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        revisionId,
        workSourceId,
        command.content,
        contentHash,
        command.authoring ? "authoring" : "manual",
        command.authoring ? JSON.stringify(command.authoring) : null,
        JSON.stringify(context.actor),
        occurredAt,
      )
    return pending("work_source_created", "work_source", workSourceId, { workSourceId, revisionId })
  }
  if (command.type === "revise_work_source") {
    const source = database
      .prepare(
        `
      SELECT latest_revision_number, source_kind, metadata_json FROM wg_v2_work_sources WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.workSourceId) as { latest_revision_number: number; source_kind: string; metadata_json: string } | undefined
    if (!source) return rejected(request.operationId, "not_found", "Work Source not found")
    if ((source.source_kind === "authoring") !== !!command.authoring) {
      return rejected(request.operationId, "validation_error", "Authoring Work Sources require exact authoring provenance on every revision")
    }
    const authoringIdentity = command.authoring ? AuthoringSourceRevisionSchema.parse(JSON.parse(source.metadata_json)) : undefined
    if (
      command.authoring &&
      (command.authoring.adapterId !== authoringIdentity!.adapterId ||
        command.authoring.projectId !== authoringIdentity!.projectId ||
        command.authoring.documentId !== authoringIdentity!.documentId)
    )
      return rejected(request.operationId, "validation_error", "Authoring revision belongs to a different document")
    const contentHash = hash(command.content)
    if (command.authoring && contentHash !== command.authoring.contentHash) {
      return rejected(request.operationId, "validation_error", "Authoring revision content does not match its declared content hash")
    }
    const latest = database
      .prepare(
        `
      SELECT id, origin_kind, origin_reference_json FROM wg_v2_work_source_revisions
      WHERE organization_id = ? AND owner_user_id = ? AND work_source_id = ? AND revision_number = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.workSourceId, source.latest_revision_number) as {
      id: string
      origin_kind: string
      origin_reference_json: string | null
    }
    if (latest.id !== command.expectedRevisionId) return rejected(request.operationId, "version_conflict", "Work Source revision changed")
    const previousAuthoring = command.authoring ? AuthoringSourceRevisionSchema.parse(JSON.parse(requiredOriginReference(latest.origin_reference_json, "authoring"))) : undefined
    if (command.authoring && previousAuthoring!.snapshotId === command.authoring.snapshotId) {
      return rejected(request.operationId, "version_conflict", "Authoring snapshot is already the Work Source head")
    }
    const previousManualOrigin =
      latest.origin_kind === "manual"
        ? WorkSourceOriginSchema.parse({
            kind: "manual",
            ...(latest.origin_reference_json ? JSON.parse(latest.origin_reference_json) : {}),
          })
        : undefined
    const derivedFromExternal = latest.origin_kind === "external" || (previousManualOrigin?.kind === "manual" && previousManualOrigin.derivedFromExternal === true)
    const revisionId = ids.next("revision")
    const revisionNumber = source.latest_revision_number + 1
    database
      .prepare(
        `
      INSERT INTO wg_v2_work_source_revisions
        (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, origin_kind, origin_reference_json, created_by_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        revisionId,
        command.workSourceId,
        revisionNumber,
        command.content,
        contentHash,
        command.authoring ? "authoring" : "manual",
        command.authoring ? JSON.stringify(command.authoring) : derivedFromExternal ? JSON.stringify({ derivedFromExternal: true }) : null,
        JSON.stringify(context.actor),
        occurredAt,
      )
    database
      .prepare(
        `
      UPDATE wg_v2_work_sources SET title = COALESCE(?, title), latest_revision_number = ?, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .run(command.title ?? null, revisionNumber, occurredAt, context.organizationId, context.ownerUserId, command.workSourceId)
    return pending("work_source_revised", "work_source", command.workSourceId, {
      workSourceId: command.workSourceId,
      revisionId,
    })
  }
  if (command.type === "create_outcome") {
    if (!ownedStream(database, context, command.streamId)) return rejected(request.operationId, "not_found", "Stream not found")
    const outcomeId = ids.next("outcome")
    database
      .prepare(
        `
      INSERT INTO wg_v2_outcomes
        (organization_id, owner_user_id, id, stream_id, title, description, lifecycle, success_criteria_json, execution_defaults_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        outcomeId,
        command.streamId,
        command.title,
        command.description ?? "",
        JSON.stringify(command.successCriteria),
        JSON.stringify(command.execution ?? {}),
        occurredAt,
        occurredAt,
      )
    return pending("outcome_created", "outcome", outcomeId, { outcomeId }, command.streamId)
  }
  if (command.type === "update_outcome") {
    const outcome = ownedOutcome(database, context, command.outcomeId)
    if (!outcome) return rejected(request.operationId, "not_found", "Outcome not found")
    if (outcome.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Outcome version changed")
    database
      .prepare(
        `
      UPDATE wg_v2_outcomes SET
        title = COALESCE(?, title), description = COALESCE(?, description),
        success_criteria_json = COALESCE(?, success_criteria_json), execution_defaults_json = COALESCE(?, execution_defaults_json),
        row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        command.title ?? null,
        command.description ?? null,
        command.successCriteria ? JSON.stringify(command.successCriteria) : null,
        command.execution ? JSON.stringify(command.execution) : null,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.outcomeId,
        command.expectedVersion,
      )
    return pending("outcome_updated", "outcome", command.outcomeId, { outcomeId: command.outcomeId }, outcome.stream_id)
  }
  if (command.type === "create_work_item") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (command.parentTaskId && (command.dependencyIds?.length ?? 0) > 0) {
      return rejected(request.operationId, "validation_error", "Subtasks cannot declare dependencies")
    }
    const parent = command.parentTaskId ? ownedWorkItem(database, context, command.parentTaskId) : undefined
    if (command.parentTaskId && (!parent || parent.stream_id !== command.streamId)) return rejected(request.operationId, "not_found", "Parent Task not found")
    if (parent?.parent_task_id) return rejected(request.operationId, "validation_error", "Subtasks support one nesting level")
    if (
      parent &&
      context.actor.type !== "user" &&
      !database
        .prepare(
          `
        SELECT 1 FROM wg_v2_runs
        WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?
          AND lifecycle IN ('admitted', 'placing', 'running') LIMIT 1
      `,
        )
        .get(context.organizationId, context.ownerUserId, parent.id)
    ) {
      return rejected(request.operationId, "blocked", "Subtasks require a live parent Run")
    }
    const source = command.source ? exactSourceHead(database, context, command.source) : undefined
    if (command.source && !source?.exists) {
      return rejected(request.operationId, "not_found", "Work Item source revision not found")
    }
    if (command.outcomeId) {
      const outcome = database
        .prepare(
          `
        SELECT 1 FROM wg_v2_outcomes WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND stream_id = ?
      `,
        )
        .get(context.organizationId, context.ownerUserId, command.outcomeId, command.streamId)
      if (!outcome) return rejected(request.operationId, "not_found", "Outcome not found")
    }
    const dependenciesExist =
      command.dependencyIds?.every((dependencyId) =>
        database
          .prepare(
            `
      SELECT 1 FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND stream_id = ?
    `,
          )
          .get(context.organizationId, context.ownerUserId, dependencyId, command.streamId),
      ) ?? true
    if (!dependenciesExist) return rejected(request.operationId, "not_found", "Dependency not found")
    const origin =
      context.actor.type === "agent"
        ? (database
            .prepare(
              `
          SELECT binding.current_run_id, item.source_revision_id, revision.work_source_id,
            revision.content_hash, revision.origin_kind, revision.origin_reference_json
          FROM wg_v2_session_bindings binding
          JOIN wg_v2_runs run
            ON run.organization_id = binding.organization_id AND run.owner_user_id = binding.owner_user_id
            AND run.id = binding.current_run_id
          JOIN wg_v2_work_items item
            ON item.organization_id = run.organization_id AND item.owner_user_id = run.owner_user_id
            AND item.id = run.work_item_id
          LEFT JOIN wg_v2_work_source_revisions revision
            ON revision.organization_id = item.organization_id AND revision.owner_user_id = item.owner_user_id
            AND revision.id = item.source_revision_id
          WHERE binding.organization_id = ? AND binding.owner_user_id = ? AND binding.session_id = ?
            AND binding.stream_id = ? AND binding.state = 'active' AND binding.current_run_id IS NOT NULL
          LIMIT 1
        `,
            )
            .get(context.organizationId, context.ownerUserId, context.actor.id, command.streamId) as
            | {
                current_run_id: string
                source_revision_id: string | null
                work_source_id: string | null
                content_hash: string | null
                origin_kind: string | null
                origin_reference_json: string | null
              }
            | undefined)
        : undefined
    const inheritedOrigin = origin?.origin_reference_json ? (JSON.parse(origin.origin_reference_json) as { derivedFromExternal?: boolean }) : undefined
    const workItemId = ids.next("work_item")
    // Draft intent is inert. Otherwise the compiled Stream autonomy decides
    // whether trusted agent work is admitted; external provenance always keeps
    // the owner approval boundary.
    const bornState = command.draft
      ? "draft"
      : context.actor.type === "user" ||
          (streamAutonomy(stream.execution_defaults_json) === "autonomous" &&
            !source?.untrusted &&
            origin?.origin_kind !== "external" &&
            inheritedOrigin?.derivedFromExternal !== true)
        ? "pending"
        : "pending_approval"
    database
      .prepare(
        `
      INSERT INTO wg_v2_work_items
        (organization_id, owner_user_id, id, stream_id, parent_task_id, outcome_id, source_revision_id, title, description, lifecycle, priority, execution_overrides_json, completion_contract_json, created_by_actor_type, created_by_actor_id, origin_run_id, auto_admitted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        workItemId,
        command.streamId,
        command.parentTaskId ?? null,
        command.outcomeId ?? null,
        command.source?.revisionId ?? origin?.source_revision_id ?? null,
        command.title,
        command.description ?? "",
        bornState,
        command.priority ?? 0,
        JSON.stringify(command.execution ?? {}),
        JSON.stringify(command.completionContract),
        context.actor.type,
        context.actor.id,
        origin?.current_run_id ?? null,
        context.actor.type === "agent" && bornState === "pending" ? 1 : null,
        occurredAt,
        occurredAt,
      )
    command.dependencyIds?.forEach((dependencyId) => {
      database
        .prepare(
          `
        INSERT INTO wg_v2_work_item_dependencies (organization_id, owner_user_id, id, work_item_id, depends_on_work_item_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(context.organizationId, context.ownerUserId, ids.next("dependency"), workItemId, dependencyId, occurredAt)
    })
    const sourceReference =
      command.source ??
      (origin?.work_source_id && origin.source_revision_id && origin.content_hash
        ? {
            workSourceId: origin.work_source_id,
            revisionId: origin.source_revision_id,
            contentHash: origin.content_hash,
          }
        : undefined)
    if (sourceReference) addSourceReference(database, context, ids, "work_item", workItemId, sourceReference, occurredAt)
    return pending("work_item_created", "work_item", workItemId, { workItemId }, command.streamId)
  }
  if (command.type === "update_work_item") {
    const item = ownedWorkItem(database, context, command.workItemId)
    if (!item) return rejected(request.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Work Item version changed")
    if (command.outcomeId) {
      const outcome = database
        .prepare("SELECT 1 FROM wg_v2_outcomes WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND stream_id = ?")
        .get(context.organizationId, context.ownerUserId, command.outcomeId, item.stream_id)
      if (!outcome) return rejected(request.operationId, "not_found", "Outcome not found")
    }
    const dependencyIds = command.dependencyIds ?? []
    if (item.parent_task_id && dependencyIds.length > 0) return rejected(request.operationId, "validation_error", "Subtasks cannot declare dependencies")
    if (dependencyIds.includes(command.workItemId)) return rejected(request.operationId, "validation_error", "A Work Item cannot depend on itself")
    if (new Set(dependencyIds).size !== dependencyIds.length) return rejected(request.operationId, "validation_error", "Dependencies must be unique")
    const dependenciesExist = dependencyIds.every((dependencyId) =>
      database
        .prepare(
          `
      SELECT 1 FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND stream_id = ?
    `,
        )
        .get(context.organizationId, context.ownerUserId, dependencyId, item.stream_id),
    )
    if (command.dependencyIds && !dependenciesExist) return rejected(request.operationId, "not_found", "Dependency not found")
    if (command.dependencyIds) {
      const graph = readSqliteDependencyGraph(database, context, item.stream_id)
      graph.set(command.workItemId, dependencyIds)
      if (dependencyGraphHasCycle([...graph].map(([id, currentDependencyIds]) => ({ id, dependencyIds: currentDependencyIds })))) {
        return rejected(request.operationId, "validation_error", "Work Item dependencies contain a cycle")
      }
    }
    database
      .prepare(
        `
      UPDATE wg_v2_work_items SET
        outcome_id = CASE WHEN ? THEN ? ELSE outcome_id END,
        title = COALESCE(?, title), description = COALESCE(?, description), priority = COALESCE(?, priority),
        completion_contract_json = COALESCE(?, completion_contract_json), execution_overrides_json = COALESCE(?, execution_overrides_json),
        row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        command.outcomeId !== undefined ? 1 : 0,
        command.outcomeId ?? null,
        command.title ?? null,
        command.description ?? null,
        command.priority ?? null,
        command.completionContract ? JSON.stringify(command.completionContract) : null,
        command.execution ? JSON.stringify(command.execution) : null,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.workItemId,
        command.expectedVersion,
      )
    if (command.dependencyIds) {
      database
        .prepare("DELETE FROM wg_v2_work_item_dependencies WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?")
        .run(context.organizationId, context.ownerUserId, command.workItemId)
      dependencyIds.forEach((dependencyId) =>
        database
          .prepare(
            `
        INSERT INTO wg_v2_work_item_dependencies (organization_id, owner_user_id, id, work_item_id, depends_on_work_item_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
          )
          .run(context.organizationId, context.ownerUserId, ids.next("dependency"), command.workItemId, dependencyId, occurredAt),
      )
    }
    // Agent material edits re-open the approval gate: an owner-authorized agent
    // mutating an approved-but-not-yet-launched plan demotes it back to
    // `pending_approval` so the owner re-approves. Human edits re-affirm (their
    // row_version bump already CAS-invalidates any stale in-flight approval), and
    // edits to running/terminal items never touch approval.
    const changesMaterialField =
      command.title !== undefined ||
      command.description !== undefined ||
      command.priority !== undefined ||
      command.outcomeId !== undefined ||
      command.dependencyIds !== undefined ||
      command.completionContract !== undefined ||
      command.execution !== undefined
    const stream = ownedStream(database, context, item.stream_id)
    if (context.actor.type === "agent" && item.lifecycle === "pending" && changesMaterialField && streamAutonomy(stream?.execution_defaults_json) !== "autonomous") {
      database
        .prepare(
          `
        UPDATE wg_v2_work_items SET lifecycle = 'pending_approval', row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'pending'
      `,
        )
        .run(occurredAt, context.organizationId, context.ownerUserId, command.workItemId)
      return pending("work_item_restaged", "work_item", command.workItemId, { workItemId: command.workItemId }, item.stream_id)
    }
    return pending("work_item_updated", "work_item", command.workItemId, { workItemId: command.workItemId }, item.stream_id)
  }
  if (command.type === "cancel_work_item") {
    const item = ownedWorkItem(database, context, command.workItemId)
    if (!item) return rejected(request.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Work Item version changed")
    if (item.lifecycle === "completed" || item.lifecycle === "abandoned") return rejected(request.operationId, "invalid_transition", "Work Item is already terminal")
    const liveRun = database
      .prepare(
        `
      SELECT 1 FROM wg_v2_runs
      WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ? AND lifecycle NOT IN ('result', 'failed', 'cancelled')
      LIMIT 1
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.workItemId)
    const activeLease = database
      .prepare(
        `
      SELECT 1 FROM wg_v2_leases
      WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ? AND CAST(expires_at AS INTEGER) > ?
      LIMIT 1
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.workItemId, occurredAt)
    if (liveRun || activeLease) return rejected(request.operationId, "blocked", "Cancel the active Run before abandoning its Work Item")
    database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'abandoned', abandoned_reason = ?, abandoned_at = ?,
        row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(command.reason, occurredAt, occurredAt, context.organizationId, context.ownerUserId, command.workItemId, command.expectedVersion)
    return pending("work_item_updated", "work_item", command.workItemId, { workItemId: command.workItemId }, item.stream_id)
  }
  if (command.type === "set_stream_visibility") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    const transition = transitionStreamVisibility(stream.visibility as "visible" | "archived", command.visibility)
    if (!transition.ok) return rejected(request.operationId, "invalid_transition", "Invalid visibility transition")
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET visibility = ?, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(transition.state, occurredAt, context.organizationId, context.ownerUserId, command.streamId, command.expectedVersion)
    return pending("stream_visibility_changed", "stream", command.streamId, { streamId: command.streamId }, command.streamId)
  }
  if (command.type === "propose_decision") {
    if (!ownedStream(database, context, command.streamId)) return rejected(request.operationId, "not_found", "Stream not found")
    const optionIds = command.options.map((option) => option.id)
    if (new Set(optionIds).size !== optionIds.length) return rejected(request.operationId, "validation_error", "Decision option IDs must be unique")
    if (command.recommendationOptionId && !optionIds.includes(command.recommendationOptionId)) {
      return rejected(request.operationId, "validation_error", "Recommendation must reference an option")
    }
    const affectedExist = command.affectedWorkItemIds.every((workItemId) =>
      database
        .prepare(
          `
      SELECT 1 FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND stream_id = ?
    `,
        )
        .get(context.organizationId, context.ownerUserId, workItemId, command.streamId),
    )
    if (!affectedExist) return rejected(request.operationId, "not_found", "Affected Work Item not found")
    const decisionId = ids.next("decision")
    database
      .prepare(
        `
      INSERT INTO wg_v2_decisions
        (organization_id, owner_user_id, id, stream_id, question, options_json, recommendation_json, rationale, lifecycle, proposed_by_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        decisionId,
        command.streamId,
        command.question,
        JSON.stringify(command.options),
        command.recommendationOptionId ? JSON.stringify({ optionId: command.recommendationOptionId }) : null,
        command.rationale ?? null,
        JSON.stringify(context.actor),
        occurredAt,
        occurredAt,
      )
    command.affectedWorkItemIds.forEach((workItemId) =>
      database
        .prepare(
          `
      INSERT INTO wg_v2_decision_work_items (organization_id, owner_user_id, id, decision_id, work_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `,
        )
        .run(context.organizationId, context.ownerUserId, ids.next("decision_work_item"), decisionId, workItemId, occurredAt),
    )
    return pending("decision_proposed", "decision", decisionId, { decisionId }, command.streamId)
  }
  if (command.type === "answer_decision") {
    const decision = ownedDecision(database, context, command.decisionId)
    if (!decision) return rejected(request.operationId, "not_found", "Decision not found")
    if (decision.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Decision version changed")
    const transition = transitionDecision(decision.lifecycle as "proposed" | "pending" | "answered" | "dismissed", "answered")
    if (!transition.ok) return rejected(request.operationId, "invalid_transition", "Decision is not pending")
    if (!command.optionId && !command.answer) return rejected(request.operationId, "validation_error", "An option or answer is required")
    const options = JSON.parse(decision.options_json) as Array<{ id: string }>
    if (command.optionId && !options.some((option) => option.id === command.optionId)) {
      return rejected(request.operationId, "validation_error", "Decision option not found")
    }
    database
      .prepare(
        `
      UPDATE wg_v2_decisions SET lifecycle = 'answered', answer_json = ?, answered_by_json = ?, answered_at = ?,
        row_version = row_version + 1, updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        JSON.stringify({
          ...(command.optionId ? { optionId: command.optionId } : {}),
          ...(command.answer ? { answer: command.answer } : {}),
        }),
        JSON.stringify(context.actor),
        occurredAt,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.decisionId,
        command.expectedVersion,
      )
    return pending("decision_answered", "decision", command.decisionId, { decisionId: command.decisionId }, decision.stream_id)
  }
  if (command.type === "dismiss_decision") {
    const decision = ownedDecision(database, context, command.decisionId)
    if (!decision) return rejected(request.operationId, "not_found", "Decision not found")
    if (decision.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Decision version changed")
    const transition = transitionDecision(decision.lifecycle as "proposed" | "pending" | "answered" | "dismissed", "dismissed")
    if (!transition.ok) return rejected(request.operationId, "invalid_transition", "Decision is not pending")
    database
      .prepare(
        `
      UPDATE wg_v2_decisions SET lifecycle = 'dismissed', answer_json = ?, answered_by_json = ?, answered_at = ?,
        row_version = row_version + 1, updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        JSON.stringify({ dismissReason: command.reason }),
        JSON.stringify(context.actor),
        occurredAt,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.decisionId,
        command.expectedVersion,
      )
    return pending("decision_dismissed", "decision", command.decisionId, { decisionId: command.decisionId }, decision.stream_id)
  }
  if (command.type === "propose_admission") {
    const source = exactSourceHead(database, context, command.source)
    if (!source.exists) return rejected(request.operationId, "not_found", "Work Source revision not found")
    if (!source.current) return rejected(request.operationId, "version_conflict", "Admission requires the current Work Source head")
    if (command.targetStreamId && !ownedStream(database, context, command.targetStreamId)) {
      return rejected(request.operationId, "not_found", "Target Stream not found")
    }
    const proposalId = ids.next("admission")
    const evidence = sourcePlanningEvidence(database, context, {
      title: source.title,
      content: source.content,
      ...(command.targetStreamId ? { targetStreamId: command.targetStreamId } : {}),
      now: occurredAt,
    })
    const previous = command.targetStreamId ? previousSourceRevision(database, context, command.targetStreamId, command.source) : undefined
    const planning = {
      source: command.source,
      ...(command.execution ? { execution: command.execution } : {}),
      ...(previous
        ? {
            previousSource: previous.reference,
            diffSummary: sourceRevisionDiffSummary(previous.content, source.content),
          }
        : {}),
      planningEvidence: evidence,
      generation: { method: "planning" as const, tryNumber: 0, queuedAt: occurredAt },
    }
    database
      .prepare(
        `
      INSERT INTO wg_v2_admission_proposals
        (organization_id, owner_user_id, id, workgraph_id, source_revision_id, previous_source_revision_id, proposal_kind, lifecycle, proposed_work_json, duplicate_matches_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'source', 'planning', ?, ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        proposalId,
        rootId,
        command.source.revisionId,
        previous?.reference.revisionId ?? null,
        JSON.stringify(planning),
        JSON.stringify(evidence.duplicateMatches),
        occurredAt,
        occurredAt,
      )
    database
      .prepare(
        `
      INSERT OR IGNORE INTO wg_v2_due_jobs
        (organization_id, owner_user_id, id, job_type, subject_id, due_at, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, 'source_plan', ?, ?, 'pending', ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        `source_plan_job_${proposalId}`,
        proposalId,
        occurredAt,
        JSON.stringify({ proposalId, source: command.source, automaticFailureCount: 0 }),
        occurredAt,
        occurredAt,
      )
    return pending("admission_proposed", "work_source", command.source.workSourceId, { proposalId })
  }
  if (command.type === "retry_admission_planning") {
    const row = database
      .prepare(
        `
      SELECT lifecycle, proposed_work_json, source_revision_id, row_version
      FROM wg_v2_admission_proposals WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.proposalId) as AdmissionProposalRow | undefined
    if (!row) return rejected(request.operationId, "not_found", "Admission proposal not found")
    if (row.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Admission proposal version changed")
    if (row.lifecycle !== "planning_failed") return rejected(request.operationId, "invalid_transition", "Admission planning has not failed")
    const failed = JSON.parse(row.proposed_work_json) as {
      source?: WorkSourceRevisionRef
      execution?: ExecutionProfileDefaults
      previousSource?: WorkSourceRevisionRef
      diffSummary?: string
      planningEvidence?: unknown
      suggestedPlacement?: { mode: "new_stream"; streamTitle: string } | { mode: "existing"; streamId: string }
      generation?: { method?: string; tryNumber?: number; retryable?: boolean }
    }
    if (!failed.source || failed.generation?.method !== "planning_failed") return rejected(request.operationId, "invalid_transition", "Admission planning failure is incomplete")
    if (failed.generation.retryable !== true) return rejected(request.operationId, "invalid_transition", "Admission planning failure is not retryable")
    const source = exactSourceHead(database, context, failed.source)
    if (!source.exists || !source.current) return rejected(request.operationId, "version_conflict", "Admission source is no longer current")
    const tryNumber = failed.generation.tryNumber ?? 0
    database
      .prepare(
        `
      UPDATE wg_v2_admission_proposals SET lifecycle = 'planning', proposed_work_json = ?,
        row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ? AND lifecycle = 'planning_failed'
    `,
      )
      .run(
        JSON.stringify({
          source: failed.source,
          ...(failed.execution ? { execution: failed.execution } : {}),
          ...(failed.previousSource ? { previousSource: failed.previousSource } : {}),
          ...(failed.diffSummary ? { diffSummary: failed.diffSummary } : {}),
          planningEvidence: failed.planningEvidence ?? {},
          generation: { method: "planning", tryNumber, queuedAt: occurredAt },
        }),
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.proposalId,
        command.expectedVersion,
      )
    database
      .prepare(
        `
      INSERT INTO wg_v2_due_jobs
        (organization_id, owner_user_id, id, job_type, subject_id, due_at, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, 'source_plan', ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(organization_id, owner_user_id, job_type, subject_id) DO UPDATE SET
        due_at = excluded.due_at, status = 'pending', payload_json = excluded.payload_json,
        claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
        row_version = wg_v2_due_jobs.row_version + 1, updated_at = excluded.updated_at
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        `source_plan_job_${command.proposalId}`,
        command.proposalId,
        occurredAt,
        JSON.stringify({ proposalId: command.proposalId, source: failed.source, automaticFailureCount: 0 }),
        occurredAt,
        occurredAt,
      )
    return pending("admission_planning_retried", "admission_proposal", command.proposalId, {
      proposalId: command.proposalId,
      version: command.expectedVersion + 1,
      tryNumber,
    })
  }
  if (command.type === "dismiss_admission" || command.type === "reopen_admission") {
    const proposal = database
      .prepare(
        `
      SELECT lifecycle, proposed_work_json, row_version FROM wg_v2_admission_proposals
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.proposalId) as AdmissionProposalRow | undefined
    if (!proposal) return rejected(request.operationId, "not_found", "Admission proposal not found")
    if (proposal.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Admission proposal version changed")
    const expectedState = command.type === "dismiss_admission" ? "proposed" : "dismissed"
    if (proposal.lifecycle !== expectedState) {
      return rejected(
        request.operationId,
        "invalid_transition",
        command.type === "dismiss_admission" ? "Only a reviewable admission proposal may be dismissed" : "Only a dismissed admission proposal may be reopened",
      )
    }
    if (!reviewableAdmissionPayload(JSON.parse(proposal.proposed_work_json))) {
      return rejected(request.operationId, "invalid_transition", "Admission proposal is not reviewable")
    }
    const nextState = command.type === "dismiss_admission" ? "dismissed" : "proposed"
    const changed = database
      .prepare(
        `
      UPDATE wg_v2_admission_proposals SET lifecycle = ?, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ? AND lifecycle = ?
    `,
      )
      .run(nextState, occurredAt, context.organizationId, context.ownerUserId, command.proposalId, command.expectedVersion, expectedState)
    if (changed.changes !== 1) return rejected(request.operationId, "version_conflict", "Admission proposal version changed")
    return pending(command.type === "dismiss_admission" ? "admission_dismissed" : "admission_reopened", "admission_proposal", command.proposalId, {
      proposalId: command.proposalId,
      version: command.expectedVersion + 1,
    })
  }
  if (command.type === "confirm_admission") {
    if (command.charter && !charterMatchesHash(command.charter)) return rejected(request.operationId, "validation_error", "Stream charter text does not match its declared hash")
    const proposal = database
      .prepare(
        `
      SELECT source_revision_id, intake_candidate_id, lifecycle, proposed_work_json, row_version FROM wg_v2_admission_proposals
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.proposalId) as AdmissionProposalRow | undefined
    if (!proposal) return rejected(request.operationId, "not_found", "Admission proposal not found")
    if (proposal.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Admission proposal version changed")
    if (proposal.lifecycle !== "proposed") return rejected(request.operationId, "invalid_transition", "Admission proposal is not open")
    const proposed = JSON.parse(proposal.proposed_work_json) as {
      source: { workSourceId: string; revisionId: string }
      execution?: ExecutionProfileDefaults
      previousSource?: WorkSourceRevisionRef
      generation?: { method?: string; sessionId?: string }
      outcomes?: unknown[]
      workItems?: unknown[]
      placementMatches?: unknown[]
      duplicateMatches?: unknown[]
    }
    if (
      proposed.generation?.method !== "agent_session" ||
      !proposed.generation.sessionId ||
      !Array.isArray(proposed.outcomes) ||
      !Array.isArray(proposed.workItems) ||
      !Array.isArray(proposed.placementMatches) ||
      !Array.isArray(proposed.duplicateMatches)
    ) {
      return rejected(request.operationId, "invalid_transition", "Admission proposal has no complete Session-authored plan")
    }
    if (proposed.source.workSourceId !== command.source.workSourceId || proposal.source_revision_id !== command.source.revisionId) {
      return rejected(request.operationId, "version_conflict", "Admission source does not match the proposal")
    }
    const source = exactSourceHead(database, context, command.source)
    if (!source.exists) return rejected(request.operationId, "not_found", "Work Source revision not found")
    if (!source.current) return rejected(request.operationId, "version_conflict", "Admission source is no longer current")
    if (proposal.intake_candidate_id) {
      const candidate = database
        .prepare(
          `
        SELECT normalized_json, status FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .get(context.organizationId, context.ownerUserId, proposal.intake_candidate_id) as { normalized_json: string; status: string } | undefined
      const admission = candidate ? (JSON.parse(candidate.normalized_json) as { admissionProposalId?: string; source?: typeof command.source }) : undefined
      if (
        candidate?.status !== "staged" ||
        admission?.admissionProposalId !== command.proposalId ||
        !admission.source ||
        admission.source.workSourceId !== command.source.workSourceId ||
        admission.source.revisionId !== command.source.revisionId ||
        admission.source.contentHash !== command.source.contentHash
      ) {
        return rejected(request.operationId, "version_conflict", "Intake candidate does not match the admission proposal")
      }
    }
    const existingStreamId = "streamId" in command.selection ? command.selection.streamId : undefined
    const existingStream = existingStreamId ? ownedStream(database, context, existingStreamId) : undefined
    if (existingStreamId && !existingStream) return rejected(request.operationId, "not_found", "Selected Stream not found")
    const outcomeKeys = command.outcomes?.map((outcome) => outcome.proposalKey) ?? []
    const workItemKeys = command.workItems?.map((item) => item.proposalKey) ?? []
    if (new Set(outcomeKeys).size !== outcomeKeys.length || new Set(workItemKeys).size !== workItemKeys.length) {
      return rejected(request.operationId, "validation_error", "Admission proposal keys must be unique")
    }
    const validOutcomeRefs = command.workItems?.every((item) => !item.outcomeProposalKey || outcomeKeys.includes(item.outcomeProposalKey)) ?? true
    const validDependencyRefs =
      command.workItems?.every((item) => item.dependencyProposalKeys?.every((key) => workItemKeys.includes(key) && key !== item.proposalKey) ?? true) ?? true
    if (!validOutcomeRefs || !validDependencyRefs) return rejected(request.operationId, "validation_error", "Admission references an unknown proposal key")
    if (
      dependencyGraphHasCycle(
        (command.workItems ?? []).map((item) => ({
          id: item.proposalKey,
          dependencyIds: item.dependencyProposalKeys ?? [],
        })),
      )
    )
      return rejected(request.operationId, "validation_error", "Admission Work Item dependencies contain a cycle")

    if (command.selection.mode === "replace") {
      const replacement = validateSqliteReplacement(database, context, {
        streamId: command.selection.streamId,
        previousSource: proposed.previousSource,
        workItems: command.selection.workItems,
      })
      if (!replacement.ok) return rejected(request.operationId, replacement.code, replacement.message)
    }

    const streamId = command.selection.mode === "create" || command.selection.mode === "fork" ? ids.next("stream") : existingStreamId!
    if (command.selection.mode === "create" || command.selection.mode === "fork") {
      database
        .prepare(
          `
        INSERT INTO wg_v2_streams
          (organization_id, owner_user_id, id, workgraph_id, title, purpose, charter_json, lifecycle, execution_defaults_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          streamId,
          rootId,
          command.selection.streamTitle,
          command.selection.streamTitle,
          command.charter ? JSON.stringify(command.charter) : null,
          JSON.stringify(proposed.execution ?? {}),
          occurredAt,
          occurredAt,
        )
    }
    if (command.selection.mode === "replace") {
      const runs = database
        .prepare(
          `
        SELECT id, work_item_id, session_id FROM wg_v2_runs
        WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
          AND work_item_id IN (${command.selection.workItems.map(() => "?").join(", ")})
          AND lifecycle IN ('admitted', 'placing', 'running', 'parked')
      `,
        )
        .all(context.organizationId, context.ownerUserId, streamId, ...command.selection.workItems.map((item) => item.workItemId)) as Array<{
        id: RunID
        work_item_id: WorkItemID
        session_id: ExecutionSessionID | null
      }>
      database
        .prepare(
          `
        UPDATE wg_v2_runs SET lifecycle = 'parked', parked_reason = 'Cancellation pending: replaced by confirmed admission',
          row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
          AND work_item_id IN (${command.selection.workItems.map(() => "?").join(", ")})
          AND lifecycle IN ('admitted', 'placing', 'running', 'parked')
      `,
        )
        .run(occurredAt, context.organizationId, context.ownerUserId, streamId, ...command.selection.workItems.map((item) => item.workItemId))
      runs.forEach((run) =>
        releaseSqliteRunLeases(database, context, {
          runId: run.id,
          streamId: streamId as StreamID,
          workItemId: run.work_item_id,
        }),
      )
      database
        .prepare(
          `
        UPDATE wg_v2_work_items SET lifecycle = 'abandoned', abandoned_reason = 'Replaced by confirmed admission',
          abandoned_at = ?, row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
          AND id IN (${command.selection.workItems.map(() => "?").join(", ")})
      `,
        )
        .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, streamId, ...command.selection.workItems.map((item) => item.workItemId))
      const reset = {
        state: "pending",
        proposalId: command.proposalId,
        previousSource: proposed.previousSource!,
        source: command.source,
        requestedAt: occurredAt,
      }
      database
        .prepare(
          `
        UPDATE wg_v2_streams SET replacement_reset_json = ?, charter_json = COALESCE(?, charter_json), row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .run(JSON.stringify(reset), command.charter ? JSON.stringify(command.charter) : null, occurredAt, context.organizationId, context.ownerUserId, streamId)
      reserveRuntimeEffect(
        database,
        context,
        {
          operationId: request.operationId,
          kind: "reset_stream",
          resourceType: "stream",
          resourceId: streamId,
          payload: {
            streamId,
            proposalId: command.proposalId,
            runIds: runs.map((run) => run.id),
            sessions: runs.flatMap((run) => (run.session_id ? [{ runId: run.id, sessionId: run.session_id }] : [])),
            envelopeId: existingStream?.envelope_identity_json ? (JSON.parse(existingStream.envelope_identity_json) as { id?: string }).id : undefined,
          },
        },
        occurredAt,
      )
    }
    if (command.charter && existingStream && command.selection.mode !== "replace") {
      database
        .prepare(
          `UPDATE wg_v2_streams SET charter_json = ?, row_version = row_version + 1, updated_at = ?
           WHERE organization_id = ? AND owner_user_id = ? AND id = ?`,
        )
        .run(JSON.stringify(command.charter), occurredAt, context.organizationId, context.ownerUserId, streamId)
    }
    addSourceReference(database, context, ids, "stream", streamId, command.source, occurredAt)
    const outcomes = new Map(
      (command.outcomes ?? []).map((outcome) => {
        const outcomeId = ids.next("outcome")
        database
          .prepare(
            `
        INSERT INTO wg_v2_outcomes
          (organization_id, owner_user_id, id, stream_id, title, description, lifecycle, success_criteria_json, execution_defaults_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `,
          )
          .run(
            context.organizationId,
            context.ownerUserId,
            outcomeId,
            streamId,
            outcome.title,
            outcome.description ?? "",
            JSON.stringify(outcome.successCriteria),
            JSON.stringify(outcome.execution ?? {}),
            occurredAt,
            occurredAt,
          )
        addSourceReference(database, context, ids, "outcome", outcomeId, command.source, occurredAt)
        return [outcome.proposalKey, outcomeId]
      }),
    )
    const itemIds = new Map((command.workItems ?? []).map((item) => [item.proposalKey, ids.next("work_item")]))
    ;(command.workItems ?? []).forEach((item) => {
      const workItemId = itemIds.get(item.proposalKey)!
      database
        .prepare(
          `
        INSERT INTO wg_v2_work_items
          (organization_id, owner_user_id, id, stream_id, outcome_id, source_revision_id, title, description, lifecycle, execution_overrides_json, completion_contract_json, created_by_actor_type, created_by_actor_id, origin_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          workItemId,
          streamId,
          item.outcomeProposalKey ? outcomes.get(item.outcomeProposalKey) : null,
          command.source.revisionId,
          item.title,
          item.description ?? "",
          JSON.stringify(item.execution ?? {}),
          JSON.stringify(item.completionContract),
          context.actor.type,
          context.actor.id,
          null,
          occurredAt,
          occurredAt,
        )
      addSourceReference(database, context, ids, "work_item", workItemId, command.source, occurredAt)
      item.dependencyProposalKeys?.forEach((key) =>
        database
          .prepare(
            `
        INSERT INTO wg_v2_work_item_dependencies (organization_id, owner_user_id, id, work_item_id, depends_on_work_item_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
          )
          .run(context.organizationId, context.ownerUserId, ids.next("dependency"), workItemId, itemIds.get(key), occurredAt),
      )
    })
    database
      .prepare(
        `
      UPDATE wg_v2_admission_proposals SET lifecycle = 'confirmed', proposed_work_json = ?, disposition_json = ?, confirmed_at = ?,
        row_version = row_version + 1, updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        JSON.stringify({ ...proposed, outcomes: command.outcomes ?? [], workItems: command.workItems ?? [] }),
        JSON.stringify({ selection: command.selection, streamId }),
        occurredAt,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.proposalId,
        command.expectedVersion,
      )
    if (proposal.intake_candidate_id)
      database
        .prepare(
          `
      UPDATE wg_v2_intake_candidates SET status = 'confirmed', row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND status = 'staged'
    `,
        )
        .run(occurredAt, context.organizationId, context.ownerUserId, proposal.intake_candidate_id)
    return pending("admission_confirmed", "stream", streamId, { proposalId: command.proposalId, streamId }, streamId)
  }
  if (command.type === "close_outcome") {
    const outcome = ownedOutcome(database, context, command.outcomeId)
    if (!outcome) return rejected(request.operationId, "not_found", "Outcome not found")
    if (outcome.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Outcome version changed")
    const childStates = database
      .prepare("SELECT lifecycle FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND outcome_id = ?")
      .all(context.organizationId, context.ownerUserId, command.outcomeId) as Array<{
      lifecycle: Parameters<typeof completeOutcome>[0]["childStates"][number]
    }>
    const confirmationRow = database
      .prepare(
        `
      SELECT id, requirement_id, source_run_id, reference_json, provenance_json, created_at FROM wg_v2_evidence
      WHERE organization_id = ? AND owner_user_id = ? AND subject_type = 'outcome' AND subject_id = ? AND evidence_kind = 'owner_confirmation'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.outcomeId) as EvidenceRow | undefined
    const completion = completeOutcome({
      outcomeId: command.outcomeId,
      ownerUserId: context.ownerUserId,
      state: outcome.lifecycle as Parameters<typeof completeOutcome>[0]["state"],
      childStates: childStates.map((row) => row.lifecycle),
      ownerConfirmation: confirmationRow ? evidenceDto({ type: "outcome", outcomeId: command.outcomeId }, confirmationRow) : undefined,
      closedAt: occurredAt,
      closedBy: context.actor,
    })
    if (!completion.ok) return rejected(request.operationId, "blocked", completion.error.code)
    database
      .prepare(
        `
      UPDATE wg_v2_outcomes SET lifecycle = 'completed', completed_at = ?, closed_by_json = ?, close_reason = ?,
        row_version = row_version + 1, updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        occurredAt,
        JSON.stringify(completion.provenance.closedBy),
        command.reason,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.outcomeId,
        command.expectedVersion,
      )
    return pending("outcome_closed", "outcome", command.outcomeId, { outcomeId: command.outcomeId, reason: command.reason }, outcome.stream_id)
  }
  if (command.type === "approve_work_item") {
    if (context.actor.type !== "user") return rejected(request.operationId, "forbidden", "Only the owner can approve tasks")
    const item = ownedWorkItem(database, context, command.workItemId)
    if (!item) return rejected(request.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Work Item version changed")
    if (item.lifecycle !== "pending_approval") return rejected(request.operationId, "invalid_transition", "Task is not awaiting approval")
    const changed = database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'pending', row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ? AND lifecycle = 'pending_approval'
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, command.workItemId, command.expectedVersion)
    if (changed.changes !== 1) return rejected(request.operationId, "version_conflict", "Work Item version changed")
    return pending("work_item_approved", "work_item", command.workItemId, { workItemId: command.workItemId, version: item.row_version + 1 }, item.stream_id)
  }
  if (command.type === "reject_work_item") {
    if (context.actor.type !== "user") return rejected(request.operationId, "forbidden", "Only the owner can reject tasks")
    const item = ownedWorkItem(database, context, command.workItemId)
    if (!item) return rejected(request.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Work Item version changed")
    if (item.lifecycle !== "pending_approval") return rejected(request.operationId, "invalid_transition", "Task is not awaiting approval")
    const changed = database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'abandoned', abandoned_reason = ?, abandoned_at = ?,
        row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ? AND lifecycle = 'pending_approval'
    `,
      )
      .run(command.reason, occurredAt, occurredAt, context.organizationId, context.ownerUserId, command.workItemId, command.expectedVersion)
    if (changed.changes !== 1) return rejected(request.operationId, "version_conflict", "Work Item version changed")
    return pending("work_item_rejected", "work_item", command.workItemId, { workItemId: command.workItemId, reason: command.reason }, item.stream_id)
  }
  if (command.type === "approve_work_items") {
    if (context.actor.type !== "user") return rejected(request.operationId, "forbidden", "Only the owner can approve tasks")
    // Per-entry CAS `pending_approval -> pending`. Partial success by design: one
    // stale or missing task never blocks the rest. A server-side "approve
    // everything staged" sweep is forbidden — the client sends the exact
    // row_versions it rendered so it never approves an unseen edit.
    const results = command.approvals.map((approval) => {
      const item = ownedWorkItem(database, context, approval.workItemId)
      if (!item) return { workItemId: approval.workItemId, outcome: "not_found" as const }
      if (item.row_version !== approval.expectedVersion) return { workItemId: approval.workItemId, outcome: "version_conflict" as const }
      if (item.lifecycle !== "pending_approval") return { workItemId: approval.workItemId, outcome: "not_staged" as const }
      const changed = database
        .prepare(
          `
        UPDATE wg_v2_work_items SET lifecycle = 'pending', row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ? AND lifecycle = 'pending_approval'
      `,
        )
        .run(occurredAt, context.organizationId, context.ownerUserId, approval.workItemId, approval.expectedVersion)
      if (changed.changes !== 1) return { workItemId: approval.workItemId, outcome: "version_conflict" as const }
      return { workItemId: approval.workItemId, outcome: "approved" as const, version: item.row_version + 1 }
    })
    return pending("work_item_approved", "workgraph", rootId, { results })
  }
  if (command.type === "arm_work_item") {
    if (context.actor.type !== "user") return rejected(request.operationId, "forbidden", "Only the owner can arm draft tasks")
    const item = ownedWorkItem(database, context, command.workItemId)
    if (!item) return rejected(request.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Work Item version changed")
    if (item.lifecycle !== "draft") return rejected(request.operationId, "invalid_transition", "Task is not a draft")
    const changed = database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'pending', row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ? AND lifecycle = 'draft'
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, item.id, item.row_version)
    if (changed.changes !== 1) return rejected(request.operationId, "version_conflict", "Work Item version changed")
    return pending("work_item_armed", "work_item", item.id, { workItemId: item.id }, item.stream_id)
  }
  if (command.type === "arm_work_items") {
    if (context.actor.type !== "user") return rejected(request.operationId, "forbidden", "Only the owner can arm draft tasks")
    const results = command.items.map((entry) => {
      const item = ownedWorkItem(database, context, entry.workItemId)
      if (!item) return { workItemId: entry.workItemId, outcome: "not_found" as const }
      if (item.row_version !== entry.expectedVersion) return { workItemId: entry.workItemId, outcome: "version_conflict" as const }
      if (item.lifecycle !== "draft") return { workItemId: entry.workItemId, outcome: "not_draft" as const }
      const changed = database
        .prepare(
          `
        UPDATE wg_v2_work_items SET lifecycle = 'pending', row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ? AND lifecycle = 'draft'
      `,
        )
        .run(occurredAt, context.organizationId, context.ownerUserId, item.id, item.row_version)
      if (changed.changes !== 1) return { workItemId: entry.workItemId, outcome: "version_conflict" as const }
      return { workItemId: entry.workItemId, outcome: "armed" as const, version: item.row_version + 1 }
    })
    return pending("work_item_armed", "workgraph", rootId, { results })
  }
  if (command.type === "retry_work_item") {
    // Pure CAS-guarded `failed -> pending` flip. Approval is preserved by
    // construction (the retry edge never passes through `pending_approval`). The
    // drain re-admits the item once the Stream is active and its hold clears.
    const item = ownedWorkItem(database, context, command.workItemId)
    if (!item) return rejected(request.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Work Item version changed")
    if (item.lifecycle !== "failed") return rejected(request.operationId, "invalid_transition", "Only a failed Work Item can be retried")
    const changed = database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'pending', row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ? AND lifecycle = 'failed'
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, command.workItemId, command.expectedVersion)
    if (changed.changes !== 1) return rejected(request.operationId, "version_conflict", "Work Item version changed")
    return pending("work_item_state_changed", "work_item", command.workItemId, { workItemId: command.workItemId, state: "pending" }, item.stream_id)
  }
  if (command.type === "restart_run") {
    if (context.actor.type !== "user") return rejected(request.operationId, "forbidden", "Only the owner can restart a parked Run")
    const run = database
      .prepare(
        `
      SELECT id, stream_id, work_item_id, lifecycle, row_version FROM wg_v2_runs
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.runId) as
      | { id: string; stream_id: string; work_item_id: string; lifecycle: string; row_version: number }
      | undefined
    if (!run) return rejected(request.operationId, "not_found", "Run not found")
    if (run.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Run version changed")
    if (run.lifecycle !== "parked") return rejected(request.operationId, "invalid_transition", "Only a parked Run can be restarted")
    database
      .prepare(
        `
      UPDATE wg_v2_runs SET lifecycle = 'cancelled', parked_reason = ?, finished_at = ?,
        updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ? AND lifecycle = 'parked'
    `,
      )
      .run(`Restarted: ${command.reason}`, occurredAt, occurredAt, context.organizationId, context.ownerUserId, run.id, run.row_version)
    releaseSqliteRunLeases(database, context, {
      runId: run.id as RunID,
      streamId: run.stream_id as StreamID,
      workItemId: run.work_item_id as WorkItemID,
    })
    database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'pending', updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'active'
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, run.work_item_id)
    return pending("run_state_changed", "run", run.id, { runId: run.id, workItemId: run.work_item_id, state: "cancelled", reason: command.reason }, run.stream_id)
  }
  if (command.type === "cancel_run") {
    const run = database
      .prepare(
        `
      SELECT id, stream_id, work_item_id, lifecycle, row_version FROM wg_v2_runs WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.runId) as
      | { id: string; stream_id: string; work_item_id: string; lifecycle: string; row_version: number }
      | undefined
    if (!run) return rejected(request.operationId, "not_found", "Run not found")
    if (run.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Run version changed")
    if (["result", "failed", "cancelled"].includes(run.lifecycle)) return rejected(request.operationId, "invalid_transition", "Run is already terminal")
    database
      .prepare(
        `
      UPDATE wg_v2_runs SET lifecycle = 'cancelled', parked_reason = ?, finished_at = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(command.reason, occurredAt, occurredAt, context.organizationId, context.ownerUserId, command.runId, command.expectedVersion)
    releaseSqliteRunLeases(database, context, {
      runId: run.id as RunID,
      streamId: run.stream_id as StreamID,
      workItemId: run.work_item_id as WorkItemID,
    })
    database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'failed', updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'active'
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, run.work_item_id)
    return pending("run_cancelled", "run", command.runId, { runId: command.runId }, run.stream_id)
  }
  if (command.type === "reopen_outcome") {
    const outcome = ownedOutcome(database, context, command.outcomeId)
    if (!outcome) return rejected(request.operationId, "not_found", "Outcome not found")
    if (outcome.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Outcome version changed")
    const reopened = reopenOutcome({
      state: outcome.lifecycle as Parameters<typeof reopenOutcome>[0]["state"],
      reopenedAt: occurredAt,
      reopenedBy: context.actor,
      reason: command.reason,
    })
    if (!reopened.ok) return rejected(request.operationId, "invalid_transition", reopened.error.code)
    database
      .prepare(
        `
      UPDATE wg_v2_outcomes SET lifecycle = 'reopened', reopened_at = ?, reopen_reason = ?,
        row_version = row_version + 1, updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(occurredAt, reopened.provenance.reason, occurredAt, context.organizationId, context.ownerUserId, command.outcomeId, command.expectedVersion)
    return pending("outcome_reopened", "outcome", command.outcomeId, { outcomeId: command.outcomeId, reason: reopened.provenance.reason }, outcome.stream_id)
  }
  if (command.type === "close_stream") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    const transition = transitionStream(stream.lifecycle as StreamLifecycleState, "closed")
    if (!transition.ok) return rejected(request.operationId, "invalid_transition", "Invalid stream transition")
    const openChildren = database
      .prepare(
        `
      SELECT id FROM wg_v2_streams
      WHERE organization_id = ? AND owner_user_id = ? AND parent_stream_id = ? AND lifecycle <> 'closed'
      ORDER BY id
    `,
      )
      .all(context.organizationId, context.ownerUserId, stream.id) as Array<{ id: string }>
    if (openChildren.length > 0)
      return rejected(request.operationId, "children_open", `Child Streams must close first: ${openChildren.map((child) => child.id).join(", ")}`, {
        childStreamIds: openChildren.map((child) => child.id),
      })
    const reservation = database
      .prepare(
        `
      SELECT operation_id, expected_version, cleanup_mode FROM wg_v2_stream_cleanup_reservations
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND state = 'reserved'
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.streamId) as { operation_id: string; expected_version: number; cleanup_mode: string } | undefined
    if (reservation && (reservation.operation_id !== request.operationId || reservation.expected_version !== command.expectedVersion || reservation.cleanup_mode !== "close")) {
      return rejected(request.operationId, "version_conflict", "Stream cleanup is owned by another operation")
    }
    database
      .prepare(
        `
      UPDATE wg_v2_runs SET lifecycle = 'cancelled', parked_reason = ?, finished_at = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle IN ('admitted', 'placing', 'running', 'parked')
    `,
      )
      .run(command.reason, occurredAt, occurredAt, context.organizationId, context.ownerUserId, command.streamId)
    database
      .prepare(
        `
      DELETE FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ?
        AND (
          (resource_type = 'work_item'
            AND resource_id IN (SELECT id FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?))
          OR (resource_type = 'stream' AND resource_id = ?)
        )
    `,
      )
      .run(context.organizationId, context.ownerUserId, context.organizationId, context.ownerUserId, command.streamId, command.streamId)
    database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'abandoned', abandoned_reason = ?, abandoned_at = ?, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle NOT IN ('completed', 'abandoned')
    `,
      )
      .run(command.reason, occurredAt, occurredAt, context.organizationId, context.ownerUserId, command.streamId)
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET lifecycle = 'closed', closed_at = ?, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, command.streamId, command.expectedVersion)
    cancelSqliteMasterJobs(database, context, command.streamId, occurredAt)
    return pending("stream_closed", "stream", command.streamId, { streamId: command.streamId, reason: command.reason }, command.streamId)
  }
  if (command.type === "record_run_checkpoint" || command.type === "complete_run") {
    const run = database
      .prepare(
        `
      SELECT id, stream_id, work_item_id, lifecycle, execution_kind, session_id, envelope_id, generation
      FROM wg_v2_runs
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.runId) as
      | {
          id: RunID
          stream_id: StreamID
          work_item_id: WorkItemID
          lifecycle: string
          execution_kind: string
          session_id: string | null
          envelope_id: string | null
          generation: number
        }
      | undefined
    if (!run || run.session_id !== command.sessionId) return rejected(request.operationId, "not_found", "Active Run Session not found")
    if (run.lifecycle !== "running") return rejected(request.operationId, "invalid_transition", "Run is not running")
    if (run.execution_kind === "managed") {
      if (command.generation !== run.generation) return rejected(request.operationId, "version_conflict", "Run lease changed")
      const lease = database
        .prepare(
          `
        SELECT 1 FROM wg_v2_leases
        WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
          AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
      `,
        )
        .get(context.organizationId, context.ownerUserId, run.work_item_id, run.id, run.generation, occurredAt)
      if (!lease) return rejected(request.operationId, "version_conflict", "Run lease is no longer active")
    }
    const activeBinding = database
      .prepare(
        `
      SELECT id, project_id FROM wg_v2_session_bindings
      WHERE organization_id = ? AND owner_user_id = ? AND session_id = ? AND current_run_id = ? AND state = 'active'
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.sessionId, run.id) as { id: string; project_id: string } | undefined
    if (!activeBinding || activeBinding.project_id !== command.workspaceId) return rejected(request.operationId, "invalid_transition", "Run Session is not bound to this workspace")
    const bindingId = activeBinding.id

    if (command.type === "record_run_checkpoint") {
      const evidenceIds = command.evidenceIds ?? []
      const invalidEvidence = evidenceIds.some((id) => {
        const evidence = database
          .prepare(
            `
          SELECT subject_type, subject_id, source_run_id FROM wg_v2_evidence
          WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, id) as { subject_type: string; subject_id: string; source_run_id: string | null } | undefined
        return !evidence || !((evidence.subject_type === "work_item" && evidence.subject_id === run.work_item_id) || evidence.source_run_id === run.id)
      })
      if (invalidEvidence) return rejected(request.operationId, "not_found", "Checkpoint evidence does not belong to the Run")
      const checkpointId = ids.next("agent_checkpoint")
      database
        .prepare(
          `
        INSERT INTO wg_v2_agent_checkpoints
          (organization_id, owner_user_id, id, stream_id, work_item_id, run_id, session_binding_id,
           level, summary, evidence_ids_json, occurred_at, provenance_json, operation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          checkpointId,
          run.stream_id,
          run.work_item_id,
          run.id,
          bindingId,
          command.level,
          command.summary,
          JSON.stringify(evidenceIds),
          occurredAt,
          JSON.stringify({ actor: context.actor, operationId: request.operationId }),
          request.operationId,
          occurredAt,
          occurredAt,
        )
      return pending("agent_checkpoint_recorded", "run", run.id, { runId: run.id, checkpointId }, run.stream_id)
    }

    const hasDurableEvidence = command.evidence.some((input) => input.evidence.kind === "integration" && input.evidence.effect !== "other")
    if (
      hasDurableEvidence &&
      database
        .prepare(
          `
        SELECT 1 FROM wg_v2_stream_cleanup_reservations
        WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND state = 'reserved'
      `,
        )
        .get(context.organizationId, context.ownerUserId, run.stream_id)
    ) {
      return rejected(request.operationId, "blocked", "Stream cleanup has already been reserved")
    }
    const evidenceIds = command.evidence.map((input, index) => {
      const evidenceId = ids.next("evidence")
      const receiptId = input.evidence.kind === "integration" && input.evidence.effect !== "other" ? ids.next("receipt") : undefined
      database
        .prepare(
          `
        INSERT INTO wg_v2_evidence
          (organization_id, owner_user_id, id, stream_id, subject_type, subject_id, requirement_id,
           source_run_id, evidence_kind, summary, reference_json, provenance_json, created_at)
        VALUES (?, ?, ?, ?, 'work_item', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          evidenceId,
          run.stream_id,
          run.work_item_id,
          input.requirementId ?? null,
          run.id,
          input.evidence.kind,
          input.evidence.summary,
          JSON.stringify({ ...input.evidence, ...(receiptId ? { durableEffectReceiptId: receiptId } : {}) }),
          JSON.stringify({ actor: context.actor, operationId: request.operationId, requestId: context.requestId }),
          occurredAt,
        )
      if (receiptId && input.evidence.kind === "integration") {
        database
          .prepare(
            `
          INSERT INTO wg_v2_durable_effect_receipts
            (organization_id, owner_user_id, id, stream_id, run_id, effect_kind, idempotency_key,
             external_reference_json, provenance_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            context.organizationId,
            context.ownerUserId,
            receiptId,
            run.stream_id,
            run.id,
            input.evidence.effect,
            `${request.operationId}:integration:${index}`,
            JSON.stringify({ reference: input.evidence.reference }),
            JSON.stringify({ actor: context.actor, operationId: request.operationId }),
            occurredAt,
          )
      }
      return evidenceId
    })
    database
      .prepare(
        `
      UPDATE wg_v2_runs
      SET lifecycle = 'result', terminal_result_json = ?, parked_reason = NULL, finished_at = ?,
        updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'running'
    `,
      )
      .run(
        JSON.stringify({ summary: command.summary, artifactRefs: command.artifacts ?? [], finishedAt: occurredAt }),
        occurredAt,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        run.id,
      )
    database
      .prepare(
        `
      UPDATE wg_v2_work_items
      SET lifecycle = 'result_ready', updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle NOT IN ('completed', 'abandoned')
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, run.work_item_id)
    if (run.execution_kind === "managed") {
      releaseSqliteRunLeases(database, context, {
        runId: run.id,
        streamId: run.stream_id,
        workItemId: run.work_item_id,
      })
      database
        .prepare(
          `
        UPDATE wg_v2_session_bindings
        SET state = 'released', released_at = ?, updated_at = ?, row_version = row_version + 1
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND state = 'active'
      `,
        )
        .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, bindingId)
    }
    const completion = promoteSatisfiedResultReadyWork(database, context, run.work_item_id, occurredAt)
    const parentTaskId = database
      .prepare("SELECT parent_task_id FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
      .pluck()
      .get(context.organizationId, context.ownerUserId, run.work_item_id) as string | null
    enqueueSqliteMasterWake(database, context, run.stream_id, occurredAt, "task_settled")
    return pending(
      completion.outcomeId ? "outcome_ready_to_close" : "run_completed",
      "run",
      run.id,
      {
        runId: run.id,
        workItemId: run.work_item_id,
        workItemState: completion.completed ? "completed" : "result_ready",
        evidenceIds,
        ...(parentTaskId ? { parentTaskId } : {}),
        ...(completion.outcomeId ? { outcomeId: completion.outcomeId } : {}),
      },
      run.stream_id,
    )
  }
  if (command.type === "record_evidence") {
    const subject = findEvidenceSubject(database, context, command.subject)
    if (!subject) return rejected(request.operationId, "not_found", "Evidence subject not found")
    const evidenceId = ids.next("evidence")
    const durable = command.evidence.kind === "integration" && command.evidence.effect !== "other"
    const durableEffectReceiptId = durable ? ids.next("receipt") : undefined
    if (
      durable &&
      database
        .prepare(
          `
      SELECT 1 FROM wg_v2_stream_cleanup_reservations WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND state = 'reserved'
    `,
        )
        .get(context.organizationId, context.ownerUserId, subject.streamId)
    ) {
      return rejected(request.operationId, "blocked", "Stream cleanup has already been reserved")
    }
    database
      .prepare(
        `
      INSERT INTO wg_v2_evidence
        (organization_id, owner_user_id, id, stream_id, subject_type, subject_id, requirement_id, source_run_id, evidence_kind, summary, reference_json, provenance_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        evidenceId,
        subject.streamId,
        command.subject.type,
        subject.subjectId,
        command.requirementId ?? null,
        command.sourceRunId ?? null,
        command.evidence.kind,
        command.evidence.summary,
        JSON.stringify({ ...command.evidence, ...(durableEffectReceiptId ? { durableEffectReceiptId } : {}) }),
        JSON.stringify({ actor: context.actor, operationId: request.operationId, requestId: context.requestId }),
        occurredAt,
      )
    if (durable && command.evidence.kind === "integration") {
      database
        .prepare(
          `
        INSERT INTO wg_v2_durable_effect_receipts
          (organization_id, owner_user_id, id, stream_id, effect_kind, idempotency_key, external_reference_json, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          durableEffectReceiptId,
          subject.streamId,
          command.evidence.effect,
          `${request.operationId}:integration`,
          JSON.stringify({ reference: command.evidence.reference }),
          JSON.stringify({ actor: context.actor, operationId: request.operationId }),
          occurredAt,
        )
    }
    const completion =
      command.subject.type === "work_item" ? promoteSatisfiedResultReadyWork(database, context, command.subject.workItemId, occurredAt) : { completed: false, outcomeId: undefined }
    if (completion.completed) enqueueSqliteMasterWake(database, context, subject.streamId, occurredAt, "task_settled")
    if (completion.outcomeId)
      return pending(
        "outcome_ready_to_close",
        "outcome",
        completion.outcomeId,
        {
          outcomeId: completion.outcomeId,
          evidenceId,
          workItemState: "completed",
        },
        subject.streamId,
      )
    return pending(
      "evidence_recorded",
      "evidence",
      evidenceId,
      {
        evidenceId,
        ...(durableEffectReceiptId ? { durableEffectReceiptId } : {}),
        ...(completion.completed ? { workItemState: "completed" } : {}),
      },
      subject.streamId,
    )
  }
  if (command.type === "delete_stream") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    const receipts = database
      .prepare(
        `
      SELECT COUNT(*) AS count FROM wg_v2_durable_effect_receipts WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.streamId) as { count: number }
    if (receipts.count > 0) return rejected(request.operationId, "close_required", "Durable effects require close")
    if (stream.row_version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
    const reservation = database
      .prepare(
        `
      SELECT operation_id, expected_version, cleanup_mode FROM wg_v2_stream_cleanup_reservations
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND state = 'reserved'
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.streamId) as { operation_id: string; expected_version: number; cleanup_mode: string } | undefined
    if (reservation && (reservation.operation_id !== request.operationId || reservation.expected_version !== command.expectedVersion || reservation.cleanup_mode !== "delete")) {
      return rejected(request.operationId, "version_conflict", "Stream cleanup is owned by another operation")
    }
    database
      .prepare("DELETE FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?")
      .run(context.organizationId, context.ownerUserId, command.streamId, command.expectedVersion)
    cancelSqliteMasterJobs(database, context, command.streamId, occurredAt)
    return pending("stream_deleted", "stream", command.streamId, { streamId: command.streamId }, command.streamId)
  }
  return rejected(request.operationId, "internal_error", "Unsupported SQLite command")
}

function readSqliteDependencyGraph(database: Database, context: WorkGraphContext, streamId: string) {
  const graph = new Map<string, string[]>(
    (
      database
        .prepare(
          `
      SELECT id FROM wg_v2_work_items
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
    `,
        )
        .all(context.organizationId, context.ownerUserId, streamId) as Array<{ id: string }>
    ).map((row) => [row.id, []]),
  )
  const dependencies = database
    .prepare(
      `
    SELECT dependencies.work_item_id, dependencies.depends_on_work_item_id
    FROM wg_v2_work_item_dependencies dependencies
    JOIN wg_v2_work_items items
      ON items.organization_id = dependencies.organization_id
      AND items.owner_user_id = dependencies.owner_user_id
      AND items.id = dependencies.work_item_id
    WHERE dependencies.organization_id = ? AND dependencies.owner_user_id = ? AND items.stream_id = ?
  `,
    )
    .all(context.organizationId, context.ownerUserId, streamId) as Array<{
    work_item_id: string
    depends_on_work_item_id: string
  }>
  dependencies.forEach((row) => graph.get(row.work_item_id)?.push(row.depends_on_work_item_id))
  return graph
}

function validateSqliteReplacement(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{
    streamId: StreamID
    previousSource?: WorkSourceRevisionRef
    workItems: ReadonlyArray<Readonly<{ workItemId: WorkItemID; expectedVersion: number }>>
  }>,
): Readonly<{ ok: true }> | Readonly<{ ok: false; code: CommandErrorCode; message: string }> {
  if (!input.previousSource) {
    return {
      ok: false,
      code: "invalid_transition",
      message: "Replacement requires an exact previous Work Source revision",
    }
  }
  const review = readSqliteReplacementReview(database, context, input as ReplacementReviewInput)
  if (!review) return { ok: false, code: "not_found", message: "Selected Stream or previous Work Source revision not found" }
  if (review.status === "unavailable") return { ok: false, code: "blocked", message: review.reason }
  if (review.status === "durable") return { ok: false, code: "close_required", message: review.reason }
  if (review.status === "unrelated") return { ok: false, code: "blocked", message: review.reason }
  if (review.status === "empty") return input.workItems.length === 0 ? { ok: true } : { ok: false, code: "version_conflict", message: "Replacement Task set changed after review" }
  const reviewed = [...input.workItems].sort((left, right) => left.workItemId.localeCompare(right.workItemId))
  if (new Set(reviewed.map((item) => item.workItemId)).size !== reviewed.length || reviewed.length !== review.targets.length) {
    return { ok: false, code: "version_conflict", message: "Replacement Task set changed after review" }
  }
  if (review.targets.some((item, index) => item.workItemId !== reviewed[index]?.workItemId || item.expectedVersion !== reviewed[index]?.expectedVersion)) {
    return { ok: false, code: "version_conflict", message: "Replacement Task set changed after review" }
  }
  return { ok: true }
}

function readSqliteReplacementReview(database: Database, context: WorkGraphContext, input: ReplacementReviewInput): ReplacementReview | undefined {
  const stream = ownedStream(database, context, input.streamId)
  const source = database
    .prepare(
      `
    SELECT content_hash FROM wg_v2_work_source_revisions
    WHERE organization_id = ? AND owner_user_id = ? AND work_source_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, input.previousSource.workSourceId, input.previousSource.revisionId) as { content_hash: string } | undefined
  if (!stream || source?.content_hash !== input.previousSource.contentHash) return undefined
  const base = { streamId: input.streamId, streamTitle: stream.title }
  const reset = stream.replacement_reset_json ? (JSON.parse(stream.replacement_reset_json) as { state?: string }) : undefined
  if (reset && reset.state !== "completed") {
    return ReplacementReviewSchema.parse({
      ...base,
      status: "unavailable",
      reason: "Stream replacement cleanup is still pending",
    })
  }
  const receipt = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_durable_effect_receipts WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, input.streamId)
  if (receipt) {
    return ReplacementReviewSchema.parse({ ...base, status: "durable", reason: "Durable effects cannot be replaced" })
  }
  const current = database
    .prepare(
      `
    SELECT items.id, items.title, items.lifecycle, items.row_version,
      EXISTS (
        SELECT 1 FROM wg_v2_record_source_revisions refs
        WHERE refs.organization_id = items.organization_id AND refs.owner_user_id = items.owner_user_id AND refs.record_type = 'work_item' AND refs.record_id = items.id
          AND refs.work_source_id = ? AND refs.source_revision_id = ?
      ) AS linked_to_previous_source
    FROM wg_v2_work_items items
    WHERE items.organization_id = ? AND items.owner_user_id = ? AND items.stream_id = ? AND items.lifecycle NOT IN ('completed', 'abandoned')
    ORDER BY items.id
  `,
    )
    .all(input.previousSource.workSourceId, input.previousSource.revisionId, context.organizationId, context.ownerUserId, input.streamId) as Array<{
    id: WorkItemID
    title: string
    lifecycle: string
    row_version: number
    linked_to_previous_source: number
  }>
  if (current.some((item) => !item.linked_to_previous_source)) {
    return ReplacementReviewSchema.parse({
      ...base,
      status: "unrelated",
      reason: "Stream contains unrelated nonterminal work; keep or fork instead",
    })
  }
  if (current.length === 0) {
    return ReplacementReviewSchema.parse({
      ...base,
      status: "empty",
      reason: "No source-linked Tasks remain to replace",
    })
  }
  return ReplacementReviewSchema.parse({
    ...base,
    status: "eligible",
    targets: current.map((item) => ({
      workItemId: item.id,
      expectedVersion: item.row_version,
      title: item.title,
      state: item.lifecycle,
    })),
  })
}

function createQueries(database: Database, clock: Readonly<{ now: () => number }>) {
  const activity = createSqliteWorkGraphActivityPorts({ database, clock }).activity
  return {
    snapshot: {
      page: async (context: WorkGraphContext, input: Readonly<{ after?: SnapshotResumeCursor; limit: number }>): Promise<WorkGraphSnapshotPage> => {
        const cursor = database
          .prepare("SELECT next_cursor - 1 AS cursor FROM wg_v2_change_cursors WHERE organization_id = ? AND owner_user_id = ?")
          .get(context.organizationId, context.ownerUserId) as { cursor: number } | undefined
        const currentSnapshotCursor = createChangeCursor({
          organizationId: context.organizationId,
          ownerUserId: context.ownerUserId,
          position: cursor?.cursor ?? 0,
        })
        const resume = input.after ? decodeSnapshotResumeCursor(input.after, context.organizationId, context.ownerUserId) : { offset: 0, capturedAt: clock.now() }
        if ("snapshotCursor" in resume && resume.snapshotCursor !== currentSnapshotCursor) {
          const relevant = database
            .prepare(
              `
            SELECT 1 FROM wg_v2_changes
            WHERE organization_id = ? AND owner_user_id = ? AND snapshot_relevant = 1 AND cursor > ? LIMIT 1
          `,
            )
            .get(context.organizationId, context.ownerUserId, readChangeCursor(resume.snapshotCursor, context.organizationId, context.ownerUserId))
          if (relevant) throw new SnapshotResumeCursorError("invalidated")
        }
        const snapshotCursor = "snapshotCursor" in resume ? resume.snapshotCursor : currentSnapshotCursor
        const records = [
          readWorkGraphDefaultsRecord(database, context),
          ...readStreamRecords(database, context),
          ...readOutcomeRecords(database, context),
          ...readWorkItemRecords(database, context),
          ...readRunRecords(database, context),
          ...readDecisionRecords(database, context),
          ...readAdmissionRecords(database, context),
        ].sort(compareSnapshotCursorPosition)
        const offset = resume.offset
        const page = records.slice(offset, offset + input.limit)
        return {
          snapshotCursor,
          records: page,
          references: page.map((record, index) => ({
            sequence: offset + index + 1,
            resource: recordReference(record),
            version: record.version,
          })),
          hasMore: offset + page.length < records.length,
          ...(offset + page.length < records.length
            ? {
                nextCursor: createSnapshotResumeCursor({
                  organizationId: context.organizationId,
                  ownerUserId: context.ownerUserId,
                  snapshotCursor,
                  offset: offset + page.length,
                  capturedAt: resume.capturedAt,
                  position: page.at(-1)!,
                }),
              }
            : {}),
          capturedAt: resume.capturedAt,
        }
      },
    },
    defaults: {
      read: async (context: WorkGraphContext): Promise<WorkGraphDefaultsDto> => readWorkGraphDefaultsRecord(database, context),
    },
    streams: {
      read: async (context: WorkGraphContext, input: Readonly<{ streamId: StreamID }>): Promise<StreamDto | undefined> => {
        const stream = readStreamRecords(database, context, input.streamId)[0]
        if (!stream) return undefined
        return withLegacyStreamState(stream)
      },
    },
    proposals: {
      read: async (context: WorkGraphContext, input: Readonly<{ proposalId: string }>) => readAdmissionRecords(database, context, input.proposalId)[0],
      replacementReview: async (context: WorkGraphContext, input: ReplacementReviewInput) => readSqliteReplacementReview(database, context, input),
    },
    runs: {
      read: async (context: WorkGraphContext, input: Readonly<{ runId: string }>) => {
        const row = database
          .prepare(
            `
          SELECT * FROM wg_v2_runs WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.runId) as RunRecordRow | undefined
        return row ? runDetailDto(database, context, row) : undefined
      },
    },
    decisions: {
      read: async (context: WorkGraphContext, input: Readonly<{ decisionId: string }>) => readDecisionRecords(database, context, input.decisionId)[0],
    },
    sources: {
      list: async (context: WorkGraphContext, input: Readonly<{ after?: WorkSourcePageCursor; limit: number }>) => {
        const resume = input.after ? readWorkSourcePageCursor(input.after, context.organizationId, context.ownerUserId) : undefined
        const rows = database
          .prepare(
            `
          SELECT * FROM wg_v2_work_sources
          WHERE organization_id = ? AND owner_user_id = ?
            AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
          ORDER BY created_at, id LIMIT ?
        `,
          )
          .all(
            context.organizationId,
            context.ownerUserId,
            resume?.createdAt ?? null,
            resume?.createdAt ?? null,
            resume?.createdAt ?? null,
            resume?.sourceId ?? null,
            input.limit + 1,
          ) as WorkSourceRecordRow[]
        const page = rows.slice(0, input.limit).map((row) => workSourceDto(database, context, row))
        const hasMore = rows.length > input.limit
        return {
          sources: page,
          hasMore,
          ...(hasMore
            ? {
                nextCursor: createWorkSourcePageCursor({
                  organizationId: context.organizationId,
                  ownerUserId: context.ownerUserId,
                  createdAt: page.at(-1)!.createdAt,
                  sourceId: page.at(-1)!.id,
                }),
              }
            : {}),
        }
      },
      read: async (context: WorkGraphContext, input: Readonly<{ workSourceId: WorkSourceID }>) => {
        const row = database
          .prepare(
            `
          SELECT * FROM wg_v2_work_sources WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.workSourceId) as WorkSourceRecordRow | undefined
        return row ? workSourceDto(database, context, row) : undefined
      },
      readRevision: async (context: WorkGraphContext, input: Readonly<{ workSourceId: string; revisionId: string }>) => {
        const revision = database
          .prepare(
            `
          SELECT work_source_id, id, revision_number, content, content_hash, origin_kind, origin_reference_json, created_at
          FROM wg_v2_work_source_revisions
          WHERE organization_id = ? AND owner_user_id = ? AND work_source_id = ? AND id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.workSourceId, input.revisionId) as WorkSourceRevisionRecordRow | undefined
        if (!revision) return undefined
        return WorkSourceRevisionDtoSchema.parse({
          id: revision.id,
          workSourceId: revision.work_source_id,
          revisionNumber: revision.revision_number,
          content: revision.content,
          contentHash: revision.content_hash,
          origin:
            revision.origin_kind === "manual"
              ? WorkSourceOriginSchema.parse({
                  kind: "manual",
                  ...(revision.origin_reference_json ? JSON.parse(revision.origin_reference_json) : {}),
                })
              : revision.origin_kind === "authoring"
                ? {
                    kind: "authoring",
                    ...AuthoringSourceRevisionSchema.parse(JSON.parse(requiredOriginReference(revision.origin_reference_json, "authoring"))),
                  }
                : {
                    kind: "external",
                    ...JSON.parse(requiredOriginReference(revision.origin_reference_json, "external")),
                  },
          createdAt: Number(revision.created_at),
          createdBy: recordProvenance(database, context, "work_source", revision.work_source_id).actor,
        })
      },
    },
    evidence: {
      read: async (context: WorkGraphContext, input: EvidenceReadInput) => {
        const row = database
          .prepare(
            `
          SELECT id, subject_type, subject_id, requirement_id, source_run_id, reference_json, provenance_json, created_at
          FROM wg_v2_evidence WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.evidenceId) as StoredEvidenceRow | undefined
        if (!row) return undefined
        return canonicalEvidenceDto(database, context, evidenceSubject(row.subject_type, row.subject_id), row)
      },
      list: async (context: WorkGraphContext, input: EvidenceListInput) => {
        const resume = input.after ? readEvidencePageCursor(input.after, context.organizationId, context.ownerUserId, input.subject) : undefined
        const rows = database
          .prepare(
            `
          SELECT id, subject_type, subject_id, requirement_id, source_run_id, reference_json, provenance_json, created_at
          FROM wg_v2_evidence
          WHERE organization_id = ? AND owner_user_id = ? AND subject_type = ? AND subject_id = ?
            AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
          ORDER BY created_at, id LIMIT ?
        `,
          )
          .all(
            context.organizationId,
            context.ownerUserId,
            input.subject.type,
            evidenceSubjectId(input.subject),
            resume?.recordedAt ?? null,
            resume?.recordedAt ?? null,
            resume?.recordedAt ?? null,
            resume?.evidenceId ?? null,
            input.limit + 1,
          ) as StoredEvidenceRow[]
        const page = rows.slice(0, input.limit)
        const hasMore = rows.length > input.limit
        return EvidencePageSchema.parse({
          evidence: page.map((row) => canonicalEvidenceDto(database, context, input.subject, row)),
          hasMore,
          ...(hasMore
            ? {
                nextCursor: createEvidencePageCursor({
                  organizationId: context.organizationId,
                  ownerUserId: context.ownerUserId,
                  subject: input.subject,
                  recordedAt: Number(page.at(-1)!.created_at),
                  evidenceId: page.at(-1)!.id,
                }),
              }
            : {}),
        })
      },
    },
    attention: {
      list: async (context: WorkGraphContext, input: AttentionListInput) => {
        const resume = input.after ? readAttentionCursor(input.after, context.organizationId, context.ownerUserId) : undefined
        const acknowledgement = database
          .prepare(
            `
          SELECT read_through_at, cleared_through_at FROM wg_v2_attention_acknowledgements
          WHERE organization_id = ? AND owner_user_id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId) as { read_through_at: number; cleared_through_at: number | null } | undefined
        const parameters = {
          organization: context.organizationId,
          owner: context.ownerUserId,
          cleared_at: acknowledgement?.cleared_through_at ?? null,
          after_at: resume?.updatedAt ?? null,
          after_kind: resume?.kind ?? null,
          after_id: resume?.id ?? null,
          limit: input.limit + 1,
        }
        const rows = database
          .prepare(
            `
          SELECT kind, id, updated_at, job_type, subject_id, stream_id, last_error, payload_json FROM (${sqliteAttentionRows})
          WHERE (@cleared_at IS NULL OR updated_at > @cleared_at)
            AND (@after_at IS NULL OR updated_at < @after_at
              OR (updated_at = @after_at AND (kind > @after_kind OR (kind = @after_kind AND id > @after_id))))
          ORDER BY updated_at DESC, kind, id LIMIT @limit
        `,
          )
          .all(parameters) as AttentionRow[]
        const total = database.prepare(`SELECT COUNT(*) AS count FROM (${sqliteAttentionRows}) WHERE @cleared_at IS NULL OR updated_at > @cleared_at`).get({
          organization: context.organizationId,
          owner: context.ownerUserId,
          cleared_at: acknowledgement?.cleared_through_at ?? null,
        }) as { count: number }
        const page = rows.slice(0, input.limit).map((row) => sqliteAttentionItem(database, context, row, acknowledgement?.read_through_at))
        const hasMore = rows.length > input.limit
        return AttentionPageSchema.parse({
          items: page,
          total: total.count,
          hasMore,
          ...(hasMore ? { nextCursor: createAttentionCursor(context.organizationId, context.ownerUserId, page.at(-1)!) } : {}),
        })
      },
    },
    changes: {
      list: async (context: WorkGraphContext, input: Readonly<{ after?: ChangeCursor; deliveredEventIds?: readonly string[]; limit?: number }>) =>
        readChanges(database, context, input).slice(0, input.limit ?? Number.MAX_SAFE_INTEGER),
      listStream: async (context: WorkGraphContext, input: Readonly<{ streamId: StreamID; after?: ChangeCursor }>) => readChanges(database, context, input),
    },
    workItems: {
      readDetail: async (context: WorkGraphContext, input: Readonly<{ workItemId: string }>) => readWorkItemRecords(database, context, input.workItemId)[0],
      listRuns: async (context: WorkGraphContext, input: WorkItemRunListInput) => {
        const resume = input.after ? readWorkItemRunPageCursor(input.after, context.organizationId, context.ownerUserId, input.workItemId) : undefined
        const rows = database
          .prepare(
            `
          SELECT * FROM wg_v2_runs
          WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?
            AND (? IS NULL OR run_number > ? OR (run_number = ? AND id > ?))
          ORDER BY run_number, id LIMIT ?
        `,
          )
          .all(
            context.organizationId,
            context.ownerUserId,
            input.workItemId,
            resume?.runNumber ?? null,
            resume?.runNumber ?? null,
            resume?.runNumber ?? null,
            resume?.runId ?? null,
            input.limit + 1,
          ) as RunRecordRow[]
        const page = rows.slice(0, input.limit)
        const hasMore = rows.length > input.limit
        return WorkItemRunPageSchema.parse({
          runs: page.map((row) => runDetailDto(database, context, row)),
          hasMore,
          ...(hasMore
            ? {
                nextCursor: createWorkItemRunPageCursor({
                  organizationId: context.organizationId,
                  ownerUserId: context.ownerUserId,
                  workItemId: input.workItemId,
                  runNumber: page.at(-1)!.run_number,
                  runId: page.at(-1)!.id,
                }),
              }
            : {}),
        })
      },
      listActivity: (context: WorkGraphContext, input: TaskActivityListInput) => activity.list(context, input),
      read: async (context: WorkGraphContext, input: Readonly<{ workItemId: string }>) => {
        const item = database
          .prepare(
            `
          SELECT id, completion_contract_json FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.workItemId) as WorkItemRow | undefined
        if (!item) return undefined
        const evidence = database
          .prepare(
            `
          SELECT id, requirement_id, source_run_id, reference_json, provenance_json, created_at FROM wg_v2_evidence
          WHERE organization_id = ? AND owner_user_id = ? AND subject_type = 'work_item' AND subject_id = ? ORDER BY created_at, id
        `,
          )
          .all(context.organizationId, context.ownerUserId, input.workItemId) as EvidenceRow[]
        return {
          id: item.id,
          completionSatisfied: evaluateCompletionContract(
            JSON.parse(item.completion_contract_json) as CompletionContract,
            { type: "work_item", workItemId: input.workItemId as WorkItemID },
            evidence.map((row) => evidenceDto({ type: "work_item", workItemId: input.workItemId as WorkItemID }, row)),
          ).satisfied,
        }
      },
    },
  }
}

/** Internal semantic projection reused by the portable archive adapter. */
export function readSqliteWorkGraphPublicRecords(databaseInput: SqliteInput, context: WorkGraphContext) {
  const database = initializeWorkGraphSqliteSchema(databaseInput).raw()
  if (!database) throw new Error("SQLite public record projection requires direct database access")
  const root = database
    .prepare("SELECT 1 AS present FROM wg_v2_workgraphs WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
    .get(context.organizationId, context.ownerUserId, rootId)
  if (!root) return []
  return [
    readWorkGraphDefaultsRecord(database, context),
    ...readStreamRecords(database, context),
    ...readOutcomeRecords(database, context),
    ...readWorkItemRecords(database, context),
    ...readRunRecords(database, context),
    ...readDecisionRecords(database, context),
    ...readAdmissionRecords(database, context),
  ] satisfies WorkGraphPublicRecord[]
}

function workSourceDto(database: Database, context: WorkGraphContext, row: WorkSourceRecordRow) {
  const latest = database
    .prepare(
      `
    SELECT id FROM wg_v2_work_source_revisions
    WHERE organization_id = ? AND owner_user_id = ? AND work_source_id = ? AND revision_number = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, row.id, row.latest_revision_number) as { id: WorkSourceRevisionID } | undefined
  if (!latest) throw new Error(`Work Source ${row.id} has no latest revision`)
  return WorkSourceDtoSchema.parse({
    id: row.id,
    ownerUserId: context.ownerUserId,
    title: row.title,
    latestRevisionId: latest.id,
    revisionCount: row.latest_revision_number,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  })
}

function readChanges(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{ after?: ChangeCursor; deliveredEventIds?: readonly string[]; streamId?: StreamID }>,
): ChangeEnvelope[] {
  const scope = input.streamId ? { type: "stream" as const, streamId: input.streamId } : { type: "all" as const }
  const position = input.after ? readChangeCursor(input.after, context.organizationId, context.ownerUserId, scope) : 0
  const rows = database
    .prepare(
      `
    SELECT changes.cursor, changes.id AS change_id, changes.stream_id, changes.operation_id,
      changes.resource_type, changes.resource_id, changes.change_type, changes.payload_json, changes.created_at,
      events.id AS event_id, events.stream_id AS event_stream_id, events.sequence, events.schema_version,
      events.actor_type, events.actor_id, events.request_id,
      events.correlation_id, events.causation_id, events.occurred_at
    FROM wg_v2_changes changes
    JOIN wg_v2_events events ON events.organization_id = changes.organization_id AND events.owner_user_id = changes.owner_user_id AND events.operation_id = changes.operation_id
    WHERE changes.organization_id = ? AND changes.owner_user_id = ?
      AND (
        (? IS NULL AND changes.cursor > ?)
        OR (? IS NOT NULL AND changes.stream_id = ? AND events.sequence > ?)
      )
    ORDER BY CASE WHEN ? IS NULL THEN changes.cursor ELSE events.sequence END
  `,
    )
    .all(
      context.organizationId,
      context.ownerUserId,
      input.streamId ?? null,
      position,
      input.streamId ?? null,
      input.streamId ?? null,
      position,
      input.streamId ?? null,
    ) as ChangeRow[]
  const delivered = new Set(input.deliveredEventIds ?? [])
  return rows
    .filter((row) => !delivered.has(row.event_id))
    .map((row) =>
      withLegacyChange(
        ChangeEnvelopeSchema.parse({
          cursor: createChangeCursor({
            organizationId: context.organizationId,
            ownerUserId: context.ownerUserId,
            scope,
            position: input.streamId ? Number(row.sequence) : Number(row.cursor),
          }),
          ownerUserId: context.ownerUserId,
          resource: { type: row.resource_type, id: row.resource_id },
          event: {
            schemaVersion: 1 as const,
            id: row.event_id,
            ownerUserId: context.ownerUserId,
            ...(row.event_stream_id ? { streamId: row.event_stream_id as StreamID } : {}),
            sequence: row.sequence,
            type: row.change_type,
            payload: JSON.parse(row.payload_json),
            provenance: {
              actor: { type: row.actor_type, id: row.actor_id },
              operationId: row.operation_id,
              requestId: row.request_id,
            },
            occurredAt: Number(row.occurred_at),
          },
        }),
      ),
    )
}

function readStreamRecords(database: Database, context: WorkGraphContext, streamId?: string) {
  const parameters = streamId ? [context.organizationId, context.ownerUserId, streamId] : [context.organizationId, context.ownerUserId]
  const rows = database
    .prepare(
      `
    SELECT * FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? ${streamId ? "AND id = ?" : ""} ORDER BY created_at, id
  `,
    )
    .all(...parameters) as StreamRecordRow[]
  const durableEffects = new Map(
    (
      database
        .prepare(
          `
      SELECT stream_id, COUNT(*) AS count FROM wg_v2_durable_effect_receipts
      WHERE organization_id = ? AND owner_user_id = ? ${streamId ? "AND stream_id = ?" : ""}
      GROUP BY stream_id
    `,
        )
        .all(...parameters) as Array<{ stream_id: string; count: number }>
    ).map((row) => [row.stream_id, row.count]),
  )
  const provenance = new Map<string, ReturnType<typeof recordProvenance>>()
  const provenanceRows = database
    .prepare(
      `
    SELECT changes.resource_id, events.actor_type, events.actor_id, events.operation_id
    FROM wg_v2_changes changes
    JOIN wg_v2_events events
      ON events.organization_id = changes.organization_id
      AND events.owner_user_id = changes.owner_user_id
      AND events.operation_id = changes.operation_id
    WHERE changes.organization_id = ? AND changes.owner_user_id = ?
      AND changes.resource_type = 'stream' ${streamId ? "AND changes.resource_id = ?" : ""}
    ORDER BY changes.cursor DESC
  `,
    )
    .all(...parameters) as Array<{
    resource_id: string
    actor_type: "user" | "agent" | "system"
    actor_id: string
    operation_id: OperationID
  }>
  provenanceRows.forEach((row) => {
    if (provenance.has(row.resource_id)) return
    provenance.set(row.resource_id, {
      actor: { type: row.actor_type, id: row.actor_id },
      operationId: row.operation_id,
    })
  })
  const sourceRefs = new Map<string, WorkSourceRevisionRef[]>()
  const sourceRefRows = database
    .prepare(
      `
    SELECT refs.record_id, refs.work_source_id, refs.source_revision_id, revisions.content_hash
    FROM wg_v2_record_source_revisions refs
    JOIN wg_v2_work_source_revisions revisions
      ON revisions.organization_id = refs.organization_id
      AND revisions.owner_user_id = refs.owner_user_id
      AND revisions.work_source_id = refs.work_source_id
      AND revisions.id = refs.source_revision_id
    WHERE refs.organization_id = ? AND refs.owner_user_id = ?
      AND refs.record_type = 'stream' ${streamId ? "AND refs.record_id = ?" : ""}
    ORDER BY refs.record_id, refs.ordinal
  `,
    )
    .all(...parameters) as Array<{
    record_id: string
    work_source_id: string
    source_revision_id: string
    content_hash: string
  }>
  sourceRefRows.forEach((row) => {
    const refs = sourceRefs.get(row.record_id) ?? []
    refs.push({
      workSourceId: row.work_source_id as WorkSourceRevisionRef["workSourceId"],
      revisionId: row.source_revision_id as WorkSourceRevisionRef["revisionId"],
      contentHash: row.content_hash as WorkSourceRevisionRef["contentHash"],
    })
    sourceRefs.set(row.record_id, refs)
  })
  return rows.map((row) => {
    const activityAt = Number(row.last_activity_at ?? row.updated_at)
    return StreamDtoSchema.parse({
      recordType: "stream",
      schemaVersion: 1,
      ownerUserId: context.ownerUserId,
      version: row.row_version,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      provenance: provenance.get(row.id) ?? { actor: { type: "user", id: context.ownerUserId } },
      id: row.id,
      ...(row.parent_stream_id ? { parentStreamId: row.parent_stream_id } : {}),
      title: row.title,
      description: row.purpose,
      ...(row.charter_json ? { charter: JSON.parse(row.charter_json) } : {}),
      ...(row.master_status_json ? { masterStatus: JSON.parse(row.master_status_json) } : {}),
      ...(row.notes_source_json ? { notesSource: JSON.parse(row.notes_source_json) } : {}),
      ...(row.public_pr_confirmed_at === null ? {} : { publicPrConfirmedAt: Number(row.public_pr_confirmed_at) }),
      lifecycleState: row.lifecycle,
      visibility: row.visibility,
      pinned: !!row.pinned,
      executionDefaults: JSON.parse(row.execution_defaults_json),
      ...(row.spend_json ? { spend: JSON.parse(row.spend_json) } : {}),
      activityGranularity: row.activity_granularity,
      activity: { lastActivityAt: activityAt },
      ...(row.replacement_reset_json ? { replacementReset: JSON.parse(row.replacement_reset_json) } : {}),
      durableEffectCount: durableEffects.get(row.id) ?? 0,
      sourceRevisionRefs: sourceRefs.get(row.id) ?? [],
    })
  })
}

function readWorkGraphDefaultsRecord(database: Database, context: WorkGraphContext): WorkGraphDefaultsDto {
  const row = database
    .prepare(
      `
    SELECT defaults_json, row_version, created_at, updated_at
    FROM wg_v2_workgraphs WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, rootId) as
    | {
        defaults_json: string
        row_version: number
        created_at: string | number
        updated_at: string | number
      }
    | undefined
  return WorkGraphDefaultsDtoSchema.parse({
    recordType: "workgraph",
    schemaVersion: 1,
    ownerUserId: context.ownerUserId,
    version: row?.row_version ?? 1,
    createdAt: Number(row?.created_at ?? 0),
    updatedAt: Number(row?.updated_at ?? 0),
    provenance: row ? recordProvenance(database, context, "workgraph", rootId) : { actor: { type: "system", id: "workgraph_defaults" } },
    id: rootId,
    defaults: { execution: JSON.parse(row?.defaults_json ?? "{}") },
  })
}

function readOutcomeRecords(database: Database, context: WorkGraphContext) {
  const rows = database
    .prepare("SELECT * FROM wg_v2_outcomes WHERE organization_id = ? AND owner_user_id = ? ORDER BY created_at, id")
    .all(context.organizationId, context.ownerUserId) as OutcomeRecordRow[]
  return rows.map((row) =>
    OutcomeDtoSchema.parse({
      recordType: "outcome",
      schemaVersion: 1,
      ownerUserId: context.ownerUserId,
      version: row.row_version,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      provenance: recordProvenance(database, context, "outcome", row.id),
      id: row.id,
      streamId: row.stream_id,
      title: row.title,
      description: row.description,
      state: row.lifecycle,
      successCriteria: JSON.parse(row.success_criteria_json),
      evidenceIds: readEvidenceIds(database, context, "outcome", row.id),
      executionDefaults: JSON.parse(row.execution_defaults_json),
      sourceRevisionRefs: readSourceRefs(database, context, "outcome", row.id),
      ...(row.completed_at ? { closedAt: Number(row.completed_at) } : {}),
      ...(row.closed_by_json ? { closedBy: JSON.parse(row.closed_by_json) } : {}),
      ...(row.close_reason ? { closeReason: row.close_reason } : {}),
      ...(row.reopened_at ? { reopenedAt: Number(row.reopened_at) } : {}),
      ...(row.reopen_reason ? { reopenReason: row.reopen_reason } : {}),
    }),
  )
}

function readWorkItemRecords(database: Database, context: WorkGraphContext, workItemId?: string) {
  const rows = database
    .prepare(`SELECT * FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? ${workItemId ? "AND id = ?" : ""} ORDER BY created_at, id`)
    .all(...(workItemId ? [context.organizationId, context.ownerUserId, workItemId] : [context.organizationId, context.ownerUserId])) as WorkItemRecordRow[]
  return rows.map((row) =>
    WorkItemDtoSchema.parse({
      recordType: "work_item",
      schemaVersion: 1,
      ownerUserId: context.ownerUserId,
      version: row.row_version,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      provenance: recordProvenance(database, context, "work_item", row.id),
      id: row.id,
      streamId: row.stream_id,
      ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
      ...(row.outcome_id ? { outcomeId: row.outcome_id } : {}),
      title: row.title,
      description: row.description,
      state: row.lifecycle,
      priority: row.priority,
      dependencyIds: (
        database
          .prepare(
            `
      SELECT depends_on_work_item_id FROM wg_v2_work_item_dependencies
      WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ? ORDER BY created_at, id
    `,
          )
          .all(context.organizationId, context.ownerUserId, row.id) as Array<{ depends_on_work_item_id: string }>
      ).map((dependency) => dependency.depends_on_work_item_id),
      sourceRevisionRefs: readSourceRefs(database, context, "work_item", row.id),
      completionContract: JSON.parse(row.completion_contract_json),
      evidenceIds: readEvidenceIds(database, context, "work_item", row.id),
      executionDefaults: JSON.parse(row.execution_overrides_json),
      ...(row.created_by_actor_type ? { createdByActorType: row.created_by_actor_type } : {}),
      ...(row.created_by_actor_id ? { createdByActorId: row.created_by_actor_id } : {}),
      ...(row.origin_run_id ? { originRunId: row.origin_run_id } : {}),
      ...(row.auto_admitted === 1 ? { autoAdmitted: true } : {}),
      ...(row.lifecycle === "abandoned" ? { abandonedAt: Number(row.abandoned_at), abandonReason: row.abandoned_reason } : {}),
    }),
  )
}

function readRunRecords(database: Database, context: WorkGraphContext, runId?: string) {
  const rows = database
    .prepare(`SELECT * FROM wg_v2_runs WHERE organization_id = ? AND owner_user_id = ? ${runId ? "AND id = ?" : ""} ORDER BY created_at, id`)
    .all(...(runId ? [context.organizationId, context.ownerUserId, runId] : [context.organizationId, context.ownerUserId])) as RunRecordRow[]
  return rows.map((row) => runDto(database, context, row))
}

function runDto(database: Database, context: WorkGraphContext, row: RunRecordRow) {
  const executionReferences = runExecutionReferences(database, context, row)
  return RunDtoSchema.parse({
    recordType: "run",
    schemaVersion: 1,
    ownerUserId: context.ownerUserId,
    version: row.row_version,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    provenance: recordProvenance(database, context, "run", row.id),
    id: row.id,
    streamId: row.stream_id,
    workItemId: row.work_item_id,
    runNumber: row.run_number,
    generation: row.generation,
    state: row.lifecycle,
    executionKind: row.execution_kind,
    resolvedExecution: JSON.parse(row.resolved_execution_profile_json),
    admittedAt: Number(row.created_at),
    ...(row.started_at ? { startedAt: Number(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: Number(row.finished_at) } : {}),
    ...(row.terminal_result_json ? { result: JSON.parse(row.terminal_result_json) } : {}),
    ...(row.parked_reason ? { parkedReason: row.parked_reason } : {}),
    resumeAttempts: row.resume_attempts,
    ...(row.completion_retry_json ? { completionRetry: JSON.parse(row.completion_retry_json) } : {}),
    sourceRevisionRefs: readSourceRefs(database, context, "run", row.id),
    ...(Object.keys(executionReferences).length ? { executionReferences } : {}),
  })
}

function runDetailDto(database: Database, context: WorkGraphContext, row: RunRecordRow) {
  const executionReferences = runExecutionReferences(database, context, row)
  return RunDetailDtoSchema.parse({
    run: runDto(database, context, row),
    ...(Object.keys(executionReferences).length ? { executionReferences } : {}),
  })
}

function runExecutionReferences(database: Database, context: WorkGraphContext, row: RunRecordRow) {
  const binding = row.session_id
    ? (database
        .prepare(
          `SELECT project_id FROM wg_v2_session_bindings
       WHERE organization_id = ? AND owner_user_id = ? AND session_id = ? AND current_run_id = ?
       ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(context.organizationId, context.ownerUserId, row.session_id, row.id) as { project_id: string } | undefined)
    : undefined
  const workspaceId = binding?.project_id ?? row.envelope_id ?? undefined
  return {
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(row.child_workspace_id ? { childWorkspaceId: row.child_workspace_id } : {}),
  }
}

function readDecisionRecords(database: Database, context: WorkGraphContext, decisionId?: string) {
  const rows = database
    .prepare(`SELECT * FROM wg_v2_decisions WHERE organization_id = ? AND owner_user_id = ? ${decisionId ? "AND id = ?" : ""} ORDER BY created_at, id`)
    .all(...(decisionId ? [context.organizationId, context.ownerUserId, decisionId] : [context.organizationId, context.ownerUserId])) as DecisionRecordRow[]
  return rows.map((row) => {
    const recommendation = row.recommendation_json ? (JSON.parse(row.recommendation_json) as { optionId: string }) : undefined
    const answer = row.answer_json ? (JSON.parse(row.answer_json) as { optionId?: string; answer?: string; dismissReason?: string }) : undefined
    return DecisionDtoSchema.parse({
      recordType: "decision",
      schemaVersion: 1,
      ownerUserId: context.ownerUserId,
      version: row.row_version,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      provenance: recordProvenance(database, context, "decision", row.id),
      id: row.id,
      streamId: row.stream_id,
      state: row.lifecycle,
      question: row.question,
      options: JSON.parse(row.options_json),
      ...(recommendation ? { recommendationOptionId: recommendation.optionId } : {}),
      ...(row.rationale ? { rationale: row.rationale } : {}),
      affectedWorkItemIds: (
        database
          .prepare(
            `
        SELECT work_item_id FROM wg_v2_decision_work_items WHERE organization_id = ? AND owner_user_id = ? AND decision_id = ? ORDER BY created_at, id
      `,
          )
          .all(context.organizationId, context.ownerUserId, row.id) as Array<{ work_item_id: string }>
      ).map((item) => item.work_item_id),
      sourceRevisionRefs: readSourceRefs(database, context, "decision", row.id),
      ...(row.lifecycle === "answered" && answer
        ? {
            answer: { ...answer, answeredAt: Number(row.answered_at), answeredBy: JSON.parse(row.answered_by_json!) },
          }
        : {}),
      ...(row.lifecycle === "dismissed" ? { dismissedAt: Number(row.answered_at), dismissReason: answer?.dismissReason } : {}),
    })
  })
}

function readAdmissionRecords(database: Database, context: WorkGraphContext, proposalId?: string) {
  const rows = database
    .prepare(
      `
    SELECT proposals.*, sources.title AS source_title
    FROM wg_v2_admission_proposals proposals
    JOIN wg_v2_work_source_revisions revisions
      ON revisions.organization_id = proposals.organization_id AND revisions.owner_user_id = proposals.owner_user_id AND revisions.id = proposals.source_revision_id
    JOIN wg_v2_work_sources sources
      ON sources.organization_id = revisions.organization_id AND sources.owner_user_id = revisions.owner_user_id AND sources.id = revisions.work_source_id
    WHERE proposals.organization_id = ? AND proposals.owner_user_id = ? ${proposalId ? "AND proposals.id = ?" : ""}
    ORDER BY proposals.created_at, proposals.id
  `,
    )
    .all(...(proposalId ? [context.organizationId, context.ownerUserId, proposalId] : [context.organizationId, context.ownerUserId])) as AdmissionRecordRow[]
  return rows.map((row) => {
    const proposed = JSON.parse(row.proposed_work_json) as {
      source: WorkSourceRevisionRef
      previousSource?: WorkSourceRevisionRef
      diffSummary?: string
      planningEvidence?: unknown
      targetStreamId?: string
      suggestedPlacement?: { mode: "new_stream"; streamTitle: string } | { mode: "existing"; streamId: string }
      outcomes?: Array<{
        proposalKey: string
        title: string
        description?: string
        successCriteria: string[]
        execution?: unknown
      }>
      workItems?: Array<{
        proposalKey: string
        outcomeProposalKey?: string
        title: string
        description?: string
        dependencyProposalKeys?: string[]
        completionContract: unknown
        execution?: unknown
      }>
      generation?:
        | { method: "planning"; tryNumber: number; queuedAt: number; startedAt?: number }
        | {
            method: "planning_failed"
            tryNumber: number
            reason: string
            failedAt?: number
            invalidatedAt?: number
            retryable: boolean
          }
        | { method: "agent_session"; sessionId: string; generatedAt: number }
      placementMatches?: Array<{
        streamId: string
        confidence: "high" | "medium" | "low"
        score: number
        reason: string
        evidence: string[]
      }>
      duplicateMatches?: Array<{
        subject: { type: "outcome"; outcomeId: string } | { type: "work_item"; workItemId: string }
        streamId: string
        title: string
        state: string
        score: number
        reason: string
        evidence: string[]
      }>
    }
    const base = {
      recordType: "admission_proposal",
      schemaVersion: 1,
      ownerUserId: context.ownerUserId,
      version: row.row_version,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      provenance: recordProvenance(database, context, "admission_proposal", row.id),
      id: row.id,
      state: row.lifecycle,
      source: proposed.source,
      ...(proposed.previousSource ? { previousSource: proposed.previousSource } : {}),
      ...(proposed.diffSummary ? { diffSummary: proposed.diffSummary } : {}),
      generation: proposed.generation,
    }
    if (row.lifecycle === "planning" || row.lifecycle === "planning_failed") {
      return AdmissionProposalDtoSchema.parse(base)
    }
    return AdmissionProposalDtoSchema.parse({
      ...base,
      suggestedPlacement: proposed.suggestedPlacement,
      placementMatches: proposed.placementMatches ?? [],
      proposedOutcomes: (proposed.outcomes ?? []).map((outcome) => ({
        key: outcome.proposalKey,
        title: outcome.title,
        ...(outcome.description ? { description: outcome.description } : {}),
        successCriteria: outcome.successCriteria,
        execution: "execution" in outcome ? outcome.execution : {},
      })),
      proposedWorkItems: (proposed.workItems ?? []).map((item) => ({
        key: item.proposalKey,
        ...(item.outcomeProposalKey ? { outcomeKey: item.outcomeProposalKey } : {}),
        title: item.title,
        ...(item.description ? { description: item.description } : {}),
        dependencyKeys: item.dependencyProposalKeys ?? [],
        completionContract: item.completionContract,
        execution: item.execution ?? {},
      })),
      duplicateMatches: proposed.duplicateMatches ?? JSON.parse(row.duplicate_matches_json),
    })
  })
}

function sqliteAttentionItem(database: Database, context: WorkGraphContext, row: AttentionRow, readThrough?: number) {
  const read = readThrough !== undefined && row.updated_at <= readThrough ? { readAt: readThrough } : {}
  if (row.kind === "admission_proposal") {
    const record = requiredAttentionRecord(readAdmissionRecords(database, context, row.id), row)
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      record,
      ...("suggestedPlacement" in record && record.suggestedPlacement.mode === "existing" ? sqliteAttentionStreamPath(database, context, record.suggestedPlacement.streamId) : {}),
    })
  }
  if (row.kind === "decision") {
    const record = requiredAttentionRecord(readDecisionRecords(database, context, row.id), row)
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      record,
      ...sqliteAttentionStreamPath(database, context, record.streamId),
    })
  }
  if (row.kind === "work_item") {
    const record = requiredAttentionRecord(readWorkItemRecords(database, context, row.id), row)
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      record,
      ...sqliteAttentionStreamPath(database, context, record.streamId),
    })
  }
  if (row.kind === "run") {
    const record = requiredAttentionRecord(readRunRecords(database, context, row.id), row)
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      record,
      ...sqliteAttentionStreamPath(database, context, record.streamId),
    })
  }
  if (row.kind === "unorganized_ai_work") {
    const counts = database
      .prepare(
        `
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN candidate_kind = 'external_issue' THEN 1 ELSE 0 END) AS external_issues,
        SUM(CASE WHEN candidate_kind = 'session' THEN 1 ELSE 0 END) AS sessions
      FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND status = 'unorganized'
    `,
      )
      .get(context.organizationId, context.ownerUserId) as { total: number; external_issues: number; sessions: number }
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      counts: { externalIssues: counts.external_issues, sessions: counts.sessions, total: counts.total },
    })
  }
  if (row.kind === "configuration_required") {
    if (!row.last_error || !row.job_type || !row.payload_json) throw new Error(`Generation configuration attention ${row.id} is incomplete`)
    const marker = (
      JSON.parse(row.payload_json) as {
        configurationRequirement?: { type?: unknown; purpose?: unknown; scope?: unknown }
      }
    ).configurationRequirement
    const scopeStreamId =
      marker?.scope &&
      typeof marker.scope === "object" &&
      "type" in marker.scope &&
      marker.scope.type === "stream" &&
      "streamId" in marker.scope &&
      typeof marker.scope.streamId === "string"
        ? marker.scope.streamId
        : undefined
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      ...(scopeStreamId ? sqliteAttentionStreamPath(database, context, scopeStreamId) : {}),
      requirement: {
        type: marker?.type,
        jobId: row.id,
        purpose: marker?.purpose,
        scope: marker?.scope,
        reason: row.last_error,
      },
    })
  }
  if (row.kind === "master_escalation") {
    if (!row.last_error || !row.stream_id) throw new Error(`Master escalation ${row.id} is incomplete`)
    const stream = database
      .prepare(
        `
      SELECT master_status_json FROM wg_v2_streams
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, row.stream_id) as { master_status_json: string | null } | undefined
    const status = stream?.master_status_json
      ? (JSON.parse(stream.master_status_json) as {
          sessionId?: unknown
          receiptRefs?: unknown
          escalation?: unknown
        })
      : undefined
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      ...sqliteAttentionStreamPath(database, context, row.stream_id),
      streamId: row.stream_id,
      ...(typeof status?.sessionId === "string" ? { sessionId: status.sessionId } : {}),
      ...(status?.escalation === "public_pr_confirmation" || status?.escalation === "failure_halt" || status?.escalation === "budget_exhausted"
        ? { category: status.escalation }
        : {}),
      reason: row.last_error,
      evidenceIds: [],
      receiptRefs: Array.isArray(status?.receiptRefs) ? status.receiptRefs.filter((value): value is string => typeof value === "string") : [],
    })
  }
  throw new Error(`Unsupported SQLite Attention kind ${String(row.kind)}`)
}

function sqliteAttentionStreamPath(database: Database, context: WorkGraphContext, streamId: string) {
  const path = database
    .prepare(
      `
    WITH RECURSIVE ancestry(id, title, parent_stream_id, depth) AS (
      SELECT id, title, parent_stream_id, 0
      FROM wg_v2_streams
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      UNION ALL
      SELECT parent.id, parent.title, parent.parent_stream_id, ancestry.depth + 1
      FROM wg_v2_streams parent
      JOIN ancestry ON parent.id = ancestry.parent_stream_id
      WHERE parent.organization_id = ? AND parent.owner_user_id = ? AND ancestry.depth < 99
    )
    SELECT id AS streamId, title FROM ancestry ORDER BY depth DESC
  `,
    )
    .all(context.organizationId, context.ownerUserId, streamId, context.organizationId, context.ownerUserId) as Array<{
    streamId: StreamID
    title: string
  }>
  if (path.length === 0) throw new Error(`Attention Stream ${streamId} is missing`)
  return path.length > 1 ? { streamPath: path } : {}
}

function requiredAttentionRecord<Record>(records: Record[], row: AttentionRow) {
  const record = records[0]
  if (!record) throw new Error(`Attention source ${row.kind}:${row.id} disappeared during its owner-scoped read`)
  return record
}

function recordProvenance(database: Database, context: WorkGraphContext, resourceType: string, resourceId: string) {
  const row = database
    .prepare(
      `
    SELECT events.actor_type, events.actor_id, events.operation_id
    FROM wg_v2_changes changes
    JOIN wg_v2_events events ON events.organization_id = changes.organization_id AND events.owner_user_id = changes.owner_user_id AND events.operation_id = changes.operation_id
    WHERE changes.organization_id = ? AND changes.owner_user_id = ? AND changes.resource_type = ? AND changes.resource_id = ?
    ORDER BY changes.cursor DESC LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, resourceType, resourceId) as
    | { actor_type: "user" | "agent" | "system"; actor_id: string; operation_id: OperationID }
    | undefined
  if (!row) return { actor: { type: "user" as const, id: context.ownerUserId } }
  return { actor: { type: row.actor_type, id: row.actor_id }, operationId: row.operation_id }
}

function readSourceRefs(database: Database, context: WorkGraphContext, recordType: string, recordId: string) {
  return (
    database
      .prepare(
        `
    SELECT refs.work_source_id, refs.source_revision_id, revisions.content_hash
    FROM wg_v2_record_source_revisions refs
    JOIN wg_v2_work_source_revisions revisions
      ON revisions.organization_id = refs.organization_id AND revisions.owner_user_id = refs.owner_user_id AND revisions.work_source_id = refs.work_source_id AND revisions.id = refs.source_revision_id
    WHERE refs.organization_id = ? AND refs.owner_user_id = ? AND refs.record_type = ? AND refs.record_id = ? ORDER BY refs.ordinal
  `,
      )
      .all(context.organizationId, context.ownerUserId, recordType, recordId) as Array<{
      work_source_id: string
      source_revision_id: string
      content_hash: string
    }>
  ).map((row) => ({
    workSourceId: row.work_source_id,
    revisionId: row.source_revision_id,
    contentHash: row.content_hash,
  }))
}

function readEvidenceIds(database: Database, context: WorkGraphContext, subjectType: string, subjectId: string) {
  return (
    database
      .prepare(
        `
    SELECT id FROM wg_v2_evidence WHERE organization_id = ? AND owner_user_id = ? AND subject_type = ? AND subject_id = ? ORDER BY created_at, id
  `,
      )
      .all(context.organizationId, context.ownerUserId, subjectType, subjectId) as Array<{ id: string }>
  ).map((row) => row.id)
}

function withLegacyStreamState<Record extends object>(record: Record) {
  Object.defineProperty(record, "state", {
    enumerable: false,
    get: () => (record as Record & { lifecycleState?: string }).lifecycleState,
  })
  return record
}

function recordReference(record: WorkGraphPublicRecord): WorkGraphRecordReference {
  if (record.recordType === "workgraph") return { type: "workgraph", id: record.id }
  if (record.recordType === "stream") return { type: "stream", id: record.id }
  if (record.recordType === "outcome") return { type: "outcome", id: record.id }
  if (record.recordType === "work_item") return { type: "work_item", id: record.id }
  if (record.recordType === "run") return { type: "run", id: record.id }
  if (record.recordType === "decision") return { type: "decision", id: record.id }
  return { type: "admission_proposal", id: record.id }
}

function withLegacyChange<Record extends { event: { type: string; occurredAt: number; streamId?: StreamID } }>(record: Record) {
  Object.defineProperties(record, {
    type: { enumerable: false, get: () => record.event.type },
    occurredAt: { enumerable: false, get: () => record.event.occurredAt },
    streamId: { enumerable: false, get: () => record.event.streamId },
  })
  return record
}

function evidenceDto(subject: EvidenceSubject, row: EvidenceRow) {
  const provenance = JSON.parse(row.provenance_json) as { actor: WorkGraphContext["actor"] }
  return {
    ...(JSON.parse(row.reference_json) as EvidenceInput),
    id: row.id,
    subject,
    ...(row.requirement_id ? { requirementId: row.requirement_id } : {}),
    ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
    recordedAt: Number(row.created_at),
    recordedBy: provenance.actor,
  } as EvidenceDto
}

function canonicalEvidenceDto(database: Database, context: WorkGraphContext, subject: EvidenceSubject, row: EvidenceRow) {
  const evidence = evidenceDto(subject, row)
  if (evidence.kind !== "integration" || evidence.effect === "other" || evidence.durableEffectReceiptId) {
    return EvidenceDtoSchema.parse(evidence)
  }
  const provenance = JSON.parse(row.provenance_json) as { operationId?: string }
  if (!provenance.operationId) return EvidenceDtoSchema.parse(evidence)
  const receipt = database
    .prepare(
      `
    SELECT id FROM wg_v2_durable_effect_receipts WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, `${provenance.operationId}:integration`) as { id: string } | undefined
  return EvidenceDtoSchema.parse({
    ...evidence,
    ...(receipt ? { durableEffectReceiptId: receipt.id } : {}),
  })
}

function evidenceSubject(subjectType: string, subjectId: string): EvidenceSubject {
  if (subjectType === "stream") return { type: "stream", streamId: subjectId as StreamID }
  if (subjectType === "outcome") return { type: "outcome", outcomeId: subjectId as OutcomeID }
  if (subjectType === "work_item") return { type: "work_item", workItemId: subjectId as WorkItemID }
  throw new Error(`Unsupported Evidence subject type ${subjectType}`)
}

function evidenceSubjectId(subject: EvidenceSubject) {
  if (subject.type === "stream") return subject.streamId
  if (subject.type === "outcome") return subject.outcomeId
  return subject.workItemId
}

function findEvidenceSubject(database: Database, context: WorkGraphContext, subject: EvidenceSubject) {
  if (subject.type === "stream") {
    const row = database
      .prepare("SELECT id FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
      .get(context.organizationId, context.ownerUserId, subject.streamId) as { id: string } | undefined
    return row ? { subjectId: row.id, streamId: row.id } : undefined
  }
  if (subject.type === "work_item") {
    const row = database
      .prepare("SELECT id, stream_id FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
      .get(context.organizationId, context.ownerUserId, subject.workItemId) as { id: string; stream_id: string } | undefined
    return row ? { subjectId: row.id, streamId: row.stream_id } : undefined
  }
  const row = database
    .prepare("SELECT id, stream_id FROM wg_v2_outcomes WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
    .get(context.organizationId, context.ownerUserId, subject.outcomeId) as { id: string; stream_id: string } | undefined
  return row ? { subjectId: row.id, streamId: row.stream_id } : undefined
}

function promoteSatisfiedResultReadyWork(database: Database, context: WorkGraphContext, workItemId: WorkItemID, occurredAt: number): { completed: boolean; outcomeId?: string } {
  const item = database
    .prepare(
      `
    SELECT lifecycle, completion_contract_json, outcome_id, parent_task_id
    FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId) as
    | {
        lifecycle: string
        completion_contract_json: string
        outcome_id: string | null
        parent_task_id: string | null
      }
    | undefined
  if (!item || item.lifecycle !== "result_ready") return { completed: false as const }
  const evidence = database
    .prepare(
      `
    SELECT id, requirement_id, source_run_id, reference_json, provenance_json, created_at FROM wg_v2_evidence
    WHERE organization_id = ? AND owner_user_id = ? AND subject_type = 'work_item' AND subject_id = ? ORDER BY created_at, id
  `,
    )
    .all(context.organizationId, context.ownerUserId, workItemId) as EvidenceRow[]
  const satisfied = evaluateCompletionContract(
    JSON.parse(item.completion_contract_json) as CompletionContract,
    { type: "work_item", workItemId } as EvidenceSubject,
    evidence.map((row) => evidenceDto({ type: "work_item", workItemId }, row)),
  ).satisfied
  if (!satisfied) return { completed: false as const }
  const unfinishedChild = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_work_items
    WHERE organization_id = ? AND owner_user_id = ? AND parent_task_id = ?
      AND lifecycle NOT IN ('completed', 'abandoned') LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId)
  if (unfinishedChild) return { completed: false as const }
  const completed =
    database
      .prepare(
        `
    UPDATE wg_v2_work_items SET lifecycle = 'completed', completed_at = ?, updated_at = ?, row_version = row_version + 1
    WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'result_ready'
  `,
      )
      .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, workItemId).changes === 1
  if (!completed) return { completed }
  const parentCompletion = item.parent_task_id ? promoteSatisfiedResultReadyWork(database, context, item.parent_task_id as WorkItemID, occurredAt) : undefined
  const outcomeId = parentCompletion?.outcomeId ?? item.outcome_id
  if (!outcomeId) return { completed }
  const unfinished = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_work_items
    WHERE organization_id = ? AND owner_user_id = ? AND outcome_id = ? AND lifecycle NOT IN ('completed', 'abandoned') LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, outcomeId)
  if (unfinished) return { completed }
  const promoted = database
    .prepare(
      `
    UPDATE wg_v2_outcomes SET lifecycle = 'ready_to_close', ready_to_close_at = ?, updated_at = ?, row_version = row_version + 1
    WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'active'
  `,
    )
    .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, outcomeId)
  return { completed, ...(promoted.changes === 1 ? { outcomeId } : {}) }
}

function ensureOwnerRoot(database: Database, context: WorkGraphContext, occurredAt: number) {
  database
    .prepare(
      `
    INSERT OR IGNORE INTO wg_v2_workgraphs (organization_id, owner_user_id, id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `,
    )
    .run(context.organizationId, context.ownerUserId, rootId, occurredAt, occurredAt)
}

async function launchRun(
  database: Database,
  execution: WorkspaceExecutionPort,
  context: WorkGraphContext,
  runId: RunID,
  occurredAt: number,
  ids: Readonly<{ next: (kind: string) => string }>,
  schedulePlacementCompensationDrain?: () => void,
  scheduleResumeDrain?: (delayMs: number) => void,
) {
  const row = database
    .prepare(
      `
    SELECT runs.stream_id, runs.work_item_id, runs.resolved_execution_profile_json, runs.generation,
      items.title, items.description, items.completion_contract_json, streams.envelope_identity_json,
      streams.parent_stream_id
    FROM wg_v2_runs runs
    JOIN wg_v2_work_items items ON items.organization_id = runs.organization_id AND items.owner_user_id = runs.owner_user_id AND items.id = runs.work_item_id
    JOIN wg_v2_streams streams ON streams.organization_id = runs.organization_id AND streams.owner_user_id = runs.owner_user_id AND streams.id = runs.stream_id
    WHERE runs.organization_id = ? AND runs.owner_user_id = ? AND runs.id = ? AND runs.lifecycle = 'admitted'
  `,
    )
    .get(context.organizationId, context.ownerUserId, runId) as
    | {
        stream_id: StreamID
        work_item_id: WorkItemID
        resolved_execution_profile_json: string
        title: string
        description: string
        completion_contract_json: string
        envelope_identity_json: string | null
        parent_stream_id: StreamID | null
        generation: number
      }
    | undefined
  if (!row) return
  const envelope = row.envelope_identity_json ? (JSON.parse(row.envelope_identity_json) as { id?: string }) : undefined
  const profile = ResolvedExecutionProfileSchema.parse(JSON.parse(row.resolved_execution_profile_json))
  await placeAdmittedRun(
    context,
    {
      runId,
      streamId: row.stream_id,
      ...(row.parent_stream_id ? { parentStreamId: row.parent_stream_id } : {}),
      workItemId: row.work_item_id,
      title: row.title,
      prompt: buildRunPrompt({
        title: row.title,
        description: row.description,
        completionContract: row.completion_contract_json,
        connectionIds: profile.connectionIds,
        untrustedSource: hasExternalWorkItemSource(database, context, row.work_item_id),
      }),
      profile,
      ...(envelope?.id ? { envelopeId: envelope.id as never } : {}),
    },
    {
      ownsLease: async (_context, input) =>
        !!database
          .prepare(
            `
      SELECT 1 FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
        AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
    `,
          )
          .get(context.organizationId, context.ownerUserId, input.workItemId, input.runId, input.leaseEpoch, occurredAt),
      markPlacing: async (_context, input) => {
        return database.transaction(() => {
          const owned = database
            .prepare(
              `
          SELECT 1 FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
            AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
        `,
            )
            .get(context.organizationId, context.ownerUserId, row.work_item_id, runId, input.leaseEpoch, occurredAt)
          if (!owned) return false
          database
            .prepare(
              `
          UPDATE wg_v2_streams SET envelope_identity_json = ?, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `,
            )
            .run(JSON.stringify(input.envelope), occurredAt, context.organizationId, context.ownerUserId, row.stream_id)
          const changed = database
            .prepare(
              `
          UPDATE wg_v2_runs SET lifecycle = 'placing', envelope_id = ?, child_workspace_id = ?, updated_at = ?, row_version = row_version + 1
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'admitted' AND generation = ?
        `,
            )
            .run(input.envelope.id, input.childIsolationId ?? null, occurredAt, context.organizationId, context.ownerUserId, runId, input.leaseEpoch)
          if (changed.changes !== 1) return false
          appendRuntimeChange(database, context, { type: "run_state_changed", runId, streamId: row.stream_id, state: "placing" }, occurredAt)
          return true
        })()
      },
      markRunning: async (_context, input) => {
        return database.transaction(() => {
          const owned = database
            .prepare(
              `
          SELECT 1 FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
            AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
        `,
            )
            .get(context.organizationId, context.ownerUserId, row.work_item_id, runId, input.leaseEpoch, occurredAt)
          if (!owned) return false
          const changed = database
            .prepare(
              `
          UPDATE wg_v2_runs SET lifecycle = 'running', session_id = ?, started_at = ?, parked_reason = NULL,
            resume_available_at = NULL, updated_at = ?, row_version = row_version + 1
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'placing' AND generation = ?
        `,
            )
            .run(input.launch.sessionId, occurredAt, occurredAt, context.organizationId, context.ownerUserId, runId, input.leaseEpoch)
          if (changed.changes !== 1) return false
          const activeBinding = database
            .prepare(
              `
            SELECT current_run_id FROM wg_v2_session_bindings
            WHERE organization_id = ? AND owner_user_id = ? AND session_id = ? AND state = 'active'
          `,
            )
            .get(context.organizationId, context.ownerUserId, input.launch.sessionId) as { current_run_id: string | null } | undefined
          if (activeBinding && activeBinding.current_run_id !== runId) {
            throw new Error("Execution Session is already bound to another Run")
          }
          if (!activeBinding) {
            database
              .prepare(
                `
              INSERT INTO wg_v2_session_bindings
                (organization_id, owner_user_id, id, stream_id, session_id, project_id, current_work_item_id,
                 current_run_id, state, bound_at, provenance_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
            `,
              )
              .run(
                context.organizationId,
                context.ownerUserId,
                ids.next("session_binding"),
                row.stream_id,
                input.launch.sessionId,
                input.launch.projectId,
                row.work_item_id,
                runId,
                occurredAt,
                JSON.stringify({ actor: context.actor }),
                occurredAt,
                occurredAt,
              )
          }
          appendRuntimeChange(database, context, { type: "run_state_changed", runId, streamId: row.stream_id, state: "running" }, occurredAt)
          return true
        })()
      },
      markParked: async (_context, input) => {
        return database.transaction(() => {
          const owned = database
            .prepare(
              `
          SELECT 1 FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
            AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
        `,
            )
            .get(context.organizationId, context.ownerUserId, row.work_item_id, runId, input.leaseEpoch, occurredAt)
          if (!owned) return false
          const current = database
            .prepare(
              `
          SELECT resume_attempts FROM wg_v2_runs
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND generation = ? AND lifecycle IN ('admitted', 'placing')
        `,
            )
            .get(context.organizationId, context.ownerUserId, runId, input.leaseEpoch) as { resume_attempts: number } | undefined
          if (!current) return false
          const resumeAttempts = current.resume_attempts + 1
          if (isRunResumeCapExceeded(resumeAttempts)) {
            database
              .prepare(
                `
              UPDATE wg_v2_runs SET lifecycle = 'failed', parked_reason = ?, resume_attempts = ?,
                resume_available_at = NULL, finished_at = ?, updated_at = ?, row_version = row_version + 1
              WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND generation = ?
            `,
              )
              .run(input.reason, resumeAttempts, occurredAt, occurredAt, context.organizationId, context.ownerUserId, runId, input.leaseEpoch)
            database
              .prepare(
                `
              UPDATE wg_v2_work_items SET lifecycle = 'failed', updated_at = ?, row_version = row_version + 1
              WHERE organization_id = ? AND owner_user_id = ? AND id = ?
            `,
              )
              .run(occurredAt, context.organizationId, context.ownerUserId, row.work_item_id)
            releaseSqliteRunLeases(database, context, {
              runId,
              streamId: row.stream_id,
              workItemId: row.work_item_id,
            })
            appendRuntimeChange(database, context, { type: "run_state_changed", runId, streamId: row.stream_id, state: "failed" }, occurredAt)
            return true
          }
          const retryAfterMs = Math.min(60_000, 1_000 * 2 ** (resumeAttempts - 1))
          database
            .prepare(
              `
            UPDATE wg_v2_runs SET lifecycle = 'parked', parked_reason = ?, resume_attempts = ?, resume_available_at = ?,
              updated_at = ?, row_version = row_version + 1
            WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND generation = ?
          `,
            )
            .run(input.reason, resumeAttempts, occurredAt + retryAfterMs, occurredAt, context.organizationId, context.ownerUserId, runId, input.leaseEpoch)
          database
            .prepare(
              `
            UPDATE wg_v2_leases SET expires_at = ?, updated_at = ?, row_version = row_version + 1
            WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item'
              AND resource_id = ? AND holder_id = ? AND epoch = ?
          `,
            )
            .run(occurredAt + PARKED_LEASE_TTL_MS, occurredAt, context.organizationId, context.ownerUserId, row.work_item_id, runId, input.leaseEpoch)
          appendRuntimeChange(database, context, { type: "run_state_changed", runId, streamId: row.stream_id, state: "parked" }, occurredAt)
          scheduleResumeDrain?.(retryAfterMs)
          return true
        })()
      },
      placementCompensation: {
        reserve: async (_context, input) => {
          const key = placementCompensationKey(input)
          reserveRuntimeEffect(
            database,
            context,
            {
              operationId: key as OperationID,
              kind: "compensate_run_placement",
              resourceType: "run",
              resourceId: input.runId,
              payload: input,
            },
            occurredAt,
          )
          database
            .prepare(
              `
          UPDATE wg_v2_runtime_effects SET state = 'claimed', updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ? AND state = 'pending'
        `,
            )
            .run(occurredAt, context.organizationId, context.ownerUserId, key)
          return key
        },
        complete: async (_context, input) => {
          completeSqlitePlacementCompensationEffect(database, context, input.key as OperationID, occurredAt)
        },
        fail: async (_context, input) => {
          failSqlitePlacementCompensationEffect(database, context, input.key as OperationID, input.reason, occurredAt)
          schedulePlacementCompensationDrain?.()
        },
      },
    },
    execution,
    row.generation,
  )
}

function admitRun(
  database: Database,
  context: WorkGraphContext,
  workItemId: WorkItemID,
  occurredAt: number,
  ids: Readonly<{ next: (kind: string) => string }>,
  capabilities: ExecutionCapabilities | undefined,
): Readonly<{ ok: true; runId: string; streamId: string; leaseEpoch: number }> | Readonly<{ ok: false; code: CommandErrorCode; message: string }> {
  const row = database
    .prepare(
      `
    SELECT items.id, items.stream_id, items.outcome_id, items.lifecycle, items.execution_overrides_json,
      streams.lifecycle AS stream_lifecycle, streams.execution_defaults_json AS stream_defaults,
      streams.replacement_reset_json,
      outcomes.execution_defaults_json AS outcome_defaults, graphs.defaults_json AS workgraph_defaults
    FROM wg_v2_work_items items
    JOIN wg_v2_streams streams ON streams.organization_id = items.organization_id AND streams.owner_user_id = items.owner_user_id AND streams.id = items.stream_id
    JOIN wg_v2_workgraphs graphs ON graphs.organization_id = streams.organization_id AND graphs.owner_user_id = streams.owner_user_id AND graphs.id = streams.workgraph_id
    LEFT JOIN wg_v2_outcomes outcomes ON outcomes.organization_id = items.organization_id AND outcomes.owner_user_id = items.owner_user_id AND outcomes.id = items.outcome_id
    WHERE items.organization_id = ? AND items.owner_user_id = ? AND items.id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId) as
    | {
        id: string
        stream_id: string
        outcome_id: string | null
        lifecycle: string
        execution_overrides_json: string
        stream_lifecycle: string
        stream_defaults: string
        replacement_reset_json: string | null
        outcome_defaults: string | null
        workgraph_defaults: string
      }
    | undefined
  if (!row) return { ok: false, code: "not_found", message: "Work Item not found" }
  if (row.replacement_reset_json && (JSON.parse(row.replacement_reset_json) as { state?: string }).state !== "completed") {
    return { ok: false, code: "blocked", message: "Stream replacement cleanup is still pending" }
  }
  if (row.stream_lifecycle === "paused") return { ok: false, code: "blocked", message: "Paused Streams do not admit new Runs" }
  if (row.stream_lifecycle === "closed") return { ok: false, code: "invalid_transition", message: "Closed Streams do not execute" }
  if (["completed", "abandoned"].includes(row.lifecycle)) return { ok: false, code: "invalid_transition", message: "Finished Work Items do not execute" }
  const decision = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_decisions decisions
    JOIN wg_v2_decision_work_items affected ON affected.organization_id = decisions.organization_id AND affected.owner_user_id = decisions.owner_user_id
      AND affected.decision_id = decisions.id
    WHERE decisions.organization_id = ? AND decisions.owner_user_id = ? AND affected.work_item_id = ?
      AND decisions.lifecycle IN ('proposed', 'pending') LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId)
  if (decision) return { ok: false, code: "blocked", message: "Work Item requires a pending Decision" }
  const blocked = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_work_item_dependencies dependencies
    JOIN wg_v2_work_items blockers ON blockers.organization_id = dependencies.organization_id AND blockers.owner_user_id = dependencies.owner_user_id AND blockers.id = dependencies.depends_on_work_item_id
    WHERE dependencies.organization_id = ? AND dependencies.owner_user_id = ? AND dependencies.work_item_id = ? AND blockers.lifecycle <> 'completed' LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId)
  if (blocked) return { ok: false, code: "blocked", message: "Work Item dependencies are incomplete" }
  const lease = database
    .prepare(
      `
    SELECT holder_id, epoch, CAST(expires_at AS INTEGER) AS expires_at FROM wg_v2_leases
    WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId) as { holder_id: string; epoch: number; expires_at: number } | undefined
  if (lease && lease.expires_at <= occurredAt) {
    database
      .prepare(
        `
      UPDATE wg_v2_runs SET lifecycle = 'parked', parked_reason = 'Execution lease expired', updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle IN ('admitted', 'placing', 'running')
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, lease.holder_id)
  }
  const running = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_runs runs
    JOIN wg_v2_leases leases ON leases.organization_id = runs.organization_id AND leases.owner_user_id = runs.owner_user_id AND leases.resource_type = 'work_item'
      AND leases.resource_id = runs.work_item_id AND leases.holder_id = runs.id AND leases.epoch = runs.generation
    WHERE runs.organization_id = ? AND runs.owner_user_id = ? AND runs.work_item_id = ? AND runs.lifecycle IN ('admitted', 'placing', 'running')
      AND CAST(leases.expires_at AS INTEGER) > ? LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId, occurredAt)
  if (running) return { ok: false, code: "blocked", message: "Work Item already has an active Run" }
  // The master turn owns the shared Stream workspace while running: no
  // Run admits into the envelope mid-turn (the mirror of the master's
  // own live-run deferral).
  const masterRunning = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_due_jobs
    WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND job_type = 'master_wake'
      AND status = 'running' LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, row.stream_id)
  if (masterRunning) return { ok: false, code: "blocked", message: "Stream master turn is in progress" }
  const hierarchy = {
    workgraph: JSON.parse(row.workgraph_defaults) as ExecutionProfileDefaults,
    stream: JSON.parse(row.stream_defaults) as ExecutionProfileDefaults,
    ...(row.outcome_defaults ? { outcome: JSON.parse(row.outcome_defaults) as ExecutionProfileDefaults } : {}),
    workItem: JSON.parse(row.execution_overrides_json) as ExecutionProfileDefaults,
  }
  const resolved = resolveExecutionProfile(hierarchy)
  if (!resolved.ok)
    return {
      ok: false,
      code: "validation_error",
      message:
        resolved.error.code === "unknown_agent_profile"
          ? `Unknown agent profile: ${resolved.error.profileName}`
          : `Incomplete execution profile: ${resolved.error.missingFields.join(", ")}`,
    }
  if (!capabilities) return { ok: false, code: "execution_unavailable", message: "Execution capability catalog is not configured" }
  const supported = validateResolvedExecutionProfileAgainstCapabilities({
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    now: occurredAt,
    capabilities,
    profile: resolved.profile,
  })
  if (!supported.ok) return { ok: false, code: "validation_error", message: capabilityMessage(supported.diagnostics) }
  const maxParallel = [hierarchy.workItem, hierarchy.outcome, hierarchy.stream, hierarchy.workgraph].find((defaults) => defaults?.maxParallel !== undefined)?.maxParallel ?? 1
  const activeRunCount = (
    database
      .prepare(
        `
      SELECT COUNT(*) AS value FROM wg_v2_runs runs
      JOIN wg_v2_leases leases ON leases.organization_id = runs.organization_id AND leases.owner_user_id = runs.owner_user_id
        AND leases.resource_type = 'work_item' AND leases.resource_id = runs.work_item_id
        AND leases.holder_id = runs.id AND leases.epoch = runs.generation
      WHERE runs.organization_id = ? AND runs.owner_user_id = ? AND runs.stream_id = ?
        AND runs.lifecycle IN ('admitted', 'placing', 'running') AND CAST(leases.expires_at AS INTEGER) > ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, row.stream_id, occurredAt) as { value: number }
  ).value
  if (resolvedPlacement(resolved.profile.environment.placement) === "shared" && activeRunCount > 0)
    return { ok: false, code: "blocked", message: "Stream already has an active Run" }
  if (resolvedPlacement(resolved.profile.environment.placement) !== "shared" && activeRunCount >= maxParallel)
    return {
      ok: false,
      code: "blocked",
      message: `Stream execution width is exhausted (${maxParallel})`,
    }
  const runId = ids.next("run")
  const leaseEpoch =
    Math.max(
      lease?.epoch ?? 0,
      (
        database
          .prepare(
            `
          SELECT COALESCE(MAX(generation), 0) AS value FROM wg_v2_runs
          WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, workItemId) as { value: number }
      ).value,
    ) + 1
  const runNumber = (
    database
      .prepare("SELECT COALESCE(MAX(run_number), 0) + 1 AS value FROM wg_v2_runs WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?")
      .get(context.organizationId, context.ownerUserId, workItemId) as { value: number }
  ).value
  database
    .prepare(
      `
    INSERT INTO wg_v2_runs
      (organization_id, owner_user_id, id, stream_id, work_item_id, run_number, lifecycle, resolved_execution_profile_json, generation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?, ?)
  `,
    )
    .run(context.organizationId, context.ownerUserId, runId, row.stream_id, workItemId, runNumber, JSON.stringify(resolved.profile), leaseEpoch, occurredAt, occurredAt)
  if (resolvedPlacement(resolved.profile.environment.placement) === "shared")
    database
      .prepare(
        `
      INSERT INTO wg_v2_leases
        (organization_id, owner_user_id, id, resource_type, resource_id, holder_id, epoch, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, 'stream', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, owner_user_id, resource_type, resource_id) DO UPDATE SET
        holder_id = excluded.holder_id, epoch = excluded.epoch, expires_at = excluded.expires_at,
        row_version = wg_v2_leases.row_version + 1, updated_at = excluded.updated_at
      WHERE CAST(wg_v2_leases.expires_at AS INTEGER) <= ?
    `,
      )
      .run(context.organizationId, context.ownerUserId, ids.next("lease"), row.stream_id, runId, leaseEpoch, occurredAt + 300_000, occurredAt, occurredAt, occurredAt)
  database
    .prepare(
      `
    INSERT INTO wg_v2_leases
      (organization_id, owner_user_id, id, resource_type, resource_id, holder_id, epoch, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, 'work_item', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, owner_user_id, resource_type, resource_id) DO UPDATE SET
      holder_id = excluded.holder_id, epoch = excluded.epoch, expires_at = excluded.expires_at,
      row_version = wg_v2_leases.row_version + 1, updated_at = excluded.updated_at
    WHERE CAST(wg_v2_leases.expires_at AS INTEGER) <= ?
  `,
    )
    .run(context.organizationId, context.ownerUserId, ids.next("lease"), workItemId, runId, leaseEpoch, occurredAt + 300_000, occurredAt, occurredAt, occurredAt)
  database
    .prepare("UPDATE wg_v2_work_items SET lifecycle = 'active', updated_at = ?, row_version = row_version + 1 WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
    .run(occurredAt, context.organizationId, context.ownerUserId, workItemId)
  return { ok: true, runId, streamId: row.stream_id, leaseEpoch }
}

export function recordSqliteWorkGraphLlmUsage(
  database: Database,
  context: Pick<WorkGraphContext, "organizationId" | "ownerUserId">,
  input: Readonly<{
    id: string
    sessionId: string
    streamId?: string
    runId?: string
    workItemId?: string
    providerId: string
    modelId: string
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    createdAt: number
  }>,
) {
  const binding =
    input.streamId && input.runId && input.workItemId
      ? undefined
      : (database
          .prepare(
            `
          SELECT stream_id, current_run_id, current_work_item_id FROM wg_v2_session_bindings
          WHERE organization_id = ? AND owner_user_id = ? AND session_id = ? AND state = 'active'
          ORDER BY bound_at DESC LIMIT 1
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.sessionId) as
          | { stream_id: string; current_run_id: string | null; current_work_item_id: string | null }
          | undefined)
  return (
    database
      .prepare(
        `
    INSERT OR IGNORE INTO wg_v2_llm_usage_events
      (organization_id, owner_user_id, id, session_id, stream_id, run_id, work_item_id, provider_id, model_id,
       input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        input.id,
        input.sessionId,
        input.streamId ?? binding?.stream_id ?? null,
        input.runId ?? binding?.current_run_id ?? null,
        input.workItemId ?? binding?.current_work_item_id ?? null,
        input.providerId,
        input.modelId,
        input.inputTokens,
        input.outputTokens,
        input.reasoningTokens,
        input.cacheReadTokens,
        input.cacheWriteTokens,
        input.createdAt,
      ).changes === 1
  )
}

function ownedStream(database: Database, context: WorkGraphContext, streamId: string) {
  return database
    .prepare(
      `
    SELECT id, title, lifecycle, visibility, row_version, envelope_identity_json, replacement_reset_json,
      notes_source_json, public_pr_confirmed_at, execution_defaults_json
    FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId) as StreamRow | undefined
}

function ownedOutcome(database: Database, context: WorkGraphContext, outcomeId: string) {
  return database
    .prepare(
      `
    SELECT id, stream_id, lifecycle, row_version FROM wg_v2_outcomes WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, outcomeId) as OutcomeRow | undefined
}

function ownedWorkItem(database: Database, context: WorkGraphContext, workItemId: string) {
  return database
    .prepare(
      `
    SELECT id, stream_id, parent_task_id, lifecycle, row_version
    FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId) as WorkItemVersionRow | undefined
}

function ownedDecision(database: Database, context: WorkGraphContext, decisionId: string) {
  return database
    .prepare(
      `
    SELECT id, stream_id, lifecycle, options_json, row_version FROM wg_v2_decisions WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, decisionId) as DecisionRow | undefined
}

function streamAutonomy(execution: string | undefined) {
  if (!execution) return "supervised"
  return ExecutionProfileDefaultsSchema.parse(JSON.parse(execution)).autonomy ?? "supervised"
}

function streamExecutionChangeError(
  current: string,
  requested: ExecutionProfileDefaults | undefined,
  actorType: WorkGraphContext["actor"]["type"],
  confirmAutonomy: boolean | undefined,
) {
  const currentExecution = ExecutionProfileDefaultsSchema.parse(JSON.parse(current))
  if (requested?.autonomy === "autonomous" && currentExecution.autonomy !== "autonomous" && (actorType !== "user" || confirmAutonomy !== true)) {
    return {
      code: "autonomy_confirmation_required" as const,
      message: "Autonomous Streams require explicit owner confirmation",
    }
  }
  if (requested !== undefined && JSON.stringify(requested.budget) !== JSON.stringify(currentExecution.budget) && actorType !== "user") {
    return { code: "forbidden" as const, message: "Only the owner can configure a Stream budget" }
  }
}

function exactSourceHead(database: Database, context: WorkGraphContext, source: WorkSourceRevisionRef) {
  const row = database
    .prepare(
      `
    SELECT revisions.revision_number, revisions.content_hash, revisions.content, revisions.origin_kind,
      revisions.origin_reference_json, sources.latest_revision_number, sources.title
    FROM wg_v2_work_source_revisions revisions
    JOIN wg_v2_work_sources sources ON sources.organization_id = revisions.organization_id AND sources.owner_user_id = revisions.owner_user_id AND sources.id = revisions.work_source_id
    WHERE revisions.organization_id = ? AND revisions.owner_user_id = ? AND revisions.work_source_id = ? AND revisions.id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, source.workSourceId, source.revisionId) as
    | {
        revision_number: number
        content_hash: string
        content: string
        origin_kind: string
        origin_reference_json: string | null
        latest_revision_number: number
        title: string
      }
    | undefined
  return {
    exists: !!row,
    current: !!row && row.revision_number === row.latest_revision_number && row.content_hash === source.contentHash,
    title: row?.title ?? "",
    content: row?.content ?? "",
    untrusted:
      row?.origin_kind === "external" ||
      (row?.origin_reference_json ? (JSON.parse(row.origin_reference_json) as { derivedFromExternal?: unknown }).derivedFromExternal === true : false),
  }
}

function previousSourceRevision(database: Database, context: WorkGraphContext, streamId: StreamID, current: WorkSourceRevisionRef) {
  const row = database
    .prepare(
      `
    SELECT revisions.work_source_id, revisions.id, revisions.content_hash, revisions.content
    FROM wg_v2_record_source_revisions refs
    JOIN wg_v2_work_source_revisions revisions
      ON revisions.organization_id = refs.organization_id AND revisions.owner_user_id = refs.owner_user_id AND revisions.id = refs.source_revision_id
    WHERE refs.organization_id = ? AND refs.owner_user_id = ? AND refs.record_type = 'stream' AND refs.record_id = ?
      AND revisions.work_source_id = ? AND revisions.id <> ?
    ORDER BY refs.ordinal DESC LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId, current.workSourceId, current.revisionId) as
    | {
        work_source_id: WorkSourceID
        id: WorkSourceRevisionID
        content_hash: WorkSourceRevisionRef["contentHash"]
        content: string
      }
    | undefined
  return row
    ? {
        reference: { workSourceId: row.work_source_id, revisionId: row.id, contentHash: row.content_hash },
        content: row.content,
      }
    : undefined
}

function sourceRevisionDiffSummary(previous: string, current: string) {
  return `Content changed; ${previous.split("\n").length} → ${current.split("\n").length} lines`
}

function requiredOriginReference(value: string | null, kind: "authoring" | "external") {
  if (value === null) throw new Error(`${kind === "authoring" ? "Authoring" : "External"} Work Source revision is missing its immutable origin reference`)
  return value
}

function sourcePlanningEvidence(database: Database, context: WorkGraphContext, input: Readonly<{ title: string; content: string; targetStreamId?: StreamID; now: number }>) {
  const candidate = { title: input.title, body: input.content }
  const readStreams = (where: string, limit: number, offset = 0) =>
    database
      .prepare(
        `
    SELECT id, title, purpose, pinned, last_activity_at, updated_at
    FROM wg_v2_streams
    WHERE organization_id = ? AND owner_user_id = ? AND visibility = 'visible' AND lifecycle <> 'closed' ${where}
    ORDER BY CAST(COALESCE(last_activity_at, updated_at) AS INTEGER) DESC
    LIMIT ? OFFSET ?
  `,
      )
      .all(context.organizationId, context.ownerUserId, limit, offset)
      .map((row) => {
        const stream = row as {
          id: string
          title: string
          purpose: string
          pinned: number
          last_activity_at: string | number | null
          updated_at: string | number
        }
        return {
          id: stream.id as StreamID,
          title: stream.title,
          summary: stream.purpose,
          pinned: stream.pinned === 1,
          lastActivityAt: Number(stream.last_activity_at ?? stream.updated_at),
        } satisfies MatchableStream
      })
  const recent = readStreams("", 24)
  const pinned = readStreams("AND pinned = 1", 12)
  const primary = rankStreamMatches([...recent, ...pinned], candidate, input.now)
  const ranked = primary[0]?.confidence === "high" ? primary : rankStreamMatches([...recent, ...pinned, ...readStreams("", 16, 24)], candidate, input.now)
  const placementMatches = ranked.slice(0, 4).map((match) => ({
    streamId: match.streamId,
    confidence: match.confidence,
    score: match.score,
    reason: match.explanation,
    evidence: [match.explanation],
  }))
  const explicit = input.targetStreamId
    ? [
        {
          streamId: input.targetStreamId,
          confidence: "high" as const,
          score: 1,
          reason: "The owner explicitly selected this Stream.",
          evidence: ["Explicit owner selection"],
        },
        ...placementMatches.filter((match) => match.streamId !== input.targetStreamId),
      ].slice(0, 4)
    : placementMatches
  const recommendation = ranked.find((match) => match.confidence !== "low")
  const duplicates = database
    .prepare(
      `
    SELECT 'outcome' AS subject_type, id, stream_id, title, description AS summary, lifecycle AS state, updated_at
    FROM wg_v2_outcomes
    WHERE organization_id = ? AND owner_user_id = ? AND lifecycle NOT IN ('completed', 'abandoned')
    UNION ALL
    SELECT 'work_item' AS subject_type, id, stream_id, title, description AS summary, lifecycle AS state, updated_at
    FROM wg_v2_work_items
    WHERE organization_id = ? AND owner_user_id = ? AND lifecycle NOT IN ('completed', 'abandoned')
    ORDER BY updated_at DESC
    LIMIT 48
  `,
    )
    .all(context.organizationId, context.ownerUserId, context.organizationId, context.ownerUserId)
    .map((row) => {
      const record = row as {
        subject_type: "outcome" | "work_item"
        id: string
        stream_id: string
        title: string
        summary: string
        state: string
        updated_at: string | number
      }
      return {
        subject: record.subject_type === "outcome" ? { type: "outcome" as const, outcomeId: record.id } : { type: "work_item" as const, workItemId: record.id },
        streamId: record.stream_id as StreamID,
        title: record.title,
        summary: record.summary,
        state: record.state,
        updatedAt: Number(record.updated_at),
      } satisfies DuplicateCandidate
    })
  return {
    ...(input.targetStreamId ? { targetStreamId: input.targetStreamId } : recommendation ? { targetStreamId: recommendation.streamId } : {}),
    placementMatches: explicit,
    duplicateMatches: rankDuplicateMatches(duplicates, candidate),
  }
}

function hasExternalWorkItemSource(database: Database, context: WorkGraphContext, workItemId: string) {
  return !!database
    .prepare(
      `
    SELECT 1 FROM wg_v2_record_source_revisions refs
    JOIN wg_v2_work_source_revisions revisions
      ON revisions.organization_id = refs.organization_id AND revisions.owner_user_id = refs.owner_user_id
      AND revisions.id = refs.source_revision_id
    WHERE refs.organization_id = ? AND refs.owner_user_id = ? AND refs.record_type = 'work_item'
      AND refs.record_id = ? AND (
        revisions.origin_kind = 'external'
        OR json_extract(revisions.origin_reference_json, '$.derivedFromExternal') = 1
      )
    LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId)
}

function addSourceReference(
  database: Database,
  context: WorkGraphContext,
  ids: Readonly<{ next: (kind: string) => string }>,
  recordType: string,
  recordId: string,
  source: Readonly<{ workSourceId: string; revisionId: string }>,
  occurredAt: number,
) {
  const ordinal = database
    .prepare(
      `
    SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM wg_v2_record_source_revisions
    WHERE organization_id = ? AND owner_user_id = ? AND record_type = ? AND record_id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, recordType, recordId) as { ordinal: number }
  database
    .prepare(
      `
    INSERT OR IGNORE INTO wg_v2_record_source_revisions
      (organization_id, owner_user_id, id, record_type, record_id, work_source_id, source_revision_id, ordinal, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(context.organizationId, context.ownerUserId, ids.next("source_ref"), recordType, recordId, source.workSourceId, source.revisionId, ordinal.ordinal, occurredAt)
}

function appendRuntimeChange(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{ type: string; runId: RunID; streamId: StreamID; state: string }>,
  occurredAt: number,
) {
  const operationId = `runtime_${input.runId}_${input.state}_${crypto.randomUUID()}` as OperationID
  const cursorPosition = allocateSqliteChangeCursor(database, context, occurredAt)
  const cursor = createChangeCursor({
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    position: cursorPosition,
  })
  database
    .prepare(
      `
    INSERT INTO wg_v2_operation_results
      (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, change_cursor, created_at)
    VALUES (?, ?, ?, 'runtime_transition', ?, 200, ?, ?, ?)
  `,
    )
    .run(
      context.organizationId,
      context.ownerUserId,
      operationId,
      hash(operationId),
      JSON.stringify({
        ok: true,
        operationId,
        cursor,
        value: { runId: input.runId, state: input.state },
      }),
      cursorPosition,
      occurredAt,
    )
  const sequence = allocateEventSequence(database, context, input.streamId, occurredAt)
  const payload = JSON.stringify({ runId: input.runId, streamId: input.streamId, state: input.state })
  database
    .prepare(
      `
    INSERT INTO wg_v2_events
      (organization_id, owner_user_id, id, stream_id, sequence, schema_version, operation_id, event_type, actor_type, actor_id, request_id, payload_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      context.organizationId,
      context.ownerUserId,
      `event_${crypto.randomUUID()}`,
      input.streamId,
      sequence,
      operationId,
      input.type,
      context.actor.type,
      context.actor.id,
      context.requestId,
      payload,
      occurredAt,
    )
  database
    .prepare(
      `
    INSERT INTO wg_v2_changes
      (organization_id, owner_user_id, cursor, id, stream_id, operation_id, resource_type, resource_id, change_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'run', ?, ?, ?, ?)
  `,
    )
    .run(context.organizationId, context.ownerUserId, cursorPosition, `change_${crypto.randomUUID()}`, input.streamId, operationId, input.runId, input.type, payload, occurredAt)
}

function reserveRuntimeEffect(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{
    operationId: OperationID
    kind: string
    resourceType: string
    resourceId: string
    payload: unknown
  }>,
  occurredAt: number,
) {
  database
    .prepare(
      `
    INSERT INTO wg_v2_runtime_effects
      (organization_id, owner_user_id, id, effect_kind, resource_type, resource_id, idempotency_key, payload_json, state, attempt_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
    ON CONFLICT(organization_id, owner_user_id, idempotency_key) DO UPDATE SET
      state = 'pending', attempt_count = wg_v2_runtime_effects.attempt_count + 1, last_error = NULL, updated_at = excluded.updated_at
  `,
    )
    .run(
      context.organizationId,
      context.ownerUserId,
      `effect_${crypto.randomUUID()}`,
      input.kind,
      input.resourceType,
      input.resourceId,
      input.operationId,
      JSON.stringify(input.payload),
      occurredAt,
      occurredAt,
    )
}

function completeRuntimeEffect(database: Database, context: WorkGraphContext, operationId: OperationID, occurredAt: number) {
  database
    .prepare(
      `
    UPDATE wg_v2_runtime_effects SET state = 'completed', completed_at = ?, updated_at = ?, last_error = NULL
    WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
  `,
    )
    .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, operationId)
}

function failRuntimeEffect(database: Database, context: WorkGraphContext, operationId: OperationID, error: unknown, occurredAt: number) {
  database
    .prepare(
      `
    UPDATE wg_v2_runtime_effects SET state = 'pending', last_error = ?, updated_at = ?
    WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
  `,
    )
    .run(error instanceof Error ? error.message : String(error), occurredAt, context.organizationId, context.ownerUserId, operationId)
}

function placementCompensationKey(input: PlacementCompensation) {
  return ["placement_compensation", input.runId, input.leaseEpoch, input.sessionId ?? input.childIsolationId ?? input.envelopeId].join(":")
}

type SqlitePlacementCompensation = PlacementCompensation & { failureHistory?: string[] }

function failSqlitePlacementCompensationEffect(database: Database, context: WorkGraphContext, key: OperationID, reason: string, occurredAt: number) {
  const row = database
    .prepare(
      `
    SELECT payload_json FROM wg_v2_runtime_effects
    WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
      AND effect_kind = 'compensate_run_placement'
  `,
    )
    .get(context.organizationId, context.ownerUserId, key) as { payload_json: string } | undefined
  if (!row) throw new Error("Placement compensation effect is missing")
  const payload = JSON.parse(row.payload_json) as SqlitePlacementCompensation
  database
    .prepare(
      `
    UPDATE wg_v2_runtime_effects SET state = 'pending', payload_json = ?, last_error = ?, updated_at = ?
    WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
  `,
    )
    .run(JSON.stringify({ ...payload, failureHistory: [...(payload.failureHistory ?? []), reason] }), reason, occurredAt, context.organizationId, context.ownerUserId, key)
}

function completeSqlitePlacementCompensationEffect(database: Database, context: WorkGraphContext, key: OperationID, occurredAt: number) {
  database.transaction(() => {
    const row = database
      .prepare(
        `
      SELECT payload_json FROM wg_v2_runtime_effects
      WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
        AND effect_kind = 'compensate_run_placement' AND state = 'claimed'
    `,
      )
      .get(context.organizationId, context.ownerUserId, key) as { payload_json: string } | undefined
    if (!row) return
    const compensation = JSON.parse(row.payload_json) as SqlitePlacementCompensation
    const parkedReason = compensation.failureHistory?.at(-1) ?? compensation.reason
    const changed = database
      .prepare(
        `
      UPDATE wg_v2_runs SET lifecycle = 'parked', parked_reason = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        AND lifecycle IN ('admitted', 'placing') AND session_id IS NULL
    `,
      )
      .run(parkedReason, occurredAt, context.organizationId, context.ownerUserId, compensation.runId)
    if (changed.changes === 1) {
      releaseSqliteRunLeases(database, context, {
        runId: compensation.runId,
        streamId: compensation.streamId,
        workItemId: compensation.workItemId,
      })
      // The Stream hold is derived from this Run landing in `parked`; no
      // persisted `execution_state` write is needed.
      appendRuntimeChange(
        database,
        context,
        {
          type: "run_state_changed",
          runId: compensation.runId,
          streamId: compensation.streamId,
          state: "parked",
        },
        occurredAt,
      )
    }
    completeRuntimeEffect(database, context, key, occurredAt)
  })()
}

async function settleSqlitePlacementCompensationEffect(database: Database, context: WorkGraphContext, key: OperationID, execution: WorkspaceExecutionPort, occurredAt: number) {
  const row = database.transaction(() => {
    const current = database
      .prepare(
        `
      SELECT payload_json FROM wg_v2_runtime_effects
      WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
        AND effect_kind = 'compensate_run_placement' AND state = 'pending'
    `,
      )
      .get(context.organizationId, context.ownerUserId, key) as { payload_json: string } | undefined
    if (!current) return undefined
    const claimed = database
      .prepare(
        `
      UPDATE wg_v2_runtime_effects
      SET state = 'claimed', attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ? AND state = 'pending'
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, key)
    return claimed.changes === 1 ? current : undefined
  })()
  if (!row) return
  const compensation = JSON.parse(row.payload_json) as SqlitePlacementCompensation
  const effects = await Promise.allSettled([
    ...(compensation.sessionId
      ? [
          execution.cancel(context, {
            runId: compensation.runId,
            sessionId: compensation.sessionId,
            reason: compensation.reason,
          }),
        ]
      : []),
    ...(compensation.childIsolationId
      ? [
          execution.cleanup(context, {
            streamId: compensation.streamId,
            envelopeId: compensation.envelopeId,
            childIsolationIds: [compensation.childIsolationId],
            reason: "reconcile",
          }),
        ]
      : []),
  ])
  const failures = effects.flatMap((effect, index) =>
    effect.status === "rejected" ? [`${compensation.sessionId && index === 0 ? "Session cancellation" : "workspace cleanup"} failed: ${runtimeErrorMessage(effect.reason)}`] : [],
  )
  if (failures.length > 0) {
    failSqlitePlacementCompensationEffect(database, context, key, [compensation.reason, ...failures].join("; "), occurredAt)
    return
  }
  completeSqlitePlacementCompensationEffect(database, context, key, occurredAt)
}

async function drainSqlitePlacementCompensationEffects(database: Database, execution: WorkspaceExecutionPort, now: () => number) {
  const pending = database
    .prepare(
      `
    SELECT organization_id, owner_user_id, idempotency_key FROM wg_v2_runtime_effects
    WHERE effect_kind = 'compensate_run_placement' AND state = 'pending' ORDER BY created_at, id
  `,
    )
    .all() as Array<{ organization_id: string; owner_user_id: string; idempotency_key: OperationID }>
  for (const effect of pending) {
    await settleSqlitePlacementCompensationEffect(
      database,
      {
        organizationId: effect.organization_id,
        ownerUserId: effect.owner_user_id,
        actor: { type: "system", id: "workgraph_placement_compensation" },
        requestId: `runtime_${effect.idempotency_key}`,
        access: { mode: "owner" },
      } as WorkGraphContext,
      effect.idempotency_key,
      execution,
      now(),
    )
  }
}

function runtimeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function settleSqliteReplacementEffect(
  database: Database,
  context: WorkGraphContext,
  operationId: OperationID,
  execution: WorkspaceExecutionPort | undefined,
  occurredAt: number,
) {
  const row = database.transaction(() => {
    const current = database
      .prepare(
        `
      SELECT payload_json FROM wg_v2_runtime_effects
      WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ? AND effect_kind = 'reset_stream' AND state = 'pending'
    `,
      )
      .get(context.organizationId, context.ownerUserId, operationId) as { payload_json: string } | undefined
    if (!current) return undefined
    const claimed = database
      .prepare(
        `
      UPDATE wg_v2_runtime_effects SET state = 'claimed', updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ? AND state = 'pending'
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, operationId)
    return claimed.changes === 1 ? current : undefined
  })()
  if (!row) return
  const payload = JSON.parse(row.payload_json) as {
    streamId: StreamID
    proposalId: string
    runIds: RunID[]
    sessions: Array<{ runId: RunID; sessionId: ExecutionSessionID }>
    envelopeId?: StreamEnvelopeID
  }
  if (!execution && (payload.sessions.length > 0 || payload.envelopeId)) {
    failRuntimeEffect(database, context, operationId, "Replacement runtime is not configured", occurredAt)
    return
  }
  try {
    if (execution) {
      for (const session of payload.sessions) {
        await execution.cancel(context, {
          runId: session.runId,
          sessionId: session.sessionId,
          reason: "Replaced by confirmed admission",
        })
      }
      if (payload.envelopeId) {
        await execution.cleanup(context, {
          streamId: payload.streamId,
          envelopeId: payload.envelopeId,
          reason: "replace",
        })
      }
    }
    database.transaction(() => {
      const current = database
        .prepare(
          `
        SELECT replacement_reset_json FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .get(context.organizationId, context.ownerUserId, payload.streamId) as { replacement_reset_json: string | null } | undefined
      const reset = current?.replacement_reset_json ? (JSON.parse(current.replacement_reset_json) as Record<string, unknown>) : undefined
      if (!reset || reset.state !== "pending") {
        completeRuntimeEffect(database, context, operationId, occurredAt)
        return
      }
      if (payload.runIds.length > 0) {
        database
          .prepare(
            `
          UPDATE wg_v2_runs SET lifecycle = 'cancelled', parked_reason = 'Replaced by confirmed admission',
            finished_at = ?, row_version = row_version + 1, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id IN (${payload.runIds.map(() => "?").join(", ")})
            AND lifecycle = 'parked'
        `,
          )
          .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, ...payload.runIds)
      }
      database
        .prepare(
          `
        UPDATE wg_v2_streams SET replacement_reset_json = ?, envelope_identity_json = NULL,
          row_version = row_version + 1, updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .run(JSON.stringify({ ...reset, state: "completed", completedAt: occurredAt }), occurredAt, context.organizationId, context.ownerUserId, payload.streamId)
      appendReplacementResetCompletedChange(database, context, payload, occurredAt)
      completeRuntimeEffect(database, context, operationId, occurredAt)
    })()
  } catch (error) {
    failRuntimeEffect(database, context, operationId, error, occurredAt)
  }
}

function appendReplacementResetCompletedChange(database: Database, context: WorkGraphContext, input: Readonly<{ streamId: StreamID; proposalId: string }>, occurredAt: number) {
  const operationId = `replacement_reset_completed_${input.proposalId}` as OperationID
  if (
    database
      .prepare("SELECT 1 FROM wg_v2_operation_results WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
      .get(context.organizationId, context.ownerUserId, operationId)
  )
    return
  const cursorPosition = allocateSqliteChangeCursor(database, context, occurredAt)
  const cursor = createChangeCursor({
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    position: cursorPosition,
  })
  const sequence = allocateEventSequence(database, context, input.streamId, occurredAt)
  const payload = JSON.stringify({ streamId: input.streamId, proposalId: input.proposalId })
  const result = success(operationId, cursor, { streamId: input.streamId, proposalId: input.proposalId })
  database
    .prepare(
      `
    INSERT INTO wg_v2_operation_results
      (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, change_cursor, created_at)
    VALUES (?, ?, ?, 'runtime_transition', ?, 200, ?, ?, ?)
  `,
    )
    .run(context.organizationId, context.ownerUserId, operationId, hash(operationId), JSON.stringify(result), cursorPosition, occurredAt)
  database
    .prepare(
      `
    INSERT INTO wg_v2_events
      (organization_id, owner_user_id, id, stream_id, sequence, schema_version, operation_id, event_type, actor_type, actor_id, request_id, payload_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, 'stream_replacement_reset_completed', 'system', 'workgraph_runtime', ?, ?, ?)
  `,
    )
    .run(context.organizationId, context.ownerUserId, `event_${operationId}`, input.streamId, sequence, operationId, operationId, payload, occurredAt)
  database
    .prepare(
      `
    INSERT INTO wg_v2_changes
      (organization_id, owner_user_id, cursor, id, stream_id, operation_id, resource_type, resource_id, change_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'stream', ?, 'stream_replacement_reset_completed', ?, ?)
  `,
    )
    .run(context.organizationId, context.ownerUserId, cursorPosition, `change_${operationId}`, input.streamId, operationId, input.streamId, payload, occurredAt)
}

async function drainSqliteReplacementEffects(database: Database, execution: WorkspaceExecutionPort, now: () => number) {
  const pending = database
    .prepare(
      `
    SELECT organization_id, owner_user_id, idempotency_key FROM wg_v2_runtime_effects
    WHERE effect_kind = 'reset_stream' AND state = 'pending' ORDER BY created_at, id
  `,
    )
    .all() as Array<{ organization_id: string; owner_user_id: string; idempotency_key: OperationID }>
  for (const effect of pending) {
    await settleSqliteReplacementEffect(
      database,
      {
        organizationId: effect.organization_id,
        ownerUserId: effect.owner_user_id,
        actor: { type: "system", id: "workgraph_replacement_runtime" },
        requestId: `runtime_${effect.idempotency_key}`,
        access: { mode: "owner" },
      } as WorkGraphContext,
      effect.idempotency_key,
      execution,
      now(),
    )
  }
}

function reserveStreamCleanup(
  database: Database,
  context: WorkGraphContext,
  request: Readonly<{
    operationId: OperationID
    command: Extract<WorkGraphCommandRequest["command"], { type: "close_stream" | "delete_stream" }>
  }>,
  occurredAt: number,
):
  | Readonly<{
      ok: true
      stream: { lifecycle: StreamLifecycleState; row_version: number; envelope_identity_json: string | null }
    }>
  | Readonly<{ ok: false; result: CommandResult }> {
  return database.transaction(() => {
    const stream = database
      .prepare(
        `
      SELECT lifecycle, row_version, envelope_identity_json FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, request.command.streamId) as
      | { lifecycle: StreamLifecycleState; row_version: number; envelope_identity_json: string | null }
      | undefined
    if (!stream) return { ok: false as const, result: failure(request.operationId, "not_found", "Stream not found") }
    if (stream.row_version !== request.command.expectedVersion) {
      return { ok: false as const, result: failure(request.operationId, "version_conflict", "Stream version changed") }
    }
    if (request.command.type === "close_stream" && !transitionStream(stream.lifecycle, "closed").ok) {
      return {
        ok: false as const,
        result: failure(request.operationId, "invalid_transition", "Invalid stream transition"),
      }
    }
    if (request.command.type === "delete_stream") {
      const receipts = database
        .prepare(
          `
        SELECT COUNT(*) AS count FROM wg_v2_durable_effect_receipts WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
      `,
        )
        .get(context.organizationId, context.ownerUserId, request.command.streamId) as { count: number }
      if (receipts.count > 0)
        return {
          ok: false as const,
          result: failure(request.operationId, "close_required", "Durable effects require close"),
        }
    }
    const existing = database
      .prepare(
        `
      SELECT operation_id FROM wg_v2_stream_cleanup_reservations WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, request.command.streamId) as { operation_id: string } | undefined
    if (existing && existing.operation_id !== request.operationId) {
      return {
        ok: false as const,
        result: failure(request.operationId, "version_conflict", "Stream cleanup is already reserved"),
      }
    }
    database
      .prepare(
        `
      INSERT OR IGNORE INTO wg_v2_stream_cleanup_reservations
        (organization_id, owner_user_id, stream_id, operation_id, expected_version, cleanup_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        request.command.streamId,
        request.operationId,
        request.command.expectedVersion,
        request.command.type === "delete_stream" ? "delete" : "close",
        occurredAt,
        occurredAt,
      )
    return { ok: true as const, stream }
  })()
}

function releaseStreamCleanup(database: Database, context: WorkGraphContext, operationId: OperationID) {
  database
    .prepare("DELETE FROM wg_v2_stream_cleanup_reservations WHERE organization_id = ? AND owner_user_id = ? AND operation_id = ?")
    .run(context.organizationId, context.ownerUserId, operationId)
}

function completeStreamCleanup(database: Database, context: WorkGraphContext, operationId: OperationID, occurredAt: number) {
  database
    .prepare(
      `
    UPDATE wg_v2_stream_cleanup_reservations SET state = 'completed', updated_at = ?
    WHERE organization_id = ? AND owner_user_id = ? AND operation_id = ?
  `,
    )
    .run(occurredAt, context.organizationId, context.ownerUserId, operationId)
}

function allocateEventSequence(database: Database, context: WorkGraphContext, streamId: string, occurredAt: number) {
  database
    .prepare(
      `
    INSERT OR IGNORE INTO wg_v2_stream_sequences (organization_id, owner_user_id, stream_id, next_sequence, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `,
    )
    .run(context.organizationId, context.ownerUserId, streamId, occurredAt, occurredAt)
  const row = database
    .prepare(
      `
    SELECT next_sequence FROM wg_v2_stream_sequences WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId) as { next_sequence: number }
  database
    .prepare(
      `
    UPDATE wg_v2_stream_sequences SET next_sequence = next_sequence + 1, row_version = row_version + 1, updated_at = ?
    WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
  `,
    )
    .run(occurredAt, context.organizationId, context.ownerUserId, streamId)
  return row.next_sequence
}

function saveResult(database: Database, context: WorkGraphContext, operationId: OperationID, result: CommandResult) {
  database
    .prepare(
      `
    UPDATE wg_v2_operation_results SET result_status = ?, result_json = ?, change_cursor = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .run(
      result.ok ? 200 : 400,
      JSON.stringify(result),
      result.ok ? readChangeCursor(result.cursor, context.organizationId, context.ownerUserId) : null,
      context.organizationId,
      context.ownerUserId,
      operationId,
    )
}

function pending(type: string, resourceType: string, resourceId: string, value: Record<string, unknown>, streamId?: string): PendingResult {
  return { ok: true, type, resourceType, resourceId, value, ...(streamId ? { streamId } : {}) }
}

function rejected(operationId: OperationID, code: CommandErrorCode, message: string, details?: CommandError["details"]): PendingResult {
  return { ok: false, result: failure(operationId, code, message, false, details) }
}

function success(operationId: OperationID, cursor: ChangeCursor, value: Record<string, unknown>): CommandResult {
  return { ok: true, operationId, cursor, value } as CommandResult
}

function failure(operationId: OperationID, code: CommandErrorCode, message: string, retryable = false, details?: CommandError["details"]): CommandResult {
  return { ok: false, operationId, error: { code, message, retryable, ...(details ? { details } : {}) } }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function charterMatchesHash(charter: Readonly<{ text: string; hash: string }>) {
  return hash(charter.text) === charter.hash.toLowerCase()
}

/** A closed or deleted Stream retires its master lane: the wake and the
 *  persistent daily schedule jobs are cancelled so nothing re-launches a
 *  master on a Stream that no longer runs. */
function cancelSqliteMasterJobs(database: Database, context: WorkGraphContext, streamId: string, occurredAt: number) {
  database
    .prepare(
      `
    UPDATE wg_v2_due_jobs SET status = 'cancelled', claimed_by = NULL, claim_expires_at = NULL,
      row_version = row_version + 1, updated_at = ?
    WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND job_type = 'master_wake'
      AND status NOT IN ('completed', 'cancelled')
  `,
    )
    .run(occurredAt, context.organizationId, context.ownerUserId, streamId)
}

/** Owner resolution of a halted master: clears the job's 'attention' state,
 *  the stored escalation reason, and the failure counter so the next enqueue
 *  can re-arm the lane. Only owner-driven paths (resume, public-PR confirm)
 *  call this — agent traffic never un-halts an escalated master. */
function resumeSqliteMaster(database: Database, context: WorkGraphContext, streamId: string, occurredAt: number) {
  database
    .prepare(
      `
    UPDATE wg_v2_due_jobs
    SET status = 'pending', last_error = NULL, lease_epoch = 0, claimed_by = NULL, claim_expires_at = NULL,
      row_version = row_version + 1, updated_at = ?
    WHERE organization_id = ? AND owner_user_id = ? AND job_type = 'master_wake' AND subject_id = ? AND status = 'attention'
  `,
    )
    .run(occurredAt, context.organizationId, context.ownerUserId, streamId)
  database
    .prepare(
      `
    UPDATE wg_v2_streams SET master_status_json = ?
    WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      AND json_extract(master_status_json, '$.state') = 'attention'
  `,
    )
    .run(
      JSON.stringify({
        state: "hibernating",
        sessionId: masterSessionId(streamId),
        message: "Owner resumed the master",
        receiptRefs: [],
        updatedAt: occurredAt,
      }),
      context.organizationId,
      context.ownerUserId,
      streamId,
    )
}

function enqueueSqliteMasterWake(database: Database, context: WorkGraphContext, streamId: string, occurredAt: number, trigger: "mailbox" | "task_settled" | "schedule") {
  const stream = database
    .prepare(
      `
    SELECT charter_json, master_status_json, lifecycle
    FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId) as { charter_json: string | null; master_status_json: string | null; lifecycle: string } | undefined
  // A closed Stream's master never re-arms, and an escalated ('attention')
  // master stays halted with its escalation and failure counter intact until
  // the owner resolves it — settlements and mailbox traffic must not silently
  // dismiss a Needs-you item or reset the loop-breaker.
  if (!stream || stream.lifecycle === "closed") return
  const currentStatus = stream.master_status_json ? (JSON.parse(stream.master_status_json) as { state?: unknown }) : undefined
  if (currentStatus?.state === "attention") return
  const charter = stream.charter_json ? (JSON.parse(stream.charter_json) as { hash?: unknown }) : undefined
  // Receipt refs are re-derived from settled runs when the turn claims;
  // the settlement transaction only marks the wake, it does not aggregate.
  // Overwriting an 'acting' status is safe here: the local turn fence is the
  // job row_version (the older turn's completion supersedes on CAS), so the
  // pending line is the correct face for the newly queued event.
  database
    .prepare(
      `
    UPDATE wg_v2_streams SET master_status_json = ?
    WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .run(
      JSON.stringify({
        state: "pending",
        message: trigger === "mailbox" ? "Master message queued" : "Task settlement queued for master",
        receiptRefs: [],
        ...(typeof charter?.hash === "string" ? { charterHash: charter.hash } : {}),
        updatedAt: occurredAt,
      }),
      context.organizationId,
      context.ownerUserId,
      streamId,
    )
  database
    .prepare(
      `
    INSERT INTO wg_v2_due_jobs
      (organization_id, owner_user_id, id, stream_id, job_type, subject_id, due_at, status, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'master_wake', ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(organization_id, owner_user_id, job_type, subject_id) DO UPDATE SET
      due_at = MIN(wg_v2_due_jobs.due_at, excluded.due_at), status = 'pending', payload_json = excluded.payload_json,
      claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
      lease_epoch = CASE WHEN wg_v2_due_jobs.status IN ('completed', 'cancelled', 'failed_terminal') THEN 0 ELSE wg_v2_due_jobs.lease_epoch END,
      row_version = wg_v2_due_jobs.row_version + 1, updated_at = excluded.updated_at
    WHERE wg_v2_due_jobs.status <> 'attention'
  `,
    )
    .run(context.organizationId, context.ownerUserId, `master_wake_${streamId}`, streamId, streamId, occurredAt, JSON.stringify({ streamId, trigger }), occurredAt, occurredAt)
}

function enqueueSqliteMasterSchedule(database: Database, context: WorkGraphContext, streamId: string, occurredAt: number) {
  database
    .prepare(
      `
    INSERT INTO wg_v2_due_jobs
      (organization_id, owner_user_id, id, stream_id, job_type, subject_id, due_at, status, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'master_wake', ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(organization_id, owner_user_id, job_type, subject_id) DO UPDATE SET
      status = 'pending', due_at = excluded.due_at, claimed_by = NULL, claim_expires_at = NULL,
      last_error = NULL, lease_epoch = 0, row_version = wg_v2_due_jobs.row_version + 1, updated_at = excluded.updated_at
    WHERE wg_v2_due_jobs.status = 'cancelled'
  `,
    )
    .run(
      context.organizationId,
      context.ownerUserId,
      `master_schedule_${streamId}`,
      streamId,
      `${streamId}:schedule`,
      nextDailyMasterRun(occurredAt),
      JSON.stringify({ streamId, trigger: "schedule" }),
      occurredAt,
      occurredAt,
    )
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function reviewableAdmissionPayload(value: unknown) {
  const proposal = objectValue(value)
  const generation = AdmissionProposalGenerationSchema.safeParse(proposal.generation)
  if (
    !generation.success ||
    generation.data.method !== "agent_session" ||
    !Array.isArray(proposal.placementMatches) ||
    !Array.isArray(proposal.outcomes) ||
    !Array.isArray(proposal.workItems) ||
    !Array.isArray(proposal.duplicateMatches)
  )
    return false
  return AdmissionAgentPlanSchema.safeParse({
    source: proposal.source,
    suggestedPlacement: proposal.suggestedPlacement,
    placementMatches: proposal.placementMatches,
    proposedOutcomes: proposal.outcomes.map((value) => {
      const outcome = objectValue(value)
      return {
        key: outcome.key ?? outcome.proposalKey,
        title: outcome.title,
        description: outcome.description,
        successCriteria: outcome.successCriteria,
        execution: outcome.execution,
      }
    }),
    proposedWorkItems: proposal.workItems.map((value) => {
      const item = objectValue(value)
      return {
        key: item.key ?? item.proposalKey,
        outcomeKey: item.outcomeKey ?? item.outcomeProposalKey,
        title: item.title,
        description: item.description,
        dependencyKeys: item.dependencyKeys ?? item.dependencyProposalKeys,
        completionContract: item.completionContract,
        execution: item.execution,
      }
    }),
    duplicateMatches: proposal.duplicateMatches,
  }).success
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

type PendingResult =
  | Readonly<{
      ok: true
      type: string
      resourceType: string
      resourceId: string
      value: Record<string, unknown>
      streamId?: string
    }>
  | Readonly<{ ok: false; result: CommandResult }>

type OperationRow = { request_hash: string; result_json: string }
type StreamRow = {
  id: string
  title: string
  lifecycle: string
  visibility: string
  row_version: number
  envelope_identity_json: string | null
  replacement_reset_json: string | null
  notes_source_json: string | null
  public_pr_confirmed_at: string | number | null
  execution_defaults_json: string
}
type OutcomeRow = { id: string; stream_id: string; lifecycle: string; row_version: number }
type WorkItemVersionRow = {
  id: string
  stream_id: string
  parent_task_id: string | null
  lifecycle: string
  row_version: number
}
type DecisionRow = { id: string; stream_id: string; lifecycle: string; options_json: string; row_version: number }
type AdmissionProposalRow = {
  source_revision_id: string
  intake_candidate_id: string | null
  lifecycle: string
  proposed_work_json: string
  row_version: number
}
type SourceRevisionRow = { work_source_id: string; id: string; revision_number: number; content: string }
type WorkSourceRecordRow = {
  id: WorkSourceID
  title: string
  latest_revision_number: number
  created_at: string | number
  updated_at: string | number
}
type WorkSourceRevisionRecordRow = {
  work_source_id: WorkSourceID
  id: WorkSourceRevisionID
  revision_number: number
  content: string
  content_hash: string
  origin_kind: string
  origin_reference_json: string | null
  created_at: string | number
}
type WorkItemRow = { id: string; completion_contract_json: string }
type EvidenceRow = {
  id: string
  requirement_id: string | null
  source_run_id: string | null
  reference_json: string
  provenance_json: string
  created_at: string | number
}
type StoredEvidenceRow = EvidenceRow & { subject_type: string; subject_id: string }
type SqliteUsageRow = {
  id: string
  run_id: string | null
  resolved_execution_profile_json: string | null
  provider_id: string
  model_id: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  created_at: number
}
type ChangeRow = {
  cursor: number
  change_id: string
  stream_id: string | null
  operation_id: OperationID
  resource_type: "workgraph" | "work_source" | "stream" | "outcome" | "work_item" | "run" | "decision" | "evidence" | "admission_proposal"
  resource_id: string
  change_type:
    | "workgraph_defaults_updated"
    | "work_source_created"
    | "work_source_revised"
    | "admission_proposed"
    | "admission_proposal_updated"
    | "admission_dismissed"
    | "admission_reopened"
    | "admission_confirmed"
    | "stream_created"
    | "stream_updated"
    | "stream_charter_updated"
    | "master_called"
    | "master_audit_recorded"
    | "public_pr_confirmation_requested"
    | "public_pr_confirmed"
    | "stream_lifecycle_changed"
    | "stream_visibility_changed"
    | "stream_replacement_reset_completed"
    | "stream_closed"
    | "stream_deleted"
    | "outcome_created"
    | "outcome_updated"
    | "outcome_ready_to_close"
    | "outcome_closed"
    | "outcome_reopened"
    | "work_item_created"
    | "work_item_updated"
    | "work_item_state_changed"
    | "work_item_approved"
    | "work_item_rejected"
    | "work_item_restaged"
    | "run_admitted"
    | "run_state_changed"
    | "run_completed"
    | "run_cancelled"
    | "decision_proposed"
    | "decision_answered"
    | "decision_dismissed"
    | "evidence_recorded"
  payload_json: string
  created_at: string | number
  event_id: string
  event_stream_id: string | null
  sequence: number
  schema_version: number
  actor_type: "user" | "agent" | "system"
  actor_id: string
  request_id: string
  correlation_id: string | null
  causation_id: string | null
  occurred_at: string | number
}
type StreamRecordRow = {
  id: string
  parent_stream_id: string | null
  title: string
  purpose: string
  charter_json: string | null
  master_status_json: string | null
  notes_source_json: string | null
  public_pr_confirmed_at: string | number | null
  lifecycle: string
  visibility: string
  pinned: number
  execution_defaults_json: string
  spend_json: string | null
  activity_granularity: string
  replacement_reset_json: string | null
  last_activity_at: string | number | null
  row_version: number
  created_at: string | number
  updated_at: string | number
}
type OutcomeRecordRow = {
  id: string
  stream_id: string
  title: string
  description: string
  lifecycle: string
  success_criteria_json: string
  execution_defaults_json: string
  completed_at: string | number | null
  closed_by_json: string | null
  close_reason: string | null
  reopened_at: string | number | null
  reopen_reason: string | null
  row_version: number
  created_at: string | number
  updated_at: string | number
}
type WorkItemRecordRow = {
  id: string
  stream_id: string
  parent_task_id: string | null
  outcome_id: string | null
  title: string
  description: string
  lifecycle: string
  priority: number
  execution_overrides_json: string
  completion_contract_json: string
  created_by_actor_type: "user" | "agent" | "system" | null
  created_by_actor_id: string | null
  origin_run_id: string | null
  auto_admitted: number | null
  abandoned_reason: string | null
  abandoned_at: string | number | null
  row_version: number
  created_at: string | number
  updated_at: string | number
}
type RunRecordRow = {
  id: string
  stream_id: string
  work_item_id: string
  run_number: number
  generation: number
  lifecycle: string
  execution_kind: "managed" | "attached"
  resolved_execution_profile_json: string
  envelope_id: string | null
  child_workspace_id: string | null
  session_id: string | null
  terminal_result_json: string | null
  parked_reason: string | null
  resume_attempts: number
  completion_retry_json: string | null
  row_version: number
  created_at: string | number
  updated_at: string | number
  started_at: string | number | null
  finished_at: string | number | null
}
type DecisionRecordRow = {
  id: string
  stream_id: string
  question: string
  options_json: string
  recommendation_json: string | null
  rationale: string | null
  answer_json: string | null
  lifecycle: string
  answered_by_json: string | null
  answered_at: string | number | null
  row_version: number
  created_at: string | number
  updated_at: string | number
}
type AdmissionRecordRow = {
  id: string
  lifecycle: string
  proposed_work_json: string
  duplicate_matches_json: string
  row_version: number
  created_at: string | number
  updated_at: string | number
  source_title: string
}
type AttentionRow = {
  kind: "admission_proposal" | "decision" | "work_item" | "run" | "unorganized_ai_work" | "configuration_required" | "master_escalation"
  id: string
  updated_at: number
  job_type: string | null
  subject_id: string | null
  stream_id: string | null
  last_error: string | null
  payload_json: string | null
}
class AppendFailure extends Error {}
