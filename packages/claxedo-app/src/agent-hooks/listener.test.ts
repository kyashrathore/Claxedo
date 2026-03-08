/**
 * Agent Lifecycle Listener Tests
 *
 * Tests the defensive layers that clear stuck agent status indicators:
 *
 * 1. usePtyExitCleanup — subscribes to pty.exited events and clears
 *    stuck "working"/"permission" statuses on the frontend
 * 2. useAgentLifecycleListener — processes agent.lifecycle events
 *    including the server-side Idle emit on PTY exit
 * 3. onAgentInterrupt logic — Ctrl+C/Escape keypress clears status
 *    (tested as standalone logic against the real store)
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { batch, createEffect, createRoot } from "solid-js"
import { ensureLayoutMocked, getInitLayout } from "../claxedo-ui/context/_test-helper"

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

type Listener = (event: any) => void

function createMockEmitter() {
  const onListeners = new Map<string, Set<Listener>>()
  const listenFns = new Set<Listener>()

  return {
    /** Mimics sdk.event.on(type, fn) */
    on(type: string, fn: Listener) {
      if (!onListeners.has(type)) onListeners.set(type, new Set())
      onListeners.get(type)!.add(fn)
      return () => {
        onListeners.get(type)?.delete(fn)
      }
    },
    /** Mimics sdk.event.listen(fn) — receives all events */
    listen(fn: Listener) {
      listenFns.add(fn)
      return () => {
        listenFns.delete(fn)
      }
    },
    /** Emit to on(type, ...) listeners */
    emitOn(type: string, payload: any) {
      const fns = onListeners.get(type)
      if (!fns) return
      for (const fn of fns) fn(payload)
    },
    /** Emit to listen(...) listeners — wraps in { name, details } like the real SDK */
    emitListen(directory: string, details: any) {
      for (const fn of listenFns) fn({ name: directory, details })
    },
  }
}

let mockEmitter = createMockEmitter()

// ---------------------------------------------------------------------------
// Module mocks — must be registered before importing listener.ts
// ---------------------------------------------------------------------------

// @ts-expect-error bun:test types only available at test runtime
import { mock } from "bun:test"

// Mock global SDK
mock.module("@/context/global-sdk", () => ({
  get useGlobalSDK() {
    return () => ({ event: mockEmitter })
  },
}))

// Mock settings
mock.module("@/context/settings", () => ({
  get useSettings() {
    return () => ({
      sounds: {
        agent: () => "none",
        errors: () => "none",
      },
    })
  },
}))

// Mock sound utilities
mock.module("@/utils/sound", () => ({
  playSound: () => {},
  soundSrc: () => "",
}))

// Mock debug logger — must match the full shape (log, verbose, level, enabled)
const noopDebug = {
  log: () => {},
  verbose: () => {},
  level: () => 0,
  enabled: () => false,
}
mock.module("../overrides/utils/debug", () => ({
  createDebugLogger: () => noopDebug,
  getDebugLevel: () => 0,
  isDebugEnabled: () => false,
  setDebugTrace: () => {},
  patchDebugTrace: () => {},
  clearDebugTrace: () => {},
  readDebugTraceHistory: () => [],
  clearDebugTraceHistory: () => {},
}))

// The layout mock uses the real store via _test-helper
let initLayout: () => any

// We'll inject the real layout API into useClaxedoLayout via a mutable reference
let currentApi: any = null

mock.module("../claxedo-ui/context/claxedo-layout", () => ({
  get useClaxedoLayout() {
    return () => currentApi
  },
  // Re-export types that listener.ts imports
  get TabItem() {
    return {}
  },
  get TerminalAgentStatus() {
    return {}
  },
}))

// ---------------------------------------------------------------------------
// Import under test — AFTER mocks are registered
// ---------------------------------------------------------------------------

let usePtyExitCleanup: () => void
let useAgentLifecycleListener: () => void

