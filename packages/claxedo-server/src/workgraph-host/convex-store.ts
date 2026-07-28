import type {
  WorkGraphCommandHandler,
  WorkGraphCommandHandlers,
} from "@claxedo/workgraph/hosted"
import type {
  AttentionListInput,
  AttentionItem,
  AttentionPage,
  ChangeCursor,
  SnapshotResumeCursor,
  ChangeEnvelope,
  CommandResult,
  EvidenceDto,
  EvidenceListInput,
  EvidencePage,
  EvidenceReadInput,
  AdmissionProposalDto,
  RunDetailDto,
  DecisionDto,
  ReplacementReview,
  ReplacementReviewInput,
  WorkItemRunListInput,
  WorkItemRunPage,
  TaskActivityListInput,
  TaskActivityPage,
  AgentCheckpointDto,
  AttachSessionTaskInput,
  BindSessionInput,
  RecordAgentCheckpointInput,
  ReleaseSessionBindingInput,
  SessionBindingDto,
  SessionBindingID,
  WorkItemDto,
  StreamDto,
  StreamID,
  WorkGraphContext,
  WorkGraphDefaultsDto,
  WorkGraphSnapshotPage,
  WorkSourceID,
  WorkSourcePageCursor,
  WorkSourceDto,
  WorkSourceRevisionDto,
  WorkSourceRevisionID,
} from "@claxedo/workgraph/contracts"
import {
  AttentionCursorError,
  AttentionItemSchema,
  AttentionPageSchema,
  ChangeCursorError,
  AdmissionProposalDtoSchema,
  RunDetailDtoSchema,
  DecisionDtoSchema,
  EvidenceDtoSchema,
  EvidencePageCursorError,
  EvidencePageSchema,
  ReplacementReviewSchema,
  SnapshotResumeCursorError,
  TaskActivityPageCursorError,
  TaskActivityPageSchema,
  AgentCheckpointDtoSchema,
  SessionBindingDtoSchema,
  WorkItemRunPageCursorError,
  WorkItemRunPageSchema,
  WorkItemDtoSchema,
  WorkSourcePageCursorError,
  WorkGraphArchiveRestoreError,
  WorkGraphArchiveRestoreErrorReasonSchema,
  WorkGraphArchiveRestoreResultSchema,
  hashWorkGraphArchive,
  validateWorkGraphArchive,
} from "@claxedo/workgraph/contracts"
import type { AttentionCursorErrorReason, ChangeCursorErrorReason, EvidencePageCursorErrorReason, SnapshotResumeCursorErrorReason, TaskActivityPageCursorErrorReason, WorkItemRunPageCursorErrorReason, WorkSourcePageCursorErrorReason } from "@claxedo/workgraph/contracts"
import { WorkGraphSessionBindingError } from "@claxedo/workgraph/ports"
import type { WorkGraphActivityPort, WorkGraphArchivePort, WorkGraphArchiveRestoreResult, WorkGraphSessionBindingErrorCode, WorkGraphSessionBindingPort } from "@claxedo/workgraph/ports"
import { createWorkGraphService, defineAtomicWorkGraphStore } from "@claxedo/workgraph/hosted"
import { ConvexHttpClient } from "convex/browser"
import { workGraphConvexApi } from "./convex-api"

export const CONVEX_WORKGRAPH_SUPPORTED_COMMANDS = [
  "update_workgraph_defaults",
  "create_work_source",
  "revise_work_source",
  "create_stream",
  "update_stream",
  "set_stream_charter",
  "update_stream_notes",
  "call_master",
  "request_public_pr_confirmation",
  "confirm_public_pr",
  "record_master_audit",
  "set_stream_lifecycle",
  "create_outcome",
  "update_outcome",
  "create_work_item",
  "update_work_item",
  "cancel_work_item",
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
  "approve_work_item",
  "reject_work_item",
  "approve_work_items",
  "cancel_run",
  "retry_work_item",
] as const

