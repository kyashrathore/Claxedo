import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import type { TabItem } from "../context/claxedo-layout"
import type { Pane } from "../context/claxedo-layout/types"

type Queue = {
  tabId: string
  directory: string
  command?: string
  title?: string
  groupId?: string
  previousPtyId?: string
}

type Harness = ReturnType<typeof createHarness>
let harness: Harness

function createHarness(input: {
  ptys?: Array<{ id: string; title: string; titleNumber?: number; cwd?: string }>
  tabs?: TabItem[]
  ids?: string[]
  focus?: string
  pane?: Pane
  queued?: Queue
  lifecycleById?: Record<string, "creating" | "attaching" | "attached" | "closing" | "closed" | undefined>
  createdId?: string
} = {}) {
  const [ptys, setPtys] = createSignal(
    input.ptys ?? [{ id: "pty-live", title: "Terminal 1", titleNumber: 1, cwd: "/ws" }],
  )
  const [tabs, setTabs] = createSignal<TabItem[]>(
    input.tabs ?? [
      {
        id: "tab-1",
        type: "terminal",
        directory: "/ws",
        terminalId: "pty-live",
        title: "Terminal 1",
        closable: true,
      },
    ],
  )
  const [ids, setIds] = createSignal(input.ids ?? ["pty-live"])
  const [focus, setFocus] = createSignal(input.focus ?? "pty-live")
  const [queue, setQueue] = createSignal(input.queued)
  const patches: Array<{ id: string; patch: Partial<TabItem> }> = []
  const replaced: Array<{ tab: string; from: string; to: string }> = []
  const focusSets: string[] = []
  const closeCalls: string[] = []
  const disownCalls: string[] = []
  const clearClosingCalls: string[] = []
  const lifecycleTransitions: Array<{ id: string; state: string; reason: string }> = []
  const closedByLifecycle: string[] = []
  const terminal = {
    all: () => ptys(),
    new: vi.fn(async () => input.createdId ?? "pty-new"),
    close: vi.fn(async (id: string) => {
      closeCalls.push(id)
    }),
    update: vi.fn(),
    clone: vi.fn(async () => "pty-clone"),
  }

  const groupTabs = {
    items: () => tabs(),
    patch: (id: string, patch: Partial<TabItem>) => {
      patches.push({ id, patch })
      setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)))
    },
    addFile: vi.fn(),
    setActive: vi.fn(),
  }

  const claxedo = {
    groupTabs: () => groupTabs,
    terminal: {
      ids: () => ids(),
      focus: () => focus(),
      setFocus: (_tabId: string, id: string) => {
        focusSets.push(id)
        setFocus(id)
      },
      pane: () => input.pane,
      ensure: vi.fn(),
      lifecycle: (id: string) => input.lifecycleById?.[id],
      isClosing: (id: string) => input.lifecycleById?.[id] === "closing",
      close: ({ id }: { tab: string; id: string }) => closeCalls.push(id),
      disown: (id: string) => disownCalls.push(id),
      clearClosing: (id: string) => clearClosingCalls.push(id),
      replaceId: (tab: string, from: string, to: string) => replaced.push({ tab, from, to }),
      transitionLifecycle: (id: string, state: string, reason: string) =>
        lifecycleTransitions.push({ id, state, reason }),
      zoom: () => undefined,
      peekCreateForTab: () => queue(),
      consumeCreateForTab: () => {
        const next = queue()
        setQueue(undefined)
        return next
      },
      own: vi.fn(),
      splitInTab: vi.fn(),
      resize: vi.fn(),
    },
  }

  const resolveLiveFocus = () => ids().find((id) => ptys().some((pty) => pty.id === id))

  return {
    terminal,
    claxedo,
    groupTabs,
    setTabs,
    setPtys,
    setIds,
    setFocus,
    resolveLiveFocus,
    patches,
    replaced,
    focusSets,
    closeCalls,
    disownCalls,
    clearClosingCalls,
    lifecycleTransitions,
    closedByLifecycle,
  }
}

vi.mock("@/context/terminal", () => ({
  useTerminal: () => harness.terminal,
}))

vi.mock("../context/claxedo-layout", () => ({
  useClaxedoLayout: () => harness.claxedo,
}))

vi.mock("./terminal-panel/lifecycle", () => ({
  createTerminalPanelLifecycle: (deps: { tabId: string; groupId: string }) => ({
    isUsablePtyId: (id: string | undefined) => !!id && !id.startsWith("pending-"),
    closePty: (id: string) => harness.closedByLifecycle.push(id),
    persistUpdate: vi.fn(),
    resolveLiveFocus: (_tabId: string | undefined) => harness.resolveLiveFocus(),
    terminalOrigin: () => ({
      tabId: deps.tabId,
      groupId: deps.groupId,
      hostId: `claxedo-tab-host-${deps.tabId}`,
    }),
  }),
}))

