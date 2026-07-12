import { describe, expect, test } from "bun:test"
import {
  clampFocus,
  classifyQuestionKey,
  focusIndexForTab,
  isAnswered,
  mergeCustomAnswer,
} from "./session-question-dock-nav"

const opts = (...labels: string[]) => labels.map((label) => ({ label }))

describe("clampFocus", () => {
  test("clamps into [0, count-1]", () => {
    expect(clampFocus(-3, 4)).toBe(0)
    expect(clampFocus(10, 4)).toBe(3)
    expect(clampFocus(2, 4)).toBe(2)
  })
})

describe("focusIndexForTab", () => {
  test("points at the custom row when the custom answer is active", () => {
    expect(focusIndexForTab({ options: opts("a", "b"), answers: [], customOn: true })).toBe(2)
  })

  test("points at the first answered option", () => {
    expect(focusIndexForTab({ options: opts("a", "b", "c"), answers: ["b"], customOn: false })).toBe(1)
  })

  test("defaults to 0 when nothing is answered", () => {
    expect(focusIndexForTab({ options: opts("a", "b"), answers: undefined, customOn: undefined })).toBe(0)
  })
})

describe("isAnswered", () => {
  test("true when an option is picked", () => {
    expect(isAnswered({ answers: ["a"], customOn: false, custom: "" })).toBe(true)
  })

  test("true when custom is active and non-empty", () => {
    expect(isAnswered({ answers: [], customOn: true, custom: "  typed  " })).toBe(true)
  })

  test("false when custom is active but blank", () => {
    expect(isAnswered({ answers: [], customOn: true, custom: "   " })).toBe(false)
  })

  test("false when nothing is chosen", () => {
    expect(isAnswered({ answers: undefined, customOn: undefined, custom: undefined })).toBe(false)
  })
})

describe("mergeCustomAnswer", () => {
  test("single choice replaces the answer with the trimmed custom text", () => {
    expect(mergeCustomAnswer({ multi: false, current: ["old"], previous: "old", next: "  new " })).toEqual([
      "new",
    ])
  })

  test("single choice clears the answer when custom is emptied", () => {
    expect(mergeCustomAnswer({ multi: false, current: ["old"], previous: "old", next: "  " })).toEqual([])
  })

  test("multi choice swaps the old custom value for the new one", () => {
    expect(
      mergeCustomAnswer({ multi: true, current: ["keep", "old"], previous: "old", next: "new" }),
    ).toEqual(["keep", "new"])
  })

  test("multi choice does not duplicate an existing value", () => {
    expect(
      mergeCustomAnswer({ multi: true, current: ["keep", "dup"], previous: "", next: "dup" }),
    ).toEqual(["keep", "dup"])
  })

  test("multi choice removes the previous custom value when cleared", () => {
    expect(mergeCustomAnswer({ multi: true, current: ["keep", "old"], previous: "old", next: "" })).toEqual([
      "keep",
    ])
  })
})

describe("classifyQuestionKey", () => {
  const ctx = { editing: false, inOptions: true, count: 4 }

  test("ignores already-handled events", () => {
    expect(classifyQuestionKey({ key: "Escape", defaultPrevented: true }, ctx)).toEqual({ type: "none" })
  })

  test("Escape rejects", () => {
    expect(classifyQuestionKey({ key: "Escape" }, ctx)).toEqual({ type: "reject" })
  })

  test("Cmd/Ctrl+Enter submits", () => {
    expect(classifyQuestionKey({ key: "Enter", metaKey: true }, ctx)).toEqual({ type: "next" })
    expect(classifyQuestionKey({ key: "Enter", ctrlKey: true }, ctx)).toEqual({ type: "next" })
  })

  test("Cmd+Enter with Alt or on key-repeat does not submit", () => {
    expect(classifyQuestionKey({ key: "Enter", metaKey: true, altKey: true }, ctx)).toEqual({ type: "none" })
    expect(classifyQuestionKey({ key: "Enter", metaKey: true, repeat: true }, ctx)).toEqual({ type: "none" })
  })

  test("arrow keys move focus when inside the options group", () => {
    expect(classifyQuestionKey({ key: "ArrowDown" }, ctx)).toEqual({ type: "move", step: 1 })
    expect(classifyQuestionKey({ key: "ArrowRight" }, ctx)).toEqual({ type: "move", step: 1 })
    expect(classifyQuestionKey({ key: "ArrowUp" }, ctx)).toEqual({ type: "move", step: -1 })
    expect(classifyQuestionKey({ key: "ArrowLeft" }, ctx)).toEqual({ type: "move", step: -1 })
  })

  test("Home/End jump to the first/last row", () => {
    expect(classifyQuestionKey({ key: "Home" }, ctx)).toEqual({ type: "focus", index: 0 })
    expect(classifyQuestionKey({ key: "End" }, ctx)).toEqual({ type: "focus", index: 3 })
  })

  test("navigation is suppressed while editing or outside the options group", () => {
    expect(classifyQuestionKey({ key: "ArrowDown" }, { ...ctx, editing: true })).toEqual({ type: "none" })
    expect(classifyQuestionKey({ key: "ArrowDown" }, { ...ctx, inOptions: false })).toEqual({ type: "none" })
  })

  test("modified arrow keys are ignored", () => {
    expect(classifyQuestionKey({ key: "ArrowDown", altKey: true }, ctx)).toEqual({ type: "none" })
    expect(classifyQuestionKey({ key: "ArrowDown", ctrlKey: true }, ctx)).toEqual({ type: "none" })
  })

  test("unrelated keys are ignored", () => {
    expect(classifyQuestionKey({ key: "a" }, ctx)).toEqual({ type: "none" })
  })
})
