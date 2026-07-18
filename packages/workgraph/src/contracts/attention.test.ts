import { describe, expect, it } from "vitest"
import {
  AttentionCursorError,
  AttentionAcknowledgementSchema,
  AttentionItemSchema,
  AttentionPageSchema,
  compareAttentionPosition,
  createAttentionCursor,
  readAttentionCursor,
} from "./attention"

describe("Attention contracts", () => {
  it("round-trips an owner-bound deterministic cursor", () => {
    const position = { updatedAt: 30, kind: "decision" as const, id: "decision:one" }
    const cursor = createAttentionCursor("organization one", "owner one", position)
    expect(readAttentionCursor(cursor, "organization one", "owner one")).toEqual(position)
    expect(() => readAttentionCursor(cursor, "organization two", "owner one")).toThrow(AttentionCursorError)
    expect(() => readAttentionCursor(cursor, "organization one", "owner two")).toThrow(AttentionCursorError)
    expect(() => readAttentionCursor("broken", "organization one", "owner one")).toThrow(AttentionCursorError)
    expect(() =>
      readAttentionCursor(cursor.replace(":decision:", ":unknown:"), "organization one", "owner one"),
    ).toThrow(AttentionCursorError)
  })

  it("orders newest items first with stable kind and id tie-breakers", () => {
    expect(
      [
        { updatedAt: 10, kind: "decision" as const, id: "b" },
        { updatedAt: 20, kind: "work_item" as const, id: "z" },
        { updatedAt: 10, kind: "decision" as const, id: "a" },
        { updatedAt: 10, kind: "attempt" as const, id: "c" },
      ].sort(compareAttentionPosition),
    ).toEqual([
      { updatedAt: 20, kind: "work_item", id: "z" },
      { updatedAt: 10, kind: "attempt", id: "c" },
      { updatedAt: 10, kind: "decision", id: "a" },
      { updatedAt: 10, kind: "decision", id: "b" },
    ])
  })

  it("keeps aggregated AI work and configuration requirements strict", () => {
    expect(
      AttentionItemSchema.parse({
        id: "unorganized_ai_work",
        ownerUserId: "owner_1",
        kind: "unorganized_ai_work",
        updatedAt: 5,
        counts: { externalIssues: 2, sessions: 3, total: 5 },
      }),
    ).toMatchObject({ kind: "unorganized_ai_work", counts: { total: 5 } })
    expect(() =>
      AttentionItemSchema.parse({
        id: "unorganized_ai_work",
        ownerUserId: "owner_1",
        kind: "unorganized_ai_work",
        updatedAt: 5,
        counts: { externalIssues: 2, sessions: 3, total: 4 },
      }),
    ).toThrow()
    expect(
      AttentionItemSchema.parse({
        id: "connection_1",
        ownerUserId: "owner_1",
        kind: "configuration_required",
        updatedAt: 6,
        requirement: { type: "connection", connectionId: "connection_1", integrationId: "github", status: "broken" },
      }),
    ).toMatchObject({ kind: "configuration_required" })
    expect(() =>
      AttentionItemSchema.parse({
        id: "wrong_job",
        ownerUserId: "owner_1",
        kind: "configuration_required",
        updatedAt: 7,
        requirement: {
          type: "generation",
          jobId: "source_job_1",
          purpose: "source_planning",
          scope: { type: "workgraph" },
          reason: "Source planning requires explicit valid agent configuration",
        },
      }),
    ).toThrow()
  })

  it("accepts only a read watermark at or after the current Attention update", () => {
    const item = {
      id: "unorganized_ai_work",
      ownerUserId: "owner_1",
      kind: "unorganized_ai_work" as const,
      updatedAt: 5,
      counts: { externalIssues: 2, sessions: 3, total: 5 },
    }
    expect(AttentionItemSchema.parse({ ...item, readAt: 5 })).toMatchObject({ readAt: 5 })
    expect(() => AttentionItemSchema.parse({ ...item, readAt: 4 })).toThrow()
    expect(AttentionAcknowledgementSchema.parse({ ownerUserId: "owner_1", readAt: 10, clearedAt: 5 }))
      .toMatchObject({ readAt: 10, clearedAt: 5 })
    expect(() => AttentionAcknowledgementSchema.parse({ ownerUserId: "owner_1", readAt: 10, clearedAt: 11 })).toThrow()
  })

  it("treats a Task result or failure as owner attention", () => {
    const base = {
      recordType: "work_item" as const,
      schemaVersion: 1 as const,
      ownerUserId: "owner_1",
      version: 2,
      createdAt: 1,
      updatedAt: 2,
      id: "work_item_1",
      streamId: "stream_1",
      title: "Inspect the generated result",
      state: "result_ready" as const,
      priority: 0,
      dependencyIds: [],
      completionContract: {
        version: 1 as const,
        mode: "all" as const,
        requirements: [
          {
            id: "review_result",
            kind: "owner_confirmation" as const,
            description: "Owner accepts the generated result",
          },
        ],
      },
      sourceRevisionRefs: [],
      evidenceIds: [],
      provenance: { actor: { type: "user" as const, id: "owner_1" } },
    }
    expect(
      AttentionItemSchema.parse({
        id: base.id,
        ownerUserId: base.ownerUserId,
        kind: "work_item",
        updatedAt: base.updatedAt,
        record: base,
      }),
    ).toMatchObject({ kind: "work_item", record: { state: "result_ready" } })
    expect(
      AttentionItemSchema.parse({
        id: base.id,
        ownerUserId: base.ownerUserId,
        kind: "work_item",
        updatedAt: base.updatedAt,
        record: { ...base, state: "failed" },
      }),
    ).toMatchObject({ kind: "work_item", record: { state: "failed" } })
  })

  it("requires next cursors exactly when a page has more items", () => {
    expect(() => AttentionPageSchema.parse({ items: [], total: 1, hasMore: true })).toThrow()
    expect(() => AttentionPageSchema.parse({ items: [], total: 0, hasMore: false, nextCursor: "cursor" })).toThrow()
  })
})
