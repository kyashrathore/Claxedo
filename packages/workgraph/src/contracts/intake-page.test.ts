import { describe, expect, it } from "vitest"
import {
  IntakeCandidatePageCursorError,
  IntakeCandidatePageSchema,
  createIntakeCandidatePageCursor,
  readIntakeCandidatePageCursor,
} from "./intake-page"

describe("intake Candidate paging contract", () => {
  it("round-trips an owner- and Source View-bound deterministic cursor", () => {
    const cursor = createIntakeCandidatePageCursor({
      organizationId: "organization one",
      ownerUserId: "owner one",
      sourceViewId: "view/one",
      updatedAt: 42,
      candidateId: "candidate:one",
    })

    expect(readIntakeCandidatePageCursor(cursor, "organization one", "owner one", "view/one")).toEqual({
      updatedAt: 42,
      candidateId: "candidate:one",
    })
    expect(() => readIntakeCandidatePageCursor(cursor, "organization two", "owner one", "view/one"))
      .toThrowError(expect.objectContaining<Partial<IntakeCandidatePageCursorError>>({ reason: "owner_mismatch" }))
    expect(() => readIntakeCandidatePageCursor(cursor, "organization one", "owner two", "view/one"))
      .toThrowError(expect.objectContaining<Partial<IntakeCandidatePageCursorError>>({ reason: "owner_mismatch" }))
    expect(() => readIntakeCandidatePageCursor(cursor, "organization one", "owner one"))
      .toThrowError(expect.objectContaining<Partial<IntakeCandidatePageCursorError>>({ reason: "source_view_mismatch" }))
    expect(() => readIntakeCandidatePageCursor("broken", "organization one", "owner one"))
      .toThrowError(expect.objectContaining<Partial<IntakeCandidatePageCursorError>>({ reason: "invalid" }))
  })

  it("requires a next cursor exactly when another page exists", () => {
    expect(() => IntakeCandidatePageSchema.parse({ candidates: [], hasMore: true })).toThrow()
    expect(() => IntakeCandidatePageSchema.parse({ candidates: [], hasMore: false, nextCursor: "cursor" })).toThrow()
  })
})
