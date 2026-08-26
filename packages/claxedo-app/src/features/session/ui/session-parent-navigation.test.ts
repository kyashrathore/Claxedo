import { describe, expect, test } from "bun:test"
import { createParentSessionNavigation } from "./session-parent-navigation"

describe("createParentSessionNavigation", () => {
  test("navigates to the parent and restores the child pane's content focus", () => {
    const navigated: string[] = []
    const focused: string[] = []
    const navigate = createParentSessionNavigation(
      () => ({ parentID: "parent" }),
      () => "child",
      {
        meta: { find: (predicate) => [{ id: "content", type: "session", sessionId: "child" }].find(predicate) },
        layout: { restoreContentFocus: (id) => focused.push(id) },
      },
      (route) => navigated.push(route),
    )

    navigate()

    expect(navigated).toEqual(["/s/parent"])
    expect(focused).toEqual(["content"])
  })

  test("does nothing without a parent", () => {
    let calls = 0
    const navigate = createParentSessionNavigation(
      () => undefined,
      () => "child",
      { meta: { find: () => undefined }, layout: { restoreContentFocus: () => calls++ } },
      () => calls++,
    )

    navigate()

    expect(calls).toBe(0)
  })
})
