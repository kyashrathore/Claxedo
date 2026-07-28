import { SnapshotResumeCursorError, readChangeCursor } from "../contracts"
import type {
  ChangeCursor,
  RunID,
  CommandResult,
  OperationID,
  OwnerUserID,
  ResolvedExecutionProfile,
  StreamID,
  WorkGraphContext,
  WorkGraphSnapshotPage,
  WorkItemID,
  WorkSourceID,
  WorkSourceRevisionID,
  SnapshotResumeCursor,
} from "../contracts"
import type { WorkGraphService } from "../application/workgraph-service"
import type { RunRuntimePort } from "../ports/run-runtime"
import type { WorkGraphCommandHandlers } from "../ports/store"

export * from "./archive"
export * from "./activity"
export * from "./attention"
export * from "./owner-deletion"
export * from "./replacement"
export * from "./snapshot-restart"

export const WORKGRAPH_ADAPTER_CONFORMANCE_VERSION = 7 as const

export const WORKGRAPH_ADAPTER_CONFORMANCE_SCOPE = {
  covered: [
    "owner_isolation",
    "operation_idempotency",
    "compare_and_set_and_append_rollback",
    "ordered_change_cursors",
    "snapshot_pagination_order_and_resume_cursor",
    "snapshot_cursor_owner_and_mutation_invalidation",
    "snapshot_to_changes_exactly_once_convergence",
    "snapshot_resume_across_adapter_restart",
    "stream_lifecycle_validation",
    "immutable_source_revisions",
    "completion_evidence",
    "durable_effect_delete_arbitration",
    "lease_acquire_renew_expire",
    "run_runtime_recovery",
    "source_revision_replacement_fencing",
    "session_binding_owner_isolation_and_exact_retry",
    "bounded_task_activity_pagination_and_restart",
  ],
  remaining: [
    "migration_export_restore_roundtrip",
    "workspace_cleanup_and_permanent_deletion",
  ],
} as const

export type ConformanceCommands = Pick<
  WorkGraphCommandHandlers,
  | "create_work_source"
  | "revise_work_source"
  | "create_stream"
  | "update_stream"
  | "set_stream_lifecycle"
  | "create_outcome"
  | "create_work_item"
  | "record_evidence"
  | "delete_stream"
>

export type ConformanceStreamView = Readonly<{
  id: StreamID
  ownerUserId: OwnerUserID
  title: string
  version: number
  lifecycleState: string
  durableEffectCount: number
}>

export type ConformanceSourceRevisionView = Readonly<{
  workSourceId: WorkSourceID
  id: WorkSourceRevisionID
  revisionNumber: number
  content: string
}>

export type ConformanceChangeView = Readonly<{
  cursor: ChangeCursor
  event: Readonly<{
    streamId?: StreamID
    type: string
    occurredAt: number
  }>
}>

export type ConformanceWorkItemView = Readonly<{
  id: string
  completionSatisfied: boolean
}>

export type ConformanceQueries = Readonly<{
  snapshot: Readonly<{
    page: (
      context: WorkGraphContext,
      input: Readonly<{ after?: SnapshotResumeCursor; limit: number }>,
    ) => Promise<WorkGraphSnapshotPage>
  }>
  streams: Readonly<{
    read: (
      context: WorkGraphContext,
      input: Readonly<{ streamId: StreamID }>,
    ) => Promise<ConformanceStreamView | undefined>
  }>
  sources: Readonly<{
    readRevision: (
      context: WorkGraphContext,
      input: Readonly<{ workSourceId: WorkSourceID; revisionId: WorkSourceRevisionID }>,
    ) => Promise<ConformanceSourceRevisionView | undefined>
  }>
  changes: Readonly<{
    list: (
      context: WorkGraphContext,
      input: Readonly<{ after?: ChangeCursor }>,
    ) => Promise<readonly ConformanceChangeView[]>
    listStream: (
      context: WorkGraphContext,
      input: Readonly<{ streamId: StreamID; after?: ChangeCursor }>,
    ) => Promise<readonly ConformanceChangeView[]>
  }>
  workItems: Readonly<{
    read: (
      context: WorkGraphContext,
      input: Readonly<{ workItemId: string }>,
    ) => Promise<ConformanceWorkItemView | undefined>
  }>
}>

