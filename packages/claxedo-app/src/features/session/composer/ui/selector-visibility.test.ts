import { describe, expect, test } from "bun:test"
import { shouldShowPromptAgentSelector } from "./selector-visibility"

describe("shouldShowPromptAgentSelector", () => {
  test("hides the selector when the runner exposes no agents", () => {
    expect(shouldShowPromptAgentSelector({ isHarnessMode: false, agentCount: 0 })).toBe(false)
  })

  test("shows the selector for non-ACP runners with agents", () => {
    expect(shouldShowPromptAgentSelector({ isHarnessMode: false, agentCount: 1 })).toBe(true)
  })

  test("hides the selector in ACP mode", () => {
    expect(shouldShowPromptAgentSelector({ isHarnessMode: true, agentCount: 1 })).toBe(false)
  })
})
