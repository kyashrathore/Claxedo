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
import { buildSwitcherItemsFromState } from "./switcher-items"

/** Mirror of the orchestration test fixture: minimal fake `UseWorkbench`. */
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
      remove: (id) => apply((s) => reducers.contents.remove(s, id)),
    },
    panes: {
      assign: (paneId, contentId) => apply((s) => reducers.panes.assign(s, paneId, contentId)),
    },
    split: {
      split: (targetPaneId, edge, contentId) =>
        apply((s) => reducers.split.split(s, targetPaneId, edge, contentId)),
      close: (paneId, opts) =>
        apply((s) => reducers.split.close(s, paneId, opts ?? { destroyContent: false })),
      move: (contentId, fromPaneId, toPaneId) =>
        apply((s) => reducers.split.move(s, contentId, fromPaneId, toPaneId)),
      focus: (paneId) => apply((s) => reducers.split.focus(s, paneId)),
      resize: (path, ratio) => apply((s) => reducers.split.resize(s, path, ratio)),
    },
    navigation: {
      show: (contentId) => apply((s) => reducers.navigation.show(s, contentId)),
    },
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
  return {
    wb,
    meta,
    terminal,
    workspace,
    rail,
    workspacePanel,
    processPane,
    layout,
    ready: () => true,
    state,
  }
}

describe("buildSwitcherItemsFromState", () => {
  test("maps open contents from new state to switcher items", () => {
    const api = makeApi()
    const sessionId = api.layout.openSession("/work/foo", "ses_1", "Build fix")
    const terminalId = api.layout.openTerminal("/work/foo", "pty_1", "Dev server")
    const items = buildSwitcherItemsFromState(api)
    expect(items.map((i) => i.title)).toEqual(["Build fix", "Dev server"])
    expect(items.map((i) => i.kind)).toEqual(["session", "terminal"])
    expect(items.map((i) => i.workspaceDir)).toEqual(["/work/foo", "/work/foo"])
    expect(items.map((i) => i.contentId)).toEqual([sessionId, terminalId])
    expect(items[0].active).toBe(false)
    expect(items[1].active).toBe(true)
  })

  test("falls back to type-based titles when no explicit title", () => {
    const api = makeApi()
    api.layout.openSession("/work/foo", "ses_1")
    api.layout.openTerminal("/work/foo", "pty_1")
    const titles = buildSwitcherItemsFromState(api).map((i) => i.title)
    expect(titles).toEqual(["Session", "Terminal"])
  })

  test("maps draft-session to a displayable item", () => {
    const api = makeApi()
    api.layout.openDraftSession("/work/foo", "draft_abc")
    const items = buildSwitcherItemsFromState(api)
    expect(items.length).toBe(1)
    const draft = items[0]
    expect(draft.kind).toBe("session") // draft-session maps to session
    expect(draft.title).toBe("New Session")
  })

  test("maps marketplace to a closable global tab", () => {
    const api = makeApi()
    api.layout.openMarketplace()
    const items = buildSwitcherItemsFromState(api)

    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe("marketplace")
    expect(items[0].title).toBe("Marketplace")
    expect(items[0].closable).toBe(true)
  })

  test("filters page entries when pages are unavailable", () => {
    const api = makeApi()
    api.layout.openSession("/work/foo", "ses_1", "Session")
    api.layout.openPagesIndex("/work/foo")
    api.layout.openPage("page_1", "Page", "/work/foo")

    expect(buildSwitcherItemsFromState(api).map((item) => item.kind)).toEqual(["session"])
    expect(buildSwitcherItemsFromState(api, { canUsePages: true }).map((item) => item.kind)).toEqual(["session", "page", "page"])
    expect(buildSwitcherItemsFromState(api, { canUsePages: false }).map((item) => item.kind)).toEqual(["session"])
  })

  test("returns empty array when no contents exist", () => {
    const api = makeApi()
    expect(buildSwitcherItemsFromState(api)).toEqual([])
  })

  test("does not reorder items when focus changes", () => {
    const api = makeApi()
    const first = api.layout.openSession("/work/foo", "ses_1", "Foo")
    api.layout.openSession("/work/bar", "ses_2", "Bar")
    api.wb.navigation.show(first)
    const items = buildSwitcherItemsFromState(api)

    expect(items.map((item) => item.workspaceDir)).toEqual(["/work/foo", "/work/bar"])
    expect(items.map((item) => item.title)).toEqual(["Foo", "Bar"])
    expect(items[0].active).toBe(true)
  })
})
