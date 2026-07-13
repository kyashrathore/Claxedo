import type { OperationID, OwnerUserID, WorkGraphContext } from "../contracts"
import {
  WorkGraphOwnerDeletionError,
  type WorkGraphOwnerDeletionPort,
  type WorkGraphOwnerDeletionResult,
} from "../ports"

const CLEANUP_FAILURE_SECRET = "owner_deletion_cleanup_secret"

export const WORKGRAPH_OWNER_DELETION_CONFORMANCE_VERSION = 1 as const

export type OwnerDeletionCleanupObservation = Readonly<{
  ownerUserId: string
  streamId: string
  envelopeId: string
  childIsolationIds: readonly string[]
  ownerRecordCountAtCleanup: number
}>

export type OwnerDeletionConformanceFactory = (input: Readonly<{
  clock: Readonly<{ now: () => number }>
  ids: Readonly<{ next: (kind: string) => string }>
  owners: Readonly<{ first: WorkGraphContext; second: WorkGraphContext }>
}>) => Promise<Readonly<{
  deletion: WorkGraphOwnerDeletionPort
  expectedCleanup: readonly Readonly<{
    streamId: string
    envelopeId: string
    childIsolationIds: readonly string[]
  }>[]
  ownerRecordCount: (context: WorkGraphContext) => Promise<number>
  cleanupObservations: () => readonly OwnerDeletionCleanupObservation[]
  setCleanupFailure: (envelopeId: string | undefined) => void
  setExecutionBusy: (context: WorkGraphContext, busy: boolean) => Promise<void>
  raceOwnerWriteDuringCleanup: (
    context: WorkGraphContext,
    startDeletion: () => Promise<WorkGraphOwnerDeletionResult>,
  ) => Promise<Readonly<{ deletionResult: WorkGraphOwnerDeletionResult; writeCommitted: boolean }>>
}>>

export type WorkGraphOwnerDeletionConformanceCase = Readonly<{
  name: string
  run: () => Promise<void>
}>

/** Runner-neutral permanent-deletion contract for local and hosted adapters. */
export function workGraphOwnerDeletionConformance(
  factory: OwnerDeletionConformanceFactory,
): readonly WorkGraphOwnerDeletionConformanceCase[] {
  return [
    testCase("cleans every live Stream workspace before atomically deleting all owner state", async () => {
      const fixture = await setup(factory)
      const before = await fixture.ownerRecordCount(fixture.owners.first)
      assert(before > 0, "Owner deletion conformance source must contain persistent state")

      const result = await fixture.deletion.deleteOwner(fixture.owners.first, {
        operationId: operation("owner_delete_all"),
      })
      const observations = fixture.cleanupObservations()

      assert(result.deleted, "Owner deletion did not report the achieved state")
      assert(result.recordCount === before, "Owner deletion reported the wrong persistent record count")
      assert(result.workspaceCount === fixture.expectedCleanup.length, "Owner deletion reported the wrong workspace count")
      assert(await fixture.ownerRecordCount(fixture.owners.first) === 0, "Owner deletion left persistent owner rows")
      assert(observations.length === fixture.expectedCleanup.length, "Owner deletion did not clean every workspace exactly once")
      assertDeepEqual(
        observations.map(cleanupIdentity),
        fixture.expectedCleanup.map(canonicalCleanupIdentity),
        "Owner deletion cleaned the wrong workspace set",
      )
      assert(observations.every((entry) => entry.ownerRecordCountAtCleanup === before), "Persistent deletion ran before all cleanup calls")
    }),
    testCase("returns the exact completed result without repeating workspace cleanup", async () => {
      const fixture = await setup(factory)
      const input = { operationId: operation("owner_delete_retry") }
      const first = await fixture.deletion.deleteOwner(fixture.owners.first, input)
      const cleanupCount = fixture.cleanupObservations().length
      const retry = await fixture.deletion.deleteOwner(fixture.owners.first, input)

      assertDeepEqual(retry, first, "Exact owner deletion retry returned a different result")
      assert(fixture.cleanupObservations().length === cleanupCount, "Exact owner deletion retry repeated cleanup")
      assert(await fixture.ownerRecordCount(fixture.owners.first) === 0, "Exact owner deletion retry recreated owner state")
    }),
    testCase("rejects an owner write racing external cleanup so no successful write disappears", async () => {
      const fixture = await setup(factory)
      const raced = await fixture.raceOwnerWriteDuringCleanup(
        fixture.owners.first,
        () => fixture.deletion.deleteOwner(fixture.owners.first, {
          operationId: operation("owner_delete_write_race"),
        }),
      )

      assert(!raced.writeCommitted, "Owner deletion allowed a concurrent write that was later deleted")
      assert(raced.deletionResult.deleted, "Owner deletion did not complete after rejecting the concurrent write")
      assert(await fixture.ownerRecordCount(fixture.owners.first) === 0, "Owner write race left partial owner state")
    }),
    testCase("rejects non-quiescent execution without cleanup, deletion, or operation reservation", async () => {
      const fixture = await setup(factory)
      const before = await fixture.ownerRecordCount(fixture.owners.first)
      const input = { operationId: operation("owner_delete_busy") }
      await fixture.setExecutionBusy(fixture.owners.first, true)

      await assertDeletionError(() => fixture.deletion.deleteOwner(fixture.owners.first, input), "not_quiescent", fixture)
      assert(fixture.cleanupObservations().length === 0, "Non-quiescent rejection started workspace cleanup")
      assert(await fixture.ownerRecordCount(fixture.owners.first) === before + 1, "Non-quiescent rejection changed owner state")

      await fixture.setExecutionBusy(fixture.owners.first, false)
      await fixture.deletion.deleteOwner(fixture.owners.first, input)
      assert(await fixture.ownerRecordCount(fixture.owners.first) === 0, "Non-quiescent rejection reserved the deletion operation")
    }),
    testCase("preserves every owner row when workspace cleanup fails and permits a strict retry", async () => {
      const fixture = await setup(factory)
      const before = await fixture.ownerRecordCount(fixture.owners.first)
      const input = { operationId: operation("owner_delete_cleanup_failure") }
      fixture.setCleanupFailure(fixture.expectedCleanup.at(-1)?.envelopeId)

      await assertDeletionError(() => fixture.deletion.deleteOwner(fixture.owners.first, input), "cleanup_failed", fixture)
      assert(await fixture.ownerRecordCount(fixture.owners.first) === before, "Cleanup failure partially deleted persistent owner state")

      fixture.setCleanupFailure(undefined)
      await fixture.deletion.deleteOwner(fixture.owners.first, input)
      assert(await fixture.ownerRecordCount(fixture.owners.first) === 0, "Cleanup failure reserved the deletion operation")
    }),
    testCase("never reads, cleans, or deletes another owner's WorkGraph", async () => {
      const fixture = await setup(factory)
      const secondBefore = await fixture.ownerRecordCount(fixture.owners.second)
      await fixture.deletion.deleteOwner(fixture.owners.first, { operationId: operation("owner_delete_isolation") })

      assert(secondBefore > 0, "Cross-owner conformance source must contain second-owner state")
      assert(await fixture.ownerRecordCount(fixture.owners.second) === secondBefore, "Owner deletion changed another owner's rows")
      assert(
        fixture.cleanupObservations().every((entry) => entry.ownerUserId === fixture.owners.first.ownerUserId),
        "Owner deletion cleaned another owner's workspace",
      )
    }),
    testCase("requires trusted owner access", async () => {
      const fixture = await setup(factory)
      const before = await fixture.ownerRecordCount(fixture.owners.first)
      const observer = { ...fixture.owners.first, access: { mode: "shared_read" as const } }

      await assertDeletionError(
        () => fixture.deletion.deleteOwner(observer, { operationId: operation("owner_delete_forbidden") }),
        "forbidden",
        fixture,
      )
      assert(await fixture.ownerRecordCount(fixture.owners.first) === before, "Forbidden deletion changed owner state")
      assert(fixture.cleanupObservations().length === 0, "Forbidden deletion started cleanup")
    }),
  ]
}