beforeAll(async () => {
  await ensureLayoutMocked()
  initLayout = getInitLayout()

  // Dynamically import the listener module after mocks are in place
  const key = `${Date.now()}-${Math.random()}`
  const mod = await import(`./listener.ts?test=${key}`)
  usePtyExitCleanup = mod.usePtyExitCleanup
  useAgentLifecycleListener = mod.useAgentLifecycleListener
})

beforeEach(() => {
  mockEmitter = createMockEmitter()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh layout store + hook wired together inside a SolidJS root */
function createTestHarness(hook: () => void) {
  let dispose!: () => void
  let api: any

  createRoot((d) => {
    dispose = d
    api = initLayout()
    currentApi = api
    hook()
  })

  return { api: api!, dispose }
}

/** Add a terminal tab and set up ownership + pane structure */
function addTerminal(api: any, dir: string, ptyId: string, groupId?: string) {
  const gid = groupId ?? api.split.orderedGroups()[0].id
  const tabs = api.groupTabs(gid)
  const tabId = tabs.addTerminal(dir, ptyId, `Terminal ${ptyId}`)
  api.terminal.own(tabId, ptyId)
  api.terminal.ensure(tabId, ptyId)
  return { tabId, groupId: gid }
}

function getTab(api: any, tabId: string) {
  for (const group of api.split.orderedGroups()) {
    const tab = group.tabs.items.find((t: any) => t.id === tabId)
    if (tab) return tab
  }
  return undefined
}

// ===========================================================================
// usePtyExitCleanup
// ===========================================================================

describe("usePtyExitCleanup", () => {
  test("clears working status when pty exits", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-1")
      api.terminal.setAgentStatus("pty-1", "working")
      api.patchTab(tabId, { loading: true })

      expect(api.terminal.agentStatus("pty-1")).toBe("working")

      // Simulate pty.exited
      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-1", exitCode: 0 } })

      expect(api.terminal.agentStatus("pty-1")).toBe("idle")
      expect(api.terminal.isTracked("pty-1")).toBe(true)

      const tab = getTab(api, tabId)
      expect(tab?.loading).toBe(false)
    } finally {
      dispose()
    }
  })

  test("clears permission status when pty exits", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-2")
      api.terminal.setAgentStatus("pty-2", "permission")
      api.patchTab(tabId, { attention: true })

      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-2", exitCode: 0 } })

      expect(api.terminal.agentStatus("pty-2")).toBe("idle")

      const tab = getTab(api, tabId)
      expect(tab?.attention).toBe(false)
    } finally {
      dispose()
    }
  })

  test("no-op for untracked terminals", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      // pty-unknown was never tracked
      expect(api.terminal.isTracked("pty-unknown")).toBe(false)

      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-unknown", exitCode: 0 } })

      // Should still be untracked — the hook didn't create any entry
      expect(api.terminal.isTracked("pty-unknown")).toBe(false)
      expect(api.terminal.agentStatus("pty-unknown")).toBe("idle")
    } finally {
      dispose()
    }
  })

  test("no-op for terminals already idle", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-idle")
      // Set to working then back to idle (simulates normal agent completion)
      api.terminal.setAgentStatus("pty-idle", "working")
      api.terminal.setAgentStatus("pty-idle", "idle")
      api.patchTab(tabId, { loading: false, done: true })

      const tabBefore = getTab(api, tabId)
      const doneBefore = tabBefore?.done

      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-idle", exitCode: 0 } })

      // Status unchanged
      expect(api.terminal.agentStatus("pty-idle")).toBe("idle")
      // done flag should not have been cleared
      const tabAfter = getTab(api, tabId)
      expect(tabAfter?.done).toBe(doneBefore)
    } finally {
      dispose()
    }
  })

  test("no-op when event has no id", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      addTerminal(api, "/ws", "pty-noid")
      api.terminal.setAgentStatus("pty-noid", "working")

      // Event with missing id
      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: {} })

      // Status unchanged
      expect(api.terminal.agentStatus("pty-noid")).toBe("working")
    } finally {
      dispose()
    }
  })

  test("ignores non-pty.exited events", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      addTerminal(api, "/ws", "pty-other")
      api.terminal.setAgentStatus("pty-other", "working")

      mockEmitter.emitListen("/ws", { type: "pty.created", properties: { id: "pty-other" } })

      expect(api.terminal.agentStatus("pty-other")).toBe("working")
    } finally {
      dispose()
    }
  })

  test("handles terminal with no owning tab gracefully", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      // Set agent status but don't own it to any tab
      api.terminal.setAgentStatus("pty-orphan", "working")
      expect(api.terminal.owner("pty-orphan")).toBeUndefined()

      // Should clear status without throwing
      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-orphan", exitCode: 0 } })

      expect(api.terminal.agentStatus("pty-orphan")).toBe("idle")
    } finally {
      dispose()
    }
  })

  test("multi-terminal tab: one exit keeps other terminal's status", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-m1", "Terminal M1")
      api.terminal.own(tabId, "pty-m1")
      api.terminal.ensure(tabId, "pty-m1")
      api.terminal.split({ tab: tabId, at: "pty-m1", id: "pty-m2", dir: "h" })
      api.terminal.own(tabId, "pty-m2")

      // Both terminals working
      api.terminal.setAgentStatus("pty-m1", "working")
      api.terminal.setAgentStatus("pty-m2", "working")
      api.patchTab(tabId, { loading: true })

      // pty-m1 exits
      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-m1", exitCode: 0 } })

      // pty-m1 cleared, pty-m2 still working
      expect(api.terminal.agentStatus("pty-m1")).toBe("idle")
      expect(api.terminal.agentStatus("pty-m2")).toBe("working")

      // Tab should still be loading (pty-m2 is still working)
      const tab = getTab(api, tabId)
      expect(tab?.loading).toBe(true)
    } finally {
      dispose()
    }
  })

  test("multi-terminal tab: last exit clears tab loading", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-l1", "Terminal L1")
      api.terminal.own(tabId, "pty-l1")
      api.terminal.ensure(tabId, "pty-l1")
      api.terminal.split({ tab: tabId, at: "pty-l1", id: "pty-l2", dir: "h" })
      api.terminal.own(tabId, "pty-l2")

      api.terminal.setAgentStatus("pty-l1", "working")
      api.terminal.setAgentStatus("pty-l2", "permission")
      api.patchTab(tabId, { loading: true, attention: true })

      // Both exit
      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-l1", exitCode: 0 } })
      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-l2", exitCode: 0 } })

      expect(api.terminal.agentStatus("pty-l1")).toBe("idle")
      expect(api.terminal.agentStatus("pty-l2")).toBe("idle")

      const tab = getTab(api, tabId)
      expect(tab?.loading).toBe(false)
      expect(tab?.attention).toBe(false)
    } finally {
      dispose()
    }
  })

  test("idempotent: double pty.exited for same terminal", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-double")
      api.terminal.setAgentStatus("pty-double", "working")

      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-double", exitCode: 0 } })
      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-double", exitCode: 0 } })

      // Should still be idle, not throw
      expect(api.terminal.agentStatus("pty-double")).toBe("idle")
    } finally {
      dispose()
    }
  })
})

