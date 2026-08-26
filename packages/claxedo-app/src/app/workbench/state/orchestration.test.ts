import { afterEach, describe, expect, test } from "bun:test"
import { createStore } from "solid-js"
import { reducers, selectors as pureSelectors, validate as validateWb } from "../workbench/index"
import type { Edge, UseWorkbench, WorkbenchState } from "../workbench/index"
import type { ClaxedoState } from "./types"
import { emptyClaxedoState } from "./persistence"
import { createMetadataSlice } from "./metadata"
import { createTerminalSlice } from "./terminal"
import { createLayoutOrchestration } from "./orchestration"
import { MAX_OPEN_SURFACES } from "./surface-budget"
import { mountReactive } from "@/lib/test-support/reactive-root"

// `createTerminalSlice` registers an `onCleanup` for its 15s reservation timer,
// which needs an owner to run — in the app the workbench provider is that
// owner. Building the fixture under a root gives the slices the same one, and
// disposal after each test stops the timers from outliving it. The test bodies
// stay OUTSIDE the root: their setter calls are the shell's, made with no owner
// on the stack, which is also the only shape Solid 2's dev build allows.
const mounted: (() => void)[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!()
})

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
      open: (id, focus = true) => apply((s) => focus
        ? reducers.navigation.show(reducers.contents.add(s, id), id)
        : reducers.contents.add(s, id)),
      remove: (id) => apply((s) => reducers.contents.remove(s, id)),
    },
    panes: {
      assign: (paneId, contentId) => apply((s) => reducers.panes.assign(s, paneId, contentId)),
    },
    split: {
      split: (targetPaneId, edge, contentId) => apply((s) => reducers.split.split(s, targetPaneId, edge, contentId)),
      close: (paneId, opts) => apply((s) => reducers.split.close(s, paneId, opts ?? { destroyContent: false })),
      move: (contentId, fromPaneId, toPaneId) => apply((s) => reducers.split.move(s, contentId, fromPaneId, toPaneId)),
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
  const [fixture, dispose] = mountReactive(() => buildFixture())
  mounted.push(dispose)
  return fixture
}

function buildFixture() {
  const empty = emptyClaxedoState()
  const [state, setState] = createStore<ClaxedoState>(empty)
  const { wb, getState } = fakeWb(validateWb(state.workbench).state)
  // Mirror workbench changes back into the store so metadata's `state.meta`
  // and orchestration's `wb.state` stay in sync. Since we built the fake wb
  // independent of the store's `state.workbench`, we route through a manual
  // mirror after each call. Tests below do this explicitly when needed.
  const rawMeta = createMetadataSlice({ state, setState })
  let patchCount = 0
  const meta = {
    ...rawMeta,
    patch: ((id, patch) => {
      patchCount++
      rawMeta.patch(id, patch)
    }) satisfies typeof rawMeta.patch,
  }
  const terminal = createTerminalSlice({ state, setState })
  const layout = createLayoutOrchestration({ wb, meta, terminal })
  return { state, setState, wb, getState, meta, terminal, layout, patchCount: () => patchCount }
}

const cloudSessionRef = (sessionId: string) => ({
  sessionId,
  host: "workspace" as const,
  workspaceId: "ws_cloud",
  toolSandbox: {
    kind: "workspace" as const,
    workspaceId: "ws_cloud",
    hosting: "cloud" as const,
  },
})

const localSessionRef = (sessionId: string, cwd = "/work/foo") => ({
  sessionId,
  host: "workspace" as const,
  cwd,
  toolSandbox: { kind: "local" as const, cwd },
})

