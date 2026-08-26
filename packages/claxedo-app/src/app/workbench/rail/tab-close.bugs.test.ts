import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { reducers, selectors as pureSelectors, validate as validateWb } from "../workbench/index"
import type { UseWorkbench, WorkbenchState } from "../workbench/index"
import { emptyClaxedoState } from "../state/persistence"
import { createMetadataSlice } from "../state/metadata"
import { createTerminalSlice } from "../state/terminal"
import { createWorkspaceSlice } from "../state/workspace"
import { createRailSlice } from "../state/rail"
import { createWorkspacePanelSlice } from "../state/workspace-panel"
import { createProcessPaneSlice } from "@/features/processes/state"
import { createLayoutOrchestration } from "../state/orchestration"
import type { ClaxedoState } from "../state/types"
import type { ClaxedoStateApi } from "../state/provider"
import { buildSwitcherItemsFromState } from "../compact-switcher/switcher-items"
import {
  createRouteIntentAdapter,
  markRouteIntentClosed,
  resetRouteIntentClosedForTest,
} from "../state/route-intent"
import { realDirectory } from "../state/types"

function fakeWb(initial: WorkbenchState): UseWorkbench {
  let state = initial
  const apply = (mut: (s: WorkbenchState) => WorkbenchState) => {
    state = mut(state)
  }
  return {
    get state() {
      return state
    },
    contents: {
      add: (id) => apply((s) => reducers.contents.add(s, id)),
      open: (id, focus = true) => apply((s) => focus
        ? reducers.navigation.show(reducers.contents.add(s, id), id)
        : reducers.contents.add(s, id)),
      remove: (id) => apply((s) => reducers.contents.remove(s, id)),
    },
    panes: { assign: (paneId, contentId) => apply((s) => reducers.panes.assign(s, paneId, contentId)) },
    split: {
      split: (t, e, c) => apply((s) => reducers.split.split(s, t, e, c)),
      close: (p, o) => apply((s) => reducers.split.close(s, p, o ?? { destroyContent: false })),
      move: (c, f, t) => apply((s) => reducers.split.move(s, c, f, t)),
      focus: (p) => apply((s) => reducers.split.focus(s, p)),
      resize: (p, r) => apply((s) => reducers.split.resize(s, p, r)),
    },
    navigation: { show: (c) => apply((s) => reducers.navigation.show(s, c)) },
    selectors: {
      aliveContents: () => pureSelectors.aliveContents(state),
      recentContents: () => pureSelectors.recentContents(state),
      contentPane: (id) => pureSelectors.contentPane(state, id),
      visiblePanes: () => pureSelectors.visiblePanes(state),
      paneRect: (id) => pureSelectors.paneRect(state, id),
      focusedContent: () => pureSelectors.focusedContent(state),
      snapshotFor: (id) => pureSelectors.snapshotFor(state, id),
    },
  }
}

function makeApi(): ClaxedoStateApi {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  const wb = fakeWb(validateWb(state.workbench).state)
  const meta = createMetadataSlice({ state, setState })
  const terminal = createTerminalSlice({ state, setState })
  const workspace = createWorkspaceSlice({ state, setState })
  const rail = createRailSlice({ state, setState })
  const processPane = createProcessPaneSlice({ state, setState })
  const workspacePanel = createWorkspacePanelSlice({
    state,
    setState,
    defaultTarget: () => ({ workspaceDir: undefined, targetPaneId: undefined }),
  })
  const layout = createLayoutOrchestration({ wb, meta, terminal })
  return { wb, meta, terminal, workspace, rail, workspacePanel, processPane, layout, ready: () => true, state }
}

const WS = "/work/foo"

describe("tab close — state layer sanity", () => {
  test("closeContent removes the tab from the switcher list", () => {
    const api = makeApi()
    const a = api.layout.openSession(WS, "ses_a", "Alpha")
    const b = api.layout.openSession(WS, "ses_b", "Bravo")
    api.wb.navigation.show(a)

    api.layout.closeContent(b)

    expect(buildSwitcherItemsFromState(api).map((i) => i.title)).toEqual(["Alpha"])
  })
})

