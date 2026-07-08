import { describe, expect, test } from "bun:test"
import { agentLifecycleTitle } from "./agent-status-listener"

describe("agentLifecycleTitle", () => {
  test("keeps reconnect cleanup independent from RuntimeGateway", async () => {
    expect(await Bun.file(new URL("./agent-status-listener.ts", import.meta.url)).text())
      .not.toContain("RuntimeGateway")
  })

  test("renames generic Claude terminals from lifecycle ref names", () => {
    expect(agentLifecycleTitle({
      currentTitle: "Claude",
      provider: "claude",
      refName: "@fix-typecheck-errors-2f31",
    })).toBe("Claude: Fix Typecheck Errors")
  })

  test("keeps explicit terminal names", () => {
    expect(agentLifecycleTitle({
      currentTitle: "Production shell",
      provider: "claude",
      refName: "@fix-typecheck-errors-2f31",
    })).toBeUndefined()
  })

  test("falls back to prompt text when no ref name is present", () => {
    expect(agentLifecycleTitle({
      currentTitle: "Terminal 1",
      provider: "codex",
      prompt: "investigate the stuck permission prompt",
    })).toBe("Codex: Investigate The Stuck Permission Prompt")
  })

  test("replaces weak generated terminal titles with assistant context", () => {
    expect(agentLifecycleTitle({
      currentTitle: "Claude: Hi",
      provider: "claude",
      prompt: "hi",
      lastAssistantMessage: "I can help review the terminal title propagation path.",
    })).toBe("Claude: I Can Help Review The Terminal Title Propagation Path")
  })

  test("keeps useful generated titles stable", () => {
    expect(agentLifecycleTitle({
      currentTitle: "Claude: Fix Typecheck Errors",
      provider: "claude",
      prompt: "fix typecheck errors",
      lastAssistantMessage: "I will start by running typecheck.",
    })).toBeUndefined()
  })

  test("does not use captured agent answer text as terminal prompt title", () => {
    expect(agentLifecycleTitle({
      currentTitle: "Codex",
      provider: "codex",
      prompt: "Claude is an AI assistant made by Anthropic. I'm Claude, running as Claude Code for software engineering tasks.",
      lastAssistantMessage: "I'm Codex, a coding agent based on GPT-5.",
    })).toBe("Codex: I'M Codex, A Coding Agent Based On GPT 5")
  })
})
