import { afterEach, describe, expect, test, vi } from "vitest"
import {
  workGraphOwnerDeletionConformance,
  type OwnerDeletionCleanupObservation,
} from "@claxedo/workgraph/conformance"
import type { OperationID, WorkGraphContext } from "@claxedo/workgraph/contracts"
import type { WorkGraphOwnerDeletionResult } from "@claxedo/workgraph/ports"
import {
  finalizeWorkGraphOwnerDeletion,
  prepareWorkGraphOwnerDeletion,
  releaseWorkGraphOwnerDeletion,
  renewWorkGraphOwnerDeletion,
  WORKGRAPH_OWNER_TABLES,
} from "../../../../convex/workgraphOwnerDeletion"
import { applyWorkGraphCommand } from "../../../../convex/workgraphCommands"
import { readWorkGraphProjection as readTenantWorkGraphProjection } from "../../../../convex/workgraphChanges"
import { createConvexWorkGraphOwnerDeletionPort } from "./convex-owner-deletion"

afterEach(() => vi.useRealTimers())

describe("Convex WorkGraph owner deletion conformance", () => {
  workGraphOwnerDeletionConformance(async (input) => {
    const harness = new DeletionHarness()
    await seedOwner(harness, input.owners.first, [
      { streamId: "first_stream", envelopeId: "envelope_first", childIsolationId: "child_first" },
      { streamId: "second_stream", envelopeId: "envelope_second", childIsolationId: "child_second" },
    ])
    await seedOwner(harness, input.owners.second, [
      { streamId: "other_stream", envelopeId: "envelope_other", childIsolationId: "child_other" },
    ])

    const observations: OwnerDeletionCleanupObservation[] = []
    let failingEnvelope: string | undefined
    let cleanupRace: Readonly<{ started: () => void; finish: Promise<void> }> | undefined
    const deletion = createConvexWorkGraphOwnerDeletionPort({
      serviceToken: "service-secret",
      clock: input.clock,
      executor: executor(harness),
      execution: {
        cleanup: async (context, cleanup) => {
          observations.push({
            ownerUserId: context.ownerUserId,
            streamId: cleanup.streamId,
            envelopeId: cleanup.envelopeId,
            childIsolationIds: cleanup.childIsolationIds ?? [],
            ownerRecordCountAtCleanup: countOwnerRecords(harness, context),
          })
          if (cleanupRace) {
            const race = cleanupRace
            cleanupRace = undefined
            race.started()
            await race.finish
          }
          if (cleanup.envelopeId === failingEnvelope) throw new Error("owner_deletion_cleanup_secret")
        },
      },
    })

    return {
      deletion,
      expectedCleanup: [
        { streamId: "first_stream", envelopeId: "envelope_first", childIsolationIds: ["child_first"] },
        { streamId: "second_stream", envelopeId: "envelope_second", childIsolationIds: ["child_second"] },
      ],
      ownerRecordCount: async (context) => countOwnerRecords(harness, context),
      cleanupObservations: () => observations,
      setCleanupFailure: (envelopeId) => { failingEnvelope = envelopeId },
      setExecutionBusy: async (context, busy) => {
        const existing = harness.rowsFor("workgraph_leases").find((row) =>
          row.owner_user_id === context.ownerUserId && row.id === "owner_delete_busy")
        if (!busy) {
          if (existing) await harness.delete(existing._id)
          return
        }
        await harness.insert("workgraph_leases", ownerRow(context, { id: "owner_delete_busy" }))
      },
      raceOwnerWriteDuringCleanup: async (
        context: WorkGraphContext,
        startDeletion: () => Promise<WorkGraphOwnerDeletionResult>,
      ) => {
        let cleanupStarted!: () => void
        let finishCleanup!: () => void
        const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
        const finish = new Promise<void>((resolve) => { finishCleanup = resolve })
        cleanupRace = { started: cleanupStarted, finish }
        const deleting = startDeletion()
        await started
        const write = await applyWorkGraphCommand(harness, {
          organizationId: String(context.organizationId),
          ownerUserId: context.ownerUserId,
          ownerSubject: String(context.ownerUserId),
          actor: context.actor,
          requestId: "request_conformance_raced_command",
          operationId: "operation_conformance_raced_command",
          command: { version: 1, type: "create_stream", title: "Concurrent owner write" },
        })
        finishCleanup()
        return { deletionResult: await deleting, writeCommitted: write.ok }
      },
    }
  }).forEach((testCase) => test(testCase.name, testCase.run))

  test("retains only hashed completed receipt identity", async () => {
    const harness = new DeletionHarness()
    const context = owner("private_owner_identifier")
    await seedOwner(harness, context, [])
    const operationId = "private_operation_identifier" as OperationID
    const deletion = createConvexWorkGraphOwnerDeletionPort({
      serviceToken: "service-secret",
      executor: executor(harness),
      execution: { cleanup: async () => undefined },
      clock: { now: () => 50 },
    })

    await deletion.deleteOwner(context, { operationId })

    const receipt = harness.rowsFor("workgraph_owner_deletion_receipts")[0]
    expect(receipt).toMatchObject({ state: "completed", result: { deleted: true } })
    expect(JSON.stringify(receipt)).not.toContain(context.ownerUserId)
    expect(JSON.stringify(receipt)).not.toContain(operationId)
  })

  test("preserves organization-owned Connection metadata when a member deletes personal WorkGraph data", async () => {
    const harness = new DeletionHarness()
    const context = owner("connection_member")
    await seedOwner(harness, context, [])
    await harness.insert("workgraph_connection_metadata", {
      organization_id: context.organizationId,
      connection_id: "team_connection",
      integration_id: "github",
      capabilities: ["work-source"],
      status: "connected",
      row_version: 1,
      schema_version: 1,
      created_at: 1,
      updated_at: 1,
    })
    const deletion = createConvexWorkGraphOwnerDeletionPort({
      serviceToken: "service-secret",
      executor: executor(harness),
      execution: { cleanup: async () => undefined },
      clock: { now: () => 50 },
    })

    await deletion.deleteOwner(context, { operationId: "delete_member_workgraph" as OperationID })

    expect(harness.rowsFor("workgraph_connection_metadata")).toEqual([
      expect.objectContaining({ organization_id: context.organizationId, connection_id: "team_connection" }),
    ])
  })

  test("fences a normal owner command throughout external workspace cleanup", async () => {
    const harness = new DeletionHarness()
    const context = owner("owner_command_race")
    await seedOwner(harness, context, [
      { streamId: "existing_stream", envelopeId: "existing_envelope", childIsolationId: "existing_child" },
    ])
    let cleanupStarted!: () => void
    let finishCleanup!: () => void
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    const finishing = new Promise<void>((resolve) => { finishCleanup = resolve })
    const deletion = createConvexWorkGraphOwnerDeletionPort({
      serviceToken: "service-secret",
      executor: executor(harness),
      clock: { now: () => 100 },
      execution: {
        cleanup: async () => {
          cleanupStarted()
          await finishing
        },
      },
    })

    const deleting = deletion.deleteOwner(context, { operationId: "owner_delete_race" as OperationID })
    await started
    const raced = await applyWorkGraphCommand(harness, {
      organizationId: String(context.organizationId),
      ownerUserId: context.ownerUserId,
      ownerSubject: String(context.ownerUserId),
      actor: context.actor,
      requestId: "request_raced_command",
      operationId: "operation_raced_command",
      command: { version: 1, type: "create_stream", title: "Must not disappear" },
    })
    expect(raced).toMatchObject({ ok: false, error: { code: "blocked" } })
    expect(harness.rowsFor("workgraph_streams").some((row) => row.title === "Must not disappear")).toBe(false)

    finishCleanup()
    await deleting
  })

  test("renews the deletion barrier throughout long external workspace cleanup", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const harness = new DeletionHarness()
    const context = owner("owner_long_cleanup")
    await seedOwner(harness, context, [
      { streamId: "long_stream", envelopeId: "long_envelope", childIsolationId: "long_child" },
    ])
    let cleanupStarted!: () => void
    let finishCleanup!: () => void
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    const finishing = new Promise<void>((resolve) => { finishCleanup = resolve })
    const deletion = createConvexWorkGraphOwnerDeletionPort({
      serviceToken: "service-secret",
      executor: executor(harness),
      execution: {
        cleanup: async () => {
          cleanupStarted()
          await finishing
        },
      },
    })
    const deleting = deletion.deleteOwner(context, { operationId: "owner_delete_long_cleanup" as OperationID })
    await started

    await Array.from({ length: 7 }, (_, index) => index).reduce(
      (advance) =>
        advance.then(async () => {
          await vi.advanceTimersByTimeAsync(60 * 1_000)
        }),
      Promise.resolve(),
    )

    expect(harness.rowsFor("workgraph_owner_deletion_barriers")[0]?.lease_expires_at).toBeGreaterThan(Date.now())
    expect(harness.rowsFor("workgraph_owner_deletion_receipts")[0]?.lease_expires_at).toBeGreaterThan(Date.now())
    finishCleanup()
    await deleting
  })

  test("keeps partial bounded purges unreadable and replays the completed result without cleaning twice", async () => {
    const harness = new DeletionHarness()
    const context = owner("owner_bounded_purge")
    await seedOwner(harness, context, [
      { streamId: "stream_bounded", envelopeId: "envelope_bounded", childIsolationId: "child_bounded" },
    ])
    for (let index = 0; index < 20; index++) {
      await harness.insert("workgraph_operation_results", ownerRow(context, { id: `operation_${index}` }))
    }
    const before = countOwnerRecords(harness, context)
    let batchCommitted!: () => void
    let resumePurge!: () => void
    const committed = new Promise<void>((resolve) => { batchCommitted = resolve })
    const resume = new Promise<void>((resolve) => { resumePurge = resolve })
    const direct = executor(harness)
    let paused = false
    const cleanup: string[] = []
    const deletion = createConvexWorkGraphOwnerDeletionPort({
      serviceToken: "service-secret",
      clock: { now: (() => { let now = 200; return () => now++ })() },
      executor: {
        query: direct.query,
        mutation: async (fn, args) => {
          const result = await direct.mutation(fn, args)
          if (!paused && "target_snapshot_hash" in args && result && typeof result === "object" &&
            "state" in result && result.state === "deleting") {
            paused = true
            batchCommitted()
            await resume
          }
          return result
        },
      },
      execution: {
        cleanup: async (_owner, input) => { cleanup.push(String(input.envelopeId)) },
      },
    })
    const request = { operationId: "owner_delete_bounded" as OperationID }
    const deleting = deletion.deleteOwner(context, request)

    await committed
    expect(countOwnerRecords(harness, context)).toBeGreaterThan(0)
    expect(countOwnerRecords(harness, context)).toBeLessThan(before)
    await expect(readTenantWorkGraphProjection(harness, String(context.organizationId), context.ownerUserId, "defaults", {}))
      .rejects.toThrow("owner deletion is in progress")

    resumePurge()
    const result = await deleting
    expect(result.recordCount).toBe(before)
    expect(countOwnerRecords(harness, context)).toBe(0)
    expect(cleanup).toEqual(["envelope_bounded"])
    await expect(deletion.deleteOwner(context, request)).resolves.toEqual(result)
    expect(cleanup).toEqual(["envelope_bounded"])
  })
})