// ===========================================================================
// useAgentLifecycleListener — server-side Idle on PTY exit
// ===========================================================================

describe("useAgentLifecycleListener", () => {
  test("Idle event from server clears working status", () => {
    const { api, dispose } = createTestHarness(useAgentLifecycleListener)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-srv-1")
      api.terminal.setAgentStatus("pty-srv-1", "working")
      api.patchTab(tabId, { loading: true })

      // Server emits Idle (layer 1: clearTerminalSession)
      mockEmitter.emitOn("global", {
        type: "agent.lifecycle",
        properties: {
          tabId,
          terminalId: "pty-srv-1",
          eventType: "Idle",
        },
      })

      expect(api.terminal.agentStatus("pty-srv-1")).toBe("idle")

      const tab = getTab(api, tabId)
      expect(tab?.loading).toBe(false)
    } finally {
      dispose()
    }
  })

  test("Busy event sets working status", () => {
    const { api, dispose } = createTestHarness(useAgentLifecycleListener)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-srv-busy")

      mockEmitter.emitOn("global", {
        type: "agent.lifecycle",
        properties: {
          tabId,
          terminalId: "pty-srv-busy",
          eventType: "Busy",
        },
      })

      expect(api.terminal.agentStatus("pty-srv-busy")).toBe("working")
      const tab = getTab(api, tabId)
      expect(tab?.loading).toBe(true)
    } finally {
      dispose()
    }
  })

  test("UserActionRequired event sets permission status", () => {
    const { api, dispose } = createTestHarness(useAgentLifecycleListener)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-srv-perm")

      mockEmitter.emitOn("global", {
        type: "agent.lifecycle",
        properties: {
          tabId,
          terminalId: "pty-srv-perm",
          eventType: "UserActionRequired",
        },
      })

      expect(api.terminal.agentStatus("pty-srv-perm")).toBe("permission")
      const tab = getTab(api, tabId)
      expect(tab?.attention).toBe(true)
    } finally {
      dispose()
    }
  })

  test("Start maps to working, Stop maps to idle", () => {
    const { api, dispose } = createTestHarness(useAgentLifecycleListener)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-srv-legacy")

      // Start (legacy event type)
      mockEmitter.emitOn("global", {
        type: "agent.lifecycle",
        properties: { tabId, terminalId: "pty-srv-legacy", eventType: "Start" },
      })
      expect(api.terminal.agentStatus("pty-srv-legacy")).toBe("working")

      // Stop (legacy event type)
      mockEmitter.emitOn("global", {
        type: "agent.lifecycle",
        properties: { tabId, terminalId: "pty-srv-legacy", eventType: "Stop" },
      })
      expect(api.terminal.agentStatus("pty-srv-legacy")).toBe("idle")
    } finally {
      dispose()
    }
  })

  test("tab lookup by terminalId when tabId doesn't match", () => {
    const { api, dispose } = createTestHarness(useAgentLifecycleListener)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-lookup")

      // Use a mismatched tabId, but the correct terminalId
      mockEmitter.emitOn("global", {
        type: "agent.lifecycle",
        properties: {
          tabId: "nonexistent-tab",
          terminalId: "pty-lookup",
          eventType: "Busy",
        },
      })

      // Should still find the tab via terminalId
      expect(api.terminal.agentStatus("pty-lookup")).toBe("working")
    } finally {
      dispose()
    }
  })

  test("ignores non-lifecycle events", () => {
    const { api, dispose } = createTestHarness(useAgentLifecycleListener)
    try {
      addTerminal(api, "/ws", "pty-srv-ignore")

      mockEmitter.emitOn("global", {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy" } },
      })

      // No status change
      expect(api.terminal.agentStatus("pty-srv-ignore")).toBe("idle")
      expect(api.terminal.isTracked("pty-srv-ignore")).toBe(false)
    } finally {
      dispose()
    }
  })
})

