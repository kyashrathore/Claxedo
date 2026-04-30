import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { reducers, selectors as pureSelectors, validate as validateWb } from "../../layout"
import type { Edge, UseWorkbench, WorkbenchState } from "../../layout"
import type { ClaxedoState } from "../types"
import { emptyClaxedoState } from "../persistence"
import { createMetadataSlice } from "../metadata"
import { createTerminalSlice } from "../terminal"
import { createLayoutOrchestration } from "../orchestration"

/**
 * Build a minimal fake `UseWorkbench` over a SolidJS store that mirrors the
 * real `useWorkbench()` shape but skips the SolidJS provider. Sufficient for
 * orchestration unit tests under bun:test.
 */
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

function makeFixture() {
  const empty = emptyClaxedoState()
  const [state, setState] = createStore<ClaxedoState>(empty)
  const { wb, getState } = fakeWb(validateWb(state.workbench).state)
  // Mirror workbench changes back into the store so metadata's `state.meta`
  // and orchestration's `wb.state` stay in sync. Since we built the fake wb
  // independent of the store's `state.workbench`, we route through a manual
  // mirror after each call. Tests below do this explicitly when needed.
  const meta = createMetadataSlice({ state, setState })
  const terminal = createTerminalSlice({ state, setState })
  const layout = createLayoutOrchestration({ wb, meta, terminal })
  return { state, setState, wb, getState, meta, terminal, layout }
}

describe("state/orchestration", () => {
  test("openSession creates meta + adds to workbench + focuses", () => {
    const { layout, meta, getState } = makeFixture()
    const id = layout.openSession("/work/foo", "ses_1", "Session 1")
    expect(id).toBeTruthy()
    expect(meta.get(id)).toBeDefined()
    expect(meta.get(id)?.type).toBe("session")
    expect(meta.get(id)?.sessionId).toBe("ses_1")
    expect(meta.get(id)?.directory).toBe("/work/foo")
    expect(getState().contentIds).toContain(id)
  })

  test("openSession returns existing id when (dir, sessionId) match", () => {
    const { layout } = makeFixture()
    const a = layout.openSession("/work/foo", "ses_1", "Session 1")
    const b = layout.openSession("/work/foo", "ses_1", "Session 1 again")
    expect(a).toBe(b)
  })

  test("openTerminal creates a terminal content", () => {
    const { layout, meta } = makeFixture()
    const id = layout.openTerminal("/work/foo", "pty_1", "Terminal")
    expect(meta.get(id)?.type).toBe("terminal")
    expect(meta.get(id)?.terminalId).toBe("pty_1")
  })

  test("openTerminal persists pending create command for reload recovery", () => {
    const { layout, meta } = makeFixture()
    const id = layout.openTerminal("/work/foo", "pending-1", "Claude", { command: "claude" })
    expect(meta.get(id)?.terminalId).toBe("pending-1")
    expect(meta.get(id)?.content?.terminalId).toBe("pending-1")
    expect(meta.get(id)?.content?.title).toBe("Claude")
    expect(meta.get(id)?.content?.command).toBe("claude")
  })

  test("openPagesIndex is global when directory omitted", () => {
    const { layout, meta } = makeFixture()
    const id = layout.openPagesIndex()
    expect(meta.get(id)?.scope).toBe("global")
    expect(meta.get(id)?.directory).toBeUndefined()
  })

  test("closeContent removes meta + content + cleans terminal owner", () => {
    const { layout, meta, terminal, getState } = makeFixture()
    const id = layout.openTerminal("/work/foo", "pty_1", "Terminal")
    terminal.own(id, "pty_1")
    expect(terminal.owner("pty_1")).toBe(id)
    layout.closeContent(id, "user")
    expect(meta.get(id)).toBeUndefined()
    expect(getState().contentIds).not.toContain(id)
    // owner cleared by clearForContent path
    expect(terminal.owner("pty_1")).toBeUndefined()
  })

  test("closeContent refuses pinned pages index", () => {
    const { layout, meta } = makeFixture()
    const id = layout.openPagesIndex("/work/foo")
    layout.closeContent(id)
    // Built-in workspace page index is pinned — entry survives.
    expect(meta.get(id)).toBeDefined()
  })

  test("splitContent + showContent route through wb", () => {
    const { layout, wb } = makeFixture()
    const a = layout.openSession("/d", "s1", "A")
    // openSession of `b` will collapse to a single pane. To get a 2-pane
    // state, only `a` is shown — then we split off `b` next to `a`'s pane.
    const b = layout.openSession("/d", "s2", "B")
    layout.showContent(a) // refocus on a → single pane displaying a
    const paneA = wb.selectors.contentPane(a)!
    expect(paneA).toBeTruthy()
    layout.splitContent(paneA, "right" satisfies Edge, b)
    expect(wb.selectors.visiblePanes().length).toBe(2)
    layout.showContent(a)
    expect(wb.selectors.focusedContent()).toBe(a)
  })

  test("openPage updates directory/filePath if provided when reusing existing meta", () => {
    const { layout, meta } = makeFixture()
    const a = layout.openPage("page_1", "Page 1", "/old/dir")
    const b = layout.openPage("page_1", "Page 1", "/new/dir", "/path/file.md")
    expect(a).toBe(b)
    expect(meta.get(a)?.directory).toBe("/new/dir")
    expect(meta.get(a)?.filePath).toBe("/path/file.md")
  })
})
