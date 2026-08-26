import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import {
  agentLifecycleTitle,
  reconcilePtyExit,
  sessionStatusForAgentLifecycle,
  useReconnectReconciliation,
} from "./agent-status-listener"
import { createTerminalSlice } from "./terminal"
import { emptyClaxedoState } from "./persistence"
import type { ClaxedoState } from "./types"

function terminalSlice() {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  return createTerminalSlice({ state, setState })
}

describe("useReconnectReconciliation", () => {
  test("reconciles once on reconnect and ignores later metadata and status mutations", async () => {
    let dispose: (() => void) | undefined
    let setConnected!: (connected: boolean) => void
    let setMetadata!: (title: string) => void
    let setStatus!: (status: "working" | "permission") => void
    let fetches = 0

    createRoot((rootDispose) => {
      dispose = rootDispose
      const [connected, updateConnected] = createSignal(true)
      const [metadata, updateMetadata] = createSignal("Terminal")
      const [status, updateStatus] = createSignal<"working" | "permission">("working")
      setConnected = updateConnected
      setMetadata = updateMetadata
      setStatus = updateStatus

      useReconnectReconciliation({
        connected,
        reconcile: () => {
          // These stand in for terminalReconnectTargets' synchronous snapshot.
          // Reading them must not subscribe the connection effect to later
          // metadata/title or terminal-status updates.
          metadata()
          status()
          fetches += 1
        },
      })
    })

    try {
      await settleEffects()
      expect(fetches).toBe(0)

      setConnected(false)
      await settleEffects()
      setConnected(true)
      await settleEffects()
      expect(fetches).toBe(1)

      setMetadata("Claude: Fix reconnect tracking")
      setStatus("permission")
      await settleEffects()
      expect(fetches).toBe(1)
    } finally {
      dispose?.()
    }
  })
})

async function settleEffects() {
  await Promise.resolve()
  await Promise.resolve()
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

describe("sessionStatusForAgentLifecycle", () => {
  test("routes chat-only lifecycle frames into session status", () => {
    expect(sessionStatusForAgentLifecycle({
      sessionId: "ses_1",
      eventType: "Busy",
    })).toEqual({ type: "busy" })
    expect(sessionStatusForAgentLifecycle({
      sessionId: "ses_1",
      eventType: "Idle",
    })).toEqual({ type: "idle" })
    expect(sessionStatusForAgentLifecycle({
      sessionId: "ses_1",
      eventType: "Error",
    })).toEqual({ type: "idle" })
  })

  test("leaves terminal lifecycle frames on the terminal path", () => {
    expect(sessionStatusForAgentLifecycle({
      sessionId: "ses_1",
      terminalId: "pty_1",
      eventType: "Busy",
    })).toBeUndefined()
    expect(sessionStatusForAgentLifecycle({
      eventType: "Busy",
    })).toBeUndefined()
  })
})

describe("agentLifecycleTitle", () => {
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