export const CONVEX_WORKGRAPH_UNSUPPORTED_COMMANDS = [] as const

export type WorkGraphConvexExecutor = Readonly<{
  query: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
  mutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
}>

type Input = Readonly<{
  url?: string
  bearerToken?: string
  serviceToken?: string
  executor?: WorkGraphConvexExecutor
  clock?: Readonly<{ now: () => number }>
}>

type Commands = WorkGraphCommandHandlers

export function createConvexWorkGraphStore(input: Input) {
  if (!input.executor && !input.url) throw new Error("Convex WorkGraph URL is required")
  if (!input.bearerToken && !input.serviceToken) throw new Error("Convex WorkGraph bearer or service token is required")
  const exec = input.executor ?? createWorkGraphConvexExecutor(input.url!, input.bearerToken)
  const interactive = !!input.bearerToken

  const execute: WorkGraphCommandHandler = async (context, request) => {
    if (context.access.mode !== "owner") return {
      ok: false,
      operationId: request.operationId,
      error: { code: "forbidden", message: "Owner access is required", retryable: false },
    }
    const organizationId = context.organizationId
    const args = interactive
      ? { organization_id: organizationId, operation_id: request.operationId, request_id: context.requestId, command: request.command }
      : {
          service_token: input.serviceToken ?? "",
          organization_id: organizationId,
          owner_subject: context.ownerUserId,
          // The true actor type crosses the service seam unchanged. User actors
          // are safe to attest here: this path only runs for signed owner-mode
          // contexts, and Convex `executeForService` pins a user actor's id to
          // the authenticated tenant owner. The former user→agent downgrade sent
          // every hosted user-created Task into the approval gate
          // (`pending_approval`), so the continuous drain never admitted it.
          actor_type: context.actor.type,
          actor_id: context.actor.id,
          operation_id: request.operationId,
          request_id: context.requestId,
          command: request.command,
        }
    try {
      return await exec.mutation(
        interactive ? workGraphConvexApi.workgraphCommands.execute : workGraphConvexApi.workgraphCommands.executeForService,
        args,
      ) as CommandResult
    } catch {
      return {
        ok: false,
        operationId: request.operationId,
        error: { code: "internal_error", message: "Convex WorkGraph command transaction failed", retryable: true },
      }
    }
  }

  const read = async (context: WorkGraphContext, kind: string, queryInput: Record<string, unknown>) => {
    const organizationId = context.organizationId
    const args = interactive
      ? { organization_id: organizationId, query: { kind, ...queryInput } }
      : { service_token: input.serviceToken ?? "", organization_id: organizationId, owner_subject: context.ownerUserId, query: { kind, ...queryInput } }
    try {
      return await exec.query(
        interactive ? workGraphConvexApi.workgraphChanges.read : workGraphConvexApi.workgraphChanges.readForService,
        args,
      )
    } catch (error) {
      const snapshotReason = kind === "snapshot" ? snapshotCursorErrorReason(error) : undefined
      if (snapshotReason) throw new SnapshotResumeCursorError(snapshotReason)
      const evidenceReason = kind === "evidence_list" ? evidenceCursorErrorReason(error) : undefined
      if (evidenceReason) throw new EvidencePageCursorError(evidenceReason)
      const attentionReason = kind === "attention" ? attentionCursorErrorReason(error) : undefined
      if (attentionReason) throw new AttentionCursorError(attentionReason)
      const runReason = kind === "work_item_runs" ? runCursorErrorReason(error) : undefined
      if (runReason) throw new WorkItemRunPageCursorError(runReason)
      const activityReason = kind === "work_item_activity" ? taskActivityCursorErrorReason(error) : undefined
      if (activityReason) throw new TaskActivityPageCursorError(activityReason)
      const changeReason = kind === "changes" || kind === "stream_changes" ? changeCursorErrorReason(error) : undefined
      if (changeReason) throw new ChangeCursorError(changeReason)
      const sourceReason = kind === "sources" ? workSourceCursorErrorReason(error) : undefined
      if (sourceReason) throw new WorkSourcePageCursorError(sourceReason)
      throw error
    }
  }

  const commands = {
    ...Object.fromEntries(CONVEX_WORKGRAPH_SUPPORTED_COMMANDS.map((command) => [command, execute])),
  } as Commands
  return defineAtomicWorkGraphStore({
    commands,
    queries: {
      defaults: {
        read: async (context: WorkGraphContext) =>
          publicOwner(context, await read(context, "defaults", {}) as WorkGraphDefaultsDto),
      },
      snapshot: {
        page: async (context: WorkGraphContext, queryInput: Readonly<{ after?: SnapshotResumeCursor; limit: number }>) =>
          publicSnapshot(context, await read(context, "snapshot", queryInput) as WorkGraphSnapshotPage),
      },
      attention: {
        list: async (context: WorkGraphContext, queryInput: AttentionListInput): Promise<AttentionPage> => {
          const page = AttentionPageSchema.parse(await read(context, "attention", queryInput))
          return AttentionPageSchema.parse({
            ...page,
            items: page.items.map((item) => publicAttentionItem(context, item)),
          })
        },
      },
      streams: {
        read: async (context: WorkGraphContext, queryInput: Readonly<{ streamId: StreamID }>) => {
          const stream = await read(context, "stream", queryInput) as StreamDto | undefined
          return stream ? publicOwner(context, stream) : undefined
        },
      },
      proposals: {
        read: async (context: WorkGraphContext, queryInput: Readonly<{ proposalId: string }>): Promise<AdmissionProposalDto | undefined> => {
          const proposal = await read(context, "admission_proposal", queryInput)
          return proposal ? publicOwner(context, AdmissionProposalDtoSchema.parse(proposal)) : undefined
        },
        replacementReview: async (context: WorkGraphContext, queryInput: ReplacementReviewInput): Promise<ReplacementReview | undefined> => {
          const review = await read(context, "replacement_review", queryInput)
          return review ? ReplacementReviewSchema.parse(review) : undefined
        },
      },
      runs: {
        read: async (context: WorkGraphContext, queryInput: Readonly<{ runId: string }>): Promise<RunDetailDto | undefined> => {
          const detail = await read(context, "run", queryInput)
          if (!detail) return undefined
          const parsed = RunDetailDtoSchema.parse(detail)
          return { ...parsed, run: publicOwner(context, parsed.run) }
        },
      },
      decisions: {
        read: async (context: WorkGraphContext, queryInput: Readonly<{ decisionId: string }>): Promise<DecisionDto | undefined> => {
          const decision = await read(context, "decision", queryInput)
          return decision ? publicOwner(context, DecisionDtoSchema.parse(decision)) : undefined
        },
      },
      sources: {
        list: async (context: WorkGraphContext, queryInput: Readonly<{ after?: WorkSourcePageCursor; limit: number }>) => {
          const result = await read(context, "sources", queryInput) as { sources: WorkSourceDto[]; hasMore: boolean; nextCursor?: WorkSourcePageCursor }
          return { ...result, sources: result.sources.map((source) => publicOwner(context, source)) }
        },
        read: async (context: WorkGraphContext, queryInput: Readonly<{ workSourceId: WorkSourceID }>) => {
          const source = await read(context, "source", queryInput) as WorkSourceDto | undefined
          return source ? publicOwner(context, source) : undefined
        },
        readRevision: async (context: WorkGraphContext, queryInput: Readonly<{ workSourceId: WorkSourceID; revisionId: WorkSourceRevisionID }>) =>
          await read(context, "source_revision", queryInput) as WorkSourceRevisionDto | undefined ?? undefined,
      },
      evidence: {
        read: async (context: WorkGraphContext, queryInput: EvidenceReadInput): Promise<EvidenceDto | undefined> => {
          const evidence = await read(context, "evidence", queryInput)
          return evidence ? EvidenceDtoSchema.parse(evidence) : undefined
        },
        list: async (context: WorkGraphContext, queryInput: EvidenceListInput): Promise<EvidencePage> =>
          EvidencePageSchema.parse(await read(context, "evidence_list", queryInput)),
      },
      changes: {
        list: async (context: WorkGraphContext, queryInput: Readonly<{ after?: ChangeCursor; limit?: number }>) =>
          publicChanges(context, await read(context, "changes", { ...queryInput, limit: queryInput.limit ?? 50 }) as readonly ChangeEnvelope[]),
        listStream: async (context: WorkGraphContext, queryInput: Readonly<{ streamId: StreamID; after?: ChangeCursor; limit?: number }>) =>
          publicChanges(context, await read(context, "stream_changes", { ...queryInput, limit: queryInput.limit ?? 50 }) as readonly ChangeEnvelope[]),
      },
      workItems: {
        readDetail: async (context: WorkGraphContext, queryInput: Readonly<{ workItemId: string }>): Promise<WorkItemDto | undefined> => {
          const item = await read(context, "work_item_detail", queryInput)
          return item ? publicOwner(context, WorkItemDtoSchema.parse(item)) : undefined
        },
        listRuns: async (context: WorkGraphContext, queryInput: WorkItemRunListInput): Promise<WorkItemRunPage> => {
          const page = WorkItemRunPageSchema.parse(await read(context, "work_item_runs", queryInput))
          page.runs.forEach((detail) => publicOwner(context, detail.run))
          return page
        },
        listActivity: async (context: WorkGraphContext, queryInput: TaskActivityListInput): Promise<TaskActivityPage> =>
          TaskActivityPageSchema.parse(await read(context, "work_item_activity", queryInput)),
        read: async (context: WorkGraphContext, queryInput: Readonly<{ workItemId: string }>) =>
          await read(context, "work_item", queryInput) as undefined | { id: string; completionSatisfied: boolean } ?? undefined,
      },
    },
  })
}

