import type { OperationID, OwnerUserID, WorkGraphArchive, WorkGraphArchiveRestoreError, WorkGraphContext } from "../contracts"
import type { WorkGraphArchivePort } from "../ports"

const ARCHIVE_TEST_SECRET = "ghp_archive_conformance_secret"

export const WORKGRAPH_ARCHIVE_CONFORMANCE_VERSION = 1 as const

export const WORKGRAPH_ARCHIVE_CONFORMANCE_SCOPE = {
  covered: [
    "canonical_owner_scoped_export_restore_roundtrip",
    "cross_owner_restore_rejection",
    "non_empty_target_rejection",
    "exact_restore_idempotency",
    "conflicting_restore_operation_rejection",
    "malformed_and_secret_bearing_archive_rejection",
  ],
  remaining: [
    "workspace_cleanup_and_permanent_deletion",
  ],
} as const

export type ArchiveConformanceFactory = (input: Readonly<{
  clock: Readonly<{ now: () => number }>
  ids: Readonly<{ next: (kind: string) => string }>
  owners: Readonly<{ first: WorkGraphContext; second: WorkGraphContext }>
}>) => Promise<Readonly<{
  source: WorkGraphArchivePort
  emptyTarget: WorkGraphArchivePort
  nonEmptyTarget: WorkGraphArchivePort
}>>

export type WorkGraphArchiveConformanceCase = Readonly<{
  name: string
  run: () => Promise<void>
}>

/**
 * Returns runner-neutral conformance cases for a WorkGraph archive adapter.
 * A factory seeds source and non-empty target instances while every assertion
 * interacts with those instances only through the public archive port.
 */
export function workGraphArchiveConformance(factory: ArchiveConformanceFactory): readonly WorkGraphArchiveConformanceCase[] {
  return [
    testCase("round-trips every exported public record into an empty owner target", async () => {
      const fixture = await setup(factory)
      const archive = await fixture.source.export(fixture.owners.first)
      assert(archive.records.length > 0, "Archive conformance source must contain at least one public record")

      const result = await fixture.emptyTarget.restore(fixture.owners.first, {
        operationId: operation("restore_round_trip"),
        archive,
      })
      const restored = await fixture.emptyTarget.export(fixture.owners.first)

      assert(result.restored, "Archive restore did not report success")
      assert(result.recordCount === archive.records.length, "Archive restore reported the wrong record count")
      assert(typeof result.baselineCursor === "string" && result.baselineCursor.length > 0, "Archive restore omitted its baseline cursor")
      assert(restored.ownerUserId === archive.ownerUserId, "Archive restore changed owner authority")
      assert(restored.version === archive.version, "Archive restore changed archive format version")
      assertDeepEqual(restored.records, archive.records, "Archive restore did not preserve the exact public record set")
    }),
    testCase("rejects an archive exported for another owner without restoring records", async () => {
      const fixture = await setup(factory)
      const archive = await fixture.source.export(fixture.owners.first)
      const operationId = operation("restore_cross_owner")

      await assertArchiveError(
        () => fixture.emptyTarget.restore(fixture.owners.second, {
          operationId,
          archive,
        }),
        "cross_owner",
        fixture,
      )
      assert((await fixture.emptyTarget.export(fixture.owners.second)).records.length === 0, "Cross-owner rejection left restored records")
      const ownedArchive = await fixture.source.export(fixture.owners.second)
      assert(ownedArchive.records.length === 0, "Archive conformance source unexpectedly contains second-owner records")
      const retry = await fixture.emptyTarget.restore(fixture.owners.second, { operationId, archive: ownedArchive })
      assert(retry.restored && retry.recordCount === 0, "Cross-owner rejection reserved the restore operation")
    }),
    testCase("rejects restore into a non-empty owner target without changing it", async () => {
      const fixture = await setup(factory)
      const archive = await fixture.source.export(fixture.owners.first)
      const before = await fixture.nonEmptyTarget.export(fixture.owners.first)
      assert(before.records.length > 0, "Archive conformance non-empty target must contain at least one public record")

      await assertArchiveError(
        () => fixture.nonEmptyTarget.restore(fixture.owners.first, {
          operationId: operation("restore_non_empty"),
          archive,
        }),
        "non_empty",
        fixture,
      )
      assertDeepEqual((await fixture.nonEmptyTarget.export(fixture.owners.first)).records, before.records, "Non-empty rejection changed target records")
    }),
    testCase("replays the exact restore operation without duplicating records", async () => {
      const fixture = await setup(factory)
      const archive = await fixture.source.export(fixture.owners.first)
      const input = { operationId: operation("restore_exact_retry"), archive }
      const first = await fixture.emptyTarget.restore(fixture.owners.first, input)
      const retry = await fixture.emptyTarget.restore(fixture.owners.first, input)

      assertDeepEqual(retry, first, "Exact archive restore retry returned a different result")
      assertDeepEqual(
        (await fixture.emptyTarget.export(fixture.owners.first)).records,
        archive.records,
        "Exact archive restore retry duplicated or changed public records",
      )
    }),
    testCase("rejects conflicting archive reuse of a completed restore operation", async () => {
      const fixture = await setup(factory)
      const archive = await fixture.source.export(fixture.owners.first)
      const operationId = operation("restore_conflict")
      await fixture.emptyTarget.restore(fixture.owners.first, { operationId, archive })
      const before = await fixture.emptyTarget.export(fixture.owners.first)

      await assertArchiveError(
        () => fixture.emptyTarget.restore(fixture.owners.first, {
          operationId,
          archive: { ...archive, exportedAt: archive.exportedAt + 1 },
        }),
        "idempotency_conflict",
        fixture,
      )
      assertDeepEqual((await fixture.emptyTarget.export(fixture.owners.first)).records, before.records, "Conflicting restore reuse changed target records")
    }),
    testCase("rejects a malformed archive without recording the restore operation", async () => {
      const fixture = await setup(factory)
      const archive = await fixture.source.export(fixture.owners.first)
      const operationId = operation("restore_malformed")

      await assertArchiveError(
        () => fixture.emptyTarget.restore(fixture.owners.first, {
          operationId,
          archive: { ...archive, version: 2 } as unknown as WorkGraphArchive,
        }),
        "malformed",
        fixture,
      )
      const retry = await fixture.emptyTarget.restore(fixture.owners.first, { operationId, archive })
      assert(retry.restored && retry.recordCount === archive.records.length, "Malformed archive rejection reserved the restore operation")
    }),
    testCase("rejects a secret-bearing archive without recording the restore operation", async () => {
      const fixture = await setup(factory)
      const archive = await fixture.source.export(fixture.owners.first)
      const operationId = operation("restore_secret")
      assert(archive.records.length > 0, "Archive conformance source must contain at least one public record")

      await assertArchiveError(
        () => fixture.emptyTarget.restore(fixture.owners.first, {
          operationId,
          archive: secretBearing(archive),
        }),
        "malformed",
        fixture,
      )
      const retry = await fixture.emptyTarget.restore(fixture.owners.first, { operationId, archive })
      assert(retry.restored && retry.recordCount === archive.records.length, "Secret-bearing archive rejection reserved the restore operation")
    }),
  ]
}

