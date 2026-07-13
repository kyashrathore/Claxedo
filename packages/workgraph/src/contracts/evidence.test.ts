import { describe, expect, it } from "vitest"
import {
  EvidencePageCursorError,
  EvidencePageSchema,
  createEvidencePageCursor,
  readEvidencePageCursor,
} from "./evidence"

describe("Evidence query contracts", () => {
  const subject = { type: "work_item" as const, workItemId: "item:ship/cloud" as never }

  it("round trips an owner- and subject-bound stable position", () => {
    const cursor = createEvidencePageCursor({
      ownerUserId: "owner:one@example.com",
      subject,
      recordedAt: 42,
      evidenceId: "evidence:2",
    })

    expect(readEvidencePageCursor(cursor, "owner:one@example.com", subject)).toEqual({
      recordedAt: 42,
      evidenceId: "evidence:2",
    })
  })

  it("rejects cross-owner, cross-subject, and malformed cursor reuse", () => {
    const cursor = createEvidencePageCursor({ ownerUserId: "owner_a", subject, recordedAt: 42, evidenceId: "evidence_2" })

    expect(() => readEvidencePageCursor(cursor, "owner_b", subject)).toThrow(expect.objectContaining({ reason: "owner_mismatch" }))
    expect(() => readEvidencePageCursor(cursor, "owner_a", { type: "stream", streamId: "stream_1" as never }))
      .toThrow(expect.objectContaining({ reason: "subject_mismatch" }))
    expect(() => readEvidencePageCursor("broken", "owner_a", subject)).toThrow(EvidencePageCursorError)
  })

  it("requires nextCursor exactly when a page has more records", () => {
    expect(() => EvidencePageSchema.parse({ evidence: [], hasMore: true })).toThrow()
    expect(() => EvidencePageSchema.parse({ evidence: [], hasMore: false, nextCursor: "wgep1:unexpected" })).toThrow()
  })
})
