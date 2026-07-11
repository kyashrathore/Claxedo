import { describe, expect, test } from "bun:test"
import { nextSiblingAfterRemoval, sessionRemovalNavigation } from "./session-archive"

const rows = (...ids: string[]) => ids.map((id) => ({ id }))

describe("nextSiblingAfterRemoval", () => {
  test("prefers the following session", () => {
    expect(nextSiblingAfterRemoval(rows("a", "b", "c"), "b")).toEqual({ id: "c" })
  })

  test("falls back to the preceding session when removing the last one", () => {
    expect(nextSiblingAfterRemoval(rows("a", "b", "c"), "c")).toEqual({ id: "b" })
  })

  test("returns undefined for a single-element list", () => {
    expect(nextSiblingAfterRemoval(rows("a"), "a")).toBeUndefined()
  })

  test("returns undefined when the target is not present", () => {
    expect(nextSiblingAfterRemoval(rows("a", "b"), "z")).toBeUndefined()
  })

  test("returns undefined for an empty list", () => {
    expect(nextSiblingAfterRemoval([], "a")).toBeUndefined()
  })
})

describe("sessionRemovalNavigation", () => {
  test("stays put when the removed session is not the open one", () => {
    expect(
      sessionRemovalNavigation({
        currentSessionID: "open",
        targetSessionID: "other",
        nextSessionID: "next",
      }),
    ).toEqual({ kind: "none" })
  })

  test("navigates to the parent first when the open session is removed", () => {
    expect(
      sessionRemovalNavigation({
        currentSessionID: "s",
        targetSessionID: "s",
        parentID: "p",
        nextSessionID: "next",
      }),
    ).toEqual({ kind: "parent", sessionID: "p" })
  })

  test("navigates to the next sibling when there is no parent", () => {
    expect(
      sessionRemovalNavigation({
        currentSessionID: "s",
        targetSessionID: "s",
        nextSessionID: "next",
      }),
    ).toEqual({ kind: "next", sessionID: "next" })
  })

  test("falls back to the workspace root when neither parent nor sibling exists", () => {
    expect(
      sessionRemovalNavigation({
        currentSessionID: "s",
        targetSessionID: "s",
      }),
    ).toEqual({ kind: "root" })
  })
})