// ===========================================================================
// onAgentInterrupt logic (Ctrl+C / Escape in PaneTerminal)
// ===========================================================================

describe("onAgentInterrupt logic", () => {
  /**
   * Simulate the onAgentInterrupt callback from pane-terminal.tsx.
   * This tests the exact same logic used in the real component.
   */
  function simulateAgentInterrupt(api: any, ptyId: string, tabId: string) {
    if (!api.terminal.isTracked(ptyId)) return
    if (api.terminal.agentStatus(ptyId) === "idle") return

    batch(() => {
      api.terminal.setAgentStatus(ptyId, "idle")
      const aggregated = api.terminal.getTabAgentStatus(tabId)
      api.patchTab(tabId, {
        loading: aggregated.loading,
        done: aggregated.done,
        attention: aggregated.attention ? undefined : false,
      })
    })
  }

  test("clears working status on Ctrl+C", () => {
    let dispose!: () => void
    const api = createRoot((d) => {
      dispose = d
      return initLayout()
    })
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-ctrlc")
      api.terminal.setAgentStatus("pty-ctrlc", "working")
      api.patchTab(tabId, { loading: true })

      simulateAgentInterrupt(api, "pty-ctrlc", tabId)

      expect(api.terminal.agentStatus("pty-ctrlc")).toBe("idle")
      const tab = getTab(api, tabId)
      expect(tab?.loading).toBe(false)
    } finally {
      dispose()
    }
  })

  test("clears permission status on Escape", () => {
    let dispose!: () => void
    const api = createRoot((d) => {
      dispose = d
      return initLayout()
    })
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-esc")
      api.terminal.setAgentStatus("pty-esc", "permission")
      api.patchTab(tabId, { attention: true })

      simulateAgentInterrupt(api, "pty-esc", tabId)

      expect(api.terminal.agentStatus("pty-esc")).toBe("idle")
      const tab = getTab(api, tabId)
      expect(tab?.attention).toBe(false)
    } finally {
      dispose()
    }
  })

  test("no-op for untracked terminal", () => {
    let dispose!: () => void
    const api = createRoot((d) => {
      dispose = d
      return initLayout()
    })
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-untracked")
      // Never set agent status — terminal is not tracked

      simulateAgentInterrupt(api, "pty-untracked", tabId)

      expect(api.terminal.isTracked("pty-untracked")).toBe(false)
    } finally {
      dispose()
    }
  })

  test("no-op for terminal already idle", () => {
    let dispose!: () => void
    const api = createRoot((d) => {
      dispose = d
      return initLayout()
    })
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-already-idle")
      api.terminal.setAgentStatus("pty-already-idle", "working")
      api.terminal.setAgentStatus("pty-already-idle", "idle")
      api.patchTab(tabId, { loading: false, done: true })

      simulateAgentInterrupt(api, "pty-already-idle", tabId)

      // done should remain — interrupt on idle terminal doesn't clear it
      const tab = getTab(api, tabId)
      expect(tab?.done).toBe(true)
    } finally {
      dispose()
    }
  })

  test("multi-terminal: interrupt one keeps other working", () => {
    let dispose!: () => void
    const api = createRoot((d) => {
      dispose = d
      return initLayout()
    })
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-mi1", "Terminal MI1")
      api.terminal.own(tabId, "pty-mi1")
      api.terminal.ensure(tabId, "pty-mi1")
      api.terminal.split({ tab: tabId, at: "pty-mi1", id: "pty-mi2", dir: "h" })
      api.terminal.own(tabId, "pty-mi2")

      api.terminal.setAgentStatus("pty-mi1", "working")
      api.terminal.setAgentStatus("pty-mi2", "working")
      api.patchTab(tabId, { loading: true })

      // Interrupt only pty-mi1
      simulateAgentInterrupt(api, "pty-mi1", tabId)

      expect(api.terminal.agentStatus("pty-mi1")).toBe("idle")
      expect(api.terminal.agentStatus("pty-mi2")).toBe("working")

      // Tab still loading because pty-mi2 is working
      const tab = getTab(api, tabId)
      expect(tab?.loading).toBe(true)
    } finally {
      dispose()
    }
  })
})

