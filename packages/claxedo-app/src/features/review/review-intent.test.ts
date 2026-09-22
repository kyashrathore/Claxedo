import { describe, expect, test } from "bun:test"
import { persistedReviewSelection, reviewDiffRefs } from "./review-intent"

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

describe("reviewDiffRefs", () => {
  test("sends both refs in to-from, only the base in a branch mode, and none in a worktree mode", () => {
    expect(reviewDiffRefs({ mode: "to-from", fromRef: "main", toRef: "HEAD" })).toEqual({ fromRef: "main", toRef: "HEAD" })
    expect(reviewDiffRefs({ mode: "branch", fromRef: " main ", toRef: "HEAD" })).toEqual({ fromRef: "main" })
    expect(reviewDiffRefs({ mode: "branch-worktree", fromRef: "origin/dev" })).toEqual({ fromRef: "origin/dev" })
    expect(reviewDiffRefs({ mode: "branch", fromRef: "  " })).toEqual({})
    expect(reviewDiffRefs({ mode: "unstaged", fromRef: "HEAD~1", toRef: "HEAD" })).toEqual({})
  })

  test("a branch mode persists its base and nothing else", () => {
    expect(persistedReviewSelection({ mode: "branch", fromRef: "main", toRef: "HEAD" })).toEqual({ mode: "branch", fromRef: "main" })
  })
})
