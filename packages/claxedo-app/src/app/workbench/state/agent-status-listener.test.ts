import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js"
import { agentLifecycleTitle, reconcilePtyExit } from "./agent-status-listener"
import { createTerminalSlice } from "./terminal"
import { emptyClaxedoState } from "./persistence"
import type { ClaxedoState } from "./types"

function terminalSlice() {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  return createTerminalSlice({ state, setState })
}

describe("reconcilePtyExit", () => {
  test("externally exited working terminal drops to idle AND clears seen so the done dot disappears", () => {
    const terminal = terminalSlice()
    terminal.setAgentStatus("pty_1", "working")
    // setAgentStatus(non-idle) records `seen`; leaving it set would keep the
    // status aggregator reporting `done` forever.
    expect(terminal.seen("pty_1")).toBe(true)

    const changed = reconcilePtyExit({ terminal }, "pty_1")

    expect(changed).toBe(true)
    expect(terminal.agentStatus("pty_1")).toBe("idle")
    expect(terminal.seen("pty_1")).toBe(false)
  })

  test("permission terminal is reconciled to idle with seen cleared", () => {
    const terminal = terminalSlice()
    terminal.setAgentStatus("pty_2", "permission")

    reconcilePtyExit({ terminal }, "pty_2")

    expect(terminal.agentStatus("pty_2")).toBe("idle")
    expect(terminal.seen("pty_2")).toBe(false)
  })

  test("untracked pty id is a no-op returning false", () => {
    const terminal = terminalSlice()
    expect(reconcilePtyExit({ terminal }, "never-seen")).toBe(false)
  })

  test("missing pty id is a no-op returning false", () => {
    const terminal = terminalSlice()
    expect(reconcilePtyExit({ terminal }, undefined)).toBe(false)
  })

  test("already-idle tracked terminal is left untouched (no redundant write)", () => {
    const terminal = terminalSlice()
    terminal.setAgentStatus("pty_3", "idle")
    expect(reconcilePtyExit({ terminal }, "pty_3")).toBe(false)
    expect(terminal.agentStatus("pty_3")).toBe("idle")
  })
})

describe("agentLifecycleTitle", () => {
  test("renames generic Claude terminals from lifecycle ref names", () => {
    expect(
      agentLifecycleTitle({
        currentTitle: "Claude",
        provider: "claude",
        refName: "@fix-typecheck-errors-2f31",
      }),
    ).toBe("Claude: Fix Typecheck Errors")
  })

  test("keeps explicit terminal names", () => {
    expect(
      agentLifecycleTitle({
        currentTitle: "Production shell",
        provider: "claude",
        refName: "@fix-typecheck-errors-2f31",
      }),
    ).toBeUndefined()
  })

  test("falls back to prompt text when no ref name is present", () => {
    expect(
      agentLifecycleTitle({
        currentTitle: "Terminal 1",
        provider: "codex",
        prompt: "investigate the stuck permission prompt",
      }),
    ).toBe("Codex: Investigate The Stuck Permission Prompt")
  })

  test("replaces weak generated terminal titles with assistant context", () => {
    expect(
      agentLifecycleTitle({
        currentTitle: "Claude: Hi",
        provider: "claude",
        prompt: "hi",
        lastAssistantMessage: "I can help review the terminal title propagation path.",
      }),
    ).toBe("Claude: I Can Help Review The Terminal Title Propagation Path")
  })

  test("keeps useful generated titles stable", () => {
    expect(
      agentLifecycleTitle({
        currentTitle: "Claude: Fix Typecheck Errors",
        provider: "claude",
        prompt: "fix typecheck errors",
        lastAssistantMessage: "I will start by running typecheck.",
      }),
    ).toBeUndefined()
  })

  test("does not use captured agent answer text as terminal prompt title", () => {
    expect(
      agentLifecycleTitle({
        currentTitle: "Codex",
        provider: "codex",
        prompt:
          "Claude is an AI assistant made by Anthropic. I'm Claude, running as Claude Code for software engineering tasks.",
        lastAssistantMessage: "I'm Codex, a coding agent based on GPT-5.",
      }),
    ).toBe("Codex: I'M Codex, A Coding Agent Based On GPT 5")
  })
})