function snapshotCursorErrorReason(error: unknown): SnapshotResumeCursorErrorReason | undefined {
  if (error instanceof SnapshotResumeCursorError) return error.reason
  if (error && typeof error === "object" && "code" in error && error.code === "cursor_invalid") {
    if (!("reason" in error) || !snapshotCursorReason(error.reason)) return
    return error.reason
  }
  if (!error || typeof error !== "object" || !("data" in error)) return
  const data = error.data
  if (!data || typeof data !== "object" || !("code" in data) || data.code !== "cursor_invalid") return
  if (!("reason" in data) || !snapshotCursorReason(data.reason)) return
  return data.reason
}

function snapshotCursorReason(value: unknown): value is SnapshotResumeCursorErrorReason {
  return value === "invalid" || value === "owner_mismatch" || value === "invalidated"
}

function evidenceCursorErrorReason(error: unknown): EvidencePageCursorErrorReason | undefined {
  if (error instanceof EvidencePageCursorError) return error.reason
  if (error && typeof error === "object" && "code" in error && error.code === "cursor_invalid") {
    if (!("reason" in error) || !evidenceCursorReason(error.reason)) return
    return error.reason
  }
  if (!error || typeof error !== "object" || !("data" in error)) return
  const data = error.data
  if (!data || typeof data !== "object" || !("code" in data) || data.code !== "cursor_invalid") return
  if (!("reason" in data) || !evidenceCursorReason(data.reason)) return
  return data.reason
}

