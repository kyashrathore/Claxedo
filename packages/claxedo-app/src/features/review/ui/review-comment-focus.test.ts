import { describe, expect, test } from "bun:test"
import { reviewCommentFocusAction } from "./review-comment-focus"

const state = (overrides: Partial<Parameters<typeof reviewCommentFocusAction>[0]> = {}) =>
  reviewCommentFocusAction({ mounted: true, commentExists: true, renderable: true, ...overrides })

describe("review comment focus intent", () => {
  test("a request made before the surface mounts is held, not lost", () => {
    expect(state({ mounted: false })).toBe("wait")
    expect(state({ mounted: false, renderable: false })).toBe("wait")
  })

  test("an unfetched row is reached by identity until its content arrives", () => {
    expect(state({ renderable: false })).toBe("reveal-file")
  })

  test("the line jump applies only once the row is a real expanded diff", () => {
    expect(state()).toBe("apply-line")
  })

  test("a comment that disappeared clears the request instead of scrolling", () => {
    expect(state({ commentExists: false, renderable: false })).toBe("drop")
    expect(state({ commentExists: false })).toBe("drop")
  })
})
