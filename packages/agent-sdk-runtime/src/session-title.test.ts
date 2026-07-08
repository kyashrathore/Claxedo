import { describe, expect, test } from "bun:test"
import { extractPromptTitleText, fallbackSessionTitle, hasConcreteSessionTitle } from "./session-title"

describe("session title helpers", () => {
  test("treats generated placeholders as untitled", () => {
    expect(hasConcreteSessionTitle(undefined)).toBe(false)
    expect(hasConcreteSessionTitle("")).toBe(false)
    expect(hasConcreteSessionTitle("New Session")).toBe(false)
    expect(hasConcreteSessionTitle("New session - 2026-07-08T09:09:30.378Z")).toBe(false)
    expect(hasConcreteSessionTitle("Child session - 2026-07-08T09:09:30.378Z")).toBe(false)
    expect(hasConcreteSessionTitle("Session")).toBe(false)
  })

  test("keeps real titles concrete", () => {
    expect(hasConcreteSessionTitle("Fix terminal rendering")).toBe(true)
    expect(hasConcreteSessionTitle("New session architecture notes")).toBe(true)
  })

  test("builds fallback titles from prompt text", () => {
    expect(fallbackSessionTitle("Please fix the terminal pane")).toBe("fix the terminal pane")
    expect(extractPromptTitleText([{ type: "text", text: "hello" }])).toBe("hello")
    expect(extractPromptTitleText([{ type: "text", content: "from content" }])).toBe("from content")
  })
})