function evidenceCursorReason(value: unknown): value is EvidencePageCursorErrorReason {
  return value === "invalid" || value === "owner_mismatch" || value === "subject_mismatch"
}

function attentionCursorErrorReason(error: unknown): AttentionCursorErrorReason | undefined {
  if (error instanceof AttentionCursorError) return error.reason
  if (error && typeof error === "object" && "code" in error && error.code === "cursor_invalid") {
    if (!("reason" in error) || !attentionCursorReason(error.reason)) return
    return error.reason
  }
  if (!error || typeof error !== "object" || !("data" in error)) return
  const data = error.data
  if (!data || typeof data !== "object" || !("code" in data) || data.code !== "cursor_invalid") return
  if (!("reason" in data) || !attentionCursorReason(data.reason)) return
  return data.reason
}

function attentionCursorReason(value: unknown): value is AttentionCursorErrorReason {
  return value === "invalid" || value === "owner_mismatch"
}

function changeCursorErrorReason(error: unknown): ChangeCursorErrorReason | undefined {
  if (error instanceof ChangeCursorError) return error.reason
  if (error && typeof error === "object" && "code" in error && error.code === "cursor_invalid") {
    if (!(("reason" in error) && changeCursorReason(error.reason))) return
    return error.reason
  }
  if (!error || typeof error !== "object" || !("data" in error)) return
  const data = error.data
  if (!data || typeof data !== "object" || !("code" in data) || data.code !== "cursor_invalid") return
  if (!("reason" in data) || !changeCursorReason(data.reason)) return
  return data.reason
}

