import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, createStore, flush } from "solid-js"
import { agentLifecycleTitle, reconcilePtyExit, useReconnectReconciliation } from "./agent-status-listener"
import { createTerminalSlice } from "./terminal"
import { emptyClaxedoState } from "./persistence"
import type { ClaxedoState } from "./types"
import { mountReactive } from "@/lib/test-support/reactive-root"

// `createTerminalSlice` registers an `onCleanup` for its 15s reservation timer,
// which needs an owner to run — in the app the workbench provider is that one.
const mounted: (() => void)[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!()
})

function terminalSlice() {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  const [slice, dispose] = mountReactive(() => createTerminalSlice({ state, setState }))
  mounted.push(dispose)
  return slice
}

describe("useReconnectReconciliation", () => {
  test("reconciles once on reconnect and ignores later metadata and status mutations", async () => {
    let fetches = 0

    // The signals are built under the root so the connection effect gets an
    // owner; the test drives them from outside it, exactly like the app's
    // stream callbacks do.
    const [control, dispose] = mountReactive(() => {
      const [connected, setConnected] = createSignal(true)
      const [metadata, setMetadata] = createSignal("Terminal")
      const [status, setStatus] = createSignal<"working" | "permission">("working")

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

      return { setConnected, setMetadata, setStatus }
    })

    try {
      await settleEffects()
      expect(fetches).toBe(0)

      control.setConnected(false)
      await settleEffects()
      control.setConnected(true)
      await settleEffects()
      expect(fetches).toBe(1)

      control.setMetadata("Claude: Fix reconnect tracking")
      control.setStatus("permission")
      await settleEffects()
      expect(fetches).toBe(1)
    } finally {
      dispose()
    }
  })
})

async function settleEffects() {
  // Solid 2 stages writes: the effect phase only runs once the flush does.
  flush()
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
