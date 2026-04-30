import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { reducers, selectors as pureSelectors, validate as validateWb } from "../layout"
import type { UseWorkbench, WorkbenchState } from "../layout"
import { emptyClaxedoState } from "../state/persistence"
import { createMetadataSlice } from "../state/metadata"
import { createTerminalSlice } from "../state/terminal"
import { createWorkspaceSlice } from "../state/workspace"
import { createRailSlice } from "../state/rail"
import { createWorkspacePanelSlice } from "../state/workspace-panel"
import { createProcessPaneSlice } from "../state/process-pane"
import { createLayoutOrchestration } from "../state/orchestration"
import type { ClaxedoState } from "../state/types"
import type { ClaxedoStateApi } from "../state/provider"
import { buildSwitcherGroups, buildSwitcherItemsFromState } from "./switcher-items"

/** Mirror of the orchestration test fixture — minimal fake `UseWorkbench`. */
function fakeWb(initial: WorkbenchState): { wb: UseWorkbench; getState: () => WorkbenchState } {
  let state = initial
  const apply = (mut: (s: WorkbenchState) => WorkbenchState) => {
    state = mut(state)
  }
  const wb: UseWorkbench = {
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
  return { wb, getState: () => state }
}

function makeApi(): ClaxedoStateApi {
  const empty = emptyClaxedoState()
  const [state, setState] = createStore<ClaxedoState>(empty)
  const { wb } = fakeWb(validateWb(state.workbench).state)
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
    api.layout.openSession("/work/foo", "ses_1") // no title
    api.layout.openTerminal("/work/foo", "pty_1") // no title
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

  test("returns empty array when no contents exist", () => {
    const api = makeApi()
    expect(buildSwitcherItemsFromState(api)).toEqual([])
  })

  test("does not reorder items or workspace groups when focus changes", () => {
    const api = makeApi()
    const first = api.layout.openSession("/work/foo", "ses_1", "Foo")
    api.layout.openSession("/work/bar", "ses_2", "Bar")
    api.wb.navigation.show(first)
    const groups = buildSwitcherGroups({ items: buildSwitcherItemsFromState(api) })

    expect(groups.map((group) => group.workspaceDir)).toEqual(["/work/foo", "/work/bar"])
    expect(groups.map((group) => group.items.map((item) => item.title))).toEqual([["Foo"], ["Bar"]])
    expect(groups[0].items[0].active).toBe(true)
  })

  test("uses navigation recency to choose visible overflow but keeps stable display order", () => {
    const items = ["A", "B", "C", "D", "E", "F"].map((title) => ({
      contentId: title.toLowerCase(),
      kind: "session" as const,
      title,
      workspaceDir: "/work/foo",
      active: false,
    }))

    const groups = buildSwitcherGroups({
      items,
      maxPerWorkspace: 5,
      recentContentIds: ["f", "b", "e", "d", "c", "a"],
    })

    expect(groups[0]?.items.map((item) => item.title)).toEqual(["B", "C", "D", "E", "F"])
    expect(groups[0]?.hiddenItems.map((item) => item.title)).toEqual(["A"])
  })

  test("keeps an active overflow item visible without moving it to the front", () => {
    const items = ["A", "B", "C", "D", "E", "F"].map((title) => ({
      contentId: title.toLowerCase(),
      kind: "session" as const,
      title,
      workspaceDir: "/work/foo",
      active: title === "A",
    }))

    const groups = buildSwitcherGroups({
      items,
      maxPerWorkspace: 5,
      recentContentIds: ["a", "f", "e", "d", "c", "b"],
    })

    expect(groups[0]?.items.map((item) => item.title)).toEqual(["A", "C", "D", "E", "F"])
    expect(groups[0]?.hiddenItems.map((item) => item.title)).toEqual(["B"])
  })

  test("tracks attention in hidden overflow items", () => {
    const items = ["A", "B", "C", "D", "E", "F"].map((title) => ({
      contentId: title.toLowerCase(),
      kind: "session" as const,
      title,
      workspaceDir: "/work/foo",
      active: false,
      status: title === "F" ? "permission" as const : "idle" as const,
    }))

    const groups = buildSwitcherGroups({
      items,
      maxPerWorkspace: 5,
      recentContentIds: ["a", "b", "c", "d", "e"],
    })

    expect(groups[0]?.hiddenItems.map((item) => item.title)).toEqual(["F"])
    expect(groups[0]?.hiddenAttentionCount).toBe(1)
  })
})