function changeCursorReason(value: unknown): value is ChangeCursorErrorReason {
  return value === "invalid" || value === "owner_mismatch" || value === "filter_mismatch"
}

function workSourceCursorErrorReason(error: unknown): WorkSourcePageCursorErrorReason | undefined {
  if (error instanceof WorkSourcePageCursorError) return error.reason
  const value = error && typeof error === "object" && "data" in error ? error.data : error
  if (!value || typeof value !== "object" || !("code" in value) || value.code !== "cursor_invalid" || !("reason" in value)) return
  if (value.reason === "invalid" || value.reason === "owner_mismatch") return value.reason
  if (value.reason === "filter_mismatch") return "invalid"
}

function runCursorErrorReason(error: unknown): WorkItemRunPageCursorErrorReason | undefined {
  if (error instanceof WorkItemRunPageCursorError) return error.reason
  if (error && typeof error === "object" && "code" in error && error.code === "cursor_invalid") {
    if (!("reason" in error) || !runCursorReason(error.reason)) return
    return error.reason
  }
  if (!error || typeof error !== "object" || !("data" in error)) return
  const data = error.data
  if (!data || typeof data !== "object" || !("code" in data) || data.code !== "cursor_invalid") return
  if (!("reason" in data) || !runCursorReason(data.reason)) return
  return data.reason
}

function runCursorReason(value: unknown): value is WorkItemRunPageCursorErrorReason {
  return value === "invalid" || value === "owner_mismatch" || value === "work_item_mismatch"
}

function taskActivityCursorErrorReason(error: unknown): TaskActivityPageCursorErrorReason | undefined {
  if (error instanceof TaskActivityPageCursorError) return error.reason
  const value = error && typeof error === "object" && "data" in error ? error.data : error
  if (!value || typeof value !== "object" || !("code" in value) || value.code !== "cursor_invalid" || !("reason" in value)) return
  if (value.reason === "invalid" || value.reason === "owner_mismatch" || value.reason === "work_item_mismatch" || value.reason === "granularity_mismatch") {
    return value.reason
  }
}

export function createConvexWorkGraphService(input: Input) {
  return createWorkGraphService(createConvexWorkGraphStore(input))
}