vi.mock("./terminal-panel/split", () => ({
  createTerminalPanelSplit: () => ({
    splitPending: () => undefined,
    splitFor: vi.fn(),
  }),
}))

vi.mock("./terminal-panel/pane-actions", () => ({
  createTerminalPaneActions: () => ({
    closePane: vi.fn(),
    detachPane: vi.fn(),
    focusPane: vi.fn(),
  }),
}))

vi.mock("./terminal-panel/interactions", () => ({
  createTerminalPanelInteractions: () => ({
    moveState: () => undefined,
    overState: () => undefined,
    startMove: vi.fn(),
  }),
}))

vi.mock("./terminal-panel/renderers", () => ({
  createTerminalPanelRenderers: () => ({
    FlatPaneRenderer: () => <div data-testid="terminal-panel" />,
    emptyFallback: () => <div data-testid="terminal-empty">Terminal not found</div>,
  }),
}))

import { TerminalPanel } from "./terminal-panel"

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

describe("TerminalPanel effects", () => {
  test("consumes queued pending-create and binds created PTY to tab", async () => {
    harness = createHarness({
      tabs: [
        {
          id: "tab-1",
          type: "terminal",
          directory: "/ws",
          terminalId: undefined,
          title: "Terminal 1",
          closable: true,
        },
      ],
      ids: ["pending-1"],
      pane: { t: "leaf", id: "pending-1" },
      queued: { tabId: "tab-1", directory: "/ws", groupId: "g-default" },
      createdId: "pty-created",
    })

    render(() => <TerminalPanel ptyId="pending-1" directory="/ws" groupId="g-default" tabId="tab-1" />)

    await waitFor(() => {
      expect(harness.terminal.new).toHaveBeenCalledTimes(1)
      expect(harness.replaced).toEqual([{ tab: "tab-1", from: "pending-1", to: "pty-created" }])
    })

    expect(harness.patches).toContainEqual({ id: "tab-1", patch: { terminalId: "pty-created" } })
    expect(harness.focusSets).toContain("pty-created")
    expect(harness.lifecycleTransitions).toContainEqual({
      id: "pty-created",
      state: "attached",
      reason: "pending_tab_create_ready",
    })
  })

  test("prunes stale closed PTYs and repairs tab terminalId to a live leaf", async () => {
    harness = createHarness({
      ptys: [{ id: "pty-live", title: "Terminal 1", titleNumber: 1, cwd: "/ws" }],
      ids: ["pty-stale", "pty-live"],
      focus: "pty-stale",
      pane: { t: "leaf", id: "pty-live" },
      tabs: [
        {
          id: "tab-1",
          type: "terminal",
          directory: "/ws",
          terminalId: "pty-stale",
          title: "Terminal old",
          closable: true,
        },
      ],
      lifecycleById: { "pty-stale": "closing", "pty-live": "attached" },
    })

    render(() => <TerminalPanel ptyId="pty-live" directory="/ws" groupId="g-default" tabId="tab-1" />)

    await waitFor(() => {
      expect(harness.closeCalls).toContain("pty-stale")
      expect(harness.disownCalls).toContain("pty-stale")
      expect(harness.clearClosingCalls).toContain("pty-stale")
    })

    expect(harness.patches).toContainEqual({
      id: "tab-1",
      patch: { terminalId: "pty-live", title: "Terminal 1" },
    })
    expect(harness.focusSets).toContain("pty-live")
  })

  test("repairs stale focus pointer to a live pane id", async () => {
    harness = createHarness({
      ptys: [{ id: "pty-live", title: "Terminal 1", titleNumber: 1, cwd: "/ws" }],
      ids: ["pty-stale", "pty-live"],
      focus: "pty-stale",
      pane: { t: "leaf", id: "pty-live" },
      lifecycleById: { "pty-stale": "attached", "pty-live": "attached" },
    })

    render(() => <TerminalPanel ptyId="pty-live" directory="/ws" groupId="g-default" tabId="tab-1" />)

    await waitFor(() => {
      expect(harness.focusSets).toContain("pty-live")
    })
  })

  test("force-closes all bound PTYs when the tab is removed", async () => {
    harness = createHarness({
      ids: ["pty-live", "pty-extra"],
      tabs: [
        {
          id: "tab-1",
          type: "terminal",
          directory: "/ws",
          terminalId: "pty-live",
          title: "Terminal 1",
          closable: true,
        },
      ],
      pane: { t: "leaf", id: "pty-live" },
    })

    render(() => <TerminalPanel ptyId="pty-live" directory="/ws" groupId="g-default" tabId="tab-1" />)
    harness.setTabs([])

    await waitFor(() => {
      expect(harness.closedByLifecycle).toContain("pty-live")
      expect(harness.closedByLifecycle).toContain("pty-extra")
    })
  })
})
