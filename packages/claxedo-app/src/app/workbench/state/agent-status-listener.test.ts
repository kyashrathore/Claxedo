import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { agentLifecycleTitle, reconcileAgentStatuses, reconcilePtyExit, terminalLifecycleSound, useReconnectReconciliation, type AgentStatusReconcileState } from "./agent-status-listener"
import type { ContentMeta } from "./provider"
import { createTerminalSlice } from "./terminal"
import { emptyClaxedoState } from "./persistence"
import type { ClaxedoState } from "./types"

function terminalSlice() {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  return createTerminalSlice({ state, setState })
}

describe("useReconnectReconciliation", () => {
  test("reconciles on each stream up, the first included, and ignores later metadata and status mutations", async () => {
    let dispose: (() => void) | undefined
    let setConnected!: (connected: boolean) => void
    let setMetadata!: (title: string) => void
    let setStatus!: (status: "working" | "permission") => void
    let fetches = 0

    createRoot((rootDispose) => {
      dispose = rootDispose
      const [connected, updateConnected] = createSignal(true)
      const [reconnects] = createSignal(0)
      const [metadata, updateMetadata] = createSignal("Terminal")
      const [status, updateStatus] = createSignal<"working" | "permission">("working")
      setConnected = updateConnected
      setMetadata = updateMetadata
      setStatus = updateStatus

      useReconnectReconciliation({
        connected,
        reconnects,
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
      // The first stream up reconciles too: indicators persisted from before
      // the page load are stale in the same way.
      await settleEffects()
      expect(fetches).toBe(1)

      setConnected(false)
      await settleEffects()
      setConnected(true)
      await settleEffects()
      expect(fetches).toBe(2)

      setMetadata("Claude: Fix reconnect tracking")
      setStatus("permission")
      await settleEffects()
      expect(fetches).toBe(2)
    } finally {
      dispose?.()
    }
  })

  test("a stream's return under a level another workspace stream holds up still reconciles", async () => {
    let dispose: (() => void) | undefined
    let bumpReconnects!: (count: number) => void
    let fetches = 0

    createRoot((rootDispose) => {
      dispose = rootDispose
      // The host aggregate never drops, so the level stays true throughout.
      const [connected] = createSignal(true)
      const [reconnects, updateReconnects] = createSignal(0)
      bumpReconnects = updateReconnects
      useReconnectReconciliation({ connected, reconnects, reconcile: () => { fetches += 1 } })
    })

    try {
      await settleEffects()
      expect(fetches).toBe(1)

      bumpReconnects(1)
      await settleEffects()
      expect(fetches).toBe(2)

      bumpReconnects(2)
      await settleEffects()
      expect(fetches).toBe(3)
    } finally {
      dispose?.()
    }
  })
})

async function settleEffects() {
  await Promise.resolve()
  await Promise.resolve()
}

const terminalContent = (id: string, directory: string, terminalId: string): ContentMeta => ({
  id,
  type: "terminal",
  directory,
  terminalId,
  content: { type: "terminal", directory, terminalId, title: terminalId },
})

describe("reconcileAgentStatuses", () => {
  test("reads each workspace on its own: a live terminal takes the lifecycle the runtime recorded, a gone one idles, an unreachable workspace keeps its indicators", async () => {
    const terminal = terminalSlice()
    // `setAgentStatus` to a non-idle status marks the terminal seen (the done dot's condition).
    terminal.setAgentStatus("pty_done", "working")
    terminal.setAgentStatus("pty_still", "working")
    terminal.setAgentStatus("pty_gone", "working")
    terminal.setAgentStatus("pty_away", "working")
    terminal.own("tab_done", "pty_done")
    terminal.own("tab_still", "pty_still")
    terminal.own("tab_gone", "pty_gone")
    terminal.own("tab_away", "pty_away")
    terminal.own("tab_started", "pty_started")
    terminal.own("tab_asking", "pty_asking")
    const contents = [
      terminalContent("tab_done", "/repo/a", "pty_done"),
      terminalContent("tab_still", "/repo/a", "pty_still"),
      terminalContent("tab_gone", "/repo/a", "pty_gone"),
      terminalContent("tab_started", "/repo/a", "pty_started"),
      terminalContent("tab_asking", "/repo/a", "pty_asking"),
      terminalContent("tab_away", "/repo/b", "pty_away"),
    ]
    const state: AgentStatusReconcileState = {
      terminal,
      meta: { all: () => contents, get: (id: string) => contents.find((content) => content.id === id) },
    }
    const recorded: Record<string, string> = { pty_done: "Idle", pty_still: "Busy", pty_started: "Busy", pty_asking: "UserActionRequired" }
    const request: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      const directory = url.searchParams.get("scope") ?? url.searchParams.get("directory")
      if (directory === "/repo/b") return new Response("host away", { status: 502 })
      if (url.pathname.endsWith("/workspace/resolve")) return Response.json({ kind: "local" })
      if (url.pathname.endsWith("/api/wr/pty")) return Response.json([{ id: "pty_done" }, { id: "pty_still" }, { id: "pty_started" }, { id: "pty_asking" }])
      if (url.pathname.endsWith("/hook/terminal-session")) {
        const id = url.searchParams.get("terminalId") ?? ""
        return Response.json({ success: true, source: "runtime", terminalId: id, session: { terminalId: id, eventType: recorded[id] } })
      }
      return new Response("unexpected", { status: 404 })
    }
    await reconcileAgentStatuses(state, request)
    // Finished while unrouted: the live Idle path's "done" mark stays.
    expect(terminal.agentStatus("pty_done")).toBe("idle")
    expect(terminal.seen("pty_done")).toBe(true)
    expect(terminal.agentStatus("pty_still")).toBe("working")
    // Gone: nothing to mark done any more.
    expect(terminal.agentStatus("pty_gone")).toBe("idle")
    expect(terminal.seen("pty_gone")).toBe(false)
    // Started or asked while unrouted, never tracked before: healed too.
    expect(terminal.agentStatus("pty_started")).toBe("working")
    expect(terminal.agentStatus("pty_asking")).toBe("permission")
    expect(terminal.agentStatus("pty_away")).toBe("working")
  })

  test("a live frame landing during a terminal's read outranks the record read before it", async () => {
    const terminal = terminalSlice()
    // Shown as asking; the runtime's record says the agent had resumed.
    terminal.setAgentStatus("pty_x", "permission")
    terminal.own("tab_x", "pty_x")
    const contents = [terminalContent("tab_x", "/repo/a", "pty_x")]
    const state: AgentStatusReconcileState = { terminal, meta: { all: () => contents, get: (id: string) => contents.find((content) => content.id === id) } }
    let release: (() => void) | undefined
    const stalled = new Promise<void>((resolve) => { release = resolve })
    const request: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname.endsWith("/workspace/resolve")) return Response.json({ kind: "local" })
      if (url.pathname.endsWith("/api/wr/pty")) return Response.json([{ id: "pty_x" }])
      await stalled
      return Response.json({ success: true, source: "runtime", terminalId: "pty_x", session: { terminalId: "pty_x", eventType: "Busy" } })
    }
    const reconcile = reconcileAgentStatuses(state, request)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The agent finished while the record was in flight: the live path idled it.
    terminal.setAgentStatus("pty_x", "idle")
    release?.()
    await reconcile
    expect(terminal.agentStatus("pty_x")).toBe("idle")
  })

  test("a reconcile started later supersedes one still reading, so a stale record never lands over a fresher", async () => {
    const terminal = terminalSlice()
    terminal.own("tab_x", "pty_x")
    const contents = [terminalContent("tab_x", "/repo/a", "pty_x")]
    const state: AgentStatusReconcileState = { terminal, meta: { all: () => contents, get: (id: string) => contents.find((content) => content.id === id) } }
    let recorded = "Busy"
    let release: (() => void) | undefined
    const stalled = new Promise<void>((resolve) => { release = resolve })
    const request: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname.endsWith("/workspace/resolve")) return Response.json({ kind: "local" })
      if (url.pathname.endsWith("/api/wr/pty")) return Response.json([{ id: "pty_x" }])
      const answer = recorded
      if (answer === "Busy") await stalled
      return Response.json({ success: true, source: "runtime", terminalId: "pty_x", session: { terminalId: "pty_x", eventType: answer } })
    }
    const first = reconcileAgentStatuses(state, request)
    await new Promise((resolve) => setTimeout(resolve, 0))
    recorded = "Idle"
    await reconcileAgentStatuses(state, request)
    expect(terminal.agentStatus("pty_x")).toBe("idle")
    release?.()
    await first
    expect(terminal.agentStatus("pty_x")).toBe("idle")
  })
})