export function createConvexWorkGraphActivityPorts(input: Input): Readonly<{
  activity: WorkGraphActivityPort
  sessionBindings: WorkGraphSessionBindingPort
}> {
  if (!input.executor && !input.url) throw new Error("Convex WorkGraph URL is required")
  if (!input.serviceToken) throw new Error("Convex WorkGraph service token is required for Session binding operations")
  const exec = input.executor ?? createWorkGraphConvexExecutor(input.url!, input.bearerToken)
  const owner = (context: WorkGraphContext) => {
    if (context.access.mode !== "owner") throw new WorkGraphSessionBindingError("not_found", "Owner access is required")
    return context.ownerUserId
  }
  const mutate = async (
    context: WorkGraphContext,
    command: Record<string, unknown>,
  ): Promise<SessionBindingDto | AgentCheckpointDto> => {
    const result = await exec.mutation(workGraphConvexApi.workgraphActivity.mutateForService, {
      service_token: input.serviceToken,
      organization_id: context.organizationId,
      owner_subject: owner(context),
      actor_type: context.actor.type === "system" ? "system" : "agent",
      actor_id: context.actor.id,
      request_id: context.requestId,
      command,
    }) as Readonly<{
      ok: true
      value: unknown
    }> | Readonly<{
      ok: false
      error: Readonly<{ code: unknown; message: unknown }>
    }>
    if (!result.ok) {
      const code = sessionBindingErrorCode(result.error.code) ? result.error.code : "conflict"
      const message = typeof result.error.message === "string" ? result.error.message : "Convex WorkGraph activity mutation failed"
      throw new WorkGraphSessionBindingError(code, message)
    }
    if (result.value && typeof result.value === "object" && "recordType" in result.value && result.value.recordType === "agent_checkpoint") {
      return AgentCheckpointDtoSchema.parse(result.value)
    }
    return SessionBindingDtoSchema.parse(result.value)
  }
  const sessionBindings: WorkGraphSessionBindingPort = {
    bind: async (context, binding: BindSessionInput) => {
      const result = await mutate(context, { type: "bind_session", ...binding })
      if (result.recordType !== "session_binding") throw new WorkGraphSessionBindingError("conflict", "Convex returned the wrong activity record")
      return result
    },
    attachTask: async (context, attachment: AttachSessionTaskInput) => {
      const result = await mutate(context, { type: "attach_session_task", ...attachment })
      if (result.recordType !== "session_binding") throw new WorkGraphSessionBindingError("conflict", "Convex returned the wrong activity record")
      return result
    },
    recordCheckpoint: async (context, checkpoint: RecordAgentCheckpointInput) => {
      const result = await mutate(context, { type: "record_agent_checkpoint", ...checkpoint })
      if (result.recordType !== "agent_checkpoint") throw new WorkGraphSessionBindingError("conflict", "Convex returned the wrong activity record")
      return result
    },
    release: async (context, release: ReleaseSessionBindingInput) => {
      const result = await mutate(context, { type: "release_session_binding", ...release })
      if (result.recordType !== "session_binding") throw new WorkGraphSessionBindingError("conflict", "Convex returned the wrong activity record")
      return result
    },
    read: async (context, bindingId: SessionBindingID) => {
      const result = await exec.query(workGraphConvexApi.workgraphActivity.readBindingForService, {
        service_token: input.serviceToken,
        organization_id: context.organizationId,
        owner_subject: owner(context),
        binding_id: bindingId,
      })
      return result ? SessionBindingDtoSchema.parse(result) : undefined
    },
    readForSession: async (context, sessionId: string) => {
      const result = await exec.query(workGraphConvexApi.workgraphActivity.readBindingForSessionForService, {
        service_token: input.serviceToken,
        organization_id: context.organizationId,
        owner_subject: owner(context),
        session_id: sessionId,
      })
      return result ? SessionBindingDtoSchema.parse(result) : undefined
    },
  }
  const activity: WorkGraphActivityPort = {
    list: async (context, queryInput) => {
      try {
        return TaskActivityPageSchema.parse(await exec.query(workGraphConvexApi.workgraphChanges.readForService, {
          service_token: input.serviceToken,
          organization_id: context.organizationId,
          owner_subject: owner(context),
          query: { kind: "work_item_activity", ...queryInput },
        }))
      } catch (error) {
        const reason = taskActivityCursorErrorReason(error)
        if (reason) throw new TaskActivityPageCursorError(reason)
        throw error
      }
    },
  }
  return { activity, sessionBindings }
}

function sessionBindingErrorCode(value: unknown): value is WorkGraphSessionBindingErrorCode {
  return value === "not_found" || value === "conflict" || value === "not_ready" || value === "invalid_transition"
}