export type StoreConformanceFactory = (input: Readonly<{
  clock: Readonly<{ now: () => number }>
  ids: Readonly<{ next: (kind: string) => string }>
  owners: Readonly<{ first: WorkGraphContext; second: WorkGraphContext }>
}>) => Promise<Readonly<{
  service: WorkGraphService<ConformanceCommands, ConformanceQueries>
  runRuntime: RunRuntimePort
  executionProfile?: ResolvedExecutionProfile
  restart: () => Promise<Readonly<{ runRuntime: RunRuntimePort }>>
  faults: Readonly<{ failNextAppend: () => void }>
  /**
   * Ensure the given approved (`pending`) Work Item has an admitted Run and
   * return it as a CommandResult whose value carries `{ runId, leaseEpoch }`.
   * Execution-mode commands are gone: adapters admit through their own launch
   * path (the SQLite drain auto-admits; the reference adapter admits on demand).
   */
  admit: (
    owner: WorkGraphContext,
    input: Readonly<{ workItemId: WorkItemID }>,
  ) => Promise<CommandResult>
}>>

export type WorkGraphAdapterConformanceCase = Readonly<{
  name: string
  run: () => Promise<void>
}>

/**
 * Returns runner-neutral conformance cases for a custom WorkGraph store.
 * Register each case with Vitest, Jest, Bun test, Node test, or another runner.
 */