async function seedOwner(
  harness: DeletionHarness,
  context: WorkGraphContext,
  streams: Array<{ streamId: string; envelopeId: string; childIsolationId: string }>,
) {
  await harness.insert("workgraphs", ownerRow(context, { id: "workgraph_default" }))
  for (const stream of streams) {
    await harness.insert("workgraph_streams", ownerRow(context, {
      id: stream.streamId,
      envelope: { kind: "hosted_workspace", workspaceId: stream.envelopeId, status: "ready" },
    }))
    await harness.insert("workgraph_attempts", ownerRow(context, {
      id: `attempt_${stream.streamId}`,
      stream_id: stream.streamId,
      state: "result",
      envelope_id: stream.envelopeId,
      child_workspace_id: stream.childIsolationId,
    }))
  }
  await harness.insert("workgraph_outbox", ownerRow(context, { id: "completed_outbox", status: "completed" }))
  await harness.insert("workgraph_due_jobs", ownerRow(context, { id: "completed_job", status: "completed" }))
}

function executor(harness: DeletionHarness) {
  return {
    query: async () => undefined,
    mutation: async (_function: unknown, args: Record<string, unknown>) => {
      const owner = String(args.owner_subject)
      const organization = String(args.organization_id)
      if ("renew_only" in args) {
        return renewWorkGraphOwnerDeletion(
          harness,
          organization,
          owner,
          String(args.operation_id),
          String(args.target_snapshot_hash),
          Number(args.now),
        )
      }
      if ("target_snapshot_hash" in args) {
        return finalizeWorkGraphOwnerDeletion(
          harness,
          organization,
          owner,
          String(args.operation_id),
          String(args.target_snapshot_hash),
          Number(args.now),
        )
      }
      if ("now" in args) {
        return prepareWorkGraphOwnerDeletion(harness, organization, owner, String(args.operation_id), Number(args.now))
      }
      return releaseWorkGraphOwnerDeletion(harness, organization, owner, String(args.operation_id))
    },
  }
}