export function createConvexWorkGraphArchivePort(input: Input): WorkGraphArchivePort {
  if (!input.executor && !input.url) throw new Error("Convex WorkGraph URL is required")
  if (!input.serviceToken) throw new Error("Convex WorkGraph service token is required for archive operations")
  const exec = input.executor ?? createWorkGraphConvexExecutor(input.url!, input.bearerToken)
  const clock = input.clock ?? { now: Date.now }
  const owner = (context: WorkGraphContext) => {
    if (context.access.mode !== "owner") throw new WorkGraphArchiveRestoreError("cross_owner")
    return context.ownerUserId
  }
  const result = (value: unknown) => {
    if (!value || typeof value !== "object" || !("ok" in value)) throw new WorkGraphArchiveRestoreError("target_incompatible")
    if (value.ok === false) {
      const reason = "reason" in value ? WorkGraphArchiveRestoreErrorReasonSchema.safeParse(value.reason) : undefined
      if (!reason?.success) throw new WorkGraphArchiveRestoreError("target_incompatible")
      throw new WorkGraphArchiveRestoreError(reason.data)
    }
    if (value.ok !== true) throw new WorkGraphArchiveRestoreError("target_incompatible")
    if ("archive" in value && !("result" in value)) return value.archive
    if ("result" in value && !("archive" in value)) return value.result
    throw new WorkGraphArchiveRestoreError("target_incompatible")
  }
  return {
    export: async (context) => {
      const archive = result(await exec.query(workGraphConvexApi.workgraphArchive.exportForService, {
        service_token: input.serviceToken,
        organization_id: context.organizationId,
        owner_subject: owner(context),
        exported_at: clock.now(),
      }))
      return await validateWorkGraphArchive(archive)
    },
    restore: async (context, restore) => {
      const archive = await validateWorkGraphArchive(restore.archive)
      if (archive.ownerUserId !== owner(context)) throw new WorkGraphArchiveRestoreError("cross_owner")
      const restored = WorkGraphArchiveRestoreResultSchema.safeParse(result(await exec.mutation(workGraphConvexApi.workgraphArchive.restoreForService, {
        service_token: input.serviceToken,
        organization_id: context.organizationId,
        owner_subject: context.ownerUserId,
        operation_id: restore.operationId,
        archive_hash: await hashWorkGraphArchive(archive),
        archive,
        restored_at: clock.now(),
      })))
      if (!restored.success) throw new WorkGraphArchiveRestoreError("target_incompatible")
      return restored.data as WorkGraphArchiveRestoreResult
    },
  }
}

function publicSnapshot(context: WorkGraphContext, snapshot: WorkGraphSnapshotPage): WorkGraphSnapshotPage {
  return { ...snapshot, records: snapshot.records.map((record) => publicOwner(context, record)) }
}

function publicChanges(context: WorkGraphContext, changes: readonly ChangeEnvelope[]): readonly ChangeEnvelope[] {
  return changes.map((change) => ({
    ...change,
    ownerUserId: context.ownerUserId,
    event: { ...change.event, ownerUserId: context.ownerUserId },
  }))
}

function publicAttentionItem(context: WorkGraphContext, item: AttentionItem): AttentionItem {
  if (item.kind === "unorganized_ai_work" || item.kind === "configuration_required" || item.kind === "master_escalation") {
    return AttentionItemSchema.parse(publicOwner(context, item))
  }
  return AttentionItemSchema.parse({
    ...item,
    ownerUserId: context.ownerUserId,
    record: publicOwner(context, item.record),
  })
}

function publicOwner<Record extends { ownerUserId: WorkGraphContext["ownerUserId"] }>(context: WorkGraphContext, record: Record): Record {
  return { ...record, ownerUserId: context.ownerUserId }
}

export function createWorkGraphConvexExecutor(url: string, token?: string): WorkGraphConvexExecutor {
  const client = new ConvexHttpClient(url)
  if (token) client.setAuth(token)
  return {
    query: (fn, args) => client.query(fn as never, args as never),
    mutation: (fn, args) => client.mutation(fn as never, args as never),
  }
}
