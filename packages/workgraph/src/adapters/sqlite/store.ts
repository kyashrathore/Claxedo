import { createHash } from "node:crypto"
import type BetterSqlite3 from "better-sqlite3"
import {
  AdmissionAgentPlanSchema,
  AdmissionProposalDtoSchema,
  AdmissionProposalGenerationSchema,
  AttentionItemSchema,
  AttentionPageSchema,
  AttemptDtoSchema,
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
  ModelSelectionSchema,
  OutcomeDtoSchema,
  readAttentionCursor,
  readChangeCursor,
  readEvidencePageCursor,
  SnapshotResumeCursorError,
  readWorkSourcePageCursor,
  RecapDtoSchema,
  RecapProfileDefaultsSchema,
  resolveRecapProfileDefaults,
  ReplacementReviewSchema,
  ResolvedExecutionProfileSchema,
  StreamDtoSchema,
  WorkGraphDefaultsDtoSchema,
  WorkGraphNotificationSchema,
  WorkItemDtoSchema,
  WorkSourceDtoSchema,
  WorkSourceRevisionDtoSchema,
  type ExecutionCapabilities,
  type ExecutionProfileDefaults,
  type RecapProfileDefaults,
} from "../../contracts"
import type {
  AttentionListInput,
  AttentionPage,
  ChangeCursor,
  SnapshotResumeCursor,
  ChangeEnvelope,
  CommandErrorCode,
  CommandResult,
  CompletionContract,
  EvidenceDto,
  EvidenceListInput,
  EvidencePage,
  EvidenceReadInput,
  EvidenceInput,
  EvidenceSubject,
  ExecutionMode,
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
  AttemptID,
  WorkItemID,
  AdmissionProposalDto,
  DecisionDto,
  RecapDto,
  ReplacementReview,
  ReplacementReviewInput,
  WorkItemDto,
  WorkGraphEventType,
  ChangeResource,
} from "../../contracts"
import { dependencyGraphHasCycle } from "../../domain"
import {
  AttemptDetailDtoSchema,
  WorkItemAttemptPageSchema,
  createWorkItemAttemptPageCursor,
  readWorkItemAttemptPageCursor,
} from "../../contracts/details"
import type { AttemptDetailDto, WorkItemAttemptListInput, WorkItemAttemptPage } from "../../contracts/details"
import { createWorkGraphService, type WorkGraphService } from "../../application/workgraph-service"
import {
  rankDuplicateMatches,
  rankStreamMatches,
  type DuplicateCandidate,
  type MatchableStream,
} from "../../application/matching-service"
import { placeAdmittedAttempt, type PlacementCompensation } from "../../application/execution-service"
import type { AttemptResultStore } from "../../application/completion-service"
import { completeOutcome, evaluateCompletionContract, reopenOutcome } from "../../domain/completion"
import { transitionDecision, transitionStream, transitionStreamVisibility } from "../../domain/transitions"
import { resolveExecutionProfile } from "../../domain/execution-profile"
import {
  validateExecutionProfileDefaultsAgainstCapabilities,
  validateRecapProfileDefaultsAgainstCapabilities,
  validateResolvedExecutionProfileAgainstCapabilities,
} from "../../domain/execution-capability-policy"
import {
  defineAtomicWorkGraphStore,
  type AtomicWorkGraphStore,
  type WorkGraphCommandHandler,
  type WorkGraphCommandHandlers,
} from "../../ports/store"
import type { ExecutionSessionID, StreamEnvelopeID, WorkspaceExecutionPort } from "../../ports/workspace-execution"
import type { AttemptRuntimePort } from "../../ports/attempt-runtime"
import type { ExecutionCapabilitiesPort } from "../../ports/execution-capabilities"
import type { SqliteInput } from "../../sqlite"
import { assertNoSqliteWorkGraphOwnerDeletion, SqliteWorkGraphOwnerDeletionInProgressError } from "./deletion-barrier"
import { initializeWorkGraphSqliteSchema } from "./schema"
import { createSqliteWorkGraphActivityPorts } from "./activity-store"
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
  WHERE organization_id = @organization AND owner_user_id = @owner AND lifecycle IN ('result_ready', 'blocked', 'review_needed', 'integration_needed', 'verification_failed', 'failed')
  UNION ALL
  SELECT 'attempt', id, CAST(updated_at AS INTEGER), NULL, NULL, NULL, NULL, NULL
  FROM wg_v2_attempts WHERE organization_id = @organization AND owner_user_id = @owner AND lifecycle = 'attention'
  UNION ALL
  SELECT 'recap_notification', notifications.id, CAST(notifications.updated_at AS INTEGER), NULL, NULL, NULL, NULL, NULL
  FROM wg_v2_notifications notifications
  JOIN wg_v2_recaps recaps
    ON recaps.organization_id = notifications.organization_id AND recaps.owner_user_id = notifications.owner_user_id AND recaps.id = notifications.recap_id
  WHERE notifications.organization_id = @organization AND notifications.owner_user_id = @owner AND notifications.state = 'unread'
    AND json_extract(recaps.generation_result_json, '$.state') = 'succeeded'
    AND json_extract(recaps.generation_result_json, '$.method') = 'agent_session'
    AND json_extract(recaps.generation_result_json, '$.sessionId') IS NOT NULL
    AND json_array_length(recaps.actionable_references_json) > 0
  UNION ALL
  SELECT 'unorganized_ai_work', 'unorganized_ai_work', CAST(MAX(updated_at) AS INTEGER), NULL, NULL, NULL, NULL, NULL
  FROM wg_v2_intake_candidates WHERE organization_id = @organization AND owner_user_id = @owner
  HAVING SUM(CASE WHEN status = 'unorganized' THEN 1 ELSE 0 END) > 0
  UNION ALL
  SELECT 'configuration_required', id, CAST(updated_at AS INTEGER), job_type, subject_id, stream_id, last_error, payload_json
  FROM wg_v2_due_jobs
  WHERE organization_id = @organization AND owner_user_id = @owner AND job_type IN ('source_plan', 'recap')
    AND status IN ('pending', 'failed', 'failed_terminal', 'attention')
    AND last_error IS NOT NULL
    AND json_extract(payload_json, '$.configurationRequirement.type') = 'generation'
