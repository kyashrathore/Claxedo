import type { WorkGraphService } from "../application"
import { SnapshotResumeCursorError } from "../contracts"
import type {
  OperationID,
  OwnerUserID,
  SnapshotResumeCursor,
  WorkGraphContext,
  WorkGraphSnapshotPage,
} from "../contracts"
import type { WorkGraphCommandHandlers } from "../ports"

export const WORKGRAPH_SNAPSHOT_RESTART_CONFORMANCE_VERSION = 1 as const

export type SnapshotRestartConformanceFactory = (input: Readonly<{
  clock: Readonly<{ now: () => number }>
  ids: Readonly<{ next: (kind: string) => string }>
  owners: Readonly<{ first: WorkGraphContext; second: WorkGraphContext }>
}>) => Promise<Readonly<{
  service: SnapshotRestartService
  /** Reconstructs the adapter over the same unchanged durable storage. */
  restart: () => Promise<Readonly<{ service: SnapshotRestartService }>>
}>>

type SnapshotRestartService = WorkGraphService<
  Pick<WorkGraphCommandHandlers, "create_stream">,
  Readonly<{
    snapshot: Readonly<{
      page: (
        context: WorkGraphContext,
        input: Readonly<{ after?: SnapshotResumeCursor; limit: number }>,
      ) => Promise<WorkGraphSnapshotPage>
    }>
  }>
>

/**
 * Proves that a portable snapshot resume cursor survives adapter/process
 * reconstruction while retaining strict owner and mutation invalidation.
 */
export function workGraphSnapshotRestartConformance(
  factory: SnapshotRestartConformanceFactory,
): readonly Readonly<{ name: string; run: () => Promise<void> }>[] {
  return [
    {
      name: "resumes a partial snapshot after adapter reconstruction over unchanged durable storage",
      run: async () => {
        const fixture = await setup(factory)
        await createStream(fixture.service, fixture.owners.first, "operation_1", "First")
        await createStream(fixture.service, fixture.owners.first, "operation_2", "Second")
        await createStream(fixture.service, fixture.owners.first, "operation_3", "Third")
        await createStream(fixture.service, fixture.owners.second, "operation_1", "Other owner")

        const expected = await fixture.service.query(fixture.owners.first, "snapshot", "page", { limit: 100 })
        const first = await fixture.service.query(fixture.owners.first, "snapshot", "page", { limit: 2 })
        assert(first.hasMore && first.nextCursor, "Snapshot fixture did not produce a partial page")

        const restarted = await fixture.restart()
        await assertCursorError(
          () => restarted.service.query(fixture.owners.second, "snapshot", "page", { after: first.nextCursor!, limit: 2 }),
          "owner_mismatch",
        )

        const resumed = await remainingPages(restarted.service, fixture.owners.first, first.nextCursor, 2)
        const pages = [first, ...resumed]
        assert(
          pages.every((page) => page.snapshotCursor === first.snapshotCursor && page.capturedAt === first.capturedAt),
          "Restarted snapshot changed its captured metadata",
        )
        assertDeepEqual(
          pages.flatMap((page) => page.records.map((record) => `${record.recordType}:${record.id}`)),
          expected.records.map((record) => `${record.recordType}:${record.id}`),
          "Restarted snapshot resume returned missing, duplicate, or reordered records",
        )
        assertDeepEqual(
          pages.flatMap((page) => page.references.map((reference) => reference.sequence)),
          expected.references.map((reference) => reference.sequence),
          "Restarted snapshot resume changed global reference ordering",
        )

        await createStream(restarted.service, fixture.owners.first, "operation_4", "Mutation after restart")
        await assertCursorError(
          () => restarted.service.query(fixture.owners.first, "snapshot", "page", { after: first.nextCursor!, limit: 2 }),
          "invalidated",
        )
      },
    },
  ]
}

async function remainingPages(
  service: SnapshotRestartService,
  owner: WorkGraphContext,
  firstCursor: SnapshotResumeCursor,
  limit: number,
) {
  const pages: WorkGraphSnapshotPage[] = []
  const cursors = new Set<string>()
  let after: SnapshotResumeCursor | undefined = firstCursor
  for (;;) {
    assert(pages.length < 100, "Restarted snapshot pagination did not terminate")
    const page: WorkGraphSnapshotPage = await service.query(owner, "snapshot", "page", { after, limit })
    pages.push(page)
    if (!page.hasMore) {
      assert(page.nextCursor === undefined, "Terminal restarted snapshot page exposed a resume cursor")
      return pages
    }
    assert(page.nextCursor && page.records.length > 0, "Restarted snapshot page omitted progress metadata")
    assert(!cursors.has(page.nextCursor), "Restarted snapshot repeated a resume cursor")
    cursors.add(page.nextCursor)
    after = page.nextCursor
  }
}

async function assertCursorError(
  run: () => Promise<unknown>,
  reason: SnapshotResumeCursorError["reason"],
) {
  try {
    await run()
  } catch (error) {
    assert(isCanonicalSnapshotResumeCursorError(error), "Restarted snapshot did not use the canonical cursor error")
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

async function createStream(
  service: SnapshotRestartService,
  owner: WorkGraphContext,
  operationId: string,
  title: string,
) {
  const result = await service.execute(owner, {
    operationId: operationId as OperationID,
    command: { version: 1, type: "create_stream", title },
  })
  assert(result.ok, `Could not create snapshot restart fixture Stream: ${operationId}`)
}

async function setup(factory: SnapshotRestartConformanceFactory) {
  let now = 1_000
  let id = 0
  const owners = {
    first: context("owner_first"),
    second: context("owner_second"),
  }
  return {
    ...(await factory({
      clock: { now: () => now++ },
      ids: { next: (kind) => `${kind}_${++id}` },
      owners,
    })),
    owners,
  }
}

function context(ownerUserId: string): WorkGraphContext {
  return {
    organizationId: "organization" as WorkGraphContext["organizationId"],
    ownerUserId: ownerUserId as OwnerUserID,
    actor: { type: "user", id: ownerUserId as never },
    requestId: `request_${ownerUserId}` as never,
    access: { mode: "owner" },
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message)
}