export function workGraphAdapterConformance(factory: StoreConformanceFactory): readonly WorkGraphAdapterConformanceCase[] {
  return [
    testCase("isolates every read, operation receipt, and cursor by owner", async () => {
      const fixture = await setup(factory)
      const first = await createStream(fixture, fixture.owners.first, "operation_shared", "First owner")
      const second = await createStream(fixture, fixture.owners.second, "operation_shared", "Second owner")
      assert(first.ok && second.ok, "Both owners must be able to reuse the same operation ID independently")
      const firstId = valueId(first, "streamId") as StreamID
      const secondId = valueId(second, "streamId") as StreamID
      assert(await fixture.service.query(fixture.owners.first, "streams", "read", { streamId: secondId }) === undefined, "First owner read data owned by second owner")
      assert(await fixture.service.query(fixture.owners.second, "streams", "read", { streamId: firstId }) === undefined, "Second owner read data owned by first owner")
      assert((await fixture.service.query(fixture.owners.first, "changes", "list", {})).length === 1, "First owner change cursor leaked or missed data")
      assert((await fixture.service.query(fixture.owners.second, "changes", "list", {})).length === 1, "Second owner change cursor leaked or missed data")
    }),
    testCase("replays an exact operation and rejects conflicting operation reuse without a write", async () => {
      const fixture = await setup(factory)
      const request = createStreamRequest("operation_1", "Original")
      const first = await fixture.service.execute(fixture.owners.first, request)
      const retry = await fixture.service.execute(fixture.owners.first, request)
      const conflict = await fixture.service.execute(fixture.owners.first, createStreamRequest("operation_1", "Changed"))
      assertDeepEqual(retry, first, "Exact operation replay returned a different result")
      assertError(conflict, "idempotency_conflict")
      assert((await fixture.service.query(fixture.owners.first, "changes", "list", {})).length === 1, "Conflicting operation reuse appended a change")
    }),
    testCase("enforces compare-and-set versions and rolls state back when event/change append fails", async () => {
      const fixture = await setup(factory)
      const created = await createStream(fixture, fixture.owners.first, "operation_1", "Original")
      const streamId = valueId(created, "streamId") as StreamID
      const stale = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_2"),
        command: { version: 1, type: "update_stream", streamId, expectedVersion: 0, title: "Stale" },
      })
      assertError(stale, "version_conflict")
      fixture.faults.failNextAppend()
      const failed = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_3"),
        command: { version: 1, type: "update_stream", streamId, expectedVersion: 1, title: "Must roll back" },
      })
      assertError(failed, "internal_error")
      const current = await fixture.service.query(fixture.owners.first, "streams", "read", { streamId })
      assert(current?.title === "Original" && current.version === 1, "Append failure left a partial stream update")
      assert((await fixture.service.query(fixture.owners.first, "changes", "list", {})).length === 1, "Append failure persisted a change")
    }),
    testCase("keeps owner and per-stream cursors monotonic and supports resume-after", async () => {
      const fixture = await setup(factory)
      const created = await createStream(fixture, fixture.owners.first, "operation_1", "Cursor stream")
      const streamId = valueId(created, "streamId") as StreamID
      await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_2"),
        command: { version: 1, type: "update_stream", streamId, expectedVersion: 1, title: "Updated" },
      })
      const all = await fixture.service.query(fixture.owners.first, "changes", "list", {})
      const stream = await fixture.service.query(fixture.owners.first, "changes", "listStream", { streamId }) as unknown as readonly ConformanceChangeView[]
      assertDeepEqual(all.map((change) => readChangeCursor(change.cursor, fixture.owners.first.organizationId, fixture.owners.first.ownerUserId)), [1, 2], "Owner cursors are not monotonic")
      assertDeepEqual(stream.map((change) => readChangeCursor(change.cursor, fixture.owners.first.organizationId, fixture.owners.first.ownerUserId, { type: "stream", streamId })), [1, 2], "Per-stream cursors are not monotonic")
      assertDeepEqual(all.map((change) => change.event.occurredAt), [1_000, 1_001], "Adapter ignored the supplied clock ordering")
      assertDeepEqual(
        await fixture.service.query(fixture.owners.first, "changes", "list", { after: all[0]!.cursor }),
        [all[1]],
        "Resume-after returned the wrong change window",
      )
    }),
    testCase("paginates a stable ordered snapshot through returned resume cursors", async () => {
      const fixture = await setup(factory)
      await createStream(fixture, fixture.owners.first, "operation_1", "First")
      await createStream(fixture, fixture.owners.first, "operation_2", "Second")
      const latest = await createStream(fixture, fixture.owners.first, "operation_3", "Third")
      await createStream(fixture, fixture.owners.second, "operation_1", "Other owner")
      assert(latest.ok, "Snapshot fixture write failed")

      const firstPass = await snapshotPages(fixture, fixture.owners.first, 2)
      const secondPass = await snapshotPages(fixture, fixture.owners.first, 2)
      assert(firstPass.pages[0]?.snapshotCursor === latest.cursor, "Snapshot cursor did not identify the latest included owner change")
      assert(firstPass.pages.every((page) => page.snapshotCursor === firstPass.pages[0]!.snapshotCursor), "Snapshot cursor changed while resuming an unchanged snapshot")
      assert(firstPass.pages.every((page) => page.capturedAt === firstPass.pages[0]!.capturedAt), "Snapshot capture time changed while resuming an unchanged snapshot")
      assertDeepEqual(firstPass.identity, secondPass.identity, "Repeated pagination changed record order or resume boundaries without a write")
      assert(new Set(firstPass.identity.map((entry) => entry.record)).size === firstPass.identity.length, "Snapshot pagination duplicated a record")
      assertDeepEqual(firstPass.identity.map((entry) => entry.sequence), firstPass.identity.map((_, index) => index + 1), "Snapshot references were not globally ordered across pages")
      assert(firstPass.identity.every((entry) => entry.ownerUserId === fixture.owners.first.ownerUserId), "Snapshot pagination leaked another owner's record")
    }),
    testCase("rejects malformed, cross-owner, and mutation-invalidated snapshot resume cursors", async () => {
      const fixture = await setup(factory)
      const first = await createStream(fixture, fixture.owners.first, "operation_1", "First")
      await createStream(fixture, fixture.owners.first, "operation_2", "Second")
      await createStream(fixture, fixture.owners.first, "operation_3", "Third")
      const page = await fixture.service.query(fixture.owners.first, "snapshot", "page", { limit: 1 })
      assert(page.nextCursor !== undefined, "Snapshot fixture did not return a resume cursor")

      await assertSnapshotCursorError(
        () => fixture.service.query(fixture.owners.second, "snapshot", "page", { after: page.nextCursor!, limit: 1 }),
        "owner_mismatch",
      )
      await assertSnapshotCursorError(
        () => fixture.service.query(fixture.owners.first, "snapshot", "page", { after: branded<SnapshotResumeCursor>("malformed"), limit: 1 }),
        "invalid",
      )
      await assertSnapshotCursorError(
        () => fixture.service.query(fixture.owners.first, "snapshot", "page", {
          after: branded<SnapshotResumeCursor>("x".repeat(513)),
          limit: 1,
        }),
        "invalid",
      )
      await assertSnapshotCursorError(
        () => fixture.service.query(fixture.owners.first, "snapshot", "page", {
          after: branded<SnapshotResumeCursor>("wgsp1:%ZZ:3:1:1000"),
          limit: 1,
        }),
        "invalid",
      )
      await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_4"),
        command: {
          version: 1,
          type: "update_stream",
          streamId: valueId(first, "streamId") as StreamID,
          expectedVersion: 1,
          title: "Changed after snapshot",
        },
      })
      await assertSnapshotCursorError(
        () => fixture.service.query(fixture.owners.first, "snapshot", "page", { after: page.nextCursor!, limit: 1 }),
        "invalidated",
      )
    }),
    testCase("delivers changes after a captured snapshot cursor in order exactly once", async () => {
      const fixture = await setup(factory)
      await createStream(fixture, fixture.owners.first, "operation_1", "Before snapshot")
      const snapshot = await fixture.service.query(fixture.owners.first, "snapshot", "page", { limit: 100 })
      const created = await createStream(fixture, fixture.owners.first, "operation_2", "After snapshot")
      const streamId = valueId(created, "streamId") as StreamID
      await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_3"),
        command: { version: 1, type: "update_stream", streamId, expectedVersion: 1, title: "Updated once" },
      })
      await createStream(fixture, fixture.owners.second, "operation_1", "Other owner")

      const changes = await fixture.service.query(fixture.owners.first, "changes", "list", { after: snapshot.snapshotCursor })
      assertDeepEqual(changes.map((change) => readChangeCursor(change.cursor, fixture.owners.first.organizationId, fixture.owners.first.ownerUserId)), [2, 3], "Snapshot convergence returned missing, duplicate, or unordered changes")
      assertDeepEqual(changes.map((change) => change.event.type), ["stream_created", "stream_updated"], "Snapshot convergence returned the wrong owner change sequence")
      assert(new Set(changes.map((change) => change.cursor)).size === changes.length, "Snapshot convergence returned a change more than once")
      assertDeepEqual(
        await fixture.service.query(fixture.owners.first, "changes", "list", { after: changes.at(-1)!.cursor }),
        [],
        "Resuming after the delivered change window replayed a change",
      )
    }),
    testCase("rejects an invalid lifecycle transition without changing state or appending", async () => {
      const fixture = await setup(factory)
      const created = await createStream(fixture, fixture.owners.first, "operation_1", "Lifecycle")
      const streamId = valueId(created, "streamId") as StreamID
      const result = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_2"),
        command: { version: 1, type: "set_stream_lifecycle", streamId, expectedVersion: 1, state: "reopened", reason: "Not closed" },
      })
      assertError(result, "invalid_transition")
      const current = await fixture.service.query(fixture.owners.first, "streams", "read", { streamId })
      assert(current?.lifecycleState === "active" && current.version === 1, "Invalid transition changed stream state")
      assert((await fixture.service.query(fixture.owners.first, "changes", "list", {})).length === 1, "Invalid transition appended a change")
    }),
    testCase("preserves immutable Work Source revisions and reads the exact requested revision", async () => {
      const fixture = await setup(factory)
      const created = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_1"),
        command: { version: 1, type: "create_work_source", title: "Plan", content: "version one" },
      })
      const workSourceId = valueId(created, "workSourceId") as WorkSourceID
      const firstRevisionId = valueId(created, "revisionId") as WorkSourceRevisionID
      const revised = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_2"),
        command: { version: 1, type: "revise_work_source", workSourceId, expectedRevisionId: firstRevisionId, content: "version two" },
      })
      const secondRevisionId = valueId(revised, "revisionId") as WorkSourceRevisionID
      const first = await fixture.service.query(fixture.owners.first, "sources", "readRevision", { workSourceId, revisionId: firstRevisionId })
      const second = await fixture.service.query(fixture.owners.first, "sources", "readRevision", { workSourceId, revisionId: secondRevisionId })
      assert(first?.content === "version one" && first.revisionNumber === 1, "First source revision was mutated or misread")
      assert(second?.content === "version two" && second.revisionNumber === 2, "Second source revision was not preserved")
      assert(await fixture.service.query(fixture.owners.second, "sources", "readRevision", { workSourceId, revisionId: firstRevisionId }) === undefined, "Source revision leaked across owners")
    }),
    testCase("surfaces semantic completion only after matching positive evidence", async () => {
      const fixture = await setup(factory)
      const streamId = valueId(await createStream(fixture, fixture.owners.first, "operation_1", "Completion"), "streamId") as StreamID
      const outcome = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_2"),
        command: { version: 1, type: "create_outcome", streamId, title: "Ship", successCriteria: ["Tests pass"] },
      })
      const workItem = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_3"),
        command: {
          version: 1,
          type: "create_work_item",
          streamId,
          outcomeId: valueId(outcome, "outcomeId") as never,
          title: "Test",
          completionContract: { version: 1, mode: "all", requirements: [{ id: branded("requirement_1"), kind: "test", description: "Tests pass" }] },
        },
      })
      const workItemId = valueId(workItem, "workItemId")
      assert((await fixture.service.query(fixture.owners.first, "workItems", "read", { workItemId }))?.completionSatisfied === false, "Work Item completed before evidence")
      await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_4"),
        command: {
          version: 1,
          type: "record_evidence",
          subject: { type: "work_item", workItemId: workItemId as never },
          requirementId: branded("requirement_1"),
          evidence: { kind: "test_result", summary: "green", passed: true },
        },
      })
      assert((await fixture.service.query(fixture.owners.first, "workItems", "read", { workItemId }))?.completionSatisfied === true, "Matching positive evidence did not satisfy completion")
    }),
    testCase("atomically arbitrates stream deletion against a durable integration receipt", async () => {
      const fixture = await setup(factory)
      const streamId = valueId(await createStream(fixture, fixture.owners.first, "operation_1", "Race"), "streamId") as StreamID
      const outcome = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_2"),
        command: { version: 1, type: "create_outcome", streamId, title: "Merge", successCriteria: ["Merged"] },
      })
      const workItem = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("operation_3"),
        command: {
          version: 1,
          type: "create_work_item",
          streamId,
          outcomeId: valueId(outcome, "outcomeId") as never,
          title: "Merge PR",
          completionContract: { version: 1, mode: "all", requirements: [{ id: branded("requirement_1"), kind: "integration", description: "Merged" }] },
        },
      })
      const workItemId = valueId(workItem, "workItemId")
      const [deletion, receipt] = await Promise.all([
        fixture.service.execute(fixture.owners.first, {
          operationId: operation("operation_delete"),
          command: { version: 1, type: "delete_stream", streamId, expectedVersion: 1, reason: "Discard" },
        }),
        fixture.service.execute(fixture.owners.first, {
          operationId: operation("operation_receipt"),
          command: {
            version: 1,
            type: "record_evidence",
            subject: { type: "work_item", workItemId: workItemId as never },
            requirementId: branded("requirement_1"),
            evidence: { kind: "integration", summary: "Merged", effect: "merged", reference: "pr:1" },
          },
        }),
      ])
      assert([deletion.ok, receipt.ok].filter(Boolean).length === 1, "Delete and durable receipt both committed or both failed")
      if (deletion.ok) {
        assertError(receipt, "not_found")
        assert(await fixture.service.query(fixture.owners.first, "streams", "read", { streamId }) === undefined, "Deleted Stream still exists")
        return
      }
      assertError(deletion, "close_required")
      assert(receipt.ok, "Durable receipt did not commit after winning arbitration")
      assert((await fixture.service.query(fixture.owners.first, "streams", "read", { streamId }))?.durableEffectCount === 1, "Durable receipt was not reflected on Stream")
    }),
    testCase("fences Run leases across acquisition, renewal, expiry, and runtime restart", async () => {
      const fixture = await setup(factory)
      const stream = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("lease_stream"),
        command: {
          version: 1,
          type: "create_stream",
          title: "Lease stream",
          execution: fixture.executionProfile ?? executionProfile,
        },
      })
      const workItem = await fixture.service.execute(fixture.owners.first, {
        operationId: operation("lease_item"),
        command: {
          version: 1,
          type: "create_work_item",
          streamId: valueId(stream, "streamId") as StreamID,
          title: "Lease item",
          completionContract: {
            version: 1,
            mode: "all",
            requirements: [{ id: branded("lease_proof"), kind: "test", description: "Lease behavior is green" }],
          },
        },
      })
      const workItemId = valueId(workItem, "workItemId") as WorkItemID
      // A user-created task is born approved; admission now flows through the
      // adapter's own launch path (the concurrency fence — one live lease holder
      // across competing admissions — is exercised by the adapter's own suite).
      const admitted = await fixture.admit(fixture.owners.first, { workItemId })
      assert(admitted.ok, `Approved Work Item was not admitted: ${canonicalJson(admitted)}`)
      const runId = valueId(admitted, "runId") as RunID
      const leaseEpoch = valueNumber(admitted, "leaseEpoch")
      assert(leaseEpoch === 1, "Initial admission did not start at lease epoch one")
      assert(await fixture.runRuntime.renewLease(fixture.owners.second, {
        runId,
        expectedLeaseEpoch: leaseEpoch,
        occurredAt: 2_000,
        durationMs: 300_000,
      }) === undefined, "Another owner renewed the Run lease")
      assert(await fixture.runRuntime.renewLease(fixture.owners.first, {
        runId,
        expectedLeaseEpoch: leaseEpoch + 1,
        occurredAt: 2_000,
        durationMs: 300_000,
      }) === undefined, "A non-current epoch renewed the Run lease")
      const renewed = await fixture.runRuntime.renewLease(fixture.owners.first, {
        runId,
        expectedLeaseEpoch: leaseEpoch,
        occurredAt: 2_000,
        durationMs: 300_000,
      })
      assert(renewed?.leaseEpoch === leaseEpoch && !renewed.recovered, "Current holder could not renew its active epoch")

      const restarted = await fixture.restart()
      const recovered = await restarted.runRuntime.renewLease(fixture.owners.first, {
        runId,
        expectedLeaseEpoch: leaseEpoch,
        occurredAt: 1_000_000,
        durationMs: 300_000,
      })
      assert(recovered?.leaseEpoch === leaseEpoch + 1 && recovered.recovered, "Restarted runtime did not recover the expired durable Run")
      assert(await restarted.runRuntime.renewLease(fixture.owners.first, {
        runId,
        expectedLeaseEpoch: leaseEpoch,
        occurredAt: 1_000_001,
        durationMs: 300_000,
      }) === undefined, "Recovered lease accepted its stale epoch")
      assert(!(await restarted.runRuntime.recordResult(fixture.owners.first, {
        runId,
        workItemId,
        leaseEpoch,
        state: "result",
        summary: "stale worker",
        artifacts: [],
      })), "Stale runtime completion crossed the recovered epoch fence")
      assert(await restarted.runRuntime.recordResult(fixture.owners.first, {
        runId,
        workItemId,
        leaseEpoch: recovered.leaseEpoch,
        state: "result",
        summary: "current worker",
        artifacts: [],
      }), "Current recovered runtime could not record its terminal result")
    }),
  ]
}