`

export const SQLITE_WORKGRAPH_SUPPORTED_COMMANDS = [
  "update_workgraph_defaults",
  "create_work_source",
  "revise_work_source",
  "create_stream",
  "update_stream",
  "set_stream_lifecycle",
  "create_outcome",
  "update_outcome",
  "create_work_item",
  "update_work_item",
  "propose_admission",
  "retry_admission_planning",
  "dismiss_admission",
  "reopen_admission",
  "confirm_admission",
  "set_stream_visibility",
  "propose_decision",
  "answer_decision",
  "dismiss_decision",
  "record_attempt_checkpoint",
  "complete_attempt",
  "record_evidence",
  "close_outcome",
  "reopen_outcome",
  "close_stream",
  "delete_stream",
  "cancel_work_item",
] as const

export const SQLITE_WORKGRAPH_UNSUPPORTED_COMMANDS = [
  "execute_stream",
  "execute_work_item",
  "cancel_attempt",
  "retry_work_item",
] as const

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
    page: (
      context: WorkGraphContext,
      input: Readonly<{ after?: SnapshotResumeCursor; limit: number }>,
    ) => Promise<WorkGraphSnapshotPage>
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
    read: (
      context: WorkGraphContext,
      input: Readonly<{ workSourceId: WorkSourceID }>,
    ) => Promise<WorkSourceDto | undefined>
    readRevision: (
      context: WorkGraphContext,
      input: Readonly<{ workSourceId: WorkSourceID; revisionId: WorkSourceRevisionID }>,
    ) => Promise<WorkSourceRevisionDto | undefined>
  }>
  changes: Readonly<{
    list: (
      context: WorkGraphContext,
      input: Readonly<{ after?: ChangeCursor; limit?: number }>,
    ) => Promise<readonly ChangeEnvelope[]>
    listStream: (
      context: WorkGraphContext,
      input: Readonly<{ streamId: StreamID; after?: ChangeCursor }>,
    ) => Promise<readonly ChangeEnvelope[]>
  }>
  proposals: Readonly<{
    read: (
      context: WorkGraphContext,
      input: Readonly<{ proposalId: string }>,
    ) => Promise<AdmissionProposalDto | undefined>
    replacementReview: (
      context: WorkGraphContext,
      input: ReplacementReviewInput,
    ) => Promise<ReplacementReview | undefined>
  }>
  workItems: Readonly<{
    read: (
      context: WorkGraphContext,
      input: Readonly<{ workItemId: string }>,
    ) => Promise<Readonly<{ id: string; completionSatisfied: boolean }> | undefined>
    readDetail: (context: WorkGraphContext, input: Readonly<{ workItemId: string }>) => Promise<WorkItemDto | undefined>
    listAttempts: (context: WorkGraphContext, input: WorkItemAttemptListInput) => Promise<WorkItemAttemptPage>
    listActivity: (context: WorkGraphContext, input: TaskActivityListInput) => Promise<TaskActivityPage>
  }>
  attempts: Readonly<{
    read: (context: WorkGraphContext, input: Readonly<{ attemptId: string }>) => Promise<AttemptDetailDto | undefined>
  }>
  decisions: Readonly<{
    read: (context: WorkGraphContext, input: Readonly<{ decisionId: string }>) => Promise<DecisionDto | undefined>
  }>
  recaps: Readonly<{
    read: (context: WorkGraphContext, input: Readonly<{ recapId: string }>) => Promise<RecapDto | undefined>
  }>
  evidence: Readonly<{
    read: (context: WorkGraphContext, input: EvidenceReadInput) => Promise<EvidenceDto | undefined>
    list: (context: WorkGraphContext, input: EvidenceListInput) => Promise<EvidencePage>
  }>
}>

type SqliteStoreResult = Readonly<{
  store: AtomicWorkGraphStore<SqliteCommands, SqliteQueries>
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
  let autonomousDrain: Promise<void> | undefined
  const scheduleReplacementDrain = () => {
    if (!input.execution || replacementRetryTimer || !database.open) return
    replacementRetryTimer = setTimeout(
      () => void drainReplacementEffects(),
      Math.max(1, input.replacementRetryDelayMs ?? 1_000),
    )
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
    placementCompensationRetryTimer = setTimeout(
      () => void drainPlacementCompensationEffects(),
      Math.max(1, input.replacementRetryDelayMs ?? 1_000),
    )
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
      WHERE effect_kind = 'compensate_attempt_placement' AND state = 'pending' LIMIT 1
    `,
      )
      .get()
    if (pending) schedulePlacementCompensationDrain()
  }
  const drainAutonomousExecutions = () => {
    if (!input.execution || !input.executionCapabilities || !database.open) return Promise.resolve()
    if (autonomousDrain) return autonomousDrain
    autonomousDrain = drainSqliteAutonomousStreams(
      database,
      input.execution,
      input.executionCapabilities,
      ids,
      clock.now,
      schedulePlacementCompensationDrain,
    ).finally(() => {
      autonomousDrain = undefined
    })
    return autonomousDrain
  }

  const execute: WorkGraphCommandHandler = async (context, request) => {
    if (context.access.mode !== "owner") return failure(request.operationId, "forbidden", "Owner access is required")

    const requestHash = hash(stableJson(request.command))
    const previous = database
      .prepare(
        "SELECT request_hash, result_json FROM wg_v2_operation_results WHERE organization_id = ? AND owner_user_id = ? AND id = ?",
      )
      .get(context.organizationId, context.ownerUserId, request.operationId) as OperationRow | undefined
    if (previous?.request_hash === requestHash) return JSON.parse(previous.result_json) as CommandResult
    if (previous) return failure(request.operationId, "idempotency_conflict", "Operation ID already used")
    const capabilityCheck = await validateCommandCapabilities(input.executionCapabilities, context, request, clock.now)
    if (!capabilityCheck.ok)
      return failure(request.operationId, capabilityCheck.code, capabilityCheck.message, capabilityCheck.retryable)
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
          .run(
            context.organizationId,
            context.ownerUserId,
            request.operationId,
            request.command.type,
            requestHash,
            occurredAt,
          )

        const pending = applyCommand(database, context, request, occurredAt, ids, capabilityCheck.capabilities)
        if (!pending.ok) {
          saveResult(database, context, request.operationId, pending.result)
          return pending.result
        }

        if (failNextAppend) {
          failNextAppend = false
          throw new AppendFailure()
        }

        const cursorPosition = allocateCursor(database, context, occurredAt)
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
      if (error instanceof AppendFailure)
        return failure(request.operationId, "internal_error", "Event/change append failed")
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
      request.command.type === "cancel_attempt"
        ? (database
            .prepare("SELECT session_id FROM wg_v2_attempts WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
            .get(context.organizationId, context.ownerUserId, request.command.attemptId) as
            | { session_id: string | null }
            | undefined)
        : undefined
    if (request.command.type === "cancel_attempt" && cancelledSession?.session_id) {
      reserveRuntimeEffect(
        database,
        context,
        {
          operationId: request.operationId,
          kind: "cancel_attempt",
          resourceType: "attempt",
          resourceId: request.command.attemptId,
          payload: { sessionId: cancelledSession.session_id, reason: request.command.reason },
        },
        clock.now(),
      )
      try {
        await input.execution.cancel(context, {
          attemptId: request.command.attemptId,
          sessionId: cancelledSession.session_id as never,
          reason: request.command.reason,
        })
        completeRuntimeEffect(database, context, request.operationId, clock.now())
      } catch (error) {
        failRuntimeEffect(database, context, request.operationId, error, clock.now())
        return failure(
          request.operationId,
          "execution_unavailable",
          error instanceof Error ? error.message : String(error),
          true,
        )
      }
    }
    const result = await execute(context, request)
    if (!result.ok) return result
    if (request.command.type === "cancel_attempt") return result
    if (
      request.command.type === "execute_stream" ||
      request.command.type === "execute_work_item" ||
      request.command.type === "retry_work_item"
    ) {
      const value = result.value as { attemptId?: string; attemptIds?: string[] }
      await Promise.all(
        (value.attemptIds ?? (value.attemptId ? [value.attemptId] : [])).map((attemptId) =>
          launchAttempt(
            database,
            input.execution!,
            context,
            attemptId as AttemptID,
            clock.now(),
            ids,
            schedulePlacementCompensationDrain,
          ),
        ),
      )
      return result
    }
    await drainAutonomousExecutions()
    return result
  }

  const executeWithAutonomousContinuation: WorkGraphCommandHandler = async (context, request) => {
    const result = await execute(context, request)
    if (result.ok) await drainAutonomousExecutions()
    return result
  }

  const executeAdmissionWithRuntime: WorkGraphCommandHandler = async (context, request) => {
    const result = await execute(context, request)
    if (!result.ok) return result
    if (request.command.type === "confirm_admission" && request.command.selection.mode === "replace") {
      queueMicrotask(() => void drainReplacementEffects())
    }
    await drainAutonomousExecutions()
    return result
  }

  const unavailable: WorkGraphCommandHandler = async (context, request) => {
    if (context.access.mode !== "owner") return failure(request.operationId, "forbidden", "Owner access is required")
    return failure(request.operationId, "execution_unavailable", "WorkGraph execution runtime is not configured")
  }

  const executeLifecycleWithRuntime: WorkGraphCommandHandler = async (context, request) => {
    if (!input.execution || (request.command.type !== "delete_stream" && request.command.type !== "close_stream"))
      return execute(context, request)
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
    const reservation = reserveStreamCleanup(
      database,
      context,
      { operationId: request.operationId, command },
      clock.now(),
    )
    if (!reservation.ok) return reservation.result
    const stream = reservation.stream
    const envelope = stream?.envelope_identity_json
      ? (JSON.parse(stream.envelope_identity_json) as { id?: string })
      : undefined
    const running = database
      .prepare(
        `
      SELECT id, session_id FROM wg_v2_attempts WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
        AND lifecycle IN ('admitted', 'placing', 'running', 'attention')
    `,
      )
      .all(context.organizationId, context.ownerUserId, command.streamId) as Array<{
      id: AttemptID
      session_id: ExecutionSessionID | null
    }>
    for (const attempt of running.filter((candidate) => candidate.session_id)) {
      await input.execution.cancel(context, {
        attemptId: attempt.id,
        sessionId: attempt.session_id!,
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
    if (result.ok && command.type === "close_stream")
      completeStreamCleanup(database, context, request.operationId, clock.now())
    return result
  }

  const commands = {
    update_workgraph_defaults: executeWithAutonomousContinuation,
    create_work_source: executeWithAutonomousContinuation,
    revise_work_source: executeWithAutonomousContinuation,
    create_stream: executeWithAutonomousContinuation,
    update_stream: executeWithAutonomousContinuation,
    set_stream_lifecycle: executeWithAutonomousContinuation,
    create_outcome: executeWithAutonomousContinuation,
    update_outcome: executeWithAutonomousContinuation,
    create_work_item: executeWithAutonomousContinuation,
    update_work_item: executeWithAutonomousContinuation,
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
    record_attempt_checkpoint: execute,
    complete_attempt: executeWithAutonomousContinuation,
    record_evidence: executeWithAutonomousContinuation,
    close_outcome: executeWithAutonomousContinuation,
    reopen_outcome: executeWithAutonomousContinuation,
    close_stream: executeLifecycleWithRuntime,
    delete_stream: executeLifecycleWithRuntime,
    execute_stream: executeWithRuntime,
    execute_work_item: executeWithRuntime,
    cancel_attempt: executeWithRuntime,
    retry_work_item: executeWithRuntime,
  } satisfies SqliteCommands

  if (input.execution)
    queueMicrotask(() => {
      void drainReplacementEffects()
      void drainPlacementCompensationEffects()
      void drainAutonomousExecutions()
    })

  return {
    store: defineAtomicWorkGraphStore({ commands, queries: createQueries(database, clock) }),
    faults: {
      failNextAppend: () => {
        failNextAppend = true
      },
    },
  }
}

export function createSqliteWorkGraphService(input: SqliteWorkGraphStoreInput): Readonly<{
  service: WorkGraphService<SqliteCommands, SqliteQueries>
  attemptRuntime: AttemptRuntimePort
  attemptResults: AttemptResultStore
  faults: Readonly<{ failNextAppend: () => void }>
}> {
  const adapter = createSqliteWorkGraphStore(input)
  const attemptRuntime = createSqliteAttemptRuntime(input.database, input.clock)
  return {
    service: createWorkGraphService(adapter.store),
    attemptRuntime,
    attemptResults: attemptRuntime,
    faults: adapter.faults,
  }
}

export function createSqliteAttemptRuntime(
  database: Database,
  clock: Readonly<{ now: () => number }> = { now: () => Date.now() },
): AttemptRuntimePort {
  return {
    listReconcilable: async (context) => listSqliteReconcilableAttempts(database, context),
    renewLease: async (context, input) => renewSqliteAttemptLease(database, context, input),
    recordResult: async (context, input) => {
      if (input.state === "result") {
        if (!input.summary.trim()) throw new Error("Attempt result summary must be non-empty")
        if (
          !Array.isArray(input.artifacts) ||
          input.artifacts.some((artifact) => typeof artifact !== "string" || !artifact.trim())
        ) {
          throw new Error("Attempt result artifacts must be an explicit array of non-empty references")
        }
      }
      const occurredAt = clock.now()
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
        const attempt = database
          .prepare(
            `
          SELECT stream_id, work_item_id, lifecycle, terminal_result_json, lease_epoch FROM wg_v2_attempts
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND work_item_id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.attemptId, input.workItemId) as
          | {
              stream_id: StreamID
              work_item_id: WorkItemID
              lifecycle: string
              terminal_result_json: string | null
              lease_epoch: number
            }
          | undefined
        if (!attempt || attempt.lease_epoch !== input.leaseEpoch) return false
        const terminalResult =
          input.state === "result"
            ? JSON.stringify({ summary: input.summary, artifactRefs: input.artifacts, finishedAt: occurredAt })
            : null
        if (["result", "failed", "cancelled"].includes(attempt.lifecycle)) {
          if (attempt.lifecycle === "result" && input.state === "result" && attempt.terminal_result_json) {
            const previous = JSON.parse(attempt.terminal_result_json) as { summary: string; artifactRefs: string[] }
            if (previous.summary === input.summary && stableJson(previous.artifactRefs) === stableJson(input.artifacts))
              return true
          }
          if (attempt.lifecycle === input.state && input.state !== "result") return true
          throw new Error("Attempt already has a different terminal result")
        }
        const lease = database
          .prepare(
            `
          SELECT 1 FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
            AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
        `,
          )
          .get(
            context.organizationId,
            context.ownerUserId,
            input.workItemId,
            input.attemptId,
            input.leaseEpoch,
            occurredAt,
          )
        if (!lease) return false
        const changed = database
          .prepare(
            `
          UPDATE wg_v2_attempts SET lifecycle = ?, terminal_result_json = ?, attention_reason = ?, finished_at = ?,
            updated_at = ?, row_version = row_version + 1
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lease_epoch = ? AND lifecycle IN ('placing', 'running', 'attention')
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
            input.attemptId,
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
          .run(
            input.state === "result" ? "result_ready" : "failed",
            occurredAt,
            context.organizationId,
            context.ownerUserId,
            input.workItemId,
          )
        database
          .prepare(
            `
          DELETE FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
            AND holder_id = ? AND epoch = ?
        `,
          )
          .run(context.organizationId, context.ownerUserId, input.workItemId, input.attemptId, input.leaseEpoch)
        appendRuntimeChange(
          database,
          context,
          {
            type: "attempt_state_changed",
            attemptId: input.attemptId,
            streamId: attempt.stream_id,
            state: input.state,
          },
          occurredAt,
        )
        return true
      })()
    },
  }
}

export function createSqliteAttemptResultStore(
  database: Database,
  clock?: Readonly<{ now: () => number }>,
): AttemptResultStore {
  return createSqliteAttemptRuntime(database, clock)
}

export function listSqliteReconcilableAttempts(database: Database, context: WorkGraphContext) {
  return database
    .prepare(
      `
    SELECT attempts.id AS attemptId, attempts.stream_id AS streamId, attempts.work_item_id AS workItemId,
      attempts.session_id AS sessionId, attempts.envelope_id AS envelopeId,
      attempts.child_workspace_id AS childIsolationId, attempts.resolved_execution_profile_json AS profileJson,
      attempts.lease_epoch AS leaseEpoch, CAST(leases.expires_at AS INTEGER) AS leaseExpiresAt
    FROM wg_v2_attempts attempts
    JOIN wg_v2_leases leases ON leases.organization_id = attempts.organization_id AND leases.owner_user_id = attempts.owner_user_id AND leases.resource_type = 'work_item'
      AND leases.resource_id = attempts.work_item_id AND leases.holder_id = attempts.id AND leases.epoch = attempts.lease_epoch
    WHERE attempts.organization_id = ? AND attempts.owner_user_id = ? AND attempts.lifecycle = 'running' AND attempts.session_id IS NOT NULL
    ORDER BY attempts.created_at, attempts.id
  `,
    )
    .all(context.organizationId, context.ownerUserId) as Array<{
    attemptId: AttemptID
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

/** Renews an owned lease or adopts the same durable Attempt after expiry. */
export function renewSqliteAttemptLease(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{ attemptId: AttemptID; expectedLeaseEpoch: number; occurredAt: number; durationMs: number }>,
) {
  return database.transaction(() => {
    assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
    const row = database
      .prepare(
        `
      SELECT attempts.stream_id, attempts.work_item_id, attempts.lease_epoch, leases.holder_id, leases.epoch,
        CAST(leases.expires_at AS INTEGER) AS expires_at
      FROM wg_v2_attempts attempts
      JOIN wg_v2_leases leases ON leases.organization_id = attempts.organization_id AND leases.owner_user_id = attempts.owner_user_id AND leases.resource_type = 'work_item'
        AND leases.resource_id = attempts.work_item_id
      WHERE attempts.organization_id = ? AND attempts.owner_user_id = ? AND attempts.id = ? AND attempts.lifecycle IN ('admitted', 'placing', 'running', 'attention')
    `,
      )
      .get(context.organizationId, context.ownerUserId, input.attemptId) as
      | {
          stream_id: StreamID
          work_item_id: WorkItemID
          lease_epoch: number
          holder_id: AttemptID
          epoch: number
          expires_at: number
        }
      | undefined
    if (
      !row ||
      row.holder_id !== input.attemptId ||
      row.epoch !== row.lease_epoch ||
      row.epoch !== input.expectedLeaseEpoch
    )
      return undefined
    const epoch = row.expires_at <= input.occurredAt ? row.epoch + 1 : row.epoch
    const expiresAt = input.occurredAt + input.durationMs
    const renewed = database
      .prepare(
        `
      UPDATE wg_v2_leases SET epoch = ?, expires_at = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ? AND holder_id = ? AND epoch = ?
    `,
      )
      .run(
        epoch,
        expiresAt,
        input.occurredAt,
        context.organizationId,
        context.ownerUserId,
        row.work_item_id,
        input.attemptId,
        row.epoch,
      )
    if (renewed.changes !== 1) return undefined
    if (epoch !== row.epoch) {
      database
        .prepare(
          `
        UPDATE wg_v2_attempts SET lease_epoch = ?, updated_at = ?, row_version = row_version + 1
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lease_epoch = ?
      `,
        )
        .run(epoch, input.occurredAt, context.organizationId, context.ownerUserId, input.attemptId, row.epoch)
      appendRuntimeChange(
        database,
        context,
        { type: "attempt_lease_recovered", attemptId: input.attemptId, streamId: row.stream_id, state: "running" },
        input.occurredAt,
      )
    }
    return { leaseEpoch: epoch, expiresAt, recovered: epoch !== row.epoch }
  })()
}

async function drainSqliteAutonomousStreams(
  database: Database,
  execution: WorkspaceExecutionPort,
  capabilityPort: ExecutionCapabilitiesPort,
  ids: Readonly<{ next: (kind: string) => string }>,
  now: () => number,
  schedulePlacementCompensationDrain?: () => void,
) {
  const streams = database
    .prepare(
      `
    SELECT organization_id, owner_user_id, id FROM wg_v2_streams
    WHERE execution_mode = 'autonomous' AND execution_state = 'active'
    ORDER BY updated_at, id LIMIT 100
  `,
    )
    .all() as Array<{ organization_id: string; owner_user_id: string; id: StreamID }>
  for (const stream of streams) {
    const context = {
      organizationId: stream.organization_id,
      ownerUserId: stream.owner_user_id,
      actor: { type: "system", id: "workgraph_autonomous_runtime" },
      requestId: `autonomous_${stream.id}`,
      access: { mode: "owner" },
    } as WorkGraphContext
    const capabilities = await capabilityPort.read(context, {}).catch((error) => {
      database
        .prepare(
          `
        UPDATE wg_v2_streams SET execution_state = 'stopped', updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND execution_state = 'active'
      `,
        )
        .run(now(), context.organizationId, context.ownerUserId, stream.id)
      throw error
    })
    const occurredAt = now()
    database.transaction(() =>
      continueSqliteAutonomousStream(database, context, stream.id, occurredAt, ids, capabilities),
    )()
    const admitted = database
      .prepare(
        `
      SELECT id FROM wg_v2_attempts
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle = 'admitted'
      ORDER BY created_at, id
    `,
      )
      .all(context.organizationId, context.ownerUserId, stream.id) as Array<{ id: AttemptID }>
    await Promise.all(
      admitted.map((attempt) =>
        launchAttempt(database, execution, context, attempt.id, now(), ids, schedulePlacementCompensationDrain),
      ),
    )
  }
}

function continueSqliteAutonomousStream(
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
    SELECT lifecycle, execution_mode, execution_state FROM wg_v2_streams
    WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId) as
    | {
        lifecycle: string
        execution_mode: ExecutionMode | null
        execution_state: string | null
      }
    | undefined
  if (
    !stream ||
    stream.execution_mode !== "autonomous" ||
    stream.execution_state !== "active" ||
    stream.lifecycle !== "active"
  )
    return []
  const attention = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_decisions WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle IN ('proposed', 'pending')
    UNION ALL
    SELECT 1 FROM wg_v2_attempts WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle IN ('attention', 'failed')
    LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId, context.organizationId, context.ownerUserId, streamId)
  if (attention) {
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET execution_state = 'stopped', updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND execution_state = 'active'
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, streamId)
    return []
  }
  const ready = database
    .prepare(
      `
    SELECT items.id FROM wg_v2_work_items items
    WHERE items.organization_id = ? AND items.owner_user_id = ? AND items.stream_id = ? AND items.lifecycle = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM wg_v2_work_item_dependencies dependencies
        JOIN wg_v2_work_items blockers ON blockers.organization_id = dependencies.organization_id AND blockers.owner_user_id = dependencies.owner_user_id
          AND blockers.id = dependencies.depends_on_work_item_id
        WHERE dependencies.organization_id = items.organization_id AND dependencies.owner_user_id = items.owner_user_id
          AND dependencies.work_item_id = items.id AND blockers.lifecycle <> 'completed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM wg_v2_decision_work_items affected
        JOIN wg_v2_decisions decisions ON decisions.organization_id = affected.organization_id AND decisions.owner_user_id = affected.owner_user_id
          AND decisions.id = affected.decision_id
        WHERE affected.organization_id = items.organization_id AND affected.owner_user_id = items.owner_user_id
          AND affected.work_item_id = items.id AND decisions.lifecycle IN ('proposed', 'pending')
      )
    ORDER BY items.priority DESC, items.created_at, items.id
  `,
    )
    .all(context.organizationId, context.ownerUserId, streamId) as Array<{ id: WorkItemID }>
  const admissions = ready.flatMap((item) => {
    const admitted = admitAttempt(database, context, item.id, "autonomous", occurredAt, ids, capabilities)
    if (!admitted.ok) return []
    appendRuntimeChange(
      database,
      context,
      {
        type: "attempt_admitted",
        attemptId: admitted.attemptId as AttemptID,
        streamId,
        state: "admitted",
      },
      occurredAt,
    )
    return [admitted.attemptId as AttemptID]
  })
  if (admissions.length > 0) return admissions
  const remaining = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
      AND lifecycle NOT IN ('completed', 'abandoned') LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, streamId)
  if (!remaining) {
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET execution_state = 'completed', updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND execution_state = 'active'
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, streamId)
  }
  return admissions
}

async function validateCommandCapabilities(
  port: ExecutionCapabilitiesPort | undefined,
  context: WorkGraphContext,
  request: WorkGraphCommandRequest,
  now: () => number,
): Promise<
  | Readonly<{ ok: true; capabilities?: ExecutionCapabilities }>
  | Readonly<{ ok: false; code: CommandErrorCode; message: string; retryable?: boolean }>
> {
  const profiles = executionDefaults(request)
  const recapProfiles = streamRecapDefaults(request)
  const admission = ["execute_stream", "execute_work_item", "retry_work_item"].includes(request.command.type)
  if (profiles.length === 0 && recapProfiles.length === 0 && !admission) return { ok: true }
  if (!port)
    return { ok: false, code: "execution_unavailable", message: "Execution capability catalog is not configured" }
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
  const diagnostics = profiles
    .flatMap((profile) => {
      const result = validateExecutionProfileDefaultsAgainstCapabilities({
        organizationId: context.organizationId,
        ownerUserId: context.ownerUserId,
        now: validatedAt,
        capabilities,
        profile,
      })
      return result.ok ? [] : result.diagnostics
    })
    .concat(
      recapProfiles.flatMap((profile) => {
        const result = validateRecapProfileDefaultsAgainstCapabilities({
          organizationId: context.organizationId,
          ownerUserId: context.ownerUserId,
          now: validatedAt,
          capabilities,
          profile,
        })
        return result.ok ? [] : result.diagnostics
      }),
    )
  if (diagnostics.length > 0) return { ok: false, code: "validation_error", message: capabilityMessage(diagnostics) }
  return { ok: true, capabilities }
}

