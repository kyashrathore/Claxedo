import { describe, expect, test } from "bun:test"
import { createParentSessionNavigation } from "./session-parent-navigation"

describe("createParentSessionNavigation", () => {
  test("navigates to the parent session's route", () => {
    const navigated: string[] = []
    createParentSessionNavigation(() => ({ parentID: "parent" }), (route) => navigated.push(route))()
    expect(navigated).toEqual(["/s/parent"])
  })

  test("does nothing without a parent", () => {
    let calls = 0
    createParentSessionNavigation(() => undefined, () => calls++)()
    expect(calls).toBe(0)
  })
})
