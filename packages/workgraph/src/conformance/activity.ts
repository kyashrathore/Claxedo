import type {
  OperationID,
  StreamID,
  TaskActivityPage,
  WorkGraphSnapshotPage,
  WorkGraphContext,
  WorkItemID,
} from "../contracts"
import type { WorkGraphActivityPort, WorkGraphSessionBindingPort } from "../ports"

export const WORKGRAPH_ACTIVITY_CONFORMANCE_VERSION = 1 as const

export type ActivityConformanceFixture = Readonly<{
  activity: WorkGraphActivityPort
  sessionBindings: WorkGraphSessionBindingPort
  seed: (context: WorkGraphContext) => Promise<Readonly<{
    streamId: StreamID
    workItemId: WorkItemID
  }>>
  restart: () => Promise<Pick<ActivityConformanceFixture, "activity" | "sessionBindings">>
  snapshot: (
    context: WorkGraphContext,
    input: Readonly<{ after?: WorkGraphSnapshotPage["nextCursor"]; limit: number }>,
  ) => Promise<WorkGraphSnapshotPage>
}>

export type ActivityConformanceFactory = (input: Readonly<{
  owners: Readonly<{ first: WorkGraphContext; second: WorkGraphContext }>
}>) => Promise<ActivityConformanceFixture>

export function workGraphActivityConformance(
  factory: ActivityConformanceFactory,
): readonly Readonly<{ name: string; run: () => Promise<void> }>[] {
  return [
    {
      name: "isolates Session bindings and replays only exact activity operations",
      run: async () => {
        const owners = { first: owner("activity_owner_a"), second: owner("activity_owner_b") }
        const fixture = await factory({ owners })
        const first = await fixture.seed(owners.first)
        const second = await fixture.seed(owners.second)
        const input = {
          operationId: operation("activity_bind"),
          streamId: first.streamId,
          sessionId: "session_shared",
          projectId: "project_a",
        }
        const binding = await fixture.sessionBindings.bind(owners.first, input)
        assertDeepEqual(await fixture.sessionBindings.bind(owners.first, input), binding, "Exact bind retry changed its result")
        assertDeepEqual(
          await fixture.sessionBindings.readForSession(owners.first, input.sessionId),
          binding,
          "Active Session binding could not be restored from Session identity",
        )
        await assertBindingError(() => fixture.sessionBindings.bind(owners.first, {
          ...input,
          projectId: "project_changed",
        }), "conflict")
        assert(await fixture.sessionBindings.read(owners.second, binding.id) === undefined, "Binding crossed its owner boundary")
        assert(await fixture.sessionBindings.readForSession(owners.second, input.sessionId) === undefined, "Session lookup crossed its owner boundary")
        await fixture.sessionBindings.bind(owners.second, {
          operationId: operation("activity_bind"),
          streamId: second.streamId,
          sessionId: "session_shared",
          projectId: "project_b",
        })
      },
    },
    {
      name: "paginates same-time Task activity without gaps across restart and concurrent append",
      run: async () => {
        const owners = { first: owner("activity_page_owner_a"), second: owner("activity_page_owner_b") }
        const fixture = await factory({ owners })
        const seeded = await fixture.seed(owners.first)
        const foreign = await fixture.seed(owners.second)
        const binding = await fixture.sessionBindings.bind(owners.first, {
          operationId: operation("activity_page_bind"),
          streamId: seeded.streamId,
          sessionId: "session_page",
          projectId: "project_page",
        })
        const attached = await fixture.sessionBindings.attachTask(owners.first, {
          operationId: operation("activity_page_attach"),
          bindingId: binding.id,
          expectedVersion: binding.version,
          workItemId: seeded.workItemId,
          resolvedExecution,
        })
        const firstSnapshot = await fixture.snapshot(owners.first, { limit: 1 })
        assert(firstSnapshot.hasMore && firstSnapshot.nextCursor, "Activity fixture did not produce a bounded snapshot")
        const checkpointInput = {
          operationId: operation("activity_page_checkpoint_a"),
          bindingId: binding.id,
          level: "progress" as const,
          summary: "Same-time checkpoint A",
          evidenceIds: [],
          occurredAt: 1_000,
        }
        const checkpoint = await fixture.sessionBindings.recordCheckpoint(owners.first, checkpointInput)
        assertDeepEqual(
          await fixture.sessionBindings.recordCheckpoint(owners.first, checkpointInput),
          checkpoint,
          "Exact checkpoint retry changed its result",
        )
        await fixture.sessionBindings.recordCheckpoint(owners.first, {
          ...checkpointInput,
          operationId: operation("activity_page_checkpoint_b"),
          summary: "Same-time checkpoint B",
        })
        await fixture.sessionBindings.recordCheckpoint(owners.first, {
          ...checkpointInput,
          operationId: operation("activity_page_checkpoint_c"),
          summary: "Same-time checkpoint C",
        })
        const full = await fixture.activity.list(owners.first, {
          workItemId: seeded.workItemId,
          granularity: "progress",
          limit: 100,
        })
        assert(full.entries.filter((entry) => entry.category === "checkpoint").length === 3, "Checkpoint retry duplicated activity")
        assert(full.entries.some((entry) => entry.category === "run"), "Attached Run is absent from Task activity")
        const first = await fixture.activity.list(owners.first, {
          workItemId: seeded.workItemId,
          granularity: "progress",
          limit: 1,
        })
        assert(first.hasMore && first.nextCursor, "Activity fixture did not produce a bounded first page")
        await assertCursorError(() => fixture.activity.list(owners.second, {
          workItemId: foreign.workItemId,
          granularity: "progress",
          limit: 1,
          after: first.nextCursor,
        }))
        await fixture.sessionBindings.recordCheckpoint(owners.first, {
          ...checkpointInput,
          operationId: operation("activity_page_newer_checkpoint"),
          summary: "Concurrent newer checkpoint",
          occurredAt: Math.max(...full.entries.map((entry) => entry.occurredAt)) + 1,
        })
        const restarted = await fixture.restart()
        assertDeepEqual(
          await restarted.sessionBindings.read(owners.first, binding.id),
          attached,
          "Restart lost the active Session binding",
        )
        const resumedSnapshot = await fixture.snapshot(owners.first, {
          after: firstSnapshot.nextCursor,
          limit: 100,
        })
        assert(resumedSnapshot.snapshotCursor === firstSnapshot.snapshotCursor, "Checkpoint append invalidated the unrelated snapshot page chain")
        const resumed = await collectActivity(restarted.activity, owners.first, seeded.workItemId, first)
        assertDeepEqual(
          resumed.map((entry) => entry.id),
          full.entries.map((entry) => entry.id),
          "Activity resume skipped, duplicated, reordered, or admitted a concurrent newer entry",
        )
      },
    },
    {
      name: "pages a large bounded checkpoint history without truncation",
      run: async () => {
        const owners = { first: owner("activity_large_owner_a"), second: owner("activity_large_owner_b") }
        const fixture = await factory({ owners })
        const seeded = await fixture.seed(owners.first)
        const binding = await fixture.sessionBindings.bind(owners.first, {
          operationId: operation("activity_large_bind"),
          streamId: seeded.streamId,
          sessionId: "session_large",
          projectId: "project_large",
        })
        await fixture.sessionBindings.attachTask(owners.first, {
          operationId: operation("activity_large_attach"),
          bindingId: binding.id,
          expectedVersion: binding.version,
          workItemId: seeded.workItemId,
          resolvedExecution,
        })
        await fixture.sessionBindings.recordCheckpoint(owners.first, {
          operationId: operation("activity_large_milestone"),
          bindingId: binding.id,
          level: "milestone",
          summary: "Older milestone remains visible",
          evidenceIds: [],
          occurredAt: 500,
        })
        for (let index = 0; index < 125; index++) {
          await fixture.sessionBindings.recordCheckpoint(owners.first, {
            operationId: operation(`activity_large_checkpoint_${index}`),
            bindingId: binding.id,
            level: "progress",
            summary: `Checkpoint ${index}`,
            evidenceIds: [],
            occurredAt: 1_000 + Math.floor(index / 5),
          })
        }
        const first = await fixture.activity.list(owners.first, {
          workItemId: seeded.workItemId,
          granularity: "progress",
          limit: 23,
        })
        const entries = await collectActivity(fixture.activity, owners.first, seeded.workItemId, first, 23)
        const checkpoints = entries.filter((entry) => entry.category === "checkpoint")
        assert(checkpoints.length === 126, `Large activity history was truncated at ${checkpoints.length}`)
        const milestones = await fixture.activity.list(owners.first, {
          workItemId: seeded.workItemId,
          granularity: "milestones",
          limit: 10,
        })
        assert(
          milestones.entries.some((entry) => entry.summary === "Older milestone remains visible"),
          "A milestone was hidden behind newer progress-only activity",
        )
        assert(new Set(entries.map((entry) => entry.id)).size === entries.length, "Large activity history duplicated an entry")
        entries.slice(1).forEach((entry, index) => {
          const previous = entries[index]!
          assert(previous.occurredAt > entry.occurredAt ||
            (previous.occurredAt === entry.occurredAt && previous.id > entry.id), "Large activity history is not deterministically ordered")
        })
      },
    },
  ]
}