function testCase(name: string, run: () => Promise<void>): WorkGraphArchiveConformanceCase {
  return { name, run }
}

async function setup(factory: ArchiveConformanceFactory) {
  let now = 10_000
  let id = 0
  const owners = { first: context("archive_owner_first"), second: context("archive_owner_second") }
  return {
    ...(await factory({ clock: { now: () => now++ }, ids: { next: (kind) => `${kind}_${++id}` }, owners })),
    owners,
  }
}

async function assertArchiveError(
  run: () => Promise<unknown>,
  reason: WorkGraphArchiveRestoreError["reason"],
  fixture: Awaited<ReturnType<typeof setup>>,
) {
  try {
    await run()
  } catch (error) {
    assert(isCanonicalWorkGraphArchiveRestoreError(error, reason), "Archive rejection did not use the canonical typed error")
    assert(
      !error.message.includes(fixture.owners.first.ownerUserId) && !error.message.includes(fixture.owners.second.ownerUserId),
      "Archive rejection revealed an owner identifier",
    )
    assert(!error.message.includes(ARCHIVE_TEST_SECRET), "Archive rejection revealed credential material")
    return
  }
  throw new Error(`Expected archive ${reason} rejection`)
}

/** Strict public-shape check that remains valid when package entrypoints bundle separate class identities. */
export function isCanonicalWorkGraphArchiveRestoreError(
  error: unknown,
  reason: WorkGraphArchiveRestoreError["reason"],
): error is Error & Readonly<{ name: "WorkGraphArchiveRestoreError"; code: "archive_restore_rejected"; reason: WorkGraphArchiveRestoreError["reason"] }> {
  return error instanceof Error && error.name === "WorkGraphArchiveRestoreError" &&
    "code" in error && error.code === "archive_restore_rejected" &&
    "reason" in error && error.reason === reason
}

function secretBearing(archive: WorkGraphArchive): WorkGraphArchive {
  return {
    ...archive,
    records: archive.records.map((record, index) => index === 0
      ? { ...record, value: { ...record.value, accessToken: ARCHIVE_TEST_SECRET } }
      : record),
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
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`)
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  )
}