const executionProfile = {
  environment: { kind: "local_worktree" as const, directory: "/repo" },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: [],
  connectionIds: [],
}

async function assertSnapshotCursorError(
  run: () => Promise<unknown>,
  reason: SnapshotResumeCursorError["reason"],
) {
  try {
    await run()
  } catch (error) {
    assert(isCanonicalSnapshotResumeCursorError(error), "Invalid snapshot cursor did not use the canonical typed error")
    assert(error.reason === reason, `Expected snapshot cursor ${reason}, received ${error.reason}`)
    assert(!error.message.includes("owner_first") && !error.message.includes("owner_second"), "Snapshot cursor error revealed an owner identifier")
    return
  }
  throw new Error(`Expected snapshot cursor ${reason} rejection`)
}

/** Strict public-shape check that remains valid when package entrypoints bundle separate class identities. */
function isCanonicalSnapshotResumeCursorError(
  error: unknown,
): error is Error & Readonly<{
  name: "SnapshotResumeCursorError"
  code: "cursor_invalid"
  reason: SnapshotResumeCursorError["reason"]
}> {
  return error instanceof Error && error.name === "SnapshotResumeCursorError" &&
    "code" in error && error.code === "cursor_invalid" &&
    "reason" in error && (error.reason === "invalid" || error.reason === "owner_mismatch" || error.reason === "invalidated")
}

