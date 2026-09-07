import { describe, expect, test } from "bun:test"
import { persistedReviewSelection } from "./review-intent"

describe("persistedReviewSelection", () => {
  test("keeps trimmed refs for a ref-to-ref comparison and drops blank ones", () => {
    expect(persistedReviewSelection({ mode: "to-from", fromRef: " main ", toRef: "HEAD" })).toEqual({ mode: "to-from", fromRef: "main", toRef: "HEAD" })
    expect(persistedReviewSelection({ mode: "to-from", fromRef: "  ", toRef: "HEAD" })).toEqual({ mode: "to-from", toRef: "HEAD" })
  })

  test("a worktree mode stores no refs, so the pill's placeholder never outlives the click that carried it", () => {
    expect(persistedReviewSelection({ mode: "staged", fromRef: "HEAD~1", toRef: "HEAD" })).toEqual({ mode: "staged" })
    expect(persistedReviewSelection({ mode: "uncommitted" })).toEqual({ mode: "uncommitted" })
  })
})