function countOwnerRecords(harness: DeletionHarness, context: WorkGraphContext) {
  return WORKGRAPH_OWNER_TABLES.reduce(
    (total, table) => total + harness.rowsFor(table).filter((row) => row.owner_user_id === context.ownerUserId).length,
    0,
  )
}

function owner(value: string): WorkGraphContext {
  return {
    organizationId: `org_${value}` as never,
    ownerUserId: value as never,
    actor: { type: "user", id: value as never },
    requestId: `request_${value}` as never,
    access: { mode: "owner" },
  }
}

function ownerRow(context: WorkGraphContext, value: Record<string, unknown>) {
  return { organization_id: context.organizationId, owner_user_id: context.ownerUserId, ...value }
}

class DeletionHarness {
  private rows = new Map<string, Record<string, any>[]>()
  private next = 0
  readonly db = this

  rowsFor(table: string) {
    return this.rows.get(table) ?? []
  }

  query(table: string) {
    let selected = [...this.rowsFor(table)]
    const chain = {
      withIndex: (_index: string, build: (query: any) => unknown) => {
        const filters: Array<[string, unknown]> = []
        const query = {
          eq: (field: string, expected: unknown) => {
            filters.push([field, expected])
            return query
          },
        }
        build(query)
        selected = selected.filter((row) => filters.every(([field, expected]) => row[field] === expected))
        return chain
      },
      filter: (build: (query: any) => (row: Record<string, unknown>) => boolean) => {
        const query = {
          field: (field: string) => field,
          eq: (field: string, expected: unknown) => (row: Record<string, unknown>) => row[field] === expected,
          and: (...predicates: Array<(row: Record<string, unknown>) => boolean>) =>
            (row: Record<string, unknown>) => predicates.every((predicate) => predicate(row)),
        }
        selected = selected.filter(build(query))
        return chain
      },
      unique: async () => selected[0] ?? null,
      collect: async () => selected,
      take: async (limit: number) => selected.slice(0, limit),
      first: async () => selected[0] ?? null,
    }
    return chain
  }

  async insert(table: string, value: Record<string, unknown>) {
    const row = { _id: `${table}:${++this.next}`, ...value }
    this.rows.set(table, [...this.rowsFor(table), row])
    return row._id
  }

  async patch(id: string, value: Record<string, unknown>) {
    const row = [...this.rows.values()].flat().find((candidate) => candidate._id === id)
    if (!row) throw new Error(`Missing row ${id}`)
    Object.assign(row, value)
  }

  async delete(id: string) {
    for (const [table, rows] of this.rows) this.rows.set(table, rows.filter((row) => row._id !== id))
  }
}
