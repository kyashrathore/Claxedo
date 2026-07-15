import {
  createSnapshotResumeCursor,
  createChangeCursor,
  compareSnapshotCursorPosition,
  readSnapshotResumeCursor,
  readChangeCursor,
} from "@claxedo/workgraph/contracts"
import type {
  ChangeCursor,
  AttemptID,
  CommandErrorCode,
  CommandResult,
  CompletionContract,
  EvidenceInput,
  OperationID,
  OutcomeID,
  OwnerUserID,
  StreamID,
  StreamLifecycleState,
  WorkGraphCommandRequest,
  WorkGraphContext,
  WorkGraphSnapshotPage,
  WorkItemID,
  WorkSourceID,
  WorkSourceRevisionID,
} from "@claxedo/workgraph/contracts"
import { transitionStream } from "@claxedo/workgraph/domain"
import { createWorkGraphService } from "@claxedo/workgraph/hosted"
import { defineAtomicWorkGraphStore, type WorkGraphCommandHandler } from "@claxedo/workgraph/ports"
import type { AttemptRuntimePort } from "@claxedo/workgraph/ports"
import { describe, it } from "vitest"
import {
  type ConformanceChangeView,
  type ConformanceCommands,
  type ConformanceQueries,
  type ConformanceSourceRevisionView,
  type ConformanceStreamView,
  type ConformanceWorkItemView,
  type StoreConformanceFactory,
  workGraphAdapterConformance,
} from "@claxedo/workgraph/conformance"

const branded = <Type>(value: string) => value as Type