describe("tab close — route adapter resurrection", () => {
  test("the real route adapter does NOT re-open a session whose route intent fires after close, when the close was recorded", () => {
    resetRouteIntentClosedForTest()
    const api = makeApi()
    const a = api.layout.openSession(WS, "ses_a", "Alpha")
    api.layout.openSession(WS, "ses_b", "Bravo")
    api.wb.navigation.show(a)

    const adapter = createRouteIntentAdapter({
      state: api,
      navigate: () => {},
      inventory: () => ({ global: [], byWorkspace: {}, byProject: {}, loaded: true }),
      currentSessionId: () => undefined,
    })

    // Close Bravo and record it as closed (what a correct close path must do).
    const bravo = api.meta.find((m) => m.sessionId === "ses_b")!
    markRouteIntentClosed({ workspaceId: WS, sessionId: "ses_b" })
    markRouteIntentClosed({ sessionId: "ses_b" })
    api.layout.closeContent(bravo.id)

    // A stray route intent for the just-closed session arrives.
    adapter.receive({
      ready: true,
      marketplace: false,
      workspaceId: WS,
      sessionId: "ses_b",
      pageId: undefined,
      terminalId: undefined,
      workspaceBrowse: false,
      sessionTitle: "Bravo",
      sessionBadge: undefined,
    } as Parameters<typeof adapter.receive>[0])

    expect(buildSwitcherItemsFromState(api).map((i) => i.title)).toEqual(["Alpha"])
  })

  // REGRESSION GUARD: closeContent is the single chokepoint every close path
  // funnels through. It must record the close so the route layer doesn't
  // re-materialize the session as a new (last) tab and steal focus — exactly the
  // reported "close moves focus but the tab comes back as the last tab and loops".
  test("closeContent records the close so a later route tick cannot resurrect it", () => {
    resetRouteIntentClosedForTest()
    const api = makeApi()
    const a = api.layout.openSession(WS, "ses_a", "Alpha")
    api.layout.openSession(WS, "ses_b", "Bravo")
    api.wb.navigation.show(a)

    const adapter = createRouteIntentAdapter({
      state: api,
      navigate: () => {},
      inventory: () => ({ global: [], byWorkspace: {}, byProject: {}, loaded: true }),
      currentSessionId: () => undefined,
    })

    // Close Bravo through the real chokepoint (default reason: "user").
    const bravo = api.meta.find((m) => m.sessionId === "ses_b")!
    api.layout.closeContent(bravo.id)
    expect(buildSwitcherItemsFromState(api).map((i) => i.title)).toEqual(["Alpha"])
    const focusedAfterClose = api.wb.selectors.focusedContent()

    // A route intent for the closed session arrives (inventory tick / stale nav).
    adapter.receive({
      ready: true,
      marketplace: false,
      workspaceId: WS,
      sessionId: "ses_b",
      pageId: undefined,
      terminalId: undefined,
      workspaceBrowse: false,
      sessionTitle: "Bravo",
      sessionBadge: undefined,
    } as Parameters<typeof adapter.receive>[0])

    // Bravo must stay closed and focus must not move.
    expect(buildSwitcherItemsFromState(api).map((i) => i.title)).toEqual(["Alpha"])
    expect(api.wb.selectors.focusedContent()).toBe(focusedAfterClose)
  })
})

// Faithful replica of rail-sidebar.closeHeaderSurface + ClaxedoLayout.onTabClose,
// wired to the REAL route adapter — the integration that actually runs when you
// click a tab's close button while the sidebar is hidden.
function closeFocusedSurface(
  api: ClaxedoStateApi,
  adapter: ReturnType<typeof createRouteIntentAdapter>,
  contentId: string,
) {
  const meta = api.meta.get(contentId)
  if (!meta) return
  const wasFocused = api.wb.selectors.focusedContent() === contentId
  const items = buildSwitcherItemsFromState(api)
  const index = items.findIndex((i) => i.contentId === contentId)
  const nextItem = wasFocused && index >= 0 ? items[index + 1] ?? items[index - 1] : undefined
  const nextMeta = nextItem ? api.meta.get(nextItem.contentId) : undefined

  api.layout.closeContent(contentId)
  if (nextItem) api.wb.navigation.show(nextItem.contentId)

  if (wasFocused) {
    // ── ClaxedoLayout.onTabClose ──
    const closedDirectory = realDirectory(meta.directory)
    markRouteIntentClosed({ workspaceId: closedDirectory, sessionId: meta.sessionId })
    if (meta.sessionId === "new" || !meta.sessionId) markRouteIntentClosed({ workspaceId: closedDirectory })
    markRouteIntentClosed({ sessionId: meta.sessionId })
    // Navigate to the next surface -> route layer re-delivers that intent.
    if (nextMeta && nextMeta.sessionId) {
      adapter.receive({
        ready: true,
        marketplace: false,
        workspaceId: realDirectory(nextMeta.directory),
        sessionId: nextMeta.sessionId,
        pageId: undefined,
        terminalId: undefined,
        workspaceBrowse: false,
        sessionTitle: nextMeta.content?.title ?? "",
        sessionBadge: undefined,
      } as Parameters<typeof adapter.receive>[0])
    }
  }
}

describe("tab close — closing the focused LAST tab (user repro)", () => {
  function setup() {
    resetRouteIntentClosedForTest()
    const api = makeApi()
    api.layout.openSession(WS, "ses_a", "Alpha")
    api.layout.openSession(WS, "ses_b", "Bravo")
    const c = api.layout.openSession(WS, "ses_c", "Charlie")
    api.wb.navigation.show(c) // focus the last tab
    const adapter = createRouteIntentAdapter({
      state: api,
      navigate: () => {},
      inventory: () => ({
        global: [],
        byWorkspace: { [WS]: { workspaceId: WS, directory: WS, sessions: [
          { id: "ses_a", title: "Alpha" }, { id: "ses_b", title: "Bravo" }, { id: "ses_c", title: "Charlie" },
        ] } },
        byProject: {},
        loaded: true,
      }),
      currentSessionId: () => undefined,
    })
    return { api, adapter, c }
  }

  test("closing the focused last tab removes it and moves focus to the second-last", () => {
    const { api, adapter, c } = setup()

    closeFocusedSurface(api, adapter, c)

    expect(buildSwitcherItemsFromState(api).map((i) => i.title)).toEqual(["Alpha", "Bravo"])
    const focused = api.wb.selectors.focusedContent()
    expect(api.meta.get(focused!)?.sessionId).toBe("ses_b")
  })

  test("the closed last tab is not resurrected by a later inventory/route tick", () => {
    const { api, adapter, c } = setup()
    const cMeta = api.meta.get(c)!

    closeFocusedSurface(api, adapter, c)

    // An inventory tick re-delivers the closed session's own intent.
    adapter.receive({
      ready: true,
      marketplace: false,
      workspaceId: realDirectory(cMeta.directory),
      sessionId: "ses_c",
      pageId: undefined,
      terminalId: undefined,
      workspaceBrowse: false,
      sessionTitle: "Charlie",
      sessionBadge: undefined,
    } as Parameters<typeof adapter.receive>[0])

    expect(buildSwitcherItemsFromState(api).map((i) => i.title)).toEqual(["Alpha", "Bravo"])
  })
})
