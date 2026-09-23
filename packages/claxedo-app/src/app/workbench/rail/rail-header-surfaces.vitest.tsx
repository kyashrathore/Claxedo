import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { ClaxedoStateProvider, useClaxedoState } from "../state/provider"
import { emptyClaxedoState } from "../state/persistence"
import { createRouteIntentAdapter, resetRouteIntentClosedForTest } from "../state/route-intent"
import { SessionTitleProjectionProvider } from "@/features/session/providers/session-title-projection-provider"
import { dispatchSessionStatusEvent } from "@/features/session/store/session-status-dispatcher"
import { queryClient } from "@/platform/query/query-client"
import { useRailHeaderSurfaces } from "./rail-header-surfaces"
import { useAppShellRouteSync } from "../../app-shell-route-sync"

const directory = "/work/header"
afterEach(() => {
  cleanup()
  queryClient.clear()
  resetRouteIntentClosedForTest()
})

function mountHeader() {
  let state!: ReturnType<typeof useClaxedoState>
  let header!: ReturnType<typeof useRailHeaderSurfaces>
  const onTabClose = vi.fn()
  const closeTerminal = vi.fn()
  const onLastFocusedSurfaceClosed = vi.fn()
  const Capture = () => {
    state = useClaxedoState()
    const routes = useAppShellRouteSync({
      activeSurface: () => state.meta.get(state.wb.selectors.focusedContent() ?? ""),
      activeDirectory: () => directory,
      projects: () => [], findSurface: (predicate) => state.meta.find(predicate),
      navigate: vi.fn(), params: { id: "ses_route" }, hash: () => "",
      pathname: () => "/session/ses_route", routeDirectory: () => directory,
      routeId: () => undefined, search: () => "",
      sessionInventory: () => ({ byWorkspace: {}, byProject: {} }), shellRouteKind: () => "session",
    })
    header = useRailHeaderSurfaces({
      state,
      canUseDocuments: () => true,
      worktreeInfo: () => undefined,
      autoResponds: () => false,
      onTabClose: (next, closed) => { onTabClose(next, closed); routes.handleTabClose(next, closed) },
      closeTerminal,
      onLastFocusedSurfaceClosed,
    })
    return null
  }
  render(() => (
    <SessionTitleProjectionProvider>
      <ClaxedoStateProvider initialState={emptyClaxedoState()}><Capture /></ClaxedoStateProvider>
    </SessionTitleProjectionProvider>
  ))
  return { state, header, onTabClose, closeTerminal, onLastFocusedSurfaceClosed }
}

