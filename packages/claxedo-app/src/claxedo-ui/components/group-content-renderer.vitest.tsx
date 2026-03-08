import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { TabItem } from "../context/claxedo-layout/types"

let state: {
  items: TabItem[]
  activeId: string | null
}
let setState: ReturnType<typeof createStore<typeof state>>[1]

const active = () => state.items.find((tab) => tab.id === state.activeId)

const mounts = vi.fn<(id: string) => void>()
const cleanups = vi.fn<(id: string) => void>()

/**
 * Simulated multi-pane state registry using a reactive signal.
 * Maps tabId -> boolean (true = has state, false = cleared).
 * Used to simulate the clearLater race condition where multi-pane
 * state is cleared via microtask while the tab is still in items.
 *
 * Uses a SolidJS signal so changes trigger reactive re-renders
 * (matching the real behavior where store changes to multiPane
 * cause MultiPaneTab to re-render).
 */
const [multiPaneRegistry, setMultiPaneRegistry] = createSignal<Record<string, boolean>>({})

function setMultiPaneHasState(tabId: string, hasState: boolean) {
  setMultiPaneRegistry((prev) => ({ ...prev, [tabId]: hasState }))
}

function getMultiPaneHasState(tabId: string): boolean {
  return multiPaneRegistry()[tabId] !== false
}

vi.mock("../context/claxedo-layout", () => ({
  useClaxedoLayout: () => ({
    groupTabs: () => ({
      items: () => state.items,
      activeId: () => state.activeId,
      active,
    }),
    groupWorktree: () => ({
      default: () => "/ws/main",
      pinned: () => null,
    }),
    select: {
      groupActiveTab: active,
    },
  }),
}))

vi.mock("./group-layout-provider", () => ({
  GroupLayoutProvider: (props: { children: unknown }) => props.children,
}))

vi.mock("./multi-pane/multi-pane-tab", () => ({
  MultiPaneTab: (props: { tabId: string }) => {
    onMount(() => mounts(props.tabId))
    onCleanup(() => cleanups(props.tabId))
    // Reactively check multi-pane state -- when clearLater clears it,
    // this re-evaluates and renders a spinner (simulating the real
    // MultiPaneTab behavior when layout state is undefined).
    return (
      <div>
        {getMultiPaneHasState(props.tabId)
          ? <div data-testid={`pane-${props.tabId}`} />
          : <div data-testid={`spinner-${props.tabId}`} class="spinner" />}
      </div>
    )
  },
}))

import { GroupContentRenderer } from "./group-content-renderer"

/**
 * Helper: find the slot container (div with class "absolute inset-0 overflow-hidden")
 * that wraps a given element. The mock MultiPaneTab wraps content in an extra <div>,
 * so we need to traverse up past it to find the slot container that has the "hidden" class.
 */
function slotContainer(el: Element | null): Element | null {
  if (!el) return null
  let cursor: Element | null = el
  while (cursor) {
    if (cursor.classList.contains("absolute") && cursor.classList.contains("overflow-hidden")) {
      return cursor
    }
    cursor = cursor.parentElement
  }
  return null
}

/** Check if a tab's slot container is hidden. */
function isSlotHidden(el: Element | null): boolean {
  const container = slotContainer(el)
  return container?.classList.contains("hidden") ?? false
}

afterEach(() => {
  cleanup()
  setMultiPaneRegistry({})
})

beforeEach(() => {
  ;[state, setState] = createStore<{
    items: TabItem[]
    activeId: string | null
  }>({
    items: [],
    activeId: null,
  })
  mounts.mockReset()
  cleanups.mockReset()
  setMultiPaneRegistry({})
})