async function collectActivity(
  activity: WorkGraphActivityPort,
  context: WorkGraphContext,
  workItemId: WorkItemID,
  first: TaskActivityPage,
  limit = 1,
) {
  const entries = [...first.entries]
  let cursor = first.nextCursor
  const seen = new Set(cursor ? [cursor] : [])
  while (cursor) {
    const page = await activity.list(context, { workItemId, granularity: "progress", limit, after: cursor })
    entries.push(...page.entries)
    if (!page.nextCursor) break
    assert(!seen.has(page.nextCursor), "Activity pagination repeated a cursor")
    seen.add(page.nextCursor)
    cursor = page.nextCursor
  }
  return entries
}

async function assertBindingError(action: () => Promise<unknown>, code: string) {
  try {
    await action()
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === code) return
    throw error
  }
  throw new Error(`Expected Session binding ${code}`)
}

async function assertCursorError(action: () => Promise<unknown>) {
  try {
    await action()
  } catch (error) {
    if (error instanceof Error && (error.name === "TaskActivityPageCursorError" ||
      ("code" in error && error.code === "cursor_invalid"))) return
    throw error
  }
  throw new Error("Cross-owner activity cursor was accepted")
}

function owner(ownerUserId: string): WorkGraphContext {
  return {
    organizationId: "organization" as WorkGraphContext["organizationId"],
    ownerUserId: ownerUserId as WorkGraphContext["ownerUserId"],
    actor: { type: "user", id: ownerUserId as WorkGraphContext["actor"]["id"] },
    requestId: `request_${ownerUserId}` as WorkGraphContext["requestId"],
    access: { mode: "owner" },
  }
}

function operation(value: string) {
  return value as OperationID
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

const resolvedExecution = {
  environment: { kind: "local_worktree" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: [],
  connectionIds: [],
}