describe("rail header surface ownership", () => {
  test("canonical status events update the subscribed row, settle unfocused, and clear on focus", () => {
    const { state, header } = mountHeader()
    const alpha = state.layout.openSession(directory, "ses_alpha", "Alpha")
    const bravo = state.layout.openSession(directory, "ses_bravo", "Bravo")
    state.wb.navigation.show(bravo)
    const row = header.switcherItems().find((item) => item.contentId === alpha)!
    expect(row.status).toBe("idle")

    dispatchSessionStatusEvent({ event: { type: "session.status", source: "server", sessionID: "ses_alpha", status: { type: "busy" } } })
    expect(row.status).toBe("working")
    dispatchSessionStatusEvent({ event: { type: "session.idle", source: "server", sessionID: "ses_alpha" } })
    expect(row.status).toBe("done")
    expect(header.switcherItems().find((item) => item.contentId === alpha)).toBe(row)
    header.selectSurface(alpha)
    expect(row.status).toBe("idle")
    expect(row.active).toBe(true)
  })

  test("opening and focusing a tab records when it was last used", () => {
    vi.useFakeTimers({ now: 1_000, toFake: ["Date"] })
    try {
      const { state } = mountHeader()
      const alpha = state.layout.openSession(directory, "ses_alpha", "Alpha")
      expect(state.state.activity[alpha]).toEqual({ lastActiveAt: 1_000 })

      vi.setSystemTime(5_000)
      const bravo = state.layout.openSession(directory, "ses_bravo", "Bravo", { focus: false })
      expect(state.state.activity[bravo]).toEqual({ lastActiveAt: 5_000 })

      vi.setSystemTime(7_000)
      state.wb.navigation.show(bravo)
      expect(state.state.activity[bravo]).toEqual({ lastActiveAt: 7_000 })

      vi.setSystemTime(9_000)
      state.wb.navigation.show(alpha)
      expect(state.state.activity[alpha]).toEqual({ lastActiveAt: 9_000 })
      expect(state.state.activity[bravo]).toEqual({ lastActiveAt: 7_000 })
    } finally {
      vi.useRealTimers()
    }
  })

  test("a tab is held across the idle cut while its session works or waits, and released as used", () => {
    vi.useFakeTimers({ now: 1_000, toFake: ["Date"] })
    try {
      const { state, header } = mountHeader()
      const alpha = state.layout.openSession(directory, "ses_alpha", "Alpha")
      state.wb.navigation.show(state.layout.openSession(directory, "ses_bravo", "Bravo"))
      header.switcherItems()

      vi.setSystemTime(2_000)
      dispatchSessionStatusEvent({ event: { type: "session.status", source: "server", sessionID: "ses_alpha", status: { type: "busy" } } })
      expect(state.state.activity[alpha]).toEqual({ lastActiveAt: 1_000, held: true })

      vi.setSystemTime(7_000)
      dispatchSessionStatusEvent({ event: { type: "session.idle", source: "server", sessionID: "ses_alpha" } })
      expect(state.state.activity[alpha]).toEqual({ lastActiveAt: 7_000 })
    } finally {
      vi.useRealTimers()
    }
  })

  test("a background session's failed turn shows as error on its tab until it is seen", () => {
    const { state, header } = mountHeader()
    const alpha = state.layout.openSession(directory, "ses_alpha", "Alpha")
    state.wb.navigation.show(state.layout.openSession(directory, "ses_bravo", "Bravo"))
    const row = header.switcherItems().find((item) => item.contentId === alpha)!

    dispatchSessionStatusEvent({ event: { type: "session.status", source: "server", sessionID: "ses_alpha", status: { type: "busy" } } })
    dispatchSessionStatusEvent({ event: { type: "session.error", source: "server", sessionID: "ses_alpha" } })
    dispatchSessionStatusEvent({ event: { type: "session.idle", source: "server", sessionID: "ses_alpha" } })
    expect(row.status).toBe("error")

    header.selectSurface(alpha)
    expect(row.status).toBe("idle")

    dispatchSessionStatusEvent({ event: { type: "session.status", source: "optimistic", sessionID: "ses_alpha", status: { type: "busy" } } })
    expect(row.status).toBe("working")
  })

  test("a turn that fails in the focused pane never marks its tab", () => {
    const { state, header } = mountHeader()
    const alpha = state.layout.openSession(directory, "ses_alpha", "Alpha")
    const row = header.switcherItems().find((item) => item.contentId === alpha)!

    dispatchSessionStatusEvent({ event: { type: "session.status", source: "server", sessionID: "ses_alpha", status: { type: "busy" } } })
    expect(row.status).toBe("working")
    dispatchSessionStatusEvent({ event: { type: "session.error", source: "server", sessionID: "ses_alpha" } })
    dispatchSessionStatusEvent({ event: { type: "session.idle", source: "server", sessionID: "ses_alpha" } })
    expect(row.status).toBe("idle")
  })

  test("terminal status is read from its state owner without leaking to another terminal", () => {
    const { state, header } = mountHeader()
    const first = state.layout.openTerminal(directory, "pty_one", "One")
    const second = state.layout.openTerminal(directory, "pty_two", "Two")
    const one = header.switcherItems().find((item) => item.contentId === first)!
    const two = header.switcherItems().find((item) => item.contentId === second)!
    expect(one.status).toBe("idle")
    state.terminal.setAgentStatus("pty_one", "working")
    expect(one.status).toBe("working")
    expect(two.status).toBe("idle")
    state.terminal.setAgentStatus("pty_one", "permission")
    expect(one.status).toBe("permission")
    state.terminal.setAgentStatus("pty_one", "idle")
    expect(one.status).toBe("done")
  })

  test("closing the focused last tab selects its neighbor and rejects a stale route tick", () => {
    const { state, header, onTabClose } = mountHeader()
    state.layout.openSession(directory, "ses_alpha", "Alpha")
    const bravo = state.layout.openSession(directory, "ses_bravo", "Bravo")
    const charlie = state.layout.openSession(directory, "ses_charlie", "Charlie")
    const next = state.meta.get(bravo)
    const closed = state.meta.get(charlie)
    state.wb.navigation.show(charlie)
    const adapter = createRouteIntentAdapter({
      state, navigate: () => {},
      inventory: () => ({ global: [], byWorkspace: {}, byProject: {}, loaded: true }),
      currentSessionId: () => undefined,
    })
    header.closeSurface(charlie)
    expect(header.switcherItems().map((item) => item.title)).toEqual(["Alpha", "Bravo"])
    expect(state.wb.selectors.focusedContent()).toBe(bravo)
    expect(onTabClose).toHaveBeenCalledTimes(1)
    expect(onTabClose).toHaveBeenCalledWith(next, closed)
    adapter.receive({
      ready: true, marketplace: false, workspaceId: directory, sessionId: "ses_charlie",
      pageId: undefined, terminalId: undefined, workspaceBrowse: false,
      sessionTitle: "Charlie", sessionBadge: undefined,
    })
    expect(header.switcherItems().map((item) => item.title)).toEqual(["Alpha", "Bravo"])
    expect(state.wb.selectors.focusedContent()).toBe(bravo)
  })

  test("closing the only real session suppresses draft recreation on the workspace root", () => {
    const { state, header, onLastFocusedSurfaceClosed } = mountHeader()
    const session = state.layout.openSession(directory, "ses_last", "Last")
    const adapter = createRouteIntentAdapter({
      state, navigate: () => {},
      inventory: () => ({ global: [], byWorkspace: {}, byProject: {}, loaded: true }),
      currentSessionId: () => undefined,
    })
    header.closeSurface(session)
    expect(onLastFocusedSurfaceClosed).toHaveBeenCalledTimes(1)
    adapter.receive({
      ready: true, marketplace: false, workspaceId: directory, sessionId: undefined,
      pageId: undefined, terminalId: undefined, workspaceBrowse: false,
      sessionTitle: undefined, sessionBadge: undefined,
    })
    expect(header.switcherItems()).toEqual([])
    expect(state.wb.selectors.focusedContent()).toBeNull()
  })

  test("closing a background terminal tears down its PTY without navigating the focused session", () => {
    const { state, header, onTabClose, closeTerminal } = mountHeader()
    const terminal = state.layout.openTerminal(directory, "pty_close", "Shell")
    const session = state.layout.openSession(directory, "ses_focus", "Focus")
    state.wb.navigation.show(session)
    header.closeSurface(terminal)
    expect(header.switcherItems().map((item) => item.contentId)).toEqual([session])
    expect(state.wb.selectors.focusedContent()).toBe(session)
    expect(closeTerminal).toHaveBeenCalledTimes(1)
    expect(closeTerminal).toHaveBeenCalledWith("pty_close")
    expect(onTabClose).not.toHaveBeenCalled()
  })
})