async function snapshotPages(
  fixture: Awaited<ReturnType<typeof setup>>,
  owner: WorkGraphContext,
  limit: number,
) {
  const pages = [] as WorkGraphSnapshotPage[]
  const resumeCursors = new Set<string>()
  let after: SnapshotResumeCursor | undefined
  for (;;) {
    assert(pages.length < 100, "Snapshot pagination did not terminate")
    const page = await fixture.service.query(owner, "snapshot", "page", { ...(after ? { after } : {}), limit })
    assert(page.records.length <= limit, "Snapshot page exceeded its requested limit")
    assert(page.records.length === page.references.length, "Snapshot record/reference counts diverged")
    page.records.forEach((record, index) => {
      const reference = page.references[index]!
      assert(reference.resource.type === record.recordType && reference.resource.id === record.id, "Snapshot reference does not identify its paired record")
      assert(reference.version === record.version, "Snapshot reference version does not match its paired record")
    })
    pages.push(page)
    if (!page.hasMore) {
      assert(page.nextCursor === undefined, "Terminal snapshot page exposed a resume cursor")
      break
    }
    assert(page.nextCursor !== undefined, "Non-terminal snapshot page omitted its resume cursor")
    assert(!resumeCursors.has(page.nextCursor), "Snapshot pagination repeated a resume cursor")
    resumeCursors.add(page.nextCursor)
    after = page.nextCursor
  }
  return {
    pages,
    identity: pages.flatMap((page) => page.records.map((record, index) => ({
      record: `${record.recordType}:${record.id}`,
      ownerUserId: record.ownerUserId,
      sequence: page.references[index]!.sequence,
    }))),
  }
}