function testCase(name: string, run: () => Promise<void>): WorkGraphOwnerDeletionConformanceCase {
  return { name, run }
}

async function setup(factory: OwnerDeletionConformanceFactory) {
  let now = 20_000
  let id = 0
  const owners = { first: context("deletion_owner_first"), second: context("deletion_owner_second") }
  return {
    ...(await factory({ clock: { now: () => now++ }, ids: { next: (kind) => `${kind}_${++id}` }, owners })),
    owners,
  }
}

async function assertDeletionError(
  run: () => Promise<unknown>,
  reason: WorkGraphOwnerDeletionError["reason"],
  fixture: Awaited<ReturnType<typeof setup>>,
) {
  try {
    await run()
  } catch (error) {
    assert(error instanceof WorkGraphOwnerDeletionError, "Owner deletion rejection did not use the canonical typed error")
    assert(error.reason === reason, `Expected owner deletion ${reason}, received ${error.reason}`)
    assert(
      !error.message.includes(fixture.owners.first.ownerUserId) && !error.message.includes(fixture.owners.second.ownerUserId),
      "Owner deletion rejection revealed an owner identifier",
    )
    assert(!error.message.includes(CLEANUP_FAILURE_SECRET), "Owner deletion rejection revealed cleanup failure details")
    return
  }
  throw new Error(`Expected owner deletion ${reason} rejection`)
}

function cleanupIdentity(value: OwnerDeletionCleanupObservation) {
  return canonicalCleanupIdentity(value)
}

function canonicalCleanupIdentity(value: Readonly<{ streamId: string; envelopeId: string; childIsolationIds: readonly string[] }>) {
  return {
    streamId: value.streamId,
    envelopeId: value.envelopeId,
    childIsolationIds: [...value.childIsolationIds].sort(),
  }
}

function context(ownerUserId: string): WorkGraphContext {
  return {
    ownerUserId: branded<OwnerUserID>(ownerUserId),
    actor: { type: "user", id: branded(ownerUserId) },
    requestId: branded(`request_${ownerUserId}`),
    access: { mode: "owner" },
  }
}

function operation(value: string) {
  return branded<OperationID>(value)
}

function branded<Type>(value: string) {
  return value as Type
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`)
  }
}