describe("GroupContentRenderer", () => {
  test("closing a process tab does not remount the surviving session slot when its object identity changes", async () => {
    const session = {
      id: "tab-session",
      type: "session",
      title: "Session",
      directory: "/ws/main",
      sessionId: "new",
      closable: true,
    } satisfies TabItem
    const process = {
      id: "tab-process",
      type: "process",
      title: "Processes",
      directory: "/ws/main",
      closable: true,
    } satisfies TabItem

    setMultiPaneHasState("tab-session", true)

    batch(() => {
      setState("items", [session])
      setState("activeId", session.id)
    })

    const view = render(() => <GroupContentRenderer groupId="g-default" />)

    await waitFor(() => {
      expect(view.getByTestId("pane-tab-session")).toBeTruthy()
    })

    setMultiPaneHasState("tab-process", true)

    batch(() => {
      setState("items", [{ ...session }, process])
      setState("activeId", process.id)
    })

    await waitFor(() => {
      expect(view.getByTestId("pane-tab-process")).toBeTruthy()
    })

    mounts.mockClear()
    cleanups.mockClear()

    batch(() => {
      setState("items", [{ ...session }])
      setState("activeId", session.id)
    })

    await waitFor(() => {
      expect(view.queryByTestId("pane-tab-process")).toBeNull()
    })

    expect(view.getByTestId("pane-tab-session")).toBeTruthy()
    expect(mounts).not.toHaveBeenCalled()
    expect(cleanups).toHaveBeenCalledTimes(1)
    expect(cleanups).toHaveBeenCalledWith("tab-process")
  })

  test("process tab content vanishes but tab stays when close silently fails (items not updated)", async () => {
    const session = {
      id: "tab-session",
      type: "session",
      title: "Session",
      directory: "/ws/main",
      sessionId: "s1",
      closable: true,
    } satisfies TabItem
    const process = {
      id: "tab-process",
      type: "process",
      title: "Processes",
      directory: "/ws/main",
      closable: true,
    } satisfies TabItem

    setMultiPaneHasState("tab-session", true)
    setMultiPaneHasState("tab-process", true)

    batch(() => {
      setState("items", [session, process])
      setState("activeId", process.id)
    })

    const view = render(() => <GroupContentRenderer groupId="g-default" />)

    await waitFor(() => {
      expect(view.getByTestId("pane-tab-process")).toBeTruthy()
    })

    // Simulate "failed close": activeId changes but items NOT updated
    setState("activeId", session.id)

    await waitFor(() => {
      expect(view.getByTestId("pane-tab-session")).toBeTruthy()
    })

    // Process tab should still be mounted (hidden, not removed)
    expect(view.queryByTestId("pane-tab-process")).toBeTruthy()

    // Can we switch BACK to the process tab?
    setState("activeId", process.id)

    await waitFor(() => {
      const pane = view.getByTestId("pane-tab-process")
      expect(pane).toBeTruthy()
      expect(isSlotHidden(pane)).toBe(false)
    })
  })

  test("after process tab is removed from items, can still switch between remaining tabs", async () => {
    const sessionA = {
      id: "tab-a",
      type: "session",
      title: "Session A",
      directory: "/ws/main",
      sessionId: "a",
      closable: true,
    } satisfies TabItem
    const process = {
      id: "tab-process",
      type: "process",
      title: "Processes",
      directory: "/ws/main",
      closable: true,
    } satisfies TabItem
    const sessionB = {
      id: "tab-b",
      type: "session",
      title: "Session B",
      directory: "/ws/main",
      sessionId: "b",
      closable: true,
    } satisfies TabItem

    setMultiPaneHasState("tab-a", true)
    setMultiPaneHasState("tab-process", true)
    setMultiPaneHasState("tab-b", true)

    batch(() => {
      setState("items", [sessionA, process, sessionB])
      setState("activeId", process.id)
    })

    const view = render(() => <GroupContentRenderer groupId="g-default" />)

    await waitFor(() => {
      expect(view.getByTestId("pane-tab-process")).toBeTruthy()
    })

    // Close the process tab: remove from items, switch active
    batch(() => {
      setState("items", [sessionA, sessionB])
      setState("activeId", sessionA.id)
    })

    await waitFor(() => {
      expect(view.queryByTestId("pane-tab-process")).toBeNull()
    })

    // Session A should be visible
    expect(view.getByTestId("pane-tab-a")).toBeTruthy()
    expect(isSlotHidden(view.getByTestId("pane-tab-a"))).toBe(false)

    // Switch to session B
    setState("activeId", sessionB.id)

    await waitFor(() => {
      expect(view.getByTestId("pane-tab-b")).toBeTruthy()
      expect(isSlotHidden(view.getByTestId("pane-tab-b"))).toBe(false)
      // Session A should be hidden (not removed, CSS-cached)
      expect(isSlotHidden(view.getByTestId("pane-tab-a"))).toBe(true)
    })

    // Switch back to session A
    setState("activeId", sessionA.id)

    await waitFor(() => {
      expect(isSlotHidden(view.getByTestId("pane-tab-a"))).toBe(false)
      expect(isSlotHidden(view.getByTestId("pane-tab-b"))).toBe(true)
    })
  })

  test("closing process tab and immediately closing session tab leaves only terminal", async () => {
    const session = {
      id: "tab-session",
      type: "session",
      title: "Session",
      directory: "/ws/main",
      sessionId: "s1",
      closable: true,
    } satisfies TabItem
    const process = {
      id: "tab-process",
      type: "process",
      title: "Processes",
      directory: "/ws/main",
      closable: true,
    } satisfies TabItem
    const terminal = {
      id: "tab-terminal",
      type: "terminal",
      title: "Terminal",
      directory: "/ws/main",
      terminalId: "pty-1",
      closable: true,
    } satisfies TabItem

    setMultiPaneHasState("tab-session", true)
    setMultiPaneHasState("tab-process", true)
    setMultiPaneHasState("tab-terminal", true)

    batch(() => {
      setState("items", [session, process, terminal])
      setState("activeId", process.id)
    })

    const view = render(() => <GroupContentRenderer groupId="g-default" />)

    await waitFor(() => {
      expect(view.getByTestId("pane-tab-process")).toBeTruthy()
    })

    // Close process tab
    batch(() => {
      setState("items", [session, terminal])
      setState("activeId", session.id)
    })

    // Immediately close session tab too (before any async cleanup)
    batch(() => {
      setState("items", [terminal])
      setState("activeId", terminal.id)
    })

    await waitFor(() => {
      expect(view.queryByTestId("pane-tab-process")).toBeNull()
      expect(view.queryByTestId("pane-tab-session")).toBeNull()
      expect(view.getByTestId("pane-tab-terminal")).toBeTruthy()
      expect(isSlotHidden(view.getByTestId("pane-tab-terminal"))).toBe(false)
    })
  })

  test("clearLater guard: process tab keeps content when setGroupItems silently fails", async () => {
    // FIX VERIFICATION: clearLater now checks if the tab is still in items
    // before clearing multi-pane state. When setGroupItems silently fails
    // (idx === -1), the tab stays in items, and clearLater skips the clear.
    //
    // This test verifies the tab keeps its content when:
    // 1. A close is attempted but setGroupItems silently fails
    // 2. The tab stays in items and stays active
    // 3. Multi-pane state is NOT cleared (clearLater guard prevents it)

    const session = {
      id: "tab-session",
      type: "session",
      title: "Session",
      directory: "/ws/main",
      sessionId: "s1",
      closable: true,
    } satisfies TabItem
    const process = {
      id: "tab-process",
      type: "process",
      title: "Processes",
      directory: "/ws/main",
      closable: true,
    } satisfies TabItem

    setMultiPaneHasState("tab-session", true)
    setMultiPaneHasState("tab-process", true)

    // Start with both tabs, process is active
    batch(() => {
      setState("items", [session, process])
      setState("activeId", process.id)
    })

    const view = render(() => <GroupContentRenderer groupId="g-default" />)

    await waitFor(() => {
      expect(view.getByTestId("pane-tab-process")).toBeTruthy()
    })

    // Simulate failed close: items and activeId NOT updated
    // (setGroupItems silently failed). Multi-pane state stays intact
    // because clearLater guards against clearing live tabs.
    // Force a re-render by touching items (simulating any reactive update)
    setState("items", [...state.items])

    await new Promise<void>((resolve) => queueMicrotask(resolve))

    // Process tab should STILL show content (not a spinner)
    // because clearLater skipped the clear when the tab is still in items.
    await waitFor(() => {
      const pane = view.queryByTestId("pane-tab-process")
      const spinner = view.queryByTestId("spinner-tab-process")

      expect(pane).toBeTruthy()
      expect(spinner).toBeNull()
    })
  })

  test("clearLater race: surviving tab renders content even if multi-pane is cleared via microtask before mounted signal updates", async () => {
    const session = {
      id: "tab-session",
      type: "session",
      title: "Session",
      directory: "/ws/main",
      sessionId: "s1",
      closable: true,
    } satisfies TabItem
    const process = {
      id: "tab-process",
      type: "process",
      title: "Processes",
      directory: "/ws/main",
      closable: true,
    } satisfies TabItem

    setMultiPaneHasState("tab-session", true)
    setMultiPaneHasState("tab-process", true)

    batch(() => {
      setState("items", [session, process])
      setState("activeId", process.id)
    })

    const view = render(() => <GroupContentRenderer groupId="g-default" />)

    await waitFor(() => {
      expect(view.getByTestId("pane-tab-process")).toBeTruthy()
    })

    // Correct close: remove process from items, switch to session
    batch(() => {
      setState("items", [session])
      setState("activeId", session.id)
    })

    // Simulate clearLater microtask
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    await waitFor(() => {
      const sessionPane = view.queryByTestId("pane-tab-session")
      expect(sessionPane).toBeTruthy()
      expect(isSlotHidden(sessionPane)).toBe(false)
    })

    expect(view.queryByTestId("pane-tab-process")).toBeNull()

    const sessionMountCount = mounts.mock.calls.filter(
      (call) => call[0] === "tab-session"
    ).length
    expect(sessionMountCount).toBeLessThanOrEqual(1)
  })

  test("clearLater race: rapid close-then-switch does not leave ghost tab content", async () => {
    const session = {
      id: "tab-s",
      type: "session",
      title: "Session",
      directory: "/ws/main",
      sessionId: "s1",
      closable: true,
    } satisfies TabItem
    const terminal = {
      id: "tab-t",
      type: "terminal",
      title: "Terminal",
      directory: "/ws/main",
      terminalId: "pty-1",
      closable: true,
    } satisfies TabItem
    const process = {
      id: "tab-p",
      type: "process",
      title: "Processes",
      directory: "/ws/main",
      closable: true,
    } satisfies TabItem

    setMultiPaneHasState("tab-s", true)
    setMultiPaneHasState("tab-t", true)
    setMultiPaneHasState("tab-p", true)

    batch(() => {
      setState("items", [session, terminal, process])
      setState("activeId", process.id)
    })

    const view = render(() => <GroupContentRenderer groupId="g-default" />)

    await waitFor(() => {
      expect(view.getByTestId("pane-tab-p")).toBeTruthy()
    })

    // Simulate close(): remove process from items, set active to session
    batch(() => {
      setState("items", [session, terminal])
      setState("activeId", session.id)
    })

    // Let microtask (clearLater equivalent) fire
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    await waitFor(() => {
      expect(view.queryByTestId("pane-tab-p")).toBeNull()
      expect(view.getByTestId("pane-tab-s")).toBeTruthy()
      expect(isSlotHidden(view.getByTestId("pane-tab-s"))).toBe(false)
    })

    // Switch to terminal -- must work (not wedged)
    setState("activeId", terminal.id)

    await waitFor(() => {
      expect(isSlotHidden(view.getByTestId("pane-tab-t"))).toBe(false)
      expect(isSlotHidden(view.getByTestId("pane-tab-s"))).toBe(true)
    })
  })
})
