import type {
  WorkGraphCommandHandler,
  WorkGraphCommandHandlers,
} from "@claxedo/workgraph/hosted"
import type {
  AttentionListInput,
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
  AttemptDetailDto,
  DecisionDto,
  RecapDto,
  WorkItemAttemptListInput,
  WorkItemAttemptPage,
  WorkItemDto,
  StreamDto,
  StreamID,
  WorkGraphContext,
  WorkGraphDefaultsDto,
  WorkGraphSnapshotPage,
  WorkSourceID,
  WorkSourceDto,
  WorkSourceRevisionDto,
  WorkSourceRevisionID,
} from "@claxedo/workgraph/contracts"
import {
  AttentionCursorError,
  AttentionPageSchema,
  AdmissionProposalDtoSchema,
  AttemptDetailDtoSchema,
  DecisionDtoSchema,
  EvidenceDtoSchema,
  EvidencePageCursorError,
  EvidencePageSchema,
  RecapDtoSchema,
  SnapshotResumeCursorError,
  WorkItemAttemptPageCursorError,
  WorkItemAttemptPageSchema,
  WorkItemDtoSchema,
  WorkGraphArchiveRestoreError,
  WorkGraphArchiveRestoreErrorReasonSchema,
  WorkGraphArchiveRestoreResultSchema,
  hashWorkGraphArchive,
  validateWorkGraphArchive,
} from "@claxedo/workgraph/contracts"
import type { AttentionCursorErrorReason, EvidencePageCursorErrorReason, SnapshotResumeCursorErrorReason, WorkItemAttemptPageCursorErrorReason } from "@claxedo/workgraph/contracts"
import type { WorkGraphArchivePort, WorkGraphArchiveRestoreResult } from "@claxedo/workgraph/ports"
import { createWorkGraphService, defineAtomicWorkGraphStore } from "@claxedo/workgraph/hosted"
import { ConvexHttpClient } from "convex/browser"
import { workGraphConvexApi } from "./convex-api"

export const CONVEX_WORKGRAPH_SUPPORTED_COMMANDS = [
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
  "record_evidence",
  "close_outcome",
  "reopen_outcome",
  "close_stream",
  "delete_stream",
  "execute_stream",
  "execute_work_item",
  "cancel_attempt",
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
    const args = interactive
      ? { operation_id: request.operationId, request_id: context.requestId, command: request.command }
      : {
          service_token: input.serviceToken ?? "",
          owner_subject: context.ownerUserId,
          actor_type: context.actor.type === "user" ? "agent" : context.actor.type,
          actor_id: context.actor.id,
          operation_id: request.operationId,
          request_id: context.requestId,
          command: request.command,
        }
    return await exec.mutation(
      interactive ? workGraphConvexApi.workgraphCommands.execute : workGraphConvexApi.workgraphCommands.executeForService,
      args,
    ) as CommandResult
  }

  const read = async (context: WorkGraphContext, kind: string, queryInput: Record<string, unknown>) => {
    const args = interactive
      ? { query: { kind, ...queryInput } }
      : { service_token: input.serviceToken ?? "", owner_subject: context.ownerUserId, query: { kind, ...queryInput } }
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
      const attemptReason = kind === "work_item_attempts" ? attemptCursorErrorReason(error) : undefined
      if (attemptReason) throw new WorkItemAttemptPageCursorError(attemptReason)
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
        list: async (context: WorkGraphContext, queryInput: AttentionListInput): Promise<AttentionPage> =>
          AttentionPageSchema.parse(await read(context, "attention", queryInput)),
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
      },
      attempts: {
        read: async (context: WorkGraphContext, queryInput: Readonly<{ attemptId: string }>): Promise<AttemptDetailDto | undefined> => {
          const detail = await read(context, "attempt", queryInput)
          if (!detail) return undefined
          const parsed = AttemptDetailDtoSchema.parse(detail)
          publicOwner(context, parsed.attempt)
          return parsed
        },
      },
      decisions: {
        read: async (context: WorkGraphContext, queryInput: Readonly<{ decisionId: string }>): Promise<DecisionDto | undefined> => {
          const decision = await read(context, "decision", queryInput)
          return decision ? publicOwner(context, DecisionDtoSchema.parse(decision)) : undefined
        },
      },
      recaps: {
        read: async (context: WorkGraphContext, queryInput: Readonly<{ recapId: string }>): Promise<RecapDto | undefined> => {
          const recap = await read(context, "recap", queryInput)
          return recap ? publicOwner(context, RecapDtoSchema.parse(recap)) : undefined
        },
      },
      sources: {
        list: async (context: WorkGraphContext, queryInput: Readonly<{ after?: string; limit: number }>) => {
          const result = await read(context, "sources", queryInput) as { sources: WorkSourceDto[]; hasMore: boolean; nextCursor?: string }
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
        listAttempts: async (context: WorkGraphContext, queryInput: WorkItemAttemptListInput): Promise<WorkItemAttemptPage> => {
          const page = WorkItemAttemptPageSchema.parse(await read(context, "work_item_attempts", queryInput))
          page.attempts.forEach((detail) => publicOwner(context, detail.attempt))
          return page
        },
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

function attemptCursorErrorReason(error: unknown): WorkItemAttemptPageCursorErrorReason | undefined {
  if (error instanceof WorkItemAttemptPageCursorError) return error.reason
  if (error && typeof error === "object" && "code" in error && error.code === "cursor_invalid") {
    if (!("reason" in error) || !attemptCursorReason(error.reason)) return
    return error.reason
  }
  if (!error || typeof error !== "object" || !("data" in error)) return
  const data = error.data
  if (!data || typeof data !== "object" || !("code" in data) || data.code !== "cursor_invalid") return
  if (!("reason" in data) || !attemptCursorReason(data.reason)) return
  return data.reason
}

function attemptCursorReason(value: unknown): value is WorkItemAttemptPageCursorErrorReason {
  return value === "invalid" || value === "owner_mismatch" || value === "work_item_mismatch"
}

export function createConvexWorkGraphService(input: Input) {
  return createWorkGraphService(createConvexWorkGraphStore(input))
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