function testCase(name: string, run: () => Promise<void>): WorkGraphAdapterConformanceCase {
  return { name, run }
}

async function setup(factory: StoreConformanceFactory) {
  let now = 1_000
  let id = 0
  const owners = { first: context("owner_first"), second: context("owner_second") }
  return {
    ...(await factory({ clock: { now: () => now++ }, ids: { next: (kind) => `${kind}_${++id}` }, owners })),
    owners,
  }
}

function context(ownerUserId: string): WorkGraphContext {
  return {
    organizationId: branded("organization"),
    ownerUserId: branded<OwnerUserID>(ownerUserId),
    actor: { type: "user", id: branded(ownerUserId) },
    requestId: branded(`request_${ownerUserId}`),
    access: { mode: "owner" },
  }
}

function operation(value: string) {
  return branded<OperationID>(value)
}

function createStreamRequest(operationId: string, title: string) {
  return {
    operationId: operation(operationId),
    command: { version: 1 as const, type: "create_stream" as const, title },
  }
}

function createStream(
  fixture: Awaited<ReturnType<typeof setup>>,
  owner: WorkGraphContext,
  operationId: string,
  title: string,
) {
  return fixture.service.execute(owner, createStreamRequest(operationId, title))
}

function valueId(result: CommandResult, key: string) {
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
    throw new Error(`Expected successful result containing ${key}`)
  }
  const value = result.value[key]
  if (typeof value !== "string") throw new Error(`Expected ${key}`)
  return value
}

function valueNumber(result: CommandResult, key: string) {
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
    throw new Error(`Expected successful result containing ${key}`)
  }
  const value = result.value[key]
  if (typeof value !== "number") throw new Error(`Expected ${key}`)
  return value
}

function assertError(result: CommandResult, code: string) {
  assert(!result.ok && result.error.code === code, `Expected ${code}, received ${canonicalJson(result)}`)
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  const left = canonicalJson(actual)
  const right = canonicalJson(expected)
  if (left !== right) throw new Error(`${message}\nExpected: ${right}\nReceived: ${left}`)
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonical(value))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]))
}

function branded<Type>(value: string) {
  return value as Type
}
