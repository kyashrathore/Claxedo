import { describe, expect, test } from "bun:test"
import { shouldShowPromptAgentSelector } from "./selector-visibility"

describe("shouldShowPromptAgentSelector", () => {
  test("hides the selector when OpenCode exposes no agents", () => {
    expect(shouldShowPromptAgentSelector({ isOpenCodeHarness: true, agentCount: 0 })).toBe(false)
  })

  test("shows the selector for OpenCode with agents", () => {
    expect(shouldShowPromptAgentSelector({ isOpenCodeHarness: true, agentCount: 1 })).toBe(true)
  })

  test("hides the selector for non-OpenCode harnesses, even with agents", () => {
    expect(shouldShowPromptAgentSelector({ isOpenCodeHarness: false, agentCount: 1 })).toBe(false)
  })
})