describe("terminalLifecycleSound", () => {
  const sounds = (enabled: { agent?: boolean; permissions?: boolean } = {}) => ({
    agentEnabled: () => enabled.agent ?? true,
    agent: () => "agent-sound",
    permissionsEnabled: () => enabled.permissions ?? true,
    permissions: () => "permission-sound",
  })

  test("an unfocused terminal that starts waiting on the user plays the permissions sound once", () => {
    expect(terminalLifecycleSound({ eventType: "UserActionRequired", previousStatus: "working", focused: false, sounds: sounds() })).toBe("permission-sound")
    expect(terminalLifecycleSound({ eventType: "UserActionRequired", previousStatus: "idle", focused: false, sounds: sounds() })).toBe("permission-sound")
    expect(terminalLifecycleSound({ eventType: "UserActionRequired", previousStatus: "permission", focused: false, sounds: sounds() })).toBeUndefined()
    expect(terminalLifecycleSound({ eventType: "UserActionRequired", previousStatus: "working", focused: true, sounds: sounds() })).toBeUndefined()
    expect(terminalLifecycleSound({ eventType: "UserActionRequired", previousStatus: "working", focused: false, sounds: sounds({ permissions: false }) })).toBeUndefined()
  })

  test("completion keeps the agent sound and cancellation, busy and error frames stay silent", () => {
    expect(terminalLifecycleSound({ eventType: "Idle", previousStatus: "working", focused: false, sounds: sounds() })).toBe("agent-sound")
    expect(terminalLifecycleSound({ eventType: "Idle", outcome: "cancelled", previousStatus: "working", focused: false, sounds: sounds() })).toBeUndefined()
    expect(terminalLifecycleSound({ eventType: "Idle", previousStatus: "working", focused: false, sounds: sounds({ agent: false }) })).toBeUndefined()
    expect(terminalLifecycleSound({ eventType: "Busy", previousStatus: "permission", focused: false, sounds: sounds() })).toBeUndefined()
    expect(terminalLifecycleSound({ eventType: "Error", previousStatus: "working", focused: false, sounds: sounds() })).toBeUndefined()
  })
})

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
