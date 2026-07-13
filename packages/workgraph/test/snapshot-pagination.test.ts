import { describe, expect, expectTypeOf, it } from "vitest"
import {
  SnapshotResumeCursorSchema,
  WorkGraphSnapshotAggregationError,
  WorkGraphSnapshotPageSchema,
  collectWorkGraphSnapshotPages,
  type ChangeCursor,
  type SnapshotResumeCursor,
} from "../src/contracts"

describe("WorkGraph snapshot pagination contract", () => {
  it("keeps snapshot resume cursors distinct from ordered change watermarks", () => {
    const page = snapshotPage([root("root")], "change_1", 1, "resume_1")
    expectTypeOf(page.snapshotCursor).toEqualTypeOf<ChangeCursor>()
    expectTypeOf(page.nextCursor).toEqualTypeOf<SnapshotResumeCursor | undefined>()
    expectTypeOf<SnapshotResumeCursor>().not.toEqualTypeOf<ChangeCursor>()
    expect(SnapshotResumeCursorSchema.parse("resume_1")).toBe("resume_1")
  })

  it.each([
    {
      name: "changed snapshot metadata",
      pages: [snapshotPage([root("one")], "change_1", 1, "resume_1"), snapshotPage([root("two")], "change_2", 1, undefined, 2)],
      reason: "metadata",
    },
    {
      name: "a duplicate record",
      pages: [snapshotPage([root("same")], "change_1", 1, "resume_1"), snapshotPage([root("same")], "change_1", 1, undefined, 2)],
      reason: "duplicate",
    },
    {
      name: "a non-contiguous ordered reference",
      pages: [snapshotPage([root("one")], "change_1", 1, "resume_1"), snapshotPage([root("two")], "change_1", 1, undefined, 3)],
      reason: "order",
    },
  ])("rejects $name without returning a mixed snapshot", async ({ pages, reason }) => {
    await expect(collectWorkGraphSnapshotPages({
      page: async () => pages.shift()!,
      isCursorInvalid: () => false,
    })).rejects.toMatchObject({
      name: "WorkGraphSnapshotAggregationError",
      code: "snapshot_invalid",
      reason,
    } satisfies Partial<WorkGraphSnapshotAggregationError>)
  })
})

function root(id: string) {
  return {
    recordType: "workgraph" as const,
    schemaVersion: 1 as const,
    ownerUserId: "owner",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    provenance: { actor: { type: "system" as const, id: "test" } },
    id,
    defaults: { execution: {}, recap: {} },
  }
}

function snapshotPage(
  records: ReturnType<typeof root>[],
  snapshotCursor: string,
  capturedAt: number,
  nextCursor?: string,
  sequenceStart = 1,
) {
  return WorkGraphSnapshotPageSchema.parse({
    snapshotCursor,
    records,
    references: records.map((record, index) => ({
      sequence: sequenceStart + index,
      resource: { type: "workgraph", id: record.id },
      version: record.version,
    })),
    hasMore: !!nextCursor,
    ...(nextCursor ? { nextCursor } : {}),
    capturedAt,
  })
}
