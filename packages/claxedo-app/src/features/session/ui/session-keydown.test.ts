import { describe, expect, test } from "bun:test"
import { classifySessionKeydown, isEditableTagName } from "./session-keydown"

describe("isEditableTagName", () => {
  test("matches form/interactive tags", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT", "BUTTON"]) {
      expect(isEditableTagName(tag)).toBe(true)
    }
  })

  test("rejects non-editable tags", () => {
    for (const tag of ["DIV", "SPAN", "A", "INPUTX", ""]) {
      expect(isEditableTagName(tag)).toBe(false)
    }
  })
})

describe("classifySessionKeydown", () => {
  test("scroll keys record a scroll gesture", () => {
    for (const key of ["PageUp", "PageDown", "Home", "End"]) {
      expect(classifySessionKeydown({ key })).toBe("scroll-gesture")
    }
  })

  test("a printable character focuses the composer", () => {
    expect(classifySessionKeydown({ key: "a" })).toBe("focus-input")
    expect(classifySessionKeydown({ key: "?" })).toBe("focus-input")
    expect(classifySessionKeydown({ key: " " })).toBe("focus-input")
  })

  test("ctrl/meta modified printable keys are ignored (shortcuts)", () => {
    expect(classifySessionKeydown({ key: "a", ctrlKey: true })).toBe("ignore")
    expect(classifySessionKeydown({ key: "k", metaKey: true })).toBe("ignore")
  })

  test("multi-character and Unidentified keys are ignored", () => {
    expect(classifySessionKeydown({ key: "Enter" })).toBe("ignore")
    expect(classifySessionKeydown({ key: "Shift" })).toBe("ignore")
    expect(classifySessionKeydown({ key: "Unidentified" })).toBe("ignore")
  })
})