function executionDefaults(request: WorkGraphCommandRequest): readonly ExecutionProfileDefaults[] {
  const command = request.command
  if (command.type === "update_workgraph_defaults") return [command.defaults.execution]
  if (
    [
      "create_stream",
      "update_stream",
      "create_outcome",
      "update_outcome",
      "create_work_item",
      "update_work_item",
    ].includes(command.type) &&
    "execution" in command &&
    command.execution
  ) {
    return [command.execution]
  }
  return []
}

function streamRecapDefaults(request: WorkGraphCommandRequest): readonly RecapProfileDefaults[] {
  const command = request.command
  if (!["create_stream", "update_stream"].includes(command.type) || !("recap" in command) || !command.recap) return []
  return command.recap.model || command.recap.effort ? [command.recap] : []
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
  if (command.type === "update_workgraph_defaults") {
    const root = database
      .prepare(
        `
      SELECT row_version FROM wg_v2_workgraphs WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, rootId) as { row_version: number }
    if (root.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "WorkGraph defaults version changed")
    database
      .prepare(
        `
      UPDATE wg_v2_workgraphs SET defaults_json = ?, recap_defaults_json = ?, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        JSON.stringify(command.defaults.execution),
        JSON.stringify(command.defaults.recap),
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        rootId,
        command.expectedVersion,
      )
    return pending("workgraph_defaults_updated", "workgraph", rootId, { workGraphId: rootId })
  }
  if (command.type === "create_stream") {
    if (command.source) {
      const source = exactSourceHead(database, context, command.source)
      if (!source.exists) return rejected(request.operationId, "not_found", "Work Source revision not found")
      if (!source.current)
        return rejected(request.operationId, "version_conflict", "Stream requires the current Work Source head")
    }
    const streamId = ids.next("stream")
    const root = database.prepare(`
      SELECT defaults_json FROM wg_v2_workgraphs
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `).get(context.organizationId, context.ownerUserId, rootId) as { defaults_json: string }
    const recap = resolveRecapProfileDefaults({
      recap: command.recap,
      execution: {
        ...ExecutionProfileDefaultsSchema.parse(JSON.parse(root.defaults_json)),
        ...command.execution,
      },
    }) ?? command.recap ?? {}
    database
      .prepare(
        `
      INSERT INTO wg_v2_streams
        (organization_id, owner_user_id, id, workgraph_id, title, purpose, lifecycle, execution_defaults_json, recap_defaults_json, activity_granularity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        streamId,
        rootId,
        command.title,
        command.description ?? command.title,
        JSON.stringify(command.execution ?? {}),
        JSON.stringify(recap),
        command.activityGranularity ?? "progress",
        occurredAt,
        occurredAt,
      )
    if (command.source) addSourceReference(database, context, ids, "stream", streamId, command.source, occurredAt)
    return pending("stream_created", "stream", streamId, { streamId }, streamId)
  }
  if (command.type === "update_stream") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Stream version changed")
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET
        title = COALESCE(?, title), purpose = COALESCE(?, purpose),
        execution_defaults_json = COALESCE(?, execution_defaults_json),
        recap_defaults_json = COALESCE(?, recap_defaults_json),
        activity_granularity = COALESCE(?, activity_granularity),
        row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        command.title ?? null,
        command.description ?? null,
        command.execution === undefined ? null : JSON.stringify(command.execution),
        command.recap === undefined ? null : JSON.stringify(command.recap),
        command.activityGranularity ?? null,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.streamId,
        command.expectedVersion,
      )
    return pending("stream_updated", "stream", command.streamId, { streamId: command.streamId }, command.streamId)
  }
  if (command.type === "set_stream_lifecycle") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Stream version changed")
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
    }
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET lifecycle = ?, row_version = row_version + 1, updated_at = ?, closed_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        transition.state,
        occurredAt,
        transition.state === "closed" ? occurredAt : null,
        context.organizationId,
        context.ownerUserId,
        command.streamId,
        command.expectedVersion,
      )
    return pending(
      "stream_lifecycle_changed",
      "stream",
      command.streamId,
      { streamId: command.streamId },
      command.streamId,
    )
  }
  if (command.type === "create_work_source") {
    const contentHash = hash(command.content)
    if (command.authoring && contentHash !== command.authoring.contentHash) {
      return rejected(
        request.operationId,
        "validation_error",
        "Authoring revision content does not match its declared content hash",
      )
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
      .get(context.organizationId, context.ownerUserId, command.workSourceId) as
      | { latest_revision_number: number; source_kind: string; metadata_json: string }
      | undefined
    if (!source) return rejected(request.operationId, "not_found", "Work Source not found")
    if ((source.source_kind === "authoring") !== !!command.authoring) {
      return rejected(
        request.operationId,
        "validation_error",
        "Authoring Work Sources require exact authoring provenance on every revision",
      )
    }
    const authoringIdentity = command.authoring
      ? AuthoringSourceRevisionSchema.parse(JSON.parse(source.metadata_json))
      : undefined
    if (
      command.authoring &&
      (command.authoring.adapterId !== authoringIdentity!.adapterId ||
        command.authoring.projectId !== authoringIdentity!.projectId ||
        command.authoring.documentId !== authoringIdentity!.documentId)
    )
      return rejected(request.operationId, "validation_error", "Authoring revision belongs to a different document")
    const contentHash = hash(command.content)
    if (command.authoring && contentHash !== command.authoring.contentHash) {
      return rejected(
        request.operationId,
        "validation_error",
        "Authoring revision content does not match its declared content hash",
      )
    }
    const latest = database
      .prepare(
        `
      SELECT id, origin_reference_json FROM wg_v2_work_source_revisions
      WHERE organization_id = ? AND owner_user_id = ? AND work_source_id = ? AND revision_number = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.workSourceId, source.latest_revision_number) as {
      id: string
      origin_reference_json: string | null
    }
    if (latest.id !== command.expectedRevisionId)
      return rejected(request.operationId, "version_conflict", "Work Source revision changed")
    const previousAuthoring = command.authoring
      ? AuthoringSourceRevisionSchema.parse(
          JSON.parse(requiredOriginReference(latest.origin_reference_json, "authoring")),
        )
      : undefined
    if (command.authoring && previousAuthoring!.documentRevisionNumber >= command.authoring.documentRevisionNumber) {
      return rejected(
        request.operationId,
        "version_conflict",
        "Authoring document revision is not newer than the Work Source head",
      )
    }
    if (command.authoring && command.authoring.parentDocumentRevisionId !== previousAuthoring!.documentRevisionId) {
      return rejected(
        request.operationId,
        "version_conflict",
        "Authoring document revision does not descend from the Work Source head",
      )
    }
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
        command.authoring ? JSON.stringify(command.authoring) : null,
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
      .run(
        command.title ?? null,
        revisionNumber,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.workSourceId,
      )
    return pending("work_source_revised", "work_source", command.workSourceId, {
      workSourceId: command.workSourceId,
      revisionId,
    })
  }
  if (command.type === "create_outcome") {
    if (!ownedStream(database, context, command.streamId))
      return rejected(request.operationId, "not_found", "Stream not found")
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
    if (outcome.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Outcome version changed")
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
    if (!ownedStream(database, context, command.streamId))
      return rejected(request.operationId, "not_found", "Stream not found")
    if (command.source && !exactSourceHead(database, context, command.source).exists) {
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
    const workItemId = ids.next("work_item")
    database
      .prepare(
        `
      INSERT INTO wg_v2_work_items
        (organization_id, owner_user_id, id, stream_id, outcome_id, source_revision_id, title, description, lifecycle, priority, execution_overrides_json, completion_contract_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `,
      )
      .run(
        context.organizationId,
        context.ownerUserId,
        workItemId,
        command.streamId,
        command.outcomeId ?? null,
        command.source?.revisionId ?? null,
        command.title,
        command.description ?? "",
        command.priority ?? 0,
        JSON.stringify(command.execution ?? {}),
        JSON.stringify(command.completionContract),
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
    if (command.source) addSourceReference(database, context, ids, "work_item", workItemId, command.source, occurredAt)
    return pending("work_item_created", "work_item", workItemId, { workItemId }, command.streamId)
  }
  if (command.type === "update_work_item") {
    const item = ownedWorkItem(database, context, command.workItemId)
    if (!item) return rejected(request.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Work Item version changed")
    if (command.outcomeId) {
      const outcome = database
        .prepare(
          "SELECT 1 FROM wg_v2_outcomes WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND stream_id = ?",
        )
        .get(context.organizationId, context.ownerUserId, command.outcomeId, item.stream_id)
      if (!outcome) return rejected(request.operationId, "not_found", "Outcome not found")
    }
    const dependencyIds = command.dependencyIds ?? []
    if (dependencyIds.includes(command.workItemId))
      return rejected(request.operationId, "validation_error", "A Work Item cannot depend on itself")
    if (new Set(dependencyIds).size !== dependencyIds.length)
      return rejected(request.operationId, "validation_error", "Dependencies must be unique")
    const dependenciesExist = dependencyIds.every((dependencyId) =>
      database
        .prepare(
          `
      SELECT 1 FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND stream_id = ?
    `,
        )
        .get(context.organizationId, context.ownerUserId, dependencyId, item.stream_id),
    )
    if (command.dependencyIds && !dependenciesExist)
      return rejected(request.operationId, "not_found", "Dependency not found")
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
        .prepare(
          "DELETE FROM wg_v2_work_item_dependencies WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?",
        )
        .run(context.organizationId, context.ownerUserId, command.workItemId)
      dependencyIds.forEach((dependencyId) =>
        database
          .prepare(
            `
        INSERT INTO wg_v2_work_item_dependencies (organization_id, owner_user_id, id, work_item_id, depends_on_work_item_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
          )
          .run(
            context.organizationId,
            context.ownerUserId,
            ids.next("dependency"),
            command.workItemId,
            dependencyId,
            occurredAt,
          ),
      )
    }
    return pending(
      "work_item_updated",
      "work_item",
      command.workItemId,
      { workItemId: command.workItemId },
      item.stream_id,
    )
  }
  if (command.type === "cancel_work_item") {
    const item = ownedWorkItem(database, context, command.workItemId)
    if (!item) return rejected(request.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Work Item version changed")
    if (item.lifecycle === "completed" || item.lifecycle === "abandoned")
      return rejected(request.operationId, "invalid_transition", "Work Item is already terminal")
    const liveAttempt = database
      .prepare(
        `
      SELECT 1 FROM wg_v2_attempts
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
    if (liveAttempt || activeLease)
      return rejected(request.operationId, "blocked", "Cancel the active Attempt before abandoning its Work Item")
    database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'abandoned', abandoned_reason = ?, abandoned_at = ?,
        row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        command.reason,
        occurredAt,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.workItemId,
        command.expectedVersion,
      )
    return pending(
      "work_item_updated",
      "work_item",
      command.workItemId,
      { workItemId: command.workItemId },
      item.stream_id,
    )
  }
  if (command.type === "set_stream_visibility") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Stream version changed")
    const transition = transitionStreamVisibility(stream.visibility as "visible" | "archived", command.visibility)
    if (!transition.ok) return rejected(request.operationId, "invalid_transition", "Invalid visibility transition")
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET visibility = ?, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        transition.state,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.streamId,
        command.expectedVersion,
      )
    return pending(
      "stream_visibility_changed",
      "stream",
      command.streamId,
      { streamId: command.streamId },
      command.streamId,
    )
  }
  if (command.type === "propose_decision") {
    if (!ownedStream(database, context, command.streamId))
      return rejected(request.operationId, "not_found", "Stream not found")
    const optionIds = command.options.map((option) => option.id)
    if (new Set(optionIds).size !== optionIds.length)
      return rejected(request.operationId, "validation_error", "Decision option IDs must be unique")
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
        .run(
          context.organizationId,
          context.ownerUserId,
          ids.next("decision_work_item"),
          decisionId,
          workItemId,
          occurredAt,
        ),
    )
    return pending("decision_proposed", "decision", decisionId, { decisionId }, command.streamId)
  }
  if (command.type === "answer_decision") {
    const decision = ownedDecision(database, context, command.decisionId)
    if (!decision) return rejected(request.operationId, "not_found", "Decision not found")
    if (decision.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Decision version changed")
    const transition = transitionDecision(
      decision.lifecycle as "proposed" | "pending" | "answered" | "dismissed",
      "answered",
    )
    if (!transition.ok) return rejected(request.operationId, "invalid_transition", "Decision is not pending")
    if (!command.optionId && !command.answer)
      return rejected(request.operationId, "validation_error", "An option or answer is required")
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
    return pending(
      "decision_answered",
      "decision",
      command.decisionId,
      { decisionId: command.decisionId },
      decision.stream_id,
    )
  }
  if (command.type === "dismiss_decision") {
    const decision = ownedDecision(database, context, command.decisionId)
    if (!decision) return rejected(request.operationId, "not_found", "Decision not found")
    if (decision.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Decision version changed")
    const transition = transitionDecision(
      decision.lifecycle as "proposed" | "pending" | "answered" | "dismissed",
      "dismissed",
    )
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
    return pending(
      "decision_dismissed",
      "decision",
      command.decisionId,
      { decisionId: command.decisionId },
      decision.stream_id,
    )
  }
  if (command.type === "propose_admission") {
    const source = exactSourceHead(database, context, command.source)
    if (!source.exists) return rejected(request.operationId, "not_found", "Work Source revision not found")
    if (!source.current)
      return rejected(request.operationId, "version_conflict", "Admission requires the current Work Source head")
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
    const previous = command.targetStreamId
      ? previousSourceRevision(database, context, command.targetStreamId, command.source)
      : undefined
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
      generation: { method: "planning" as const, attempt: 0, queuedAt: occurredAt },
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
    if (row.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Admission proposal version changed")
    if (row.lifecycle !== "planning_failed")
      return rejected(request.operationId, "invalid_transition", "Admission planning has not failed")
    const failed = JSON.parse(row.proposed_work_json) as {
      source?: WorkSourceRevisionRef
      execution?: ExecutionProfileDefaults
      previousSource?: WorkSourceRevisionRef
      diffSummary?: string
      planningEvidence?: unknown
      suggestedPlacement?: { mode: "new_stream"; streamTitle: string } | { mode: "existing"; streamId: string }
      generation?: { method?: string; attempt?: number; retryable?: boolean }
    }
    if (!failed.source || failed.generation?.method !== "planning_failed")
      return rejected(request.operationId, "invalid_transition", "Admission planning failure is incomplete")
    if (failed.generation.retryable !== true)
      return rejected(request.operationId, "invalid_transition", "Admission planning failure is not retryable")
    const source = exactSourceHead(database, context, failed.source)
    if (!source.exists || !source.current)
      return rejected(request.operationId, "version_conflict", "Admission source is no longer current")
    const attempt = failed.generation.attempt ?? 0
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
          generation: { method: "planning", attempt, queuedAt: occurredAt },
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
      attempt,
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
    if (proposal.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Admission proposal version changed")
    const expectedState = command.type === "dismiss_admission" ? "proposed" : "dismissed"
    if (proposal.lifecycle !== expectedState) {
      return rejected(
        request.operationId,
        "invalid_transition",
        command.type === "dismiss_admission"
          ? "Only a reviewable admission proposal may be dismissed"
          : "Only a dismissed admission proposal may be reopened",
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
      .run(
        nextState,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.proposalId,
        command.expectedVersion,
        expectedState,
      )
    if (changed.changes !== 1)
      return rejected(request.operationId, "version_conflict", "Admission proposal version changed")
    return pending(
      command.type === "dismiss_admission" ? "admission_dismissed" : "admission_reopened",
      "admission_proposal",
      command.proposalId,
      { proposalId: command.proposalId, version: command.expectedVersion + 1 },
    )
  }
  if (command.type === "confirm_admission") {
    const proposal = database
      .prepare(
        `
      SELECT source_revision_id, intake_candidate_id, lifecycle, proposed_work_json, row_version FROM wg_v2_admission_proposals
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.proposalId) as AdmissionProposalRow | undefined
    if (!proposal) return rejected(request.operationId, "not_found", "Admission proposal not found")
    if (proposal.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Admission proposal version changed")
    if (proposal.lifecycle !== "proposed")
      return rejected(request.operationId, "invalid_transition", "Admission proposal is not open")
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
      return rejected(
        request.operationId,
        "invalid_transition",
        "Admission proposal has no complete Session-authored plan",
      )
    }
    if (
      proposed.source.workSourceId !== command.source.workSourceId ||
      proposal.source_revision_id !== command.source.revisionId
    ) {
      return rejected(request.operationId, "version_conflict", "Admission source does not match the proposal")
    }
    const source = exactSourceHead(database, context, command.source)
    if (!source.exists) return rejected(request.operationId, "not_found", "Work Source revision not found")
    if (!source.current)
      return rejected(request.operationId, "version_conflict", "Admission source is no longer current")
    if (proposal.intake_candidate_id) {
      const candidate = database
        .prepare(
          `
        SELECT normalized_json, status FROM wg_v2_intake_candidates WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .get(context.organizationId, context.ownerUserId, proposal.intake_candidate_id) as
        | { normalized_json: string; status: string }
        | undefined
      const admission = candidate
        ? (JSON.parse(candidate.normalized_json) as { admissionProposalId?: string; source?: typeof command.source })
        : undefined
      if (
        candidate?.status !== "staged" ||
        admission?.admissionProposalId !== command.proposalId ||
        !admission.source ||
        admission.source.workSourceId !== command.source.workSourceId ||
        admission.source.revisionId !== command.source.revisionId ||
        admission.source.contentHash !== command.source.contentHash
      ) {
        return rejected(
          request.operationId,
          "version_conflict",
          "Intake candidate does not match the admission proposal",
        )
      }
    }
    const existingStreamId = "streamId" in command.selection ? command.selection.streamId : undefined
    const existingStream = existingStreamId ? ownedStream(database, context, existingStreamId) : undefined
    if (existingStreamId && !existingStream)
      return rejected(request.operationId, "not_found", "Selected Stream not found")
    const outcomeKeys = command.outcomes?.map((outcome) => outcome.proposalKey) ?? []
    const workItemKeys = command.workItems?.map((item) => item.proposalKey) ?? []
    if (new Set(outcomeKeys).size !== outcomeKeys.length || new Set(workItemKeys).size !== workItemKeys.length) {
      return rejected(request.operationId, "validation_error", "Admission proposal keys must be unique")
    }
    const validOutcomeRefs =
      command.workItems?.every((item) => !item.outcomeProposalKey || outcomeKeys.includes(item.outcomeProposalKey)) ??
      true
    const validDependencyRefs =
      command.workItems?.every(
        (item) =>
          item.dependencyProposalKeys?.every((key) => workItemKeys.includes(key) && key !== item.proposalKey) ?? true,
      ) ?? true
    if (!validOutcomeRefs || !validDependencyRefs)
      return rejected(request.operationId, "validation_error", "Admission references an unknown proposal key")
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

    const streamId =
      command.selection.mode === "create" || command.selection.mode === "fork" ? ids.next("stream") : existingStreamId!
    if (command.selection.mode === "create" || command.selection.mode === "fork") {
      database
        .prepare(
          `
        INSERT INTO wg_v2_streams
          (organization_id, owner_user_id, id, workgraph_id, title, purpose, lifecycle, execution_defaults_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          streamId,
          rootId,
          command.selection.streamTitle,
          command.selection.streamTitle,
          JSON.stringify(proposed.execution ?? {}),
          occurredAt,
          occurredAt,
        )
    }
    if (command.selection.mode === "replace") {
      const attempts = database
        .prepare(
          `
        SELECT id, work_item_id, session_id FROM wg_v2_attempts
        WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
          AND work_item_id IN (${command.selection.workItems.map(() => "?").join(", ")})
          AND lifecycle IN ('admitted', 'placing', 'running', 'attention')
      `,
        )
        .all(
          context.organizationId,
          context.ownerUserId,
          streamId,
          ...command.selection.workItems.map((item) => item.workItemId),
        ) as Array<{
        id: AttemptID
        work_item_id: WorkItemID
        session_id: ExecutionSessionID | null
      }>
      database
        .prepare(
          `
        UPDATE wg_v2_attempts SET lifecycle = 'attention', attention_reason = 'Cancellation pending: replaced by confirmed admission',
          row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
          AND work_item_id IN (${command.selection.workItems.map(() => "?").join(", ")})
          AND lifecycle IN ('admitted', 'placing', 'running', 'attention')
      `,
        )
        .run(
          occurredAt,
          context.organizationId,
          context.ownerUserId,
          streamId,
          ...command.selection.workItems.map((item) => item.workItemId),
        )
      database
        .prepare(
          `
        DELETE FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item'
          AND resource_id IN (${command.selection.workItems.map(() => "?").join(", ")})
      `,
        )
        .run(context.organizationId, context.ownerUserId, ...command.selection.workItems.map((item) => item.workItemId))
      database
        .prepare(
          `
        UPDATE wg_v2_work_items SET lifecycle = 'abandoned', abandoned_reason = 'Replaced by confirmed admission',
          abandoned_at = ?, row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
          AND id IN (${command.selection.workItems.map(() => "?").join(", ")})
      `,
        )
        .run(
          occurredAt,
          occurredAt,
          context.organizationId,
          context.ownerUserId,
          streamId,
          ...command.selection.workItems.map((item) => item.workItemId),
        )
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
        UPDATE wg_v2_streams SET replacement_reset_json = ?, row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .run(JSON.stringify(reset), occurredAt, context.organizationId, context.ownerUserId, streamId)
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
            attemptIds: attempts.map((attempt) => attempt.id),
            sessions: attempts.flatMap((attempt) =>
              attempt.session_id ? [{ attemptId: attempt.id, sessionId: attempt.session_id }] : [],
            ),
            envelopeId: existingStream?.envelope_identity_json
              ? (JSON.parse(existingStream.envelope_identity_json) as { id?: string }).id
              : undefined,
          },
        },
        occurredAt,
      )
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
          (organization_id, owner_user_id, id, stream_id, outcome_id, source_revision_id, title, description, lifecycle, execution_overrides_json, completion_contract_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
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
          .run(
            context.organizationId,
            context.ownerUserId,
            ids.next("dependency"),
            workItemId,
            itemIds.get(key),
            occurredAt,
          ),
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
    if (outcome.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Outcome version changed")
    const childStates = database
      .prepare(
        "SELECT lifecycle FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND outcome_id = ?",
      )
      .all(context.organizationId, context.ownerUserId, command.outcomeId) as Array<{
      lifecycle: Parameters<typeof completeOutcome>[0]["childStates"][number]
    }>
    const confirmationRow = database
      .prepare(
        `
      SELECT id, requirement_id, source_attempt_id, reference_json, provenance_json, created_at FROM wg_v2_evidence
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
      ownerConfirmation: confirmationRow
        ? evidenceDto({ type: "outcome", outcomeId: command.outcomeId }, confirmationRow)
        : undefined,
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
    return pending(
      "outcome_closed",
      "outcome",
      command.outcomeId,
      { outcomeId: command.outcomeId, reason: command.reason },
      outcome.stream_id,
    )
  }
  if (command.type === "execute_work_item") {
    const admitted = admitAttempt(
      database,
      context,
      command.workItemId,
      command.executionMode,
      occurredAt,
      ids,
      capabilities,
    )
    if (!admitted.ok) return rejected(request.operationId, admitted.code, admitted.message)
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET execution_mode = ?, execution_state = ?, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .run(
        command.executionMode,
        command.executionMode === "autonomous" ? "active" : "stopped",
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        admitted.streamId,
      )
    return pending(
      "attempt_admitted",
      "attempt",
      admitted.attemptId,
      {
        attemptId: admitted.attemptId,
        workItemId: command.workItemId,
        leaseEpoch: admitted.leaseEpoch,
      },
      admitted.streamId,
    )
  }
  if (command.type === "retry_work_item") {
    const item = ownedWorkItem(database, context, command.workItemId)
    if (!item) return rejected(request.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Work Item version changed")
    const previous = database
      .prepare(
        `
      SELECT execution_mode FROM wg_v2_attempts WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?
      ORDER BY attempt_number DESC LIMIT 1
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.workItemId) as
      | { execution_mode: ExecutionMode | null }
      | undefined
    if (!previous?.execution_mode)
      return rejected(request.operationId, "validation_error", "Retry requires an explicitly stored execution mode")
    const admitted = admitAttempt(
      database,
      context,
      command.workItemId,
      previous.execution_mode,
      occurredAt,
      ids,
      capabilities,
    )
    if (!admitted.ok) return rejected(request.operationId, admitted.code, admitted.message)
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET execution_mode = ?, execution_state = ?, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .run(
        previous.execution_mode,
        previous.execution_mode === "autonomous" ? "active" : "stopped",
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        admitted.streamId,
      )
    return pending(
      "attempt_admitted",
      "attempt",
      admitted.attemptId,
      {
        attemptId: admitted.attemptId,
        workItemId: command.workItemId,
        leaseEpoch: admitted.leaseEpoch,
      },
      admitted.streamId,
    )
  }
  if (command.type === "execute_stream") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.lifecycle === "paused")
      return rejected(request.operationId, "blocked", "Paused Streams do not admit new Attempts")
    if (stream.lifecycle === "closed")
      return rejected(request.operationId, "invalid_transition", "Closed Streams do not execute")
    const rows = database
      .prepare(
        `
      SELECT items.id FROM wg_v2_work_items items
      WHERE items.organization_id = ? AND items.owner_user_id = ? AND items.stream_id = ?
        AND items.lifecycle = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM wg_v2_work_item_dependencies dependencies
          JOIN wg_v2_work_items blockers ON blockers.organization_id = dependencies.organization_id AND blockers.owner_user_id = dependencies.owner_user_id
            AND blockers.id = dependencies.depends_on_work_item_id
          WHERE dependencies.organization_id = items.organization_id AND dependencies.owner_user_id = items.owner_user_id AND dependencies.work_item_id = items.id
            AND blockers.lifecycle <> 'completed'
        )
      ORDER BY items.priority DESC, items.created_at, items.id
    `,
      )
      .all(context.organizationId, context.ownerUserId, command.streamId) as Array<{ id: WorkItemID }>
    const results = rows.map((row) =>
      admitAttempt(database, context, row.id, command.executionMode, occurredAt, ids, capabilities),
    )
    const admissions = results.filter((result) => result.ok)
    if (admissions.length === 0) {
      const failure = results.find((result) => !result.ok)
      return failure
        ? rejected(request.operationId, failure.code, failure.message)
        : rejected(request.operationId, "blocked", "No ready Work Items can be admitted")
    }
    database
      .prepare(
        `
      UPDATE wg_v2_streams SET execution_mode = ?, execution_state = ?, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .run(
        command.executionMode,
        command.executionMode === "autonomous" ? "active" : "stopped",
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.streamId,
      )
    return pending(
      "stream_execution_requested",
      "stream",
      command.streamId,
      { attemptIds: admissions.map((result) => result.attemptId) },
      command.streamId,
    )
  }
  if (command.type === "cancel_attempt") {
    const attempt = database
      .prepare(
        `
      SELECT id, stream_id, work_item_id, lifecycle, row_version FROM wg_v2_attempts WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.attemptId) as
      | { id: string; stream_id: string; work_item_id: string; lifecycle: string; row_version: number }
      | undefined
    if (!attempt) return rejected(request.operationId, "not_found", "Attempt not found")
    if (attempt.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Attempt version changed")
    if (["result", "failed", "cancelled"].includes(attempt.lifecycle))
      return rejected(request.operationId, "invalid_transition", "Attempt is already terminal")
    database
      .prepare(
        `
      UPDATE wg_v2_attempts SET lifecycle = 'cancelled', attention_reason = ?, finished_at = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
    `,
      )
      .run(
        command.reason,
        occurredAt,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.attemptId,
        command.expectedVersion,
      )
    database
      .prepare(
        "DELETE FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?",
      )
      .run(context.organizationId, context.ownerUserId, attempt.work_item_id)
    database
      .prepare(
        `
      UPDATE wg_v2_work_items SET lifecycle = 'failed', updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'active'
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, attempt.work_item_id)
    return pending(
      "attempt_cancelled",
      "attempt",
      command.attemptId,
      { attemptId: command.attemptId },
      attempt.stream_id,
    )
  }
  if (command.type === "reopen_outcome") {
    const outcome = ownedOutcome(database, context, command.outcomeId)
    if (!outcome) return rejected(request.operationId, "not_found", "Outcome not found")
    if (outcome.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Outcome version changed")
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
      .run(
        occurredAt,
        reopened.provenance.reason,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.outcomeId,
        command.expectedVersion,
      )
    return pending(
      "outcome_reopened",
      "outcome",
      command.outcomeId,
      { outcomeId: command.outcomeId, reason: reopened.provenance.reason },
      outcome.stream_id,
    )
  }
  if (command.type === "close_stream") {
    const stream = ownedStream(database, context, command.streamId)
    if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Stream version changed")
    const transition = transitionStream(stream.lifecycle as StreamLifecycleState, "closed")
    if (!transition.ok) return rejected(request.operationId, "invalid_transition", "Invalid stream transition")
    const reservation = database
      .prepare(
        `
      SELECT operation_id, expected_version, cleanup_mode FROM wg_v2_stream_cleanup_reservations
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND state = 'reserved'
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.streamId) as
      | { operation_id: string; expected_version: number; cleanup_mode: string }
      | undefined
    if (
      reservation &&
      (reservation.operation_id !== request.operationId ||
        reservation.expected_version !== command.expectedVersion ||
        reservation.cleanup_mode !== "close")
    ) {
      return rejected(request.operationId, "version_conflict", "Stream cleanup is owned by another operation")
    }
    database
      .prepare(
        `
      UPDATE wg_v2_attempts SET lifecycle = 'cancelled', attention_reason = ?, finished_at = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND lifecycle IN ('admitted', 'placing', 'running', 'attention')
    `,
      )
      .run(command.reason, occurredAt, occurredAt, context.organizationId, context.ownerUserId, command.streamId)
    database
      .prepare(
        `
      DELETE FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item'
        AND resource_id IN (SELECT id FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?)
    `,
      )
      .run(context.organizationId, context.ownerUserId, context.organizationId, context.ownerUserId, command.streamId)
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
      .run(
        occurredAt,
        occurredAt,
        context.organizationId,
        context.ownerUserId,
        command.streamId,
        command.expectedVersion,
      )
    return pending(
      "stream_closed",
      "stream",
      command.streamId,
      { streamId: command.streamId, reason: command.reason },
      command.streamId,
    )
  }
  if (command.type === "record_attempt_checkpoint" || command.type === "complete_attempt") {
    const attempt = database
      .prepare(
        `
      SELECT id, stream_id, work_item_id, lifecycle, execution_kind, session_id, envelope_id, lease_epoch
      FROM wg_v2_attempts
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.attemptId) as
      | {
          id: AttemptID
          stream_id: StreamID
          work_item_id: WorkItemID
          lifecycle: string
          execution_kind: string
          session_id: string | null
          envelope_id: string | null
          lease_epoch: number
        }
      | undefined
    if (!attempt || attempt.session_id !== command.sessionId)
      return rejected(request.operationId, "not_found", "Active Attempt Session not found")
    if (attempt.lifecycle !== "running")
      return rejected(request.operationId, "invalid_transition", "Attempt is not running")
    if (attempt.execution_kind === "managed") {
      if (command.leaseEpoch !== attempt.lease_epoch)
        return rejected(request.operationId, "version_conflict", "Attempt lease changed")
      const lease = database
        .prepare(
          `
        SELECT 1 FROM wg_v2_leases
        WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
          AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
      `,
        )
        .get(
          context.organizationId,
          context.ownerUserId,
          attempt.work_item_id,
          attempt.id,
          attempt.lease_epoch,
          occurredAt,
        )
      if (!lease) return rejected(request.operationId, "version_conflict", "Attempt lease is no longer active")
    }
    const activeBinding = database
      .prepare(
        `
      SELECT id, project_id FROM wg_v2_session_bindings
      WHERE organization_id = ? AND owner_user_id = ? AND session_id = ? AND current_attempt_id = ? AND state = 'active'
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.sessionId, attempt.id) as
      | { id: string; project_id: string }
      | undefined
    if (!activeBinding || activeBinding.project_id !== command.workspaceId)
      return rejected(request.operationId, "invalid_transition", "Attempt Session is not bound to this workspace")
    const bindingId = activeBinding.id

    if (command.type === "record_attempt_checkpoint") {
      const evidenceIds = command.evidenceIds ?? []
      const invalidEvidence = evidenceIds.some((id) => {
        const evidence = database
          .prepare(
            `
          SELECT subject_type, subject_id, source_attempt_id FROM wg_v2_evidence
          WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, id) as
          | { subject_type: string; subject_id: string; source_attempt_id: string | null }
          | undefined
        return !evidence || !(
          (evidence.subject_type === "work_item" && evidence.subject_id === attempt.work_item_id) ||
          evidence.source_attempt_id === attempt.id
        )
      })
      if (invalidEvidence) return rejected(request.operationId, "not_found", "Checkpoint evidence does not belong to the Attempt")
      const checkpointId = ids.next("agent_checkpoint")
      database
        .prepare(
          `
        INSERT INTO wg_v2_agent_checkpoints
          (organization_id, owner_user_id, id, stream_id, work_item_id, attempt_id, session_binding_id,
           level, summary, evidence_ids_json, occurred_at, provenance_json, operation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          checkpointId,
          attempt.stream_id,
          attempt.work_item_id,
          attempt.id,
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
      return pending(
        "agent_checkpoint_recorded",
        "attempt",
        attempt.id,
        { attemptId: attempt.id, checkpointId },
        attempt.stream_id,
      )
    }

    const hasDurableEvidence = command.evidence.some(
      (input) => input.evidence.kind === "integration" && input.evidence.effect !== "other",
    )
    if (
      hasDurableEvidence &&
      database
        .prepare(
          `
        SELECT 1 FROM wg_v2_stream_cleanup_reservations
        WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND state = 'reserved'
      `,
        )
        .get(context.organizationId, context.ownerUserId, attempt.stream_id)
    ) {
      return rejected(request.operationId, "blocked", "Stream cleanup has already been reserved")
    }
    const evidenceIds = command.evidence.map((input, index) => {
      const evidenceId = ids.next("evidence")
      const receiptId = input.evidence.kind === "integration" && input.evidence.effect !== "other"
        ? ids.next("receipt")
        : undefined
      database
        .prepare(
          `
        INSERT INTO wg_v2_evidence
          (organization_id, owner_user_id, id, stream_id, subject_type, subject_id, requirement_id,
           source_attempt_id, evidence_kind, summary, reference_json, provenance_json, created_at)
        VALUES (?, ?, ?, ?, 'work_item', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          context.organizationId,
          context.ownerUserId,
          evidenceId,
          attempt.stream_id,
          attempt.work_item_id,
          input.requirementId ?? null,
          attempt.id,
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
            (organization_id, owner_user_id, id, stream_id, attempt_id, effect_kind, idempotency_key,
             external_reference_json, provenance_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            context.organizationId,
            context.ownerUserId,
            receiptId,
            attempt.stream_id,
            attempt.id,
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
      UPDATE wg_v2_attempts
      SET lifecycle = 'result', terminal_result_json = ?, attention_reason = NULL, finished_at = ?,
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
        attempt.id,
      )
    database
      .prepare(
        `
      UPDATE wg_v2_work_items
      SET lifecycle = 'result_ready', updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle NOT IN ('completed', 'abandoned')
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, attempt.work_item_id)
    if (attempt.execution_kind === "managed") {
      database
        .prepare(
          `
        DELETE FROM wg_v2_leases
        WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
          AND holder_id = ? AND epoch = ?
      `,
        )
        .run(context.organizationId, context.ownerUserId, attempt.work_item_id, attempt.id, attempt.lease_epoch)
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
    const completion = promoteSatisfiedResultReadyWork(database, context, attempt.work_item_id, occurredAt)
    return pending(
      completion.outcomeId ? "outcome_ready_to_close" : "attempt_completed",
      "attempt",
      attempt.id,
      {
        attemptId: attempt.id,
        workItemId: attempt.work_item_id,
        workItemState: completion.completed ? "completed" : "result_ready",
        evidenceIds,
        ...(completion.outcomeId ? { outcomeId: completion.outcomeId } : {}),
      },
      attempt.stream_id,
    )
  }
  if (command.type === "record_evidence") {
    const subject = findEvidenceSubject(database, context, command.subject)
    if (!subject) return rejected(request.operationId, "not_found", "Evidence subject not found")
    const evidenceId = ids.next("evidence")
    const durable = command.evidence.kind === "integration" && command.evidence.effect !== "other"
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
        (organization_id, owner_user_id, id, stream_id, subject_type, subject_id, requirement_id, source_attempt_id, evidence_kind, summary, reference_json, provenance_json, created_at)
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
        command.sourceAttemptId ?? null,
        command.evidence.kind,
        command.evidence.summary,
        JSON.stringify(command.evidence),
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
          ids.next("receipt"),
          subject.streamId,
          command.evidence.effect,
          `${request.operationId}:integration`,
          JSON.stringify({ reference: command.evidence.reference }),
          JSON.stringify({ actor: context.actor, operationId: request.operationId }),
          occurredAt,
        )
    }
    const completion =
      command.subject.type === "work_item"
        ? promoteSatisfiedResultReadyWork(database, context, command.subject.workItemId, occurredAt)
        : { completed: false, outcomeId: undefined }
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
    if (stream.row_version !== command.expectedVersion)
      return rejected(request.operationId, "version_conflict", "Stream version changed")
    const reservation = database
      .prepare(
        `
      SELECT operation_id, expected_version, cleanup_mode FROM wg_v2_stream_cleanup_reservations
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND state = 'reserved'
    `,
      )
      .get(context.organizationId, context.ownerUserId, command.streamId) as
      | { operation_id: string; expected_version: number; cleanup_mode: string }
      | undefined
    if (
      reservation &&
      (reservation.operation_id !== request.operationId ||
        reservation.expected_version !== command.expectedVersion ||
        reservation.cleanup_mode !== "delete")
    ) {
      return rejected(request.operationId, "version_conflict", "Stream cleanup is owned by another operation")
    }
    database
      .prepare(
        "DELETE FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?",
      )
      .run(context.organizationId, context.ownerUserId, command.streamId, command.expectedVersion)
    return pending("stream_deleted", "stream", command.streamId, { streamId: command.streamId }, command.streamId)
  }
  return rejected(request.operationId, "internal_error", "Unsupported SQLite command")
}

function readSqliteDependencyGraph(database: Database, context: WorkGraphContext, streamId: string) {
  const graph = new Map<string, string[]>(
    (database
      .prepare(
        `
      SELECT id FROM wg_v2_work_items
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
    `,
      )
      .all(context.organizationId, context.ownerUserId, streamId) as Array<{ id: string }>).map((row) => [row.id, []]),
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
  if (!review)
    return { ok: false, code: "not_found", message: "Selected Stream or previous Work Source revision not found" }
  if (review.status === "unavailable") return { ok: false, code: "blocked", message: review.reason }
  if (review.status === "durable") return { ok: false, code: "close_required", message: review.reason }
  if (review.status === "unrelated") return { ok: false, code: "blocked", message: review.reason }
  if (review.status === "empty")
    return input.workItems.length === 0
      ? { ok: true }
      : { ok: false, code: "version_conflict", message: "Replacement Task set changed after review" }
  const reviewed = [...input.workItems].sort((left, right) => left.workItemId.localeCompare(right.workItemId))
  if (
    new Set(reviewed.map((item) => item.workItemId)).size !== reviewed.length ||
    reviewed.length !== review.targets.length
  ) {
    return { ok: false, code: "version_conflict", message: "Replacement Task set changed after review" }
  }
  if (
    review.targets.some(
      (item, index) =>
        item.workItemId !== reviewed[index]?.workItemId || item.expectedVersion !== reviewed[index]?.expectedVersion,
    )
  ) {
    return { ok: false, code: "version_conflict", message: "Replacement Task set changed after review" }
  }
  return { ok: true }
}

function readSqliteReplacementReview(
  database: Database,
  context: WorkGraphContext,
  input: ReplacementReviewInput,
): ReplacementReview | undefined {
  const stream = ownedStream(database, context, input.streamId)
  const source = database
    .prepare(
      `
    SELECT content_hash FROM wg_v2_work_source_revisions
    WHERE organization_id = ? AND owner_user_id = ? AND work_source_id = ? AND id = ?
  `,
    )
    .get(
      context.organizationId,
      context.ownerUserId,
      input.previousSource.workSourceId,
      input.previousSource.revisionId,
    ) as { content_hash: string } | undefined
  if (!stream || source?.content_hash !== input.previousSource.contentHash) return undefined
  const base = { streamId: input.streamId, streamTitle: stream.title }
  const reset = stream.replacement_reset_json
    ? (JSON.parse(stream.replacement_reset_json) as { state?: string })
    : undefined
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
    .all(
      input.previousSource.workSourceId,
      input.previousSource.revisionId,
      context.organizationId,
      context.ownerUserId,
      input.streamId,
    ) as Array<{
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
      page: async (
        context: WorkGraphContext,
        input: Readonly<{ after?: SnapshotResumeCursor; limit: number }>,
      ): Promise<WorkGraphSnapshotPage> => {
        const cursor = database
          .prepare(
            "SELECT next_cursor - 1 AS cursor FROM wg_v2_change_cursors WHERE organization_id = ? AND owner_user_id = ?",
          )
          .get(context.organizationId, context.ownerUserId) as { cursor: number } | undefined
        const currentSnapshotCursor = createChangeCursor({
          organizationId: context.organizationId,
          ownerUserId: context.ownerUserId,
          position: cursor?.cursor ?? 0,
        })
        const resume = input.after
          ? decodeSnapshotResumeCursor(input.after, context.organizationId, context.ownerUserId)
          : { offset: 0, capturedAt: clock.now() }
        if ("snapshotCursor" in resume && resume.snapshotCursor !== currentSnapshotCursor) {
          const relevant = database.prepare(`
            SELECT 1 FROM wg_v2_changes
            WHERE organization_id = ? AND owner_user_id = ? AND snapshot_relevant = 1 AND cursor > ? LIMIT 1
          `).get(
            context.organizationId,
            context.ownerUserId,
            readChangeCursor(resume.snapshotCursor, context.organizationId, context.ownerUserId),
          )
          if (relevant) throw new SnapshotResumeCursorError("invalidated")
        }
        const snapshotCursor = "snapshotCursor" in resume ? resume.snapshotCursor : currentSnapshotCursor
        const records = [
          readWorkGraphDefaultsRecord(database, context),
          ...readStreamRecords(database, context),
          ...readOutcomeRecords(database, context),
          ...readWorkItemRecords(database, context),
          ...readAttemptRecords(database, context),
          ...readDecisionRecords(database, context),
          ...readRecapRecords(database, context),
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
      read: async (context: WorkGraphContext): Promise<WorkGraphDefaultsDto> =>
        readWorkGraphDefaultsRecord(database, context),
    },
    streams: {
      read: async (
        context: WorkGraphContext,
        input: Readonly<{ streamId: StreamID }>,
      ): Promise<StreamDto | undefined> => {
        const stream = readStreamRecords(database, context, input.streamId)[0]
        if (!stream) return undefined
        return withLegacyStreamState(stream)
      },
    },
    proposals: {
      read: async (context: WorkGraphContext, input: Readonly<{ proposalId: string }>) =>
        readAdmissionRecords(database, context, input.proposalId)[0],
      replacementReview: async (context: WorkGraphContext, input: ReplacementReviewInput) =>
        readSqliteReplacementReview(database, context, input),
    },
    attempts: {
      read: async (context: WorkGraphContext, input: Readonly<{ attemptId: string }>) => {
        const row = database
          .prepare(
            `
          SELECT * FROM wg_v2_attempts WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.attemptId) as AttemptRecordRow | undefined
        return row ? attemptDetailDto(database, context, row) : undefined
      },
    },
    decisions: {
      read: async (context: WorkGraphContext, input: Readonly<{ decisionId: string }>) =>
        readDecisionRecords(database, context, input.decisionId)[0],
    },
    recaps: {
      read: async (context: WorkGraphContext, input: Readonly<{ recapId: string }>) =>
        readRecapRecords(database, context, input.recapId)[0],
    },
    sources: {
      list: async (context: WorkGraphContext, input: Readonly<{ after?: WorkSourcePageCursor; limit: number }>) => {
        const resume = input.after
          ? readWorkSourcePageCursor(input.after, context.organizationId, context.ownerUserId)
          : undefined
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
      readRevision: async (
        context: WorkGraphContext,
        input: Readonly<{ workSourceId: string; revisionId: string }>,
      ) => {
        const revision = database
          .prepare(
            `
          SELECT work_source_id, id, revision_number, content, content_hash, origin_kind, origin_reference_json, created_at
          FROM wg_v2_work_source_revisions
          WHERE organization_id = ? AND owner_user_id = ? AND work_source_id = ? AND id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.workSourceId, input.revisionId) as
          | WorkSourceRevisionRecordRow
          | undefined
        if (!revision) return undefined
        return WorkSourceRevisionDtoSchema.parse({
          id: revision.id,
          workSourceId: revision.work_source_id,
          revisionNumber: revision.revision_number,
          content: revision.content,
          contentHash: revision.content_hash,
          origin:
            revision.origin_kind === "manual"
              ? { kind: "manual" }
              : revision.origin_kind === "authoring"
                ? {
                    kind: "authoring",
                    ...AuthoringSourceRevisionSchema.parse(
                      JSON.parse(requiredOriginReference(revision.origin_reference_json, "authoring")),
                    ),
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
          SELECT id, subject_type, subject_id, requirement_id, source_attempt_id, reference_json, provenance_json, created_at
          FROM wg_v2_evidence WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `,
          )
          .get(context.organizationId, context.ownerUserId, input.evidenceId) as StoredEvidenceRow | undefined
        if (!row) return undefined
        return canonicalEvidenceDto(database, context, evidenceSubject(row.subject_type, row.subject_id), row)
      },
      list: async (context: WorkGraphContext, input: EvidenceListInput) => {
        const resume = input.after
          ? readEvidencePageCursor(input.after, context.organizationId, context.ownerUserId, input.subject)
          : undefined
        const rows = database
          .prepare(
            `
          SELECT id, subject_type, subject_id, requirement_id, source_attempt_id, reference_json, provenance_json, created_at
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
        const resume = input.after
          ? readAttentionCursor(input.after, context.organizationId, context.ownerUserId)
          : undefined
        const acknowledgement = database.prepare(`
          SELECT read_through_at, cleared_through_at FROM wg_v2_attention_acknowledgements
          WHERE organization_id = ? AND owner_user_id = ?
        `).get(context.organizationId, context.ownerUserId) as
          | { read_through_at: number; cleared_through_at: number | null }
          | undefined
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
        const total = database
          .prepare(`SELECT COUNT(*) AS count FROM (${sqliteAttentionRows}) WHERE @cleared_at IS NULL OR updated_at > @cleared_at`)
          .get({ organization: context.organizationId, owner: context.ownerUserId, cleared_at: acknowledgement?.cleared_through_at ?? null }) as { count: number }
        const page = rows.slice(0, input.limit).map((row) =>
          sqliteAttentionItem(database, context, row, acknowledgement?.read_through_at),
        )
        const hasMore = rows.length > input.limit
        return AttentionPageSchema.parse({
          items: page,
          total: total.count,
          hasMore,
          ...(hasMore
            ? { nextCursor: createAttentionCursor(context.organizationId, context.ownerUserId, page.at(-1)!) }
            : {}),
        })
      },
    },
    changes: {
      list: async (context: WorkGraphContext, input: Readonly<{ after?: ChangeCursor; limit?: number }>) =>
        readChanges(database, context, input).slice(0, input.limit ?? Number.MAX_SAFE_INTEGER),
      listStream: async (context: WorkGraphContext, input: Readonly<{ streamId: StreamID; after?: ChangeCursor }>) =>
        readChanges(database, context, input),
    },
    workItems: {
      readDetail: async (context: WorkGraphContext, input: Readonly<{ workItemId: string }>) =>
        readWorkItemRecords(database, context, input.workItemId)[0],
      listAttempts: async (context: WorkGraphContext, input: WorkItemAttemptListInput) => {
        const resume = input.after
          ? readWorkItemAttemptPageCursor(input.after, context.organizationId, context.ownerUserId, input.workItemId)
          : undefined
        const rows = database
          .prepare(
            `
          SELECT * FROM wg_v2_attempts
          WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?
            AND (? IS NULL OR attempt_number > ? OR (attempt_number = ? AND id > ?))
          ORDER BY attempt_number, id LIMIT ?
        `,
          )
          .all(
            context.organizationId,
            context.ownerUserId,
            input.workItemId,
            resume?.attemptNumber ?? null,
            resume?.attemptNumber ?? null,
            resume?.attemptNumber ?? null,
            resume?.attemptId ?? null,
            input.limit + 1,
          ) as AttemptRecordRow[]
        const page = rows.slice(0, input.limit)
        const hasMore = rows.length > input.limit
        return WorkItemAttemptPageSchema.parse({
          attempts: page.map((row) => attemptDetailDto(database, context, row)),
          hasMore,
          ...(hasMore
            ? {
                nextCursor: createWorkItemAttemptPageCursor({
                  organizationId: context.organizationId,
                  ownerUserId: context.ownerUserId,
                  workItemId: input.workItemId,
                  attemptNumber: page.at(-1)!.attempt_number,
                  attemptId: page.at(-1)!.id,
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
          SELECT id, requirement_id, source_attempt_id, reference_json, provenance_json, created_at FROM wg_v2_evidence
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
    ...readAttemptRecords(database, context),
    ...readDecisionRecords(database, context),
    ...readRecapRecords(database, context),
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
    .get(context.organizationId, context.ownerUserId, row.id, row.latest_revision_number) as
    | { id: WorkSourceRevisionID }
    | undefined
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
  input: Readonly<{ after?: ChangeCursor; streamId?: StreamID }>,
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
    WHERE changes.organization_id = ? AND changes.owner_user_id = ? AND changes.cursor > ?
      AND (? IS NULL OR changes.stream_id = ?)
    ORDER BY changes.cursor
  `,
    )
    .all(
      context.organizationId,
      context.ownerUserId,
      position,
      input.streamId ?? null,
      input.streamId ?? null,
    ) as ChangeRow[]
  return rows.map((row) =>
    withLegacyChange(
      ChangeEnvelopeSchema.parse({
        cursor: createChangeCursor({
          organizationId: context.organizationId,
          ownerUserId: context.ownerUserId,
          scope,
          position: Number(row.cursor),
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
  const parameters = streamId
    ? [context.organizationId, context.ownerUserId, streamId]
    : [context.organizationId, context.ownerUserId]
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
  const latestRecaps = new Map<string, string>()
  const recaps = database
    .prepare(
      `
    SELECT id, stream_id, generation_result_json FROM wg_v2_recaps
    WHERE organization_id = ? AND owner_user_id = ? ${streamId ? "AND stream_id = ?" : ""}
    ORDER BY stream_id, activity_end_sequence DESC, id DESC
  `,
    )
    .all(...parameters) as Array<{ id: string; stream_id: string; generation_result_json: string }>
  recaps.forEach((recap) => {
    if (latestRecaps.has(recap.stream_id)) return
    const generation = JSON.parse(recap.generation_result_json) as {
      state?: unknown
      method?: unknown
      sessionId?: unknown
    }
    if (
      generation.state === "succeeded" &&
      generation.method === "agent_session" &&
      typeof generation.sessionId === "string" &&
      generation.sessionId.trim()
    ) {
      latestRecaps.set(recap.stream_id, recap.id)
    }
  })
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
    const recapDefaults = RecapProfileDefaultsSchema.parse(JSON.parse(row.recap_defaults_json))
    const recapQuietHours = recapDefaults.model && recapDefaults.effort ? (recapDefaults.quietHours ?? 0) : 0
    const memory = JSON.parse(row.memory_card_json) as { summary?: unknown }
    const latestRecap = latestRecaps.get(row.id)
    return StreamDtoSchema.parse({
      recordType: "stream",
      schemaVersion: 1,
      ownerUserId: context.ownerUserId,
      version: row.row_version,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      provenance: provenance.get(row.id) ?? { actor: { type: "user", id: context.ownerUserId } },
      id: row.id,
      title: row.title,
      description: row.purpose,
      lifecycleState: row.lifecycle,
      visibility: row.visibility,
      pinned: !!row.pinned,
      executionDefaults: JSON.parse(row.execution_defaults_json),
      recapDefaults,
      activityGranularity: row.activity_granularity,
      ...(typeof memory.summary === "string" && memory.summary.trim() ? { memory } : {}),
      activity: {
        lastActivityAt: activityAt,
        recapDueAt: activityAt + recapQuietHours * 60 * 60 * 1000,
        ...(latestRecap ? { lastRecapId: latestRecap } : {}),
      },
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
    SELECT defaults_json, recap_defaults_json, row_version, created_at, updated_at
    FROM wg_v2_workgraphs WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, rootId) as
    | {
        defaults_json: string
        recap_defaults_json: string
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
    provenance: row
      ? recordProvenance(database, context, "workgraph", rootId)
      : { actor: { type: "system", id: "workgraph_defaults" } },
    id: rootId,
    defaults: {
      execution: JSON.parse(row?.defaults_json ?? "{}"),
      recap: JSON.parse(row?.recap_defaults_json ?? "{}"),
    },
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
    .prepare(
      `SELECT * FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? ${workItemId ? "AND id = ?" : ""} ORDER BY created_at, id`,
    )
    .all(
      ...(workItemId
        ? [context.organizationId, context.ownerUserId, workItemId]
        : [context.organizationId, context.ownerUserId]),
    ) as WorkItemRecordRow[]
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
      ...(row.lifecycle === "abandoned"
        ? { abandonedAt: Number(row.abandoned_at), abandonReason: row.abandoned_reason }
        : {}),
    }),
  )
}

function readAttemptRecords(database: Database, context: WorkGraphContext, attemptId?: string) {
  const rows = database
    .prepare(
      `SELECT * FROM wg_v2_attempts WHERE organization_id = ? AND owner_user_id = ? ${attemptId ? "AND id = ?" : ""} ORDER BY created_at, id`,
    )
    .all(
      ...(attemptId
        ? [context.organizationId, context.ownerUserId, attemptId]
        : [context.organizationId, context.ownerUserId]),
    ) as AttemptRecordRow[]
  return rows.map((row) => attemptDto(database, context, row))
}

function attemptDto(database: Database, context: WorkGraphContext, row: AttemptRecordRow) {
  const executionReferences = {
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.envelope_id ? { workspaceId: row.envelope_id } : {}),
    ...(row.child_workspace_id ? { childWorkspaceId: row.child_workspace_id } : {}),
  }
  return AttemptDtoSchema.parse({
    recordType: "attempt",
    schemaVersion: 1,
    ownerUserId: context.ownerUserId,
    version: row.row_version,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    provenance: recordProvenance(database, context, "attempt", row.id),
    id: row.id,
    streamId: row.stream_id,
    workItemId: row.work_item_id,
    attemptNumber: row.attempt_number,
    state: row.lifecycle,
    executionKind: row.execution_kind,
    resolvedExecution: JSON.parse(row.resolved_execution_profile_json),
    admittedAt: Number(row.created_at),
    ...(row.started_at ? { startedAt: Number(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: Number(row.finished_at) } : {}),
    ...(row.terminal_result_json ? { result: JSON.parse(row.terminal_result_json) } : {}),
    ...(row.attention_reason ? { attentionReason: row.attention_reason } : {}),
    sourceRevisionRefs: readSourceRefs(database, context, "attempt", row.id),
    ...(Object.keys(executionReferences).length ? { executionReferences } : {}),
  })
}

function attemptDetailDto(database: Database, context: WorkGraphContext, row: AttemptRecordRow) {
  const executionReferences = {
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.envelope_id ? { workspaceId: row.envelope_id } : {}),
    ...(row.child_workspace_id ? { childWorkspaceId: row.child_workspace_id } : {}),
  }
  return AttemptDetailDtoSchema.parse({
    attempt: attemptDto(database, context, row),
    ...(Object.keys(executionReferences).length ? { executionReferences } : {}),
  })
}

function readDecisionRecords(database: Database, context: WorkGraphContext, decisionId?: string) {
  const rows = database
    .prepare(
      `SELECT * FROM wg_v2_decisions WHERE organization_id = ? AND owner_user_id = ? ${decisionId ? "AND id = ?" : ""} ORDER BY created_at, id`,
    )
    .all(
      ...(decisionId
        ? [context.organizationId, context.ownerUserId, decisionId]
        : [context.organizationId, context.ownerUserId]),
    ) as DecisionRecordRow[]
  return rows.map((row) => {
    const recommendation = row.recommendation_json
      ? (JSON.parse(row.recommendation_json) as { optionId: string })
      : undefined
    const answer = row.answer_json
      ? (JSON.parse(row.answer_json) as { optionId?: string; answer?: string; dismissReason?: string })
      : undefined
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
      ...(row.lifecycle === "dismissed"
        ? { dismissedAt: Number(row.answered_at), dismissReason: answer?.dismissReason }
        : {}),
    })
  })
}

function readRecapRecords(database: Database, context: WorkGraphContext, recapId?: string) {
  const rows = database
    .prepare(
      `
    SELECT recaps.* FROM wg_v2_recaps recaps
    WHERE recaps.organization_id = ? AND recaps.owner_user_id = ? ${recapId ? "AND recaps.id = ?" : ""} ORDER BY recaps.created_at, recaps.id
  `,
    )
    .all(
      ...(recapId
        ? [context.organizationId, context.ownerUserId, recapId]
        : [context.organizationId, context.ownerUserId]),
    ) as RecapRecordRow[]
  return rows.map((row) => {
    const profile = JSON.parse(row.generation_profile_json) as { model?: unknown; effort?: unknown }
    const result = JSON.parse(row.generation_result_json) as {
      state: "succeeded" | "failed"
      generatedAt?: number
      failedAt?: number
      invalidatedAt?: number
      reason?: string
      method?: "agent_session" | "deterministic_fallback"
      sessionId?: string
    }
    const model = ModelSelectionSchema.safeParse(profile.model)
    const effort = typeof profile.effort === "string" && profile.effort.trim() ? profile.effort : undefined
    const nonSession = result.state === "succeeded" && (result.method === "deterministic_fallback" || !result.sessionId)
    const completeSuccess =
      result.state === "succeeded" && !nonSession && model.success && effort && Number.isFinite(result.generatedAt)
    const completeFailure =
      result.state === "failed" &&
      model.success &&
      effort &&
      typeof result.reason === "string" &&
      result.reason.trim() &&
      (Number.isFinite(result.failedAt) || Number.isFinite(result.invalidatedAt))
    const invalidated = !completeSuccess && !completeFailure
    return RecapDtoSchema.parse({
      recordType: "recap",
      schemaVersion: 1,
      ownerUserId: context.ownerUserId,
      version: 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.created_at),
      provenance: JSON.parse(row.provenance_json),
      id: row.id,
      streamId: row.stream_id,
      ...(row.previous_recap_id ? { previousRecapId: row.previous_recap_id } : {}),
      activityRange: {
        fromSequence: row.activity_start_sequence,
        toSequence: row.activity_end_sequence,
        quietSince: Number(row.quiet_since),
      },
      summary: row.summary,
      actionableReferences: invalidated ? [] : JSON.parse(row.actionable_references_json),
      generation: invalidated
        ? {
            state: "invalidated",
            ...(model.success ? { model: model.data } : {}),
            ...(effort ? { effort } : {}),
            reason: nonSession
              ? "Retired deterministic Recap fallback is non-authoritative"
              : "Incomplete legacy Recap generation metadata is non-authoritative",
            source: nonSession ? "retired_non_session_generation" : "retired_incomplete_generation",
          }
        : result.state === "succeeded"
          ? {
              state: "succeeded",
              model: model.data!,
              effort: effort!,
              generatedAt: Number(result.generatedAt),
              method: "agent_session",
              sessionId: result.sessionId!,
            }
          : {
              state: "failed",
              model: model.data!,
              effort: effort!,
              ...(result.failedAt === undefined ? {} : { failedAt: Number(result.failedAt) }),
              ...(result.invalidatedAt === undefined ? {} : { invalidatedAt: Number(result.invalidatedAt) }),
              reason: result.reason!,
            },
      sourceRevisionRefs: readSourceRefs(database, context, "recap", row.id),
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
    .all(
      ...(proposalId
        ? [context.organizationId, context.ownerUserId, proposalId]
        : [context.organizationId, context.ownerUserId]),
    ) as AdmissionRecordRow[]
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
        | { method: "planning"; attempt: number; queuedAt: number; startedAt?: number }
        | {
            method: "planning_failed"
            attempt: number
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
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      record: requiredAttentionRecord(readAdmissionRecords(database, context, row.id), row),
    })
  }
  if (row.kind === "decision") {
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      record: requiredAttentionRecord(readDecisionRecords(database, context, row.id), row),
    })
  }
  if (row.kind === "work_item") {
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      record: requiredAttentionRecord(readWorkItemRecords(database, context, row.id), row),
    })
  }
  if (row.kind === "attempt") {
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      record: requiredAttentionRecord(readAttemptRecords(database, context, row.id), row),
    })
  }
  if (row.kind === "recap_notification") {
    const notification = database
      .prepare(
        `
      SELECT id, owner_user_id, row_version, state, stream_id, recap_id, created_at, updated_at, read_at
      FROM wg_v2_notifications WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `,
      )
      .get(context.organizationId, context.ownerUserId, row.id) as NotificationAttentionRow | undefined
    if (!notification) throw new Error(`Attention notification ${row.id} disappeared during its owner-scoped read`)
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      notification: WorkGraphNotificationSchema.parse({
        id: notification.id,
        ownerUserId: context.ownerUserId,
        version: notification.row_version,
        kind: "actionable_recap",
        state: notification.state,
        streamId: notification.stream_id,
        recapId: notification.recap_id,
        createdAt: Number(notification.created_at),
        updatedAt: Number(notification.updated_at),
        ...(notification.read_at === null ? {} : { readAt: Number(notification.read_at) }),
      }),
      recap: requiredAttentionRecord(readRecapRecords(database, context, notification.recap_id), row),
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
    if (!row.last_error || !row.job_type || !row.payload_json)
      throw new Error(`Generation configuration attention ${row.id} is incomplete`)
    const marker = (
      JSON.parse(row.payload_json) as {
        configurationRequirement?: { type?: unknown; purpose?: unknown; scope?: unknown }
      }
    ).configurationRequirement
    return AttentionItemSchema.parse({
      kind: row.kind,
      ownerUserId: context.ownerUserId,
      id: row.id,
      updatedAt: row.updated_at,
      ...read,
      requirement: {
        type: marker?.type,
        jobId: row.id,
        purpose: marker?.purpose,
        scope: marker?.scope,
        reason: row.last_error,
      },
    })
  }
  throw new Error(`Unsupported SQLite Attention kind ${String(row.kind)}`)
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
  if (record.recordType === "attempt") return { type: "attempt", id: record.id }
  if (record.recordType === "decision") return { type: "decision", id: record.id }
  if (record.recordType === "recap") return { type: "recap", id: record.id }
  return { type: "admission_proposal", id: record.id }
}

function withLegacyChange<Record extends { event: { type: string; occurredAt: number; streamId?: StreamID } }>(
  record: Record,
) {
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
    ...(row.source_attempt_id ? { sourceAttemptId: row.source_attempt_id } : {}),
    recordedAt: Number(row.created_at),
    recordedBy: provenance.actor,
  } as EvidenceDto
}

function canonicalEvidenceDto(
  database: Database,
  context: WorkGraphContext,
  subject: EvidenceSubject,
  row: EvidenceRow,
) {
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
    .get(context.organizationId, context.ownerUserId, `${provenance.operationId}:integration`) as
    | { id: string }
    | undefined
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
      .get(context.organizationId, context.ownerUserId, subject.workItemId) as
      | { id: string; stream_id: string }
      | undefined
    return row ? { subjectId: row.id, streamId: row.stream_id } : undefined
  }
  const row = database
    .prepare("SELECT id, stream_id FROM wg_v2_outcomes WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
    .get(context.organizationId, context.ownerUserId, subject.outcomeId) as
    | { id: string; stream_id: string }
    | undefined
  return row ? { subjectId: row.id, streamId: row.stream_id } : undefined
}

function promoteSatisfiedResultReadyWork(
  database: Database,
  context: WorkGraphContext,
  workItemId: WorkItemID,
  occurredAt: number,
): { completed: boolean; outcomeId?: string } {
  const item = database
    .prepare(
      `
    SELECT lifecycle, completion_contract_json, outcome_id FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId) as
    | { lifecycle: string; completion_contract_json: string; outcome_id: string | null }
    | undefined
  if (!item || item.lifecycle !== "result_ready") return { completed: false as const }
  const evidence = database
    .prepare(
      `
    SELECT id, requirement_id, source_attempt_id, reference_json, provenance_json, created_at FROM wg_v2_evidence
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
  const completed =
    database
      .prepare(
        `
    UPDATE wg_v2_work_items SET lifecycle = 'completed', completed_at = ?, updated_at = ?, row_version = row_version + 1
    WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'result_ready'
  `,
      )
      .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, workItemId).changes === 1
  if (!completed || !item.outcome_id) return { completed }
  const unfinished = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_work_items
    WHERE organization_id = ? AND owner_user_id = ? AND outcome_id = ? AND lifecycle NOT IN ('completed', 'abandoned') LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, item.outcome_id)
  if (unfinished) return { completed }
  const promoted = database
    .prepare(
      `
    UPDATE wg_v2_outcomes SET lifecycle = 'ready_to_close', ready_to_close_at = ?, updated_at = ?, row_version = row_version + 1
    WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'active'
  `,
    )
    .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, item.outcome_id)
  return { completed, ...(promoted.changes === 1 ? { outcomeId: item.outcome_id } : {}) }
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

async function launchAttempt(
  database: Database,
  execution: WorkspaceExecutionPort,
  context: WorkGraphContext,
  attemptId: AttemptID,
  occurredAt: number,
  ids: Readonly<{ next: (kind: string) => string }>,
  schedulePlacementCompensationDrain?: () => void,
) {
  const row = database
    .prepare(
      `
    SELECT attempts.stream_id, attempts.work_item_id, attempts.resolved_execution_profile_json, attempts.lease_epoch,
      items.title, items.description, items.completion_contract_json, streams.envelope_identity_json
    FROM wg_v2_attempts attempts
    JOIN wg_v2_work_items items ON items.organization_id = attempts.organization_id AND items.owner_user_id = attempts.owner_user_id AND items.id = attempts.work_item_id
    JOIN wg_v2_streams streams ON streams.organization_id = attempts.organization_id AND streams.owner_user_id = attempts.owner_user_id AND streams.id = attempts.stream_id
    WHERE attempts.organization_id = ? AND attempts.owner_user_id = ? AND attempts.id = ? AND attempts.lifecycle = 'admitted'
  `,
    )
    .get(context.organizationId, context.ownerUserId, attemptId) as
    | {
        stream_id: StreamID
        work_item_id: WorkItemID
        resolved_execution_profile_json: string
        title: string
        description: string
        completion_contract_json: string
        envelope_identity_json: string | null
        lease_epoch: number
      }
    | undefined
  if (!row) return
  const envelope = row.envelope_identity_json ? (JSON.parse(row.envelope_identity_json) as { id?: string }) : undefined
  await placeAdmittedAttempt(
    context,
    {
      attemptId,
      streamId: row.stream_id,
      workItemId: row.work_item_id,
      prompt: `${row.title}\n\n${row.description}\n\nCompletion contract:\n${row.completion_contract_json}`,
      profile: JSON.parse(row.resolved_execution_profile_json),
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
          .get(
            context.organizationId,
            context.ownerUserId,
            input.workItemId,
            input.attemptId,
            input.leaseEpoch,
            occurredAt,
          ),
      markPlacing: async (_context, input) => {
        return database.transaction(() => {
          const owned = database
            .prepare(
              `
          SELECT 1 FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
            AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
        `,
            )
            .get(context.organizationId, context.ownerUserId, row.work_item_id, attemptId, input.leaseEpoch, occurredAt)
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
          UPDATE wg_v2_attempts SET lifecycle = 'placing', envelope_id = ?, child_workspace_id = ?, updated_at = ?, row_version = row_version + 1
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'admitted' AND lease_epoch = ?
        `,
            )
            .run(
              input.envelope.id,
              input.childIsolationId ?? null,
              occurredAt,
              context.organizationId,
              context.ownerUserId,
              attemptId,
              input.leaseEpoch,
            )
          if (changed.changes !== 1) return false
          appendRuntimeChange(
            database,
            context,
            { type: "attempt_state_changed", attemptId, streamId: row.stream_id, state: "placing" },
            occurredAt,
          )
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
            .get(context.organizationId, context.ownerUserId, row.work_item_id, attemptId, input.leaseEpoch, occurredAt)
          if (!owned) return false
          const changed = database
            .prepare(
              `
          UPDATE wg_v2_attempts SET lifecycle = 'running', session_id = ?, started_at = ?, updated_at = ?, row_version = row_version + 1
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'placing' AND lease_epoch = ?
        `,
            )
            .run(
              input.launch.sessionId,
              occurredAt,
              occurredAt,
              context.organizationId,
              context.ownerUserId,
              attemptId,
              input.leaseEpoch,
            )
          if (changed.changes !== 1) return false
          const activeBinding = database
            .prepare(
              `
            SELECT current_attempt_id FROM wg_v2_session_bindings
            WHERE organization_id = ? AND owner_user_id = ? AND session_id = ? AND state = 'active'
          `,
            )
            .get(context.organizationId, context.ownerUserId, input.launch.sessionId) as
            | { current_attempt_id: string | null }
            | undefined
          if (activeBinding && activeBinding.current_attempt_id !== attemptId) {
            throw new Error("Execution Session is already bound to another Attempt")
          }
          if (!activeBinding) {
            database
              .prepare(
                `
              INSERT INTO wg_v2_session_bindings
                (organization_id, owner_user_id, id, stream_id, session_id, project_id, current_work_item_id,
                 current_attempt_id, state, bound_at, provenance_json, created_at, updated_at)
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
                attemptId,
                occurredAt,
                JSON.stringify({ actor: context.actor }),
                occurredAt,
                occurredAt,
              )
          }
          appendRuntimeChange(
            database,
            context,
            { type: "attempt_state_changed", attemptId, streamId: row.stream_id, state: "running" },
            occurredAt,
          )
          return true
        })()
      },
      markAttention: async (_context, input) => {
        return database.transaction(() => {
          const owned = database
            .prepare(
              `
          SELECT 1 FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
            AND holder_id = ? AND epoch = ? AND CAST(expires_at AS INTEGER) > ?
        `,
            )
            .get(context.organizationId, context.ownerUserId, row.work_item_id, attemptId, input.leaseEpoch, occurredAt)
          if (!owned) return false
          const changed = database
            .prepare(
              `
          UPDATE wg_v2_attempts SET lifecycle = 'attention', attention_reason = ?, updated_at = ?, row_version = row_version + 1
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lease_epoch = ? AND lifecycle IN ('admitted', 'placing')
        `,
            )
            .run(input.reason, occurredAt, context.organizationId, context.ownerUserId, attemptId, input.leaseEpoch)
          if (changed.changes !== 1) return false
          database
            .prepare(
              `
          DELETE FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? AND resource_type = 'work_item' AND resource_id = ?
            AND holder_id = ? AND epoch = ?
        `,
            )
            .run(context.organizationId, context.ownerUserId, row.work_item_id, attemptId, input.leaseEpoch)
          database
            .prepare(
              `
          UPDATE wg_v2_streams SET execution_state = 'stopped', updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND execution_mode = 'autonomous'
        `,
            )
            .run(occurredAt, context.organizationId, context.ownerUserId, row.stream_id)
          appendRuntimeChange(
            database,
            context,
            { type: "attempt_state_changed", attemptId, streamId: row.stream_id, state: "attention" },
            occurredAt,
          )
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
              kind: "compensate_attempt_placement",
              resourceType: "attempt",
              resourceId: input.attemptId,
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
    row.lease_epoch,
  )
}

function admitAttempt(
  database: Database,
  context: WorkGraphContext,
  workItemId: WorkItemID,
  executionMode: ExecutionMode,
  occurredAt: number,
  ids: Readonly<{ next: (kind: string) => string }>,
  capabilities: ExecutionCapabilities | undefined,
):
  | Readonly<{ ok: true; attemptId: string; streamId: string; leaseEpoch: number }>
  | Readonly<{ ok: false; code: CommandErrorCode; message: string }> {
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
  if (
    row.replacement_reset_json &&
    (JSON.parse(row.replacement_reset_json) as { state?: string }).state !== "completed"
  ) {
    return { ok: false, code: "blocked", message: "Stream replacement cleanup is still pending" }
  }
  if (row.stream_lifecycle === "paused")
    return { ok: false, code: "blocked", message: "Paused Streams do not admit new Attempts" }
  if (row.stream_lifecycle === "closed")
    return { ok: false, code: "invalid_transition", message: "Closed Streams do not execute" }
  if (["completed", "abandoned"].includes(row.lifecycle))
    return { ok: false, code: "invalid_transition", message: "Finished Work Items do not execute" }
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
    .get(context.organizationId, context.ownerUserId, workItemId) as
    | { holder_id: string; epoch: number; expires_at: number }
    | undefined
  if (lease && lease.expires_at <= occurredAt) {
    database
      .prepare(
        `
      UPDATE wg_v2_attempts SET lifecycle = 'attention', attention_reason = 'Execution lease expired', updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle IN ('admitted', 'placing', 'running')
    `,
      )
      .run(occurredAt, context.organizationId, context.ownerUserId, lease.holder_id)
  }
  const running = database
    .prepare(
      `
    SELECT 1 FROM wg_v2_attempts attempts
    JOIN wg_v2_leases leases ON leases.organization_id = attempts.organization_id AND leases.owner_user_id = attempts.owner_user_id AND leases.resource_type = 'work_item'
      AND leases.resource_id = attempts.work_item_id AND leases.holder_id = attempts.id AND leases.epoch = attempts.lease_epoch
    WHERE attempts.organization_id = ? AND attempts.owner_user_id = ? AND attempts.work_item_id = ? AND attempts.lifecycle IN ('admitted', 'placing', 'running')
      AND CAST(leases.expires_at AS INTEGER) > ? LIMIT 1
  `,
    )
    .get(context.organizationId, context.ownerUserId, workItemId, occurredAt)
  if (running) return { ok: false, code: "blocked", message: "Work Item already has an active Attempt" }
  const resolved = resolveExecutionProfile({
    workgraph: JSON.parse(row.workgraph_defaults),
    stream: JSON.parse(row.stream_defaults),
    ...(row.outcome_defaults ? { outcome: JSON.parse(row.outcome_defaults) } : {}),
    workItem: JSON.parse(row.execution_overrides_json),
  })
  if (!resolved.ok)
    return {
      ok: false,
      code: "validation_error",
      message: `Incomplete execution profile: ${resolved.error.missingFields.join(", ")}`,
    }
  if (!capabilities)
    return { ok: false, code: "execution_unavailable", message: "Execution capability catalog is not configured" }
  const supported = validateResolvedExecutionProfileAgainstCapabilities({
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    now: occurredAt,
    capabilities,
    profile: resolved.profile,
  })
  if (!supported.ok) return { ok: false, code: "validation_error", message: capabilityMessage(supported.diagnostics) }
  const attemptId = ids.next("attempt")
  const leaseEpoch = lease ? lease.epoch + 1 : 1
  const attemptNumber = (
    database
      .prepare(
        "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS value FROM wg_v2_attempts WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?",
      )
      .get(context.organizationId, context.ownerUserId, workItemId) as { value: number }
  ).value
  database
    .prepare(
      `
    INSERT INTO wg_v2_attempts
      (organization_id, owner_user_id, id, stream_id, work_item_id, attempt_number, lifecycle, execution_mode, resolved_execution_profile_json, lease_epoch, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?, ?, ?)
  `,
    )
    .run(
      context.organizationId,
      context.ownerUserId,
      attemptId,
      row.stream_id,
      workItemId,
      attemptNumber,
      executionMode,
      JSON.stringify(resolved.profile),
      leaseEpoch,
      occurredAt,
      occurredAt,
    )
  database
    .prepare(
      `
    INSERT INTO wg_v2_leases (organization_id, owner_user_id, id, resource_type, resource_id, holder_id, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, 'work_item', ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, owner_user_id, resource_type, resource_id) DO UPDATE SET
      holder_id = excluded.holder_id, epoch = wg_v2_leases.epoch + 1, expires_at = excluded.expires_at,
      row_version = wg_v2_leases.row_version + 1, updated_at = excluded.updated_at
    WHERE CAST(wg_v2_leases.expires_at AS INTEGER) <= ?
  `,
    )
    .run(
      context.organizationId,
      context.ownerUserId,
      ids.next("lease"),
      workItemId,
      attemptId,
      occurredAt + 300_000,
      occurredAt,
      occurredAt,
      occurredAt,
    )
  database
    .prepare(
      "UPDATE wg_v2_work_items SET lifecycle = 'active', updated_at = ?, row_version = row_version + 1 WHERE organization_id = ? AND owner_user_id = ? AND id = ?",
    )
    .run(occurredAt, context.organizationId, context.ownerUserId, workItemId)
  return { ok: true, attemptId, streamId: row.stream_id, leaseEpoch }
}

function ownedStream(database: Database, context: WorkGraphContext, streamId: string) {
  return database
    .prepare(
      `
    SELECT id, title, lifecycle, visibility, row_version, envelope_identity_json, replacement_reset_json
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
    SELECT id, stream_id, lifecycle, row_version FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?
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

function exactSourceHead(database: Database, context: WorkGraphContext, source: WorkSourceRevisionRef) {
  const row = database
    .prepare(
      `
    SELECT revisions.revision_number, revisions.content_hash, revisions.content, sources.latest_revision_number, sources.title
    FROM wg_v2_work_source_revisions revisions
    JOIN wg_v2_work_sources sources ON sources.organization_id = revisions.organization_id AND sources.owner_user_id = revisions.owner_user_id AND sources.id = revisions.work_source_id
    WHERE revisions.organization_id = ? AND revisions.owner_user_id = ? AND revisions.work_source_id = ? AND revisions.id = ?
  `,
    )
    .get(context.organizationId, context.ownerUserId, source.workSourceId, source.revisionId) as
    | { revision_number: number; content_hash: string; content: string; latest_revision_number: number; title: string }
    | undefined
  return {
    exists: !!row,
    current: !!row && row.revision_number === row.latest_revision_number && row.content_hash === source.contentHash,
    title: row?.title ?? "",
    content: row?.content ?? "",
  }
}

function previousSourceRevision(
  database: Database,
  context: WorkGraphContext,
  streamId: StreamID,
  current: WorkSourceRevisionRef,
) {
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
  if (value === null)
    throw new Error(
      `${kind === "authoring" ? "Authoring" : "External"} Work Source revision is missing its immutable origin reference`,
    )
  return value
}

function sourcePlanningEvidence(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{ title: string; content: string; targetStreamId?: StreamID; now: number }>,
) {
  const candidate = { title: input.title, body: input.content }
  const readStreams = (where: string, limit: number, offset = 0) =>
    database
      .prepare(
        `
    SELECT id, title, purpose, pinned, last_activity_at, updated_at, memory_card_json
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
          memory_card_json: string
        }
        return {
          id: stream.id as StreamID,
          title: stream.title,
          summary: `${stream.purpose} ${stream.memory_card_json}`,
          pinned: stream.pinned === 1,
          lastActivityAt: Number(stream.last_activity_at ?? stream.updated_at),
        } satisfies MatchableStream
      })
  const recent = readStreams("", 24)
  const pinned = readStreams("AND pinned = 1", 12)
  const primary = rankStreamMatches([...recent, ...pinned], candidate, input.now)
  const ranked =
    primary[0]?.confidence === "high"
      ? primary
      : rankStreamMatches(
          [
            ...recent,
            ...pinned,
            ...readStreams("AND memory_card_json <> '{}'", 16, 24).map((stream) => ({ ...stream, memoryOnly: true })),
          ],
          candidate,
          input.now,
        )
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
        subject:
          record.subject_type === "outcome"
            ? { type: "outcome" as const, outcomeId: record.id }
            : { type: "work_item" as const, workItemId: record.id },
        streamId: record.stream_id as StreamID,
        title: record.title,
        summary: record.summary,
        state: record.state,
        updatedAt: Number(record.updated_at),
      } satisfies DuplicateCandidate
    })
  return {
    ...(input.targetStreamId
      ? { targetStreamId: input.targetStreamId }
      : recommendation
        ? { targetStreamId: recommendation.streamId }
        : {}),
    placementMatches: explicit,
    duplicateMatches: rankDuplicateMatches(duplicates, candidate),
  }
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
    .run(
      context.organizationId,
      context.ownerUserId,
      ids.next("source_ref"),
      recordType,
      recordId,
      source.workSourceId,
      source.revisionId,
      ordinal.ordinal,
      occurredAt,
    )
}

function appendRuntimeChange(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{ type: string; attemptId: AttemptID; streamId: StreamID; state: string }>,
  occurredAt: number,
) {
  const operationId = `runtime_${input.attemptId}_${input.state}_${crypto.randomUUID()}` as OperationID
  const cursorPosition = allocateCursor(database, context, occurredAt)
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
        value: { attemptId: input.attemptId, state: input.state },
      }),
      cursorPosition,
      occurredAt,
    )
  const sequence = allocateEventSequence(database, context, input.streamId, occurredAt)
  const payload = JSON.stringify({ attemptId: input.attemptId, streamId: input.streamId, state: input.state })
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
    VALUES (?, ?, ?, ?, ?, ?, 'attempt', ?, ?, ?, ?)
  `,
    )
    .run(
      context.organizationId,
      context.ownerUserId,
      cursorPosition,
      `change_${crypto.randomUUID()}`,
      input.streamId,
      operationId,
      input.attemptId,
      input.type,
      payload,
      occurredAt,
    )
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

function completeRuntimeEffect(
  database: Database,
  context: WorkGraphContext,
  operationId: OperationID,
  occurredAt: number,
) {
  database
    .prepare(
      `
    UPDATE wg_v2_runtime_effects SET state = 'completed', completed_at = ?, updated_at = ?, last_error = NULL
    WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
  `,
    )
    .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, operationId)
}

function failRuntimeEffect(
  database: Database,
  context: WorkGraphContext,
  operationId: OperationID,
  error: unknown,
  occurredAt: number,
) {
  database
    .prepare(
      `
    UPDATE wg_v2_runtime_effects SET state = 'pending', last_error = ?, updated_at = ?
    WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
  `,
    )
    .run(
      error instanceof Error ? error.message : String(error),
      occurredAt,
      context.organizationId,
      context.ownerUserId,
      operationId,
    )
}

function placementCompensationKey(input: PlacementCompensation) {
  return [
    "placement_compensation",
    input.attemptId,
    input.leaseEpoch,
    input.sessionId ?? input.childIsolationId ?? input.envelopeId,
  ].join(":")
}

type SqlitePlacementCompensation = PlacementCompensation & { failureHistory?: string[] }

function failSqlitePlacementCompensationEffect(
  database: Database,
  context: WorkGraphContext,
  key: OperationID,
  reason: string,
  occurredAt: number,
) {
  const row = database
    .prepare(
      `
    SELECT payload_json FROM wg_v2_runtime_effects
    WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
      AND effect_kind = 'compensate_attempt_placement'
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
    .run(
      JSON.stringify({ ...payload, failureHistory: [...(payload.failureHistory ?? []), reason] }),
      reason,
      occurredAt,
      context.organizationId,
      context.ownerUserId,
      key,
    )
}

function completeSqlitePlacementCompensationEffect(
  database: Database,
  context: WorkGraphContext,
  key: OperationID,
  occurredAt: number,
) {
  database.transaction(() => {
    const row = database
      .prepare(
        `
      SELECT payload_json FROM wg_v2_runtime_effects
      WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
        AND effect_kind = 'compensate_attempt_placement' AND state = 'claimed'
    `,
      )
      .get(context.organizationId, context.ownerUserId, key) as { payload_json: string } | undefined
    if (!row) return
    const compensation = JSON.parse(row.payload_json) as SqlitePlacementCompensation
    const attentionReason = compensation.failureHistory?.at(-1) ?? compensation.reason
    const changed = database
      .prepare(
        `
      UPDATE wg_v2_attempts SET lifecycle = 'attention', attention_reason = ?, updated_at = ?, row_version = row_version + 1
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        AND lifecycle IN ('admitted', 'placing') AND session_id IS NULL
    `,
      )
      .run(attentionReason, occurredAt, context.organizationId, context.ownerUserId, compensation.attemptId)
    if (changed.changes === 1) {
      database
        .prepare(
          `
        DELETE FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ?
          AND resource_type = 'work_item' AND resource_id = ? AND holder_id = ?
      `,
        )
        .run(context.organizationId, context.ownerUserId, compensation.workItemId, compensation.attemptId)
      database
        .prepare(
          `
        UPDATE wg_v2_streams SET execution_state = 'stopped', updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND execution_mode = 'autonomous'
      `,
        )
        .run(occurredAt, context.organizationId, context.ownerUserId, compensation.streamId)
      appendRuntimeChange(
        database,
        context,
        {
          type: "attempt_state_changed",
          attemptId: compensation.attemptId,
          streamId: compensation.streamId,
          state: "attention",
        },
        occurredAt,
      )
    }
    completeRuntimeEffect(database, context, key, occurredAt)
  })()
}

async function settleSqlitePlacementCompensationEffect(
  database: Database,
  context: WorkGraphContext,
  key: OperationID,
  execution: WorkspaceExecutionPort,
  occurredAt: number,
) {
  const row = database.transaction(() => {
    const current = database
      .prepare(
        `
      SELECT payload_json FROM wg_v2_runtime_effects
      WHERE organization_id = ? AND owner_user_id = ? AND idempotency_key = ?
        AND effect_kind = 'compensate_attempt_placement' AND state = 'pending'
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
            attemptId: compensation.attemptId,
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
    effect.status === "rejected"
      ? [
          `${compensation.sessionId && index === 0 ? "Session cancellation" : "workspace cleanup"} failed: ${runtimeErrorMessage(effect.reason)}`,
        ]
      : [],
  )
  if (failures.length > 0) {
    failSqlitePlacementCompensationEffect(
      database,
      context,
      key,
      [compensation.reason, ...failures].join("; "),
      occurredAt,
    )
    return
  }
  completeSqlitePlacementCompensationEffect(database, context, key, occurredAt)
}

async function drainSqlitePlacementCompensationEffects(
  database: Database,
  execution: WorkspaceExecutionPort,
  now: () => number,
) {
  const pending = database
    .prepare(
      `
    SELECT organization_id, owner_user_id, idempotency_key FROM wg_v2_runtime_effects
    WHERE effect_kind = 'compensate_attempt_placement' AND state = 'pending' ORDER BY created_at, id
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
    attemptIds: AttemptID[]
    sessions: Array<{ attemptId: AttemptID; sessionId: ExecutionSessionID }>
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
          attemptId: session.attemptId,
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
        .get(context.organizationId, context.ownerUserId, payload.streamId) as
        | { replacement_reset_json: string | null }
        | undefined
      const reset = current?.replacement_reset_json
        ? (JSON.parse(current.replacement_reset_json) as Record<string, unknown>)
        : undefined
      if (!reset || reset.state !== "pending") {
        completeRuntimeEffect(database, context, operationId, occurredAt)
        return
      }
      if (payload.attemptIds.length > 0) {
        database
          .prepare(
            `
          UPDATE wg_v2_attempts SET lifecycle = 'cancelled', attention_reason = 'Replaced by confirmed admission',
            finished_at = ?, row_version = row_version + 1, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id IN (${payload.attemptIds.map(() => "?").join(", ")})
            AND lifecycle = 'attention'
        `,
          )
          .run(occurredAt, occurredAt, context.organizationId, context.ownerUserId, ...payload.attemptIds)
      }
      database
        .prepare(
          `
        UPDATE wg_v2_streams SET replacement_reset_json = ?, envelope_identity_json = NULL,
          row_version = row_version + 1, updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `,
        )
        .run(
          JSON.stringify({ ...reset, state: "completed", completedAt: occurredAt }),
          occurredAt,
          context.organizationId,
          context.ownerUserId,
          payload.streamId,
        )
      appendReplacementResetCompletedChange(database, context, payload, occurredAt)
      completeRuntimeEffect(database, context, operationId, occurredAt)
    })()
  } catch (error) {
    failRuntimeEffect(database, context, operationId, error, occurredAt)
  }
}

function appendReplacementResetCompletedChange(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{ streamId: StreamID; proposalId: string }>,
  occurredAt: number,
) {
  const operationId = `replacement_reset_completed_${input.proposalId}` as OperationID
  if (
    database
      .prepare("SELECT 1 FROM wg_v2_operation_results WHERE organization_id = ? AND owner_user_id = ? AND id = ?")
      .get(context.organizationId, context.ownerUserId, operationId)
  )
    return
  const cursorPosition = allocateCursor(database, context, occurredAt)
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
    .run(
      context.organizationId,
      context.ownerUserId,
      operationId,
      hash(operationId),
      JSON.stringify(result),
      cursorPosition,
      occurredAt,
    )
  database
    .prepare(
      `
    INSERT INTO wg_v2_events
      (organization_id, owner_user_id, id, stream_id, sequence, schema_version, operation_id, event_type, actor_type, actor_id, request_id, payload_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, 'stream_replacement_reset_completed', 'system', 'workgraph_runtime', ?, ?, ?)
  `,
    )
    .run(
      context.organizationId,
      context.ownerUserId,
      `event_${operationId}`,
      input.streamId,
      sequence,
      operationId,
      operationId,
      payload,
      occurredAt,
    )
  database
    .prepare(
      `
    INSERT INTO wg_v2_changes
      (organization_id, owner_user_id, cursor, id, stream_id, operation_id, resource_type, resource_id, change_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'stream', ?, 'stream_replacement_reset_completed', ?, ?)
  `,
    )
    .run(
      context.organizationId,
      context.ownerUserId,
      cursorPosition,
      `change_${operationId}`,
      input.streamId,
      operationId,
      input.streamId,
      payload,
      occurredAt,
    )
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
      .get(context.organizationId, context.ownerUserId, request.command.streamId) as
      | { operation_id: string }
      | undefined
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
    .prepare(
      "DELETE FROM wg_v2_stream_cleanup_reservations WHERE organization_id = ? AND owner_user_id = ? AND operation_id = ?",
    )
    .run(context.organizationId, context.ownerUserId, operationId)
}

function completeStreamCleanup(
  database: Database,
  context: WorkGraphContext,
  operationId: OperationID,
  occurredAt: number,
) {
  database
    .prepare(
      `
    UPDATE wg_v2_stream_cleanup_reservations SET state = 'completed', updated_at = ?
    WHERE organization_id = ? AND owner_user_id = ? AND operation_id = ?
  `,
    )
    .run(occurredAt, context.organizationId, context.ownerUserId, operationId)
}

function allocateCursor(database: Database, context: WorkGraphContext, occurredAt: number) {
  database
    .prepare(
      `
    INSERT OR IGNORE INTO wg_v2_change_cursors (organization_id, owner_user_id, next_cursor, created_at, updated_at) VALUES (?, ?, 1, ?, ?)
  `,
    )
    .run(context.organizationId, context.ownerUserId, occurredAt, occurredAt)
  const row = database
    .prepare("SELECT next_cursor FROM wg_v2_change_cursors WHERE organization_id = ? AND owner_user_id = ?")
    .get(context.organizationId, context.ownerUserId) as { next_cursor: number }
  database
    .prepare(
      `
    UPDATE wg_v2_change_cursors SET next_cursor = next_cursor + 1, row_version = row_version + 1, updated_at = ? WHERE organization_id = ? AND owner_user_id = ?
  `,
    )
    .run(occurredAt, context.organizationId, context.ownerUserId)
  return row.next_cursor
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

function pending(
  type: string,
  resourceType: string,
  resourceId: string,
  value: Record<string, string | number | string[]>,
  streamId?: string,
): PendingResult {
  return { ok: true, type, resourceType, resourceId, value, ...(streamId ? { streamId } : {}) }
}

function rejected(operationId: OperationID, code: CommandErrorCode, message: string): PendingResult {
  return { ok: false, result: failure(operationId, code, message) }
}

function success(
  operationId: OperationID,
  cursor: ChangeCursor,
  value: Record<string, string | number | string[]>,
): CommandResult {
  return { ok: true, operationId, cursor, value }
}

function failure(operationId: OperationID, code: CommandErrorCode, message: string, retryable = false): CommandResult {
  return { ok: false, operationId, error: { code, message, retryable } }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
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
      value: Record<string, string | number | string[]>
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
}
type OutcomeRow = { id: string; stream_id: string; lifecycle: string; row_version: number }
type WorkItemVersionRow = { id: string; stream_id: string; lifecycle: string; row_version: number }
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
  source_attempt_id: string | null
  reference_json: string
  provenance_json: string
  created_at: string | number
}
type StoredEvidenceRow = EvidenceRow & { subject_type: string; subject_id: string }
type ChangeRow = {
  cursor: number
  change_id: string
  stream_id: string | null
  operation_id: OperationID
  resource_type:
    | "workgraph"
    | "work_source"
    | "stream"
    | "outcome"
    | "work_item"
    | "attempt"
    | "decision"
    | "evidence"
    | "recap"
    | "admission_proposal"
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
    | "stream_lifecycle_changed"
    | "stream_visibility_changed"
    | "stream_execution_requested"
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
    | "work_item_execution_requested"
    | "attempt_admitted"
    | "attempt_state_changed"
    | "attempt_cancelled"
    | "decision_proposed"
    | "decision_answered"
    | "decision_dismissed"
    | "evidence_recorded"
    | "recap_published"
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
  title: string
  purpose: string
  lifecycle: string
  visibility: string
  pinned: number
  execution_defaults_json: string
  recap_defaults_json: string
  activity_granularity: string
  memory_card_json: string
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
  outcome_id: string | null
  title: string
  description: string
  lifecycle: string
  priority: number
  execution_overrides_json: string
  completion_contract_json: string
  abandoned_reason: string | null
  abandoned_at: string | number | null
  row_version: number
  created_at: string | number
  updated_at: string | number
}
type AttemptRecordRow = {
  id: string
  stream_id: string
  work_item_id: string
  attempt_number: number
  lifecycle: string
  execution_kind: "managed" | "attached"
  resolved_execution_profile_json: string
  envelope_id: string | null
  child_workspace_id: string | null
  session_id: string | null
  terminal_result_json: string | null
  attention_reason: string | null
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
type RecapRecordRow = {
  id: string
  stream_id: string
  previous_recap_id: string | null
  activity_start_sequence: number
  activity_end_sequence: number
  summary: string
  actionable_references_json: string
  generation_profile_json: string
  provenance_json: string
  generation_result_json: string
  quiet_since: string | number | null
  created_at: string | number
}
type AttentionRow = {
  kind:
    | "admission_proposal"
    | "decision"
    | "work_item"
    | "attempt"
    | "recap_notification"
    | "unorganized_ai_work"
    | "configuration_required"
  id: string
  updated_at: number
  job_type: string | null
  subject_id: string | null
  stream_id: string | null
  last_error: string | null
  payload_json: string | null
}
type NotificationAttentionRow = {
  id: string
  owner_user_id: string
  row_version: number
  state: string
  stream_id: string
  recap_id: string
  created_at: string | number
  updated_at: string | number
  read_at: string | number | null
}

class AppendFailure extends Error {}