const memoryFactory: StoreConformanceFactory = async (input) => {
  const operations = new Map<string, { fingerprint: string; result: CommandResult }>()
  const streams = new Map<StreamID, ConformanceStreamView>()
  const sources = new Map<WorkSourceID, Readonly<{ ownerUserId: OwnerUserID; latestRevisionId: WorkSourceRevisionID }>>()
  const revisions = new Map<WorkSourceRevisionID, ConformanceSourceRevisionView & { ownerUserId: OwnerUserID }>()
  const outcomes = new Map<OutcomeID, Readonly<{ ownerUserId: OwnerUserID; streamId: StreamID }>>()
  const workItems = new Map<WorkItemID, MutableWorkItem>()
  const changes = new Map<OwnerUserID, ConformanceChangeView[]>()
  const attempts = new Map<AttemptID, { ownerUserId: OwnerUserID; workItemId: WorkItemID; leaseEpoch: number; state: "running" | "result" }>()
  const leases = new Map<WorkItemID, { attemptId: AttemptID; epoch: number; expiresAt: number }>()
  let failNextAppend = false

  const execute: WorkGraphCommandHandler = async (context, request) => {
    const operationKey = `${context.ownerUserId}:${request.operationId}`
    const fingerprint = JSON.stringify(request.command)
    const previous = operations.get(operationKey)
    if (previous?.fingerprint === fingerprint) return previous.result
    if (previous) return failure(request.operationId, "idempotency_conflict", "Operation ID already used")

    const pending = apply(context, request)
    if (!pending.ok) return pending.result
    if (failNextAppend) {
      failNextAppend = false
      return failure(request.operationId, "internal_error", "Injected append failure")
    }

    pending.commit()
    const ownerChanges = changes.get(context.ownerUserId) ?? []
    const cursor = createChangeCursor({
      organizationId: context.organizationId,
      ownerUserId: context.ownerUserId,
      position: ownerChanges.length + 1,
    })
    ownerChanges.push({
      cursor,
      event: {
        ...(pending.streamId ? { streamId: pending.streamId } : {}),
        type: pending.type,
        occurredAt: input.clock.now(),
      },
    })
    changes.set(context.ownerUserId, ownerChanges)
    const result = success(request.operationId, cursor, pending.value)
    operations.set(operationKey, { fingerprint, result })
    return result
  }

  const apply = (context: WorkGraphContext, request: WorkGraphCommandRequest): PendingResult => {
    const command = request.command
    if (command.type === "create_stream") {
      const streamId = branded<StreamID>(input.ids.next("stream"))
      const stream = { id: streamId, ownerUserId: context.ownerUserId, title: command.title, version: 1, lifecycleState: "active", durableEffectCount: 0 } satisfies ConformanceStreamView
      return pending("stream_created", { streamId }, () => streams.set(streamId, stream), streamId)
    }
    if (command.type === "update_stream") {
      const stream = ownedStream(context, command.streamId)
      if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
      if (stream.version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
      const updated = { ...stream, ...(command.title ? { title: command.title } : {}), version: stream.version + 1 }
      return pending("stream_updated", { streamId: stream.id }, () => streams.set(stream.id, updated), stream.id)
    }
    if (command.type === "set_stream_lifecycle") {
      const stream = ownedStream(context, command.streamId)
      if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
      if (stream.version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
      const transition = transitionStream(stream.lifecycleState as StreamLifecycleState, command.state)
      if (!transition.ok) return rejected(request.operationId, "invalid_transition", "Invalid stream transition")
      const updated = { ...stream, lifecycleState: transition.state, version: stream.version + 1 }
      return pending("stream_lifecycle_changed", { streamId: stream.id }, () => streams.set(stream.id, updated), stream.id)
    }
    if (command.type === "create_work_source") {
      const workSourceId = branded<WorkSourceID>(input.ids.next("source"))
      const revisionId = branded<WorkSourceRevisionID>(input.ids.next("revision"))
      const revision = { workSourceId, id: revisionId, revisionNumber: 1, content: command.content, ownerUserId: context.ownerUserId }
      return pending("work_source_created", { workSourceId, revisionId }, () => {
        sources.set(workSourceId, { ownerUserId: context.ownerUserId, latestRevisionId: revisionId })
        revisions.set(revisionId, revision)
      })
    }
    if (command.type === "revise_work_source") {
      const source = sources.get(command.workSourceId)
      if (!source || source.ownerUserId !== context.ownerUserId) return rejected(request.operationId, "not_found", "Work Source not found")
      if (source.latestRevisionId !== command.expectedRevisionId) return rejected(request.operationId, "version_conflict", "Work Source revision changed")
      const previousRevision = revisions.get(source.latestRevisionId)!
      const revisionId = branded<WorkSourceRevisionID>(input.ids.next("revision"))
      const revision = { workSourceId: command.workSourceId, id: revisionId, revisionNumber: previousRevision.revisionNumber + 1, content: command.content, ownerUserId: context.ownerUserId }
      return pending("work_source_revised", { workSourceId: command.workSourceId, revisionId }, () => {
        sources.set(command.workSourceId, { ...source, latestRevisionId: revisionId })
        revisions.set(revisionId, revision)
      })
    }
    if (command.type === "create_outcome") {
      const stream = ownedStream(context, command.streamId)
      if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
      const outcomeId = branded<OutcomeID>(input.ids.next("outcome"))
      return pending("outcome_created", { outcomeId }, () => outcomes.set(outcomeId, { ownerUserId: context.ownerUserId, streamId: stream.id }), stream.id)
    }
    if (command.type === "create_work_item") {
      const stream = ownedStream(context, command.streamId)
      if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
      if (command.outcomeId) {
        const outcome = outcomes.get(command.outcomeId)
        if (!outcome || outcome.ownerUserId !== context.ownerUserId || outcome.streamId !== stream.id) return rejected(request.operationId, "not_found", "Outcome not found")
      }
      const workItemId = branded<WorkItemID>(input.ids.next("work_item"))
      const workItem = { id: workItemId, ownerUserId: context.ownerUserId, streamId: stream.id, contract: command.completionContract, evidence: [] } satisfies MutableWorkItem
      return pending("work_item_created", { workItemId }, () => workItems.set(workItemId, workItem), stream.id)
    }
    if (command.type === "execute_work_item") {
      const workItem = workItems.get(command.workItemId)
      if (!workItem || workItem.ownerUserId !== context.ownerUserId) return rejected(request.operationId, "not_found", "Work item not found")
      const active = leases.get(workItem.id)
      if (active && active.expiresAt > input.clock.now()) return rejected(request.operationId, "blocked", "Work item already has an active Attempt")
      const attemptId = branded<AttemptID>(input.ids.next("attempt"))
      const leaseEpoch = (active?.epoch ?? 0) + 1
      return pending("attempt_admitted", { attemptId, workItemId: workItem.id, leaseEpoch }, () => {
        attempts.set(attemptId, { ownerUserId: context.ownerUserId, workItemId: workItem.id, leaseEpoch, state: "running" })
        leases.set(workItem.id, { attemptId, epoch: leaseEpoch, expiresAt: input.clock.now() + 300_000 })
      }, workItem.streamId)
    }
    if (command.type === "record_evidence") {
      if (command.subject.type !== "work_item") return rejected(request.operationId, "not_found", "Outcome evidence unsupported by reference adapter")
      const workItem = workItems.get(command.subject.workItemId)
      if (!workItem || workItem.ownerUserId !== context.ownerUserId) return rejected(request.operationId, "not_found", "Work item not found")
      const stream = ownedStream(context, workItem.streamId)
      if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
      const updatedItem = { ...workItem, evidence: [...workItem.evidence, { requirementId: command.requirementId, evidence: command.evidence }] }
      const durable = command.evidence.kind === "integration" && command.evidence.effect !== "other"
      const updatedStream = durable ? { ...stream, durableEffectCount: stream.durableEffectCount + 1 } : stream
      return pending("evidence_recorded", { evidenceId: input.ids.next("evidence") }, () => {
        workItems.set(workItem.id, updatedItem)
        if (durable) streams.set(stream.id, updatedStream)
      }, stream.id)
    }
    if (command.type === "delete_stream") {
      const stream = ownedStream(context, command.streamId)
      if (!stream) return rejected(request.operationId, "not_found", "Stream not found")
      if (stream.durableEffectCount > 0) return rejected(request.operationId, "close_required", "Durable effects require close")
      if (stream.version !== command.expectedVersion) return rejected(request.operationId, "version_conflict", "Stream version changed")
      return pending("stream_deleted", { streamId: stream.id }, () => {
        streams.delete(stream.id)
        Array.from(outcomes).filter(([, outcome]) => outcome.streamId === stream.id).forEach(([id]) => outcomes.delete(id))
        Array.from(workItems).filter(([, workItem]) => workItem.streamId === stream.id).forEach(([id]) => workItems.delete(id))
      }, stream.id)
    }
    return rejected(request.operationId, "internal_error", "Unsupported reference command")
  }

  const ownedStream = (context: WorkGraphContext, streamId: StreamID) => {
    const stream = streams.get(streamId)
    if (stream?.ownerUserId === context.ownerUserId) return stream
    return undefined
  }

  const queries: ConformanceQueries = {
    snapshot: {
      page: async (context, query): Promise<WorkGraphSnapshotPage> => {
        const snapshotCursor = createChangeCursor({
          organizationId: context.organizationId,
          ownerUserId: context.ownerUserId,
          position: (changes.get(context.ownerUserId) ?? []).length,
        })
        const resume = query.after
          ? readSnapshotResumeCursor(query.after, context.organizationId, context.ownerUserId, snapshotCursor)
          : { offset: 0, capturedAt: input.clock.now() }
        const records = [...streams.values()]
          .filter((stream) => stream.ownerUserId === context.ownerUserId)
          .map((stream) => ({
            recordType: "stream" as const,
            schemaVersion: 1 as const,
            ownerUserId: stream.ownerUserId,
            version: stream.version,
            createdAt: 1_000,
            updatedAt: 1_000,
            provenance: { actor: context.actor },
            id: stream.id,
            title: stream.title,
            lifecycleState: stream.lifecycleState as StreamLifecycleState,
            visibility: "visible" as const,
            pinned: false,
            executionDefaults: {},
            recapDefaults: {},
            activity: { lastActivityAt: 1_000, recapDueAt: 29_800_000 },
            durableEffectCount: stream.durableEffectCount,
            sourceRevisionRefs: [],
          }))
          .sort(compareSnapshotCursorPosition)
        const offset = resume.offset
        const page = records.slice(offset, offset + query.limit)
        const hasMore = offset + page.length < records.length
        return {
          snapshotCursor,
          records: page,
          references: page.map((record, index) => ({ sequence: offset + index + 1, resource: { type: "stream", id: record.id }, version: record.version })),
          hasMore,
          ...(hasMore ? {
            nextCursor: createSnapshotResumeCursor({
              organizationId: context.organizationId,
              ownerUserId: context.ownerUserId,
              snapshotCursor,
              offset: offset + page.length,
              capturedAt: resume.capturedAt,
              position: page.at(-1)!,
            }),
          } : {}),
          capturedAt: resume.capturedAt,
        }
      },
    },
    streams: { read: async (context, query) => ownedStream(context, query.streamId) },
    sources: {
      readRevision: async (context, query) => {
        const revision = revisions.get(query.revisionId)
        if (revision?.ownerUserId !== context.ownerUserId || revision.workSourceId !== query.workSourceId) return undefined
        return revision
      },
    },
    changes: {
      list: async (context, query) => {
        const after = query.after ? readChangeCursor(query.after, context.organizationId, context.ownerUserId) : 0
        return (changes.get(context.ownerUserId) ?? []).filter((change) =>
          readChangeCursor(change.cursor, context.organizationId, context.ownerUserId) > after)
      },
      listStream: async (context, query) => {
        const scope = { type: "stream" as const, streamId: query.streamId }
        const after = query.after ? readChangeCursor(query.after, context.organizationId, context.ownerUserId, scope) : 0
        return (changes.get(context.ownerUserId) ?? [])
          .filter((change) => change.event.streamId === query.streamId && readChangeCursor(change.cursor, context.organizationId, context.ownerUserId) > after)
          .map((change) => ({
            ...change,
            cursor: createChangeCursor({
              organizationId: context.organizationId,
              ownerUserId: context.ownerUserId,
              scope,
              position: readChangeCursor(change.cursor, context.organizationId, context.ownerUserId),
            }),
          }))
      },
    },
    workItems: {
      read: async (context, query) => {
        const workItem = workItems.get(branded<WorkItemID>(query.workItemId))
        if (workItem?.ownerUserId !== context.ownerUserId) return undefined
        return { id: workItem.id, completionSatisfied: completionSatisfied(workItem) }
      },
    },
  }

  const commands = {
    create_work_source: execute,
    revise_work_source: execute,
    create_stream: execute,
    update_stream: execute,
    set_stream_lifecycle: execute,
    create_outcome: execute,
    create_work_item: execute,
    record_evidence: execute,
    delete_stream: execute,
    execute_work_item: execute,
  } satisfies ConformanceCommands
  const store = defineAtomicWorkGraphStore({ commands, queries })
  const attemptRuntime: AttemptRuntimePort = {
    listReconcilable: async () => [],
    renewLease: async (context, request) => {
      const attempt = attempts.get(request.attemptId)
      const lease = attempt ? leases.get(attempt.workItemId) : undefined
      if (
        !attempt ||
        attempt.ownerUserId !== context.ownerUserId ||
        !lease ||
        lease.attemptId !== request.attemptId ||
        lease.epoch !== request.expectedLeaseEpoch ||
        attempt.leaseEpoch !== request.expectedLeaseEpoch
      ) return undefined
      const leaseEpoch = lease.expiresAt <= request.occurredAt ? lease.epoch + 1 : lease.epoch
      const expiresAt = request.occurredAt + request.durationMs
      leases.set(attempt.workItemId, { ...lease, epoch: leaseEpoch, expiresAt })
      if (leaseEpoch !== attempt.leaseEpoch) attempts.set(request.attemptId, { ...attempt, leaseEpoch })
      return { leaseEpoch, expiresAt, recovered: leaseEpoch !== lease.epoch }
    },
    recordResult: async (context, request) => {
      const attempt = attempts.get(request.attemptId)
      const lease = attempt ? leases.get(attempt.workItemId) : undefined
      if (
        !attempt ||
        attempt.ownerUserId !== context.ownerUserId ||
        attempt.workItemId !== request.workItemId ||
        attempt.leaseEpoch !== request.leaseEpoch ||
        !lease ||
        lease.attemptId !== request.attemptId ||
        lease.epoch !== request.leaseEpoch
      ) return false
      attempts.set(request.attemptId, { ...attempt, state: "result" })
      leases.delete(request.workItemId)
      return true
    },
  }

  return {
    service: createWorkGraphService(store),
    attemptRuntime,
    restart: async () => ({ attemptRuntime }),
    faults: { failNextAppend: () => { failNextAppend = true } },
  }
}

describe("custom in-memory AtomicWorkGraphStore conformance", () => {
  workGraphAdapterConformance(memoryFactory).forEach((testCase) => it(testCase.name, testCase.run))
})

type MutableWorkItem = Readonly<{
  id: WorkItemID
  ownerUserId: OwnerUserID
  streamId: StreamID
  contract: CompletionContract
  evidence: readonly Readonly<{ requirementId?: string; evidence: EvidenceInput }>[]
}>

type PendingResult =
  | Readonly<{ ok: true; type: string; value: Record<string, string | number>; streamId?: StreamID; commit: () => void }>
  | Readonly<{ ok: false; result: CommandResult }>

function pending(type: string, value: Record<string, string | number>, commit: () => void, streamId?: StreamID): PendingResult {
  return { ok: true, type, value, ...(streamId ? { streamId } : {}), commit }
}

function rejected(operationId: OperationID, code: CommandErrorCode, message: string): PendingResult {
  return { ok: false, result: failure(operationId, code, message) }
}

function success(operationId: OperationID, cursor: ChangeCursor, value: Record<string, string | number>): CommandResult {
  return { ok: true, operationId, cursor, value }
}

function failure(operationId: OperationID, code: CommandErrorCode, message: string): CommandResult {
  return { ok: false, operationId, error: { code, message, retryable: false } }
}

function completionSatisfied(workItem: MutableWorkItem): ConformanceWorkItemView["completionSatisfied"] {
  const results = workItem.contract.requirements.map((requirement) => {
    const latest = workItem.evidence.findLast((entry) => entry.requirementId === requirement.id)?.evidence
    if (!latest) return false
    if (requirement.kind === "test" || requirement.kind === "verification") return latest.kind === "test_result" && latest.passed
    if (requirement.kind === "integration") return latest.kind === "integration"
    if (requirement.kind === "review") return latest.kind === "review" && latest.verdict === "approved"
    if (requirement.kind === "artifact") return latest.kind === "artifact"
    return latest.kind === "owner_confirmation" && latest.confirmed
  })
  return workItem.contract.mode === "all" ? results.every(Boolean) : results.some(Boolean)
}