// ===========================================================================
// Defense-in-depth: multiple layers firing for same event
// ===========================================================================

describe("defense-in-depth: idempotent multi-layer cleanup", () => {
  test("server Idle + pty.exited double-fire: second is no-op", () => {
    const { api, dispose } = createTestHarness(() => {
      useAgentLifecycleListener()
      usePtyExitCleanup()
    })
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-both")
      api.terminal.setAgentStatus("pty-both", "working")
      api.patchTab(tabId, { loading: true })

      // Layer 1: server emits Idle
      mockEmitter.emitOn("global", {
        type: "agent.lifecycle",
        properties: { tabId, terminalId: "pty-both", eventType: "Idle" },
      })

      expect(api.terminal.agentStatus("pty-both")).toBe("idle")

      // Layer 3: pty.exited also fires — should be no-op
      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-both", exitCode: 0 } })

      expect(api.terminal.agentStatus("pty-both")).toBe("idle")
      const tab = getTab(api, tabId)
      expect(tab?.loading).toBe(false)
    } finally {
      dispose()
    }
  })

  test("Ctrl+C interrupt + pty.exited: both clear, no crash", () => {
    const { api, dispose } = createTestHarness(usePtyExitCleanup)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-ctrlc-exit")
      api.terminal.setAgentStatus("pty-ctrlc-exit", "working")
      api.patchTab(tabId, { loading: true })

      // Layer 2+4: Ctrl+C fires onAgentInterrupt first
      batch(() => {
        api.terminal.setAgentStatus("pty-ctrlc-exit", "idle")
        const agg = api.terminal.getTabAgentStatus(tabId)
        api.patchTab(tabId, { loading: agg.loading, done: agg.done })
      })

      expect(api.terminal.agentStatus("pty-ctrlc-exit")).toBe("idle")

      // Layer 3: pty.exited fires later — should be no-op
      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-ctrlc-exit", exitCode: 0 } })

      expect(api.terminal.agentStatus("pty-ctrlc-exit")).toBe("idle")
    } finally {
      dispose()
    }
  })

  test("all three layers for same terminal: no crash, ends idle", () => {
    const { api, dispose } = createTestHarness(() => {
      useAgentLifecycleListener()
      usePtyExitCleanup()
    })
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-triple")
      api.terminal.setAgentStatus("pty-triple", "working")
      api.patchTab(tabId, { loading: true })

      // Ctrl+C (inline logic)
      batch(() => {
        api.terminal.setAgentStatus("pty-triple", "idle")
        const agg = api.terminal.getTabAgentStatus(tabId)
        api.patchTab(tabId, { loading: agg.loading, done: agg.done })
      })

      // Server Idle
      mockEmitter.emitOn("global", {
        type: "agent.lifecycle",
        properties: { tabId, terminalId: "pty-triple", eventType: "Idle" },
      })

      // PTY exit
      mockEmitter.emitListen("/ws", { type: "pty.exited", properties: { id: "pty-triple", exitCode: 0 } })

      // All three fired, still idle, no crash
      expect(api.terminal.agentStatus("pty-triple")).toBe("idle")
      const tab = getTab(api, tabId)
      expect(tab?.loading).toBe(false)
    } finally {
      dispose()
    }
  })
})

