import { describe, expect, test } from "bun:test"
import { shouldShowPromptAgentSelector } from "./selector-visibility"

describe("shouldShowPromptAgentSelector", () => {
  test("hides the selector when the runtime exposes no agents", () => {
    expect(shouldShowPromptAgentSelector({ agentCount: 0 })).toBe(false)
  })

  test("shows the selector when the runtime reports agents", () => {
    expect(shouldShowPromptAgentSelector({ agentCount: 1 })).toBe(true)
  })
})
