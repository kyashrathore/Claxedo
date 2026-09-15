import { describe, expect, test } from "bun:test"
import { deriveSessionTitle, extractPromptTitleText, isPlaceholderTitle } from "./session-title"

describe("session title helpers", () => {
  test("recognises the titles no writer chose", () => {
    expect(isPlaceholderTitle(undefined)).toBe(true)
    expect(isPlaceholderTitle(null)).toBe(true)
    expect(isPlaceholderTitle("")).toBe(true)
    expect(isPlaceholderTitle("New Session")).toBe(true)
    expect(isPlaceholderTitle("New session - 2026-07-08T09:09:30.378Z")).toBe(true)
    expect(isPlaceholderTitle("Child session - 2026-07-08T09:09:30.378Z")).toBe(true)
    expect(isPlaceholderTitle("Session")).toBe(true)
  })

  test("keeps chosen titles", () => {
    expect(isPlaceholderTitle("Fix terminal rendering")).toBe(false)
    expect(isPlaceholderTitle("New session architecture notes")).toBe(false)
  })

  test("derives titles from prompt text", () => {
    expect(deriveSessionTitle("Please fix the terminal pane")).toBe("fix the terminal pane")
    expect(extractPromptTitleText([{ type: "text", text: "hello" }])).toBe("hello")
    expect(extractPromptTitleText([{ type: "text", content: "from content" }])).toBe("from content")
  })
})
