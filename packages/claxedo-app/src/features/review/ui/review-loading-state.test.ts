import { describe, expect, test } from "bun:test"
import { reviewDiffsReady, reviewShouldShowLoadingPane } from "./review-loading-state"

describe("review loading state", () => {
  test("shows the loading pane only for initial diff loads", () => {
    expect(reviewShouldShowLoadingPane({ loading: true, diffCount: 0 })).toBe(true)
    expect(reviewDiffsReady({ loading: true, diffCount: 0 })).toBe(false)

    expect(reviewShouldShowLoadingPane({ loading: true, diffCount: 3 })).toBe(false)
    expect(reviewDiffsReady({ loading: true, diffCount: 3 })).toBe(true)
  })

  test("keeps loaded diffs visible after refresh completes", () => {
    expect(reviewShouldShowLoadingPane({ loading: false, diffCount: 3 })).toBe(false)
    expect(reviewDiffsReady({ loading: false, diffCount: 3 })).toBe(true)
  })
})