// ===========================================================================
// Optimistic interrupt: agent re-sends Busy after Ctrl+C
// ===========================================================================

describe("optimistic interrupt recovery", () => {
  test("Ctrl+C clears status, agent re-sends Busy → tab shows loading again", () => {
    const { api, dispose } = createTestHarness(useAgentLifecycleListener)
    try {
      const { tabId } = addTerminal(api, "/ws", "pty-recover")

      // Agent starts
      mockEmitter.emitOn("global", {
        type: "agent.lifecycle",
        properties: { tabId, terminalId: "pty-recover", eventType: "Busy" },
      })
      expect(api.terminal.agentStatus("pty-recover")).toBe("working")

      // User presses Ctrl+C — clears optimistically
      batch(() => {
        api.terminal.setAgentStatus("pty-recover", "idle")
        const agg = api.terminal.getTabAgentStatus(tabId)
        api.patchTab(tabId, { loading: agg.loading })
      })
      expect(api.terminal.agentStatus("pty-recover")).toBe("idle")
      expect(getTab(api, tabId)?.loading).toBe(false)

      // Agent survived Ctrl+C and re-sends Busy
      mockEmitter.emitOn("global", {
        type: "agent.lifecycle",
        properties: { tabId, terminalId: "pty-recover", eventType: "Busy" },
      })

      expect(api.terminal.agentStatus("pty-recover")).toBe("working")
      expect(getTab(api, tabId)?.loading).toBe(true)
    } finally {
      dispose()
    }
  })
})