describe("state/orchestration", () => {
  test("openSession creates meta + adds to workbench + focuses", () => {
    const { layout, meta, wb, getState } = makeFixture()
    const id = layout.openSession("/work/foo", "ses_1", "Session 1", {
      sessionRef: localSessionRef("ses_1"),
    })
    expect(id).toBeTruthy()
    expect(meta.get(id)).toBeDefined()
    expect(meta.get(id)?.type).toBe("session")
    expect(meta.get(id)?.sessionId).toBe("ses_1")
    expect(meta.get(id)?.directory).toBe("/work/foo")
    expect(meta.get(id)?.content).toMatchObject({
      type: "session",
      directory: "/work/foo",
      sessionId: "ses_1",
      sessionRef: localSessionRef("ses_1"),
    })
    expect(getState().contentIds).toContain(id)
    expect(getState().panes.some((pane) => pane.contentId === id)).toBe(true)
    expect(wb.selectors.focusedContent()).toBe(id)
  })

  test("openSession returns existing workspace id when session backing matches", () => {
    const { layout, meta } = makeFixture()
    const a = layout.openSession("/work/foo", "ses_1", "Session 1", {
      sessionRef: cloudSessionRef("ses_1"),
    })
    const b = layout.openSession("/work/alias", "ses_1", "Session 1 again", {
      sessionRef: cloudSessionRef("ses_1"),
    })
    expect(a).toBe(b)
    expect(meta.get(a)?.directory).toBe("/work/alias")
    expect(meta.get(a)?.content?.title).toBe("Session 1 again")
    expect(meta.get(a)?.content?.directory).toBe("/work/alias")
  })

  test("openSession keeps same ids separate when workspace backing differs", () => {
    const { layout, meta, getState } = makeFixture()
    const a = layout.openSession("/work/foo", "ses_1", "Session 1", {
      sessionRef: localSessionRef("ses_1"),
    })
    const b = layout.openSession("/work/alias", "ses_1", "Session 1 alias", {
      sessionRef: localSessionRef("ses_1", "/work/alias"),
    })

    expect(b).not.toBe(a)
    expect(meta.get(a)?.directory).toBe("/work/foo")
    expect(meta.get(b)?.directory).toBe("/work/alias")
    expect(getState().contentIds).toContain(a)
    expect(getState().contentIds).toContain(b)
  })

  test("openSession creates the requested tab during fast-switch quiet windows", () => {
    const { layout, meta, getState } = makeFixture()
    const a = layout.openSession("/work/foo", "ses_1", "Session 1", {
      sessionRef: localSessionRef("ses_1"),
    })
    const target = globalThis.window as typeof window & {
      __claxedoFastSessionSwitch?: { sessionId: string; until: number }
    }
    target.__claxedoFastSessionSwitch = { sessionId: "ses_1", until: Date.now() + 1_000 }
    try {
      const b = layout.openSession("/work/foo", "ses_2", "Session 2", {
        sessionRef: localSessionRef("ses_2"),
      })

      expect(b).not.toBe(a)
      expect(meta.get(b)?.sessionId).toBe("ses_2")
      expect(getState().contentIds).toContain(a)
      expect(getState().contentIds).toContain(b)
    } finally {
      delete target.__claxedoFastSessionSwitch
    }
  })

  test("openSession does not patch when backing is structurally unchanged", () => {
    const { layout, patchCount } = makeFixture()
    const id = layout.openSession("/work/foo", "ses_1", "Session 1", {
      sessionRef: localSessionRef("ses_1"),
    })

    layout.openSession("/work/foo", "ses_1", "Session 1", {
      sessionRef: localSessionRef("ses_1"),
    })

    expect(id).toBeTruthy()
    expect(patchCount()).toBe(0)
  })

  test("openSession reuses and focuses an existing session surface", () => {
    const { layout, wb } = makeFixture()
    const id = layout.openSession("/work/foo", "ses_1", "Session 1", {
      focus: false,
      sessionRef: localSessionRef("ses_1"),
    })

    const activeId = layout.openSession("/work/foo", "ses_1", "Session 1", {
      sessionRef: localSessionRef("ses_1"),
    })

    expect(activeId).toBe(id)
    expect(wb.selectors.focusedContent()).toBe(id)
  })

  test("openSession prefers explicit session refs over directory-derived backing", () => {
    const { layout, meta } = makeFixture()
    const id = layout.openSession("/work/foo", "ses_1", "Session 1", {
      sessionRef: cloudSessionRef("ses_1"),
    })

    expect(meta.get(id)?.content?.sessionRef).toEqual(cloudSessionRef("ses_1"))
  })

  test("openSession reuses one new-session surface per workspace", () => {
    const { layout, meta, getState } = makeFixture()
    const a = layout.openSession("/work/foo", "new", "New Session")
    const b = layout.openSession("/work/foo", "new", "New Session")

    expect(b).toBe(a)
    expect(meta.get(a)?.sessionId).toBe("new")
    expect(meta.get(a)?.content?.sessionRef).toBeUndefined()
    expect(getState().contentIds).toContain(a)
    expect(getState().contentIds.filter((id) => meta.get(id)?.sessionId === "new")).toEqual([a])
  })

  test("openCentralSession creates a global session surface without directory", () => {
    const { layout, meta, wb, getState } = makeFixture()
    const id = layout.openCentralSession("ses_central", "Central")

    expect(meta.get(id)).toEqual({
      id,
      type: "session",
      scope: "global",
      sessionId: "ses_central",
      content: {
        type: "session",
        sessionId: "ses_central",
        title: "Central",
        sessionRef: {
          sessionId: "ses_central",
          host: "central",
          toolSandbox: { kind: "virtual" },
        },
      },
    })
    expect(getState().contentIds).toContain(id)
    expect(wb.selectors.focusedContent()).toBe(id)
  })

  test("openCentralSession reuses existing global session and removes stale duplicates", () => {
    const { layout, meta, wb, getState } = makeFixture()
    meta.upsert({
      id: "stale-session",
      type: "session",
      scope: "directory",
      directory: "workspace:old",
      sessionId: "ses_central",
      content: { type: "session", directory: "workspace:old", sessionId: "ses_central" },
    })
    wb.contents.add("stale-session")

    const a = layout.openCentralSession("ses_central", "Central")
    const b = layout.openCentralSession("ses_central", "Central updated")

    expect(a).toBe(b)
    expect(meta.get(a)?.content?.title).toBe("Central updated")
    expect(meta.get(a)?.directory).toBeUndefined()
    expect(meta.get("stale-session")).toBeUndefined()
    expect(getState().contentIds).not.toContain("stale-session")
  })

  test("openCentralSession repairs a global placeholder without a ref", () => {
    const { layout, meta, wb } = makeFixture()
    meta.upsert({
      id: "central-placeholder",
      type: "session",
      scope: "global",
      sessionId: "ses_central",
      content: { type: "session", sessionId: "ses_central", title: "Placeholder" },
    })
    wb.contents.add("central-placeholder")

    expect(layout.openCentralSession("ses_central", "Central")).toBe("central-placeholder")
    expect(meta.get("central-placeholder")?.content?.sessionRef).toEqual({
      sessionId: "ses_central",
      host: "central",
      toolSandbox: { kind: "virtual" },
    })
  })

  test("openCentralSession upgrades a central placeholder with its authoritative harness", () => {
    const { layout, meta } = makeFixture()
    const id = layout.openCentralSession("ses_pi", "Pi session")

    layout.openCentralSession("ses_pi", "Pi session", {
      authoritative: true,
      sessionRef: {
        sessionId: "ses_pi",
        host: "central",
        toolSandbox: { kind: "virtual" },
        harness: { id: "pi" },
      },
    })

    expect(meta.get(id)?.content?.sessionRef?.harness).toEqual({ id: "pi" })
  })

  test("openCentralSession does not downgrade an authoritative central harness", () => {
    const { layout, meta } = makeFixture()
    const id = layout.openCentralSession("ses_pi", "Pi session", {
      authoritative: true,
      sessionRef: {
        sessionId: "ses_pi",
        host: "central",
        toolSandbox: { kind: "virtual" },
        harness: { id: "pi" },
      },
    })

    layout.openCentralSession("ses_pi", "Pi session updated")

    expect(meta.get(id)?.content?.title).toBe("Pi session updated")
    expect(meta.get(id)?.content?.sessionRef?.harness).toEqual({ id: "pi" })
  })

  test("openSession removes stale central placeholder for the same session", () => {
    const { layout, meta, getState } = makeFixture()
    const central = layout.openCentralSession("ses_1", "Central placeholder")

    const workspace = layout.openSession("/work/main", "ses_1", "Workspace session", {
      sessionRef: localSessionRef("ses_1", "/work/main"),
    })

    expect(workspace).not.toBe(central)
    expect(meta.get(central)).toBeUndefined()
    expect(meta.get(workspace)?.directory).toBe("/work/main")
    expect(meta.get(workspace)?.content?.sessionRef).toEqual(localSessionRef("ses_1", "/work/main"))
    expect(getState().contentIds).not.toContain(central)
    expect(getState().contentIds).toContain(workspace)
  })

  test("openCentralSession preserves an existing workspace-backed session", () => {
    const { layout, meta, wb, getState } = makeFixture()
    meta.upsert({
      id: "workspace-session",
      type: "session",
      scope: "directory",
      directory: "/work/main",
      sessionId: "ses_1",
      content: {
        type: "session",
        directory: "/work/main",
        sessionId: "ses_1",
        sessionRef: localSessionRef("ses_1", "/work/main"),
      },
    })
    wb.contents.add("workspace-session")

    const id = layout.openCentralSession("ses_1", "Central fallback")

    expect(id).toBe("workspace-session")
    expect(meta.get(id)?.directory).toBe("/work/main")
    expect(meta.get(id)?.content?.sessionRef).toEqual(localSessionRef("ses_1", "/work/main"))
    expect(getState().contentIds).toContain("workspace-session")
    expect(wb.selectors.focusedContent()).toBe("workspace-session")
  })

  test("openCentralSession replaces a workspace placeholder when central metadata is authoritative", () => {
    const { layout, meta, getState } = makeFixture()
    const workspace = layout.openSession("/work/main", "ses_1", "Workspace placeholder", {
      sessionRef: localSessionRef("ses_1", "/work/main"),
    })

    const central = layout.openCentralSession("ses_1", "Central session", { authoritative: true })

    expect(central).not.toBe(workspace)
    expect(meta.get(workspace)).toBeUndefined()
    expect(getState().contentIds).not.toContain(workspace)
    expect(meta.get(central)?.directory).toBeUndefined()
    expect(meta.get(central)?.content).toMatchObject({ sessionRef: { host: "central", sessionId: "ses_1" } })
  })

  test("openCentralSession repairs a filesystem session surface without a ref", () => {
    const { layout, meta, wb, getState } = makeFixture()
    meta.upsert({
      id: "workspace-session",
      type: "session",
      scope: "directory",
      directory: "/work/main",
      sessionId: "ses_1",
      content: {
        type: "session",
        directory: "/work/main",
        sessionId: "ses_1",
      },
    })
    wb.contents.add("workspace-session")

    const id = layout.openCentralSession("ses_1", "Central fallback")

    expect(id).toBe("workspace-session")
    expect(meta.get(id)?.content?.sessionRef).toEqual(localSessionRef("ses_1", "/work/main"))
    expect(getState().contentIds).toContain("workspace-session")
    expect(wb.selectors.focusedContent()).toBe("workspace-session")
  })

  test("openCentralSession does not invent local backing for opaque workspace aliases", () => {
    const { layout, meta } = makeFixture()
    meta.upsert({
      id: "workspace-session",
      type: "session",
      scope: "directory",
      directory: "local-reload-flow",
      sessionId: "ses_1",
      content: {
        type: "session",
        directory: "local-reload-flow",
        sessionId: "ses_1",
      },
    })

    const id = layout.openCentralSession("ses_1", "Central fallback")

    expect(id).toBe("workspace-session")
    expect(meta.get(id)?.content?.sessionRef).toBeUndefined()
  })

  test("openSession does not retarget a different workspace by root id alone", () => {
    const { layout, meta, wb, getState } = makeFixture()
    meta.upsert({
      id: "stale-session",
      type: "session",
      scope: "directory",
      directory: "/work/old",
      sessionId: "ses_1",
      content: { type: "session", directory: "/work/old", sessionId: "ses_1" },
    })
    wb.contents.add("stale-session")

    const id = layout.openSession("/work/new", "ses_1", "Session 1")

    expect(id).not.toBe("stale-session")
    expect(meta.get("stale-session")?.directory).toBe("/work/old")
    expect(meta.get(id)?.directory).toBe("/work/new")
    expect(getState().contentIds).toContain("stale-session")
    expect(getState().contentIds).toContain(id)
  })

  test("openTerminal creates a terminal content", () => {
    const { layout, meta } = makeFixture()
    const id = layout.openTerminal("/work/foo", "pty_1", "Terminal")
    expect(meta.get(id)?.type).toBe("terminal")
    expect(meta.get(id)?.terminalId).toBe("pty_1")
  })

  test("openTerminal refreshes the title for an existing terminal", () => {
    const { layout, meta } = makeFixture()
    const id = layout.openTerminal("/work/foo", "pty_1", "Claude")
    const same = layout.openTerminal("/work/foo", "pty_1", "Claude: Fix typecheck errors")
    expect(same).toBe(id)
    expect(meta.get(id)?.content?.title).toBe("Claude: Fix typecheck errors")
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

  test("openMarketplace creates one reusable closable global content", () => {
    const { layout, meta, getState } = makeFixture()
    const id = layout.openMarketplace()
    const again = layout.openMarketplace()
    expect(again).toBe(id)
    expect(meta.get(id)?.scope).toBe("global")
    expect(meta.get(id)?.directory).toBeUndefined()
    expect(meta.get(id)?.content?.type).toBe("marketplace")

    layout.closeContent(id)

    expect(meta.get(id)).toBeUndefined()
    expect(getState().contentIds).not.toContain(id)
  })

  test("openExtensionView keeps one tab per view id and stores the view id on meta and payload", () => {
    const { layout, meta, getState } = makeFixture()
    const id = layout.openExtensionView("hello-clock.clock", "Clock")
    const again = layout.openExtensionView("hello-clock.clock", "Clock")
    const other = layout.openExtensionView("hello-clock.counter", "Counter")

    expect(again).toBe(id)
    expect(other).not.toBe(id)
    expect(meta.get(id)).toMatchObject({
      type: "extension-view",
      scope: "global",
      viewId: "hello-clock.clock",
      content: { type: "extension-view", viewId: "hello-clock.clock", title: "Clock" },
    })

    layout.closeContent(id)
    expect(meta.get(id)).toBeUndefined()
    expect(getState().contentIds).not.toContain(id)
  })

  test("openWorkGraph reuses one global content", () => {
    const { layout, meta } = makeFixture()
    const id = layout.openWorkGraph()
    const again = layout.openWorkGraph()
    expect(again).toBe(id)
    expect(meta.get(id)).toMatchObject({
      scope: "global",
      content: { type: "workgraph" },
    })
  })

  test("opens one WorkGraph pane per project and one task composer per target", () => {
    const { layout, meta } = makeFixture()
    const project = layout.openWorkspaceWorkGraph("/work/foo")
    const again = layout.openWorkspaceWorkGraph("/work/foo")
    const task = layout.openTaskComposer("/work/foo")

    expect(again).toBe(project)
    expect(meta.get(project)).toMatchObject({
      type: "workspace-workgraph",
      scope: "directory",
      directory: "/work/foo",
      content: { type: "workspace-workgraph", directory: "/work/foo" },
    })
    expect(meta.get(task)).toMatchObject({
      type: "task-composer",
      scope: "directory",
      directory: "/work/foo",
      content: { type: "task-composer", directory: "/work/foo" },
    })
  })

  test("closeContent removes meta + content + cleans terminal owner", () => {
    const { layout, meta, terminal, getState } = makeFixture()
    const id = layout.openTerminal("/work/foo", "pty_1", "Terminal")
    terminal.own(id, "pty_1")
    expect(terminal.owner("pty_1")).toBe(id)
    layout.closeContent(id, "user")
    expect(meta.get(id)).toBeUndefined()
    expect(meta.ids()).not.toContain(id)
    expect(getState().contentIds).not.toContain(id)
    // owner cleared by clearForContent path
    expect(terminal.owner("pty_1")).toBeUndefined()
  })

  test("completeDraftSession converts a draft surface to the created session", () => {
    const { layout, meta, getState } = makeFixture()
    const draft = layout.openDraftSession("/work/foo", "draft_1")

    const completed = layout.completeDraftSession({
      draftId: "draft_1",
      directory: "/work/foo",
      sessionId: "ses_1",
      title: "Created Session",
      sessionRef: localSessionRef("ses_1"),
    })

    expect(completed).toBe(draft)
    expect(meta.get(draft)).toMatchObject({
      id: draft,
      type: "session",
      scope: "directory",
      directory: "/work/foo",
      sessionId: "ses_1",
      content: {
        type: "session",
        directory: "/work/foo",
        sessionId: "ses_1",
        title: "Created Session",
        sessionRef: {
          sessionId: "ses_1",
          host: "workspace",
          cwd: "/work/foo",
          toolSandbox: { kind: "local", cwd: "/work/foo" },
        },
      },
    })
    expect(meta.get(draft)?.draftId).toBeUndefined()
    expect(getState().contentIds).toContain(draft)
  })

  test("completeDraftSession uses explicit session refs", () => {
    const { layout, meta } = makeFixture()
    const draft = layout.openDraftSession("/work/foo", "draft_1")

    layout.completeDraftSession({
      draftId: "draft_1",
      directory: "/work/foo",
      sessionId: "ses_1",
      sessionRef: cloudSessionRef("ses_1"),
    })

    expect(meta.get(draft)?.content?.sessionRef).toEqual(cloudSessionRef("ses_1"))
  })

  test("completeDraftSession does not derive session refs from directory inputs", () => {
    const { layout, meta } = makeFixture()
    const draft = layout.openDraftSession("/work/foo", "draft_1")

    layout.completeDraftSession({
      draftId: "draft_1",
      directory: "/work/foo",
      sessionId: "ses_1",
    })

    expect(meta.get(draft)?.content?.sessionRef).toBeUndefined()
  })

  test("completeDraftSession removes duplicate session surfaces", () => {
    const { layout, meta, getState } = makeFixture()
    const draft = layout.openDraftSession("/work/foo", "draft_1")
    const duplicate = layout.openSession("/work/old", "ses_1", "Old Session")

    layout.completeDraftSession({
      draftId: "draft_1",
      directory: "/work/foo",
      sessionId: "ses_1",
    })

    expect(meta.get(draft)?.type).toBe("session")
    expect(meta.get(duplicate)).toBeUndefined()
    expect(getState().contentIds).not.toContain(duplicate)
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

  describe("surface budget", () => {
    /** Open `count` distinct sessions, oldest first. */
    const openSessions = (
      layout: ReturnType<typeof makeFixture>["layout"],
      count: number,
      opts?: { focus?: boolean },
    ) =>
      Array.from({ length: count }, (_, i) =>
        layout.openSession("/work/foo", `ses_${i + 1}`, `Session ${i + 1}`, {
          sessionRef: localSessionRef(`ses_${i + 1}`),
          ...opts,
        }),
      )

    test("opening past the cap evicts the least-recently-used surface", () => {
      const { layout, getState, meta } = makeFixture()
      const opened = openSessions(layout, MAX_OPEN_SURFACES)
      expect(getState().contentIds).toHaveLength(MAX_OPEN_SURFACES)

      const extra = layout.openSession("/work/foo", "ses_extra", "Extra", {
        sessionRef: localSessionRef("ses_extra"),
      })

      expect(getState().contentIds).toHaveLength(MAX_OPEN_SURFACES)
      expect(getState().contentIds).toContain(extra)
      // The first session opened is the one that has gone the longest unused.
      expect(getState().contentIds).not.toContain(opened[0])
      expect(meta.get(opened[0]!)).toBeUndefined()
      expect(meta.get(opened[1]!)).toBeDefined()
    })

    test("eviction follows use, not open order", () => {
      const { layout, getState } = makeFixture()
      const opened = openSessions(layout, MAX_OPEN_SURFACES)
      // Touch the oldest surface so the second-oldest becomes the LRU.
      layout.showContent(opened[0]!)

      layout.openSession("/work/foo", "ses_extra", "Extra", {
        sessionRef: localSessionRef("ses_extra"),
      })

      expect(getState().contentIds).toContain(opened[0])
      expect(getState().contentIds).not.toContain(opened[1])
    })

    test("a background tab does not evict the surface the user is looking at", () => {
      const { layout, getState, wb } = makeFixture()
      const opened = openSessions(layout, MAX_OPEN_SURFACES)
      const focused = opened.at(-1)!
      expect(wb.selectors.focusedContent()).toBe(focused)

      // Batch auto-tab adds surfaces without stealing focus.
      layout.openSession("/work/foo", "ses_bg", "Background", {
        sessionRef: localSessionRef("ses_bg"),
        focus: false,
      })

      expect(getState().contentIds).toContain(focused)
      expect(wb.selectors.focusedContent()).toBe(focused)
      expect(getState().contentIds).toHaveLength(MAX_OPEN_SURFACES)
    })

    test("never evicts either half of a split", () => {
      const { layout, getState, wb } = makeFixture()
      const left = layout.openSession("/work/left", "ses_left", "Left", {
        sessionRef: localSessionRef("ses_left", "/work/left"),
      })
      const right = layout.openSession("/work/right", "ses_right", "Right", {
        sessionRef: localSessionRef("ses_right", "/work/right"),
      })
      layout.showContent(left)
      layout.splitContent(wb.selectors.contentPane(left)!, "right" satisfies Edge, right)
      expect(wb.selectors.visiblePanes().length).toBe(2)

      // Background adds — `navigation.show` would collapse the split, which is
      // its own documented behaviour and would make both halves unmounted (and
      // so legitimately evictable). Auto-tab does not focus, so the split holds.
      openSessions(layout, MAX_OPEN_SURFACES * 2, { focus: false })

      expect(wb.selectors.visiblePanes().length).toBe(2)
      expect(getState().contentIds).toContain(left)
      expect(getState().contentIds).toContain(right)
      expect(getState().contentIds).toHaveLength(MAX_OPEN_SURFACES)
    })

    test("no pane is ever left pointing at an evicted surface", () => {
      const { layout, getState } = makeFixture()
      openSessions(layout, MAX_OPEN_SURFACES * 3)

      const alive = new Set(getState().contentIds)
      for (const pane of getState().panes) {
        if (pane.contentId === null) continue
        expect(alive.has(pane.contentId)).toBe(true)
      }
    })

    test("never evicts a pinned pages-index surface", () => {
      const { layout, getState, meta } = makeFixture()
      const pinned = layout.openPagesIndex("/work/foo")

      // Push it far past the LRU boundary.
      openSessions(layout, MAX_OPEN_SURFACES * 2)

      expect(getState().contentIds).toContain(pinned)
      expect(meta.get(pinned)?.type).toBe("pages-index")
      expect(getState().contentIds).toHaveLength(MAX_OPEN_SURFACES)
    })

    test("reopening an existing surface never evicts anything", () => {
      const { layout, getState } = makeFixture()
      const opened = openSessions(layout, MAX_OPEN_SURFACES)
      const before = [...getState().contentIds]

      const again = layout.openSession("/work/foo", "ses_1", "Session 1", {
        sessionRef: localSessionRef("ses_1"),
      })

      expect(again).toBe(opened[0])
      expect(getState().contentIds).toEqual(before)
    })

    test("evicting a terminal releases its terminal-slice state", () => {
      const { layout, getState, terminal } = makeFixture()
      const term = layout.openTerminal("/work/foo", "pty_1", "Terminal")
      terminal.own(term, "pty_1")
      expect(terminal.owner("pty_1")).toBe(term)

      openSessions(layout, MAX_OPEN_SURFACES * 2)

      expect(getState().contentIds).not.toContain(term)
      expect(terminal.owner("pty_1")).toBeUndefined()
    })
  })
})
