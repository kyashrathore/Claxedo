import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { createStore, type SetStoreFunction } from "solid-js/store"
import {
  CLOSED_ROUTE_MAX,
  createRouteIntentAdapter,
  isRouteIntentClosed,
  markRouteIntentClosed,
  resetRouteIntentClosedForTest,
  routeIntentClosedSizeForTest,
  sessionInventoryTarget,
  type RouteIntentStateApi,
  type RouteIntent,
} from "./route-intent"
import { workspaceSessionRoute } from "@/platform/identity/route"
import { reducers, selectors as pureSelectors, validate as validateWb } from "../workbench/index"
import type { UseWorkbench, WorkbenchState } from "../workbench/index"
import { createLayoutOrchestration, type OpenSessionOptions } from "./orchestration"
import { createMetadataSlice } from "./metadata"
import { emptyClaxedoState } from "./persistence"
import { createTerminalSlice } from "./terminal"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { ClaxedoStateApi } from "./provider"
import type { ClaxedoState, ContentMeta } from "./types"

type OpenCall =
  | { name: "openSession"; directory: string; sessionId: string; title?: string; focus?: boolean; sessionRef?: SessionRef; workspaceRouteId?: string }
  | { name: "openCentralSession"; sessionId: string; title?: string; focus?: boolean }
  | { name: "openTerminal"; directory: string; terminalId: string; title?: string; focus?: boolean; workspaceRouteId?: string }
  | { name: "openPage"; pageId: string; title?: string; directory?: string; workspaceRouteId?: string }
  | { name: "openPagesIndex"; directory?: string; workspaceRouteId?: string }
  | { name: "openMarketplace" }
  | { name: "openWorkGraph" }
  | { name: "openWorkspaceWorkGraph"; directory: string; workspaceRouteId?: string }
  | { name: "openTaskComposer"; directory?: string; workspaceRouteId?: string }

type PatchCall = {
  id: string
  patch: Partial<ContentMeta>
}

type NavigateCall = {
  path: string
  replace?: boolean
}

type WorkspacePanelCall = {
  mode: "review"
  workspaceDir: string
}

beforeEach(() => {
  resetRouteIntentClosedForTest()
})

test("central inventory identity is not reclassified as a workspace route", () => {
  expect(sessionInventoryTarget("ses_central", {
    loaded: true,
    global: [{
      id: "ses_central",
      sessionRef: "central:ses_central",
      title: "Central",
      directory: "/repo/main",
      workspaceId: "ws_1",
      projectID: "project_1",
      tags: [],
      attachments: [],
      time: { created: 1, updated: 1 },
    }],
    byWorkspace: {},
    byProject: {},
  })).toBeUndefined()
})

test("archived inventory rows are never direct-route targets", () => {
  expect(sessionInventoryTarget("ses_archived", {
    loaded: true,
    global: [],
    byWorkspace: {
      ws_1: {
        workspaceId: "ws_1",
        directory: "/repo/main",
        sessions: [{ id: "ses_archived", archived: true, title: "Archived" }],
      },
    },
    byProject: {
      project_1: [{ id: "ses_archived", archived: true, workspaceId: "ws_1" }],
    },
  })).toBeUndefined()
})

function createHarness(input: {
  focused?: string | null
  meta?: ContentMeta[]
  sessionInventory?: {
    global?: Array<{ id?: string; archived?: boolean; workspaceId?: string; directory?: string; title?: string; environment?: { kind?: string }; harness?: unknown; runner?: unknown; config?: unknown; harnessType?: unknown }>
    byWorkspace?: Record<string, { key?: string; workspaceId?: string; directory?: string; sessions?: Array<{ id?: string; archived?: boolean; title?: string; environment?: { kind?: string }; harness?: unknown; runner?: unknown; config?: unknown; harnessType?: unknown }> }>
    byProject?: Record<string, Array<{ id?: string; archived?: boolean; workspaceId?: string; directory?: string; title?: string; environment?: { kind?: string }; harness?: unknown; runner?: unknown; config?: unknown; harnessType?: unknown }>>
    loaded?: boolean
  }
  resolveSession?: (sessionId: string) => Promise<
    | { directory: string; title?: string; workspaceId?: string; environment?: { kind?: string }; sessionRef?: SessionRef }
    | { unavailable: true; redirect?: string }
    | undefined
  >
  canUseDocuments?: boolean
} = {}) {
  let focused = input.focused ?? null
  let sessionInventory = input.sessionInventory
  const meta = new Map((input.meta ?? []).map((item) => [item.id, item]))
  const opened: OpenCall[] = []
  const patches: PatchCall[] = []
  const shown: string[] = []
  const navigateCalls: NavigateCall[] = []
  const workspacePanelCalls: WorkspacePanelCall[] = []
  const workspacePanelCloseCalls: string[] = []
  const refreshCalls: string[] = []
  const findMeta = (predicate: (meta: ContentMeta) => boolean) =>
    Array.from(meta.values()).find(predicate)

  const state = {
    wb: {
      selectors: {
        focusedContent: () => focused,
      },
      navigation: {
        show: (id: string) => {
          shown.push(id)
          focused = id
        },
      },
    },
    meta: {
      find: findMeta,
      get: (id: string) => meta.get(id),
      patch: (id: string, patch: Partial<ContentMeta>) => {
        patches.push({ id, patch })
        const existing = meta.get(id)
        if (existing) meta.set(id, { ...existing, ...patch })
      },
    },
    workspacePanel: {
      open: (mode: "review", target: { workspaceDir?: string }) => {
        if (!target.workspaceDir) return
        workspacePanelCalls.push({ mode, workspaceDir: target.workspaceDir })
      },
      close: () => {
        workspacePanelCloseCalls.push("close")
      },
    },
    layout: {
      openSession(
        directory: string,
        sessionId: string,
        title?: string,
        opts?: OpenSessionOptions,
      ) {
        opened.push({
          name: "openSession",
          directory,
          sessionId,
          title,
          focus: opts?.focus,
          ...(opts?.sessionRef ? { sessionRef: opts.sessionRef } : {}),
          ...(opts?.workspaceRouteId ? { workspaceRouteId: opts.workspaceRouteId } : {}),
        })
        const existing = findMeta(
          (item) =>
            item.type === "session" &&
            item.directory === directory &&
            item.sessionId === sessionId,
        )
        if (existing) {
          if (opts?.focus !== false) focused = existing.id
          return existing.id
        }
        const id = ["session", ...(sessionId === "new" ? [directory] : []), sessionId].join(":")
        meta.set(id, {
          id,
          type: "session",
          scope: "directory",
          directory,
          sessionId,
          content: {
            type: "session",
            directory,
            sessionId,
            title,
            ...(opts?.sessionRef ? { sessionRef: opts.sessionRef } : {}),
            ...(opts?.workspaceRouteId ? { workspaceRouteId: opts.workspaceRouteId } : {}),
          },
        })
        if (opts?.focus !== false) focused = id
        return id
      },
      openCentralSession(
        sessionId: string,
        title?: string,
        opts?: { focus?: boolean },
      ) {
        opened.push({ name: "openCentralSession", sessionId, title, focus: opts?.focus })
        const existing = findMeta(
          (item) =>
            item.type === "session" &&
            !item.directory &&
            item.sessionId === sessionId,
        )
        if (existing) {
          if (opts?.focus !== false) focused = existing.id
          return existing.id
        }
        const id = `central-session:${sessionId}`
        meta.set(id, {
          id,
          type: "session",
          scope: "global",
          sessionId,
          content: { type: "session", sessionId, title },
        })
        if (opts?.focus !== false) focused = id
        return id
      },
      openPage(pageId: string, title?: string, directory?: string, _filePath?: string, opts?: { workspaceRouteId?: string }) {
        opened.push({
          name: "openPage",
          pageId,
          title,
          directory,
          ...(opts?.workspaceRouteId ? { workspaceRouteId: opts.workspaceRouteId } : {}),
        })
        const existing = findMeta((item) => item.type === "page" && item.pageId === pageId)
        if (existing) {
          meta.set(existing.id, {
            ...existing,
            ...(directory ? { directory, scope: "directory" as const } : {}),
          })
          focused = existing.id
          return existing.id
        }
        const id = `page:${pageId}`
        meta.set(id, {
          id,
          type: "page",
          scope: directory ? "directory" : "global",
          ...(directory ? { directory } : {}),
          pageId,
          content: {
            type: "page",
            pageId,
            title,
            ...(directory ? { directory } : {}),
            ...(opts?.workspaceRouteId ? { workspaceRouteId: opts.workspaceRouteId } : {}),
          },
        })
        focused = id
        return id
      },
      openTerminal(
        directory: string,
        terminalId: string,
        title?: string,
        opts?: { focus?: boolean; workspaceRouteId?: string },
      ) {
        opened.push({
          name: "openTerminal",
          directory,
          terminalId,
          title,
          focus: opts?.focus,
          ...(opts?.workspaceRouteId ? { workspaceRouteId: opts.workspaceRouteId } : {}),
        })
        const existing = findMeta(
          (item) =>
            item.type === "terminal" &&
            item.directory === directory &&
            item.terminalId === terminalId,
        )
        if (existing) {
          if (opts?.focus !== false) focused = existing.id
          return existing.id
        }
        const id = `terminal:${terminalId}`
        meta.set(id, {
          id,
          type: "terminal",
          scope: "directory",
          directory,
          terminalId,
          content: {
            type: "terminal",
            directory,
            terminalId,
            title,
            ...(opts?.workspaceRouteId ? { workspaceRouteId: opts.workspaceRouteId } : {}),
          },
        })
        if (opts?.focus !== false) focused = id
        return id
      },
      openPagesIndex(directory?: string, opts?: { workspaceRouteId?: string }) {
        opened.push({
          name: "openPagesIndex",
          directory,
          ...(opts?.workspaceRouteId ? { workspaceRouteId: opts.workspaceRouteId } : {}),
        })
        const id = `pages-index:${directory ?? "global"}`
        meta.set(id, {
          id,
          type: "pages-index",
          scope: directory ? "directory" : "global",
          ...(directory ? { directory } : {}),
          content: { type: "pages-index", ...(directory ? { directory } : {}) },
        })
        focused = id
        return id
      },
      openMarketplace() {
        opened.push({ name: "openMarketplace" })
        const id = "marketplace"
        meta.set(id, {
          id,
          type: "marketplace",
          scope: "global",
          content: { type: "marketplace" },
        })
        focused = id
        return id
      },
      openWorkGraph() {
        opened.push({ name: "openWorkGraph" })
        focused = "workgraph"
        return "workgraph"
      },
      openWorkspaceWorkGraph(directory: string, opts?: { workspaceRouteId?: string }) {
        opened.push({
          name: "openWorkspaceWorkGraph",
          directory,
          ...(opts?.workspaceRouteId ? { workspaceRouteId: opts.workspaceRouteId } : {}),
        })
        focused = `workspace-workgraph:${directory}`
        return focused
      },
      openTaskComposer(directory?: string, opts?: { workspaceRouteId?: string }) {
        opened.push({
          name: "openTaskComposer",
          directory,
          ...(opts?.workspaceRouteId ? { workspaceRouteId: opts.workspaceRouteId } : {}),
        })
        focused = `task-composer:${directory ?? "global"}`
        return focused
      },
    },
    // as-any: test double implements only the API surface exercised by this test.
  } as unknown as ClaxedoStateApi

  const adapter = createRouteIntentAdapter({
    state,
    warmWorkspace: (directory: string) => {
      refreshCalls.push(directory)
    },
    inventory: () => ({
      global: sessionInventory?.global ?? [],
      byWorkspace: sessionInventory?.byWorkspace ?? {},
      byProject: sessionInventory?.byProject ?? {},
      loaded: sessionInventory?.loaded ?? true,
    }),
    resolveSession: input.resolveSession,
    currentSessionId: () => undefined,
    canUseDocuments: () => input.canUseDocuments,
    navigate: (path, options) => navigateCalls.push({ path, replace: options?.replace }),
  })

  return {
    meta,
    opened,
    patches,
    shown,
    navigateCalls,
    workspacePanelCalls,
    workspacePanelCloseCalls,
    refreshCalls,
    focused: () => focused,
    setSessionInventory: (next: typeof input.sessionInventory) => {
      sessionInventory = next
    },
    receive: (intent: Partial<RouteIntent>) =>
      adapter.receive({
        ready: true,
        marketplace: false,
        workspaceId: "/workspace/main",
        workspaceRouteId: "ws_main",
        sessionId: undefined,
        pageId: undefined,
        terminalId: undefined,
        workspaceBrowse: false,
        sessionTitle: "",
        sessionBadge: undefined,
        ...intent,
      }),
  }
}

function storeBackedWb(input: {
  state: ClaxedoState
  setState: SetStoreFunction<ClaxedoState>
}): UseWorkbench {
  const current = () => validateWb(input.state.workbench).state
  const apply = (mutate: (state: WorkbenchState) => WorkbenchState) => {
    input.setState("workbench", mutate(current()))
  }
  return {
    get state() {
      return current()
    },
    contents: {
      add: (id) => apply((state) => reducers.contents.add(state, id)),
      open: (id, focus = true) => apply((state) => focus
        ? reducers.navigation.show(reducers.contents.add(state, id), id)
        : reducers.contents.add(state, id)),
      remove: (id) => apply((state) => reducers.contents.remove(state, id)),
    },
    panes: {
      assign: (paneId, contentId) =>
        apply((state) => reducers.panes.assign(state, paneId, contentId)),
    },
    split: {
      split: (targetPaneId, edge, contentId) =>
        apply((state) => reducers.split.split(state, targetPaneId, edge, contentId)),
      close: (paneId, opts) =>
        apply((state) => reducers.split.close(state, paneId, opts ?? { destroyContent: false })),
      move: (contentId, fromPaneId, toPaneId) =>
        apply((state) => reducers.split.move(state, contentId, fromPaneId, toPaneId)),
      focus: (paneId) => apply((state) => reducers.split.focus(state, paneId)),
      resize: (path, ratio) => apply((state) => reducers.split.resize(state, path, ratio)),
    },
    navigation: {
      show: (contentId) => apply((state) => reducers.navigation.show(state, contentId)),
    },
    selectors: {
      aliveContents: () => pureSelectors.aliveContents(current()),
      recentContents: () => pureSelectors.recentContents(current()),
      contentPane: (id) => pureSelectors.contentPane(current(), id),
      visiblePanes: () => pureSelectors.visiblePanes(current()),
      paneRect: (id) => pureSelectors.paneRect(current(), id),
      focusedContent: () => pureSelectors.focusedContent(current()),
      snapshotFor: (id) => pureSelectors.snapshotFor(current(), id),
    },
  }
}

function createRealRouteHarness(input: {
  sessionInventory?: {
    global?: Array<{ id?: string; workspaceId?: string; directory?: string; title?: string; environment?: { kind?: string }; harness?: unknown; runner?: unknown; config?: unknown; harnessType?: unknown }>
    byWorkspace?: Record<string, { key?: string; workspaceId?: string; directory?: string; sessions?: Array<{ id?: string; title?: string; environment?: { kind?: string }; harness?: unknown; runner?: unknown; config?: unknown; harnessType?: unknown }> }>
    byProject?: Record<string, Array<{ id?: string; workspaceId?: string; directory?: string; title?: string; environment?: { kind?: string }; harness?: unknown; runner?: unknown; config?: unknown; harnessType?: unknown }>>
    loaded?: boolean
  }
} = {}) {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  const wb = storeBackedWb({ state, setState })
  const meta = createMetadataSlice({ state, setState })
  const terminal = createTerminalSlice({ state, setState })
  const workspacePanelCalls: WorkspacePanelCall[] = []
  const workspacePanelCloseCalls: string[] = []
  const refreshCalls: string[] = []
  const navigateCalls: NavigateCall[] = []
  let sessionInventory = input.sessionInventory
  const layout = createLayoutOrchestration({ wb, meta, terminal })
  const api = {
    wb,
    meta,
    layout,
    workspacePanel: {
      open: (mode: "review", target: { workspaceDir?: string }) => {
        if (!target.workspaceDir) return
        workspacePanelCalls.push({ mode, workspaceDir: target.workspaceDir })
      },
      close: () => {
        workspacePanelCloseCalls.push("close")
      },
    },
  } satisfies RouteIntentStateApi
  const adapter = createRouteIntentAdapter({
    state: api,
    warmWorkspace: (directory: string) => {
      refreshCalls.push(directory)
    },
    inventory: () => ({
      global: sessionInventory?.global ?? [],
      byWorkspace: sessionInventory?.byWorkspace ?? {},
      byProject: sessionInventory?.byProject ?? {},
      loaded: sessionInventory?.loaded ?? true,
    }),
    currentSessionId: () => undefined,
    navigate: (path, options) => navigateCalls.push({ path, replace: options?.replace }),
  })
  return {
    state,
    meta,
    wb,
    workspacePanelCalls,
    workspacePanelCloseCalls,
    refreshCalls,
    navigateCalls,
    setSessionInventory: (next: typeof input.sessionInventory) => {
      sessionInventory = next
    },
    receive: (intent: Partial<RouteIntent>) =>
      adapter.receive({
        ready: true,
        marketplace: false,
        workspaceId: "/workspace/main",
        sessionId: undefined,
        pageId: undefined,
        terminalId: undefined,
        workspaceBrowse: false,
        sessionTitle: "",
        sessionBadge: undefined,
        ...intent,
      }),
  }
}

describe("state route intent", () => {
  test("marketplace route opens global marketplace content", () => {
    const harness = createHarness({ focused: "session:ses-1" })

    harness.receive({ marketplace: true, workspaceId: undefined })

    expect(harness.opened).toEqual([{ name: "openMarketplace" }])
    expect(harness.focused()).toBe("marketplace")
    expect(harness.workspacePanelCalls).toEqual([])
  })

  test("routes project WorkGraph and task composer intents to their owned surfaces", () => {
    const project = createHarness()
    project.receive({ workspaceId: "/repo/main", workspaceWorkGraph: true })
    expect(project.opened).toEqual([{
      name: "openWorkspaceWorkGraph",
      directory: "/repo/main",
      workspaceRouteId: "ws_main",
    }])

    const composer = createHarness()
    composer.receive({ workspaceId: "/repo/main", workspaceRouteId: "ws_main", newTask: true })
    expect(composer.opened).toEqual([{
      name: "openTaskComposer",
      directory: "/repo/main",
      workspaceRouteId: "ws_main",
    }])
  })

  test("workspace browse route opens the workspace panel without creating a session surface", () => {
    const harness = createHarness({ focused: "existing-session" })

    harness.receive({
      workspaceId: "ws_cloud_1",
      workspaceBrowse: true,
    })

    expect(harness.workspacePanelCalls).toEqual([{
      mode: "review",
      workspaceDir: "ws_cloud_1",
    }])
    expect(harness.opened).toEqual([])
    expect(harness.focused()).toBe("existing-session")
  })

  test("workspace browse route does NOT auto-open the review panel at narrow (collapsed) width — WP-C3 §3.2", () => {
    const original = Object.getOwnPropertyDescriptor(window, "innerWidth")
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 })
    try {
      const harness = createHarness({ focused: "existing-session" })

      harness.receive({
        workspaceId: "ws_cloud_1",
        workspaceBrowse: true,
      })

      // At phone width the review panel is full-screen; auto-opening it would
      // bury the composer. The guard suppresses it — no panel, no surface.
      expect(harness.workspacePanelCalls).toEqual([])
      expect(harness.opened).toEqual([])
      expect(harness.focused()).toBe("existing-session")
    } finally {
      if (original) Object.defineProperty(window, "innerWidth", original)
      else delete (window as { innerWidth?: number }).innerWidth
    }
  })

  test("session route without workspace opens a central session surface", () => {
    const harness = createHarness()

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-central",
      sessionTitle: "Central session",
    })

    expect(harness.opened).toEqual([{
      name: "openCentralSession",
      sessionId: "ses-central",
      title: "Central session",
      focus: undefined,
    }])
    expect(harness.focused()).toBe("central-session:ses-central")
    expect(harness.meta.get("central-session:ses-central")).toEqual({
      id: "central-session:ses-central",
      type: "session",
      scope: "global",
      sessionId: "ses-central",
      content: { type: "session", sessionId: "ses-central", title: "Central session" },
    })
  })

  test("session route without workspace parks while inventory loads", () => {
    const harness = createHarness({
      focused: "existing",
      sessionInventory: {
        loaded: false,
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-loading",
      sessionTitle: "Loading route",
    })

    expect(harness.opened).toEqual([])
    expect(harness.shown).toEqual([])
    expect(harness.focused()).toBe("existing")
  })

  test("session route without workspace opens once inventory resolves to a workspace ref", () => {
    const harness = createHarness({
      focused: "existing",
      sessionInventory: {
        loaded: false,
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-loading",
      sessionTitle: "Loading route",
    })
    harness.setSessionInventory({
      loaded: true,
      byWorkspace: {
        ws_cloud_1: {
          workspaceId: "ws_cloud_1",
          sessions: [{ id: "ses-loading", title: "Cloud loaded", environment: { kind: "cloud" } }],
        },
      },
    })
    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-loading",
      sessionTitle: "Loading route",
    })

    expect(harness.opened).toEqual([{
      name: "openSession",
      directory: "ws_cloud_1",
      sessionId: "ses-loading",
      title: "Cloud loaded",
      focus: undefined,
      sessionRef: {
        sessionId: "ses-loading",
        host: "workspace",
        workspaceId: "ws_cloud_1",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_cloud_1",
          hosting: "cloud",
        },
      },
    }])
    expect(harness.refreshCalls).toEqual(["ws_cloud_1"])
    expect(harness.focused()).toBe("session:ses-loading")
  })

  test("session route cold boot opens one real workspace pane after inventory resolves", () => {
    const harness = createRealRouteHarness({
      sessionInventory: {
        loaded: false,
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses_cloud",
      sessionTitle: "Loading route",
    })

    expect(harness.wb.state.panes).toHaveLength(0)
    expect(harness.meta.all()).toEqual([])

    harness.setSessionInventory({
      loaded: true,
      byWorkspace: {
        ws_cloud_1: {
          workspaceId: "ws_cloud_1",
          sessions: [{ id: "ses_cloud", title: "Cloud loaded", environment: { kind: "cloud" } }],
        },
      },
    })
    harness.receive({
      workspaceId: undefined,
      sessionId: "ses_cloud",
      sessionTitle: "Loading route",
    })

    expect(harness.wb.state.panes).toHaveLength(1)
    const contentId = harness.wb.state.panes[0]?.contentId
    expect(contentId).toBeDefined()
    if (!contentId) throw new Error("expected route session content")
    expect(harness.wb.selectors.focusedContent()).toBe(contentId)
    expect(harness.meta.get(contentId)).toMatchObject({
      id: contentId,
      type: "session",
      scope: "directory",
      directory: "ws_cloud_1",
      sessionId: "ses_cloud",
      content: {
        type: "session",
        directory: "ws_cloud_1",
        sessionId: "ses_cloud",
        title: "Cloud loaded",
        sessionRef: {
          sessionId: "ses_cloud",
          host: "workspace",
          workspaceId: "ws_cloud_1",
          toolSandbox: {
            kind: "workspace",
            workspaceId: "ws_cloud_1",
            hosting: "cloud",
          },
        },
      },
    })
    expect(harness.refreshCalls).toEqual(["ws_cloud_1"])

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses_cloud",
      sessionTitle: "Loading route",
    })

    expect(harness.wb.state.panes).toHaveLength(1)
    expect(harness.meta.findAll((item) => item.type === "session" && item.sessionId === "ses_cloud")).toHaveLength(1)
    expect(harness.wb.selectors.focusedContent()).toBe(contentId)
    expect(harness.refreshCalls).toEqual(["ws_cloud_1"])
  })

  test("session route without workspace waits for an async local directory cache before central fallback", async () => {
    const harness = createHarness({
      focused: "existing",
      sessionInventory: {
        loaded: false,
      },
      resolveSession: async (sessionId) => ({
        directory: "/repo/main",
        title: "Resolved local session",
        sessionRef: {
          sessionId,
          host: "workspace",
          cwd: "/repo/main",
          toolSandbox: { kind: "local", cwd: "/repo/main" },
        },
      }),
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-local-resolved",
      sessionTitle: "Fallback",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.opened).toEqual([
      {
        name: "openSession",
        directory: "/repo/main",
        sessionId: "ses-local-resolved",
        title: "Resolved local session",
        focus: undefined,
        sessionRef: {
          sessionId: "ses-local-resolved",
          host: "workspace",
          cwd: "/repo/main",
          toolSandbox: { kind: "local", cwd: "/repo/main" },
        },
      },
    ])
    expect(harness.refreshCalls).toEqual(["/repo/main"])
    expect(harness.focused()).toBe("session:ses-local-resolved")
  })

  test("an unavailable session resolver redirects without recreating a central session", async () => {
    const harness = createHarness({
      focused: "existing",
      sessionInventory: { loaded: true },
      resolveSession: async () => ({
        unavailable: true,
        redirect: "/w/ws_main",
      }),
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses_archived",
      sessionTitle: "Archived",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.opened).toEqual([])
    expect(harness.navigateCalls).toEqual([{ path: "/w/ws_main", replace: true }])
    expect(isRouteIntentClosed({ sessionId: "ses_archived" })).toBe(true)
  })

  test("session route without workspace coalesces repeated async resolver intents into one workspace surface", async () => {
    let resolverCalls = 0
    let resolveTarget: ((target: {
      directory: string
      title?: string
      sessionRef?: SessionRef
    }) => void) | undefined
    const pendingTarget = new Promise<{
      directory: string
      title?: string
      sessionRef?: SessionRef
    }>((resolve) => {
      resolveTarget = resolve
    })
    const harness = createHarness({
      focused: "existing",
      sessionInventory: {
        loaded: false,
      },
      resolveSession: async (sessionId) => {
        resolverCalls += 1
        return await pendingTarget.then((target) => ({
          ...target,
          sessionRef: target.sessionRef ?? {
            sessionId,
            host: "workspace",
            cwd: target.directory,
            toolSandbox: { kind: "local", cwd: target.directory },
          },
        }))
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-coalesced",
      sessionTitle: "Fallback",
    })
    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-coalesced",
      sessionTitle: "Fallback",
    })

    expect(resolverCalls).toBe(1)
    expect(harness.opened).toEqual([])
    expect(harness.focused()).toBe("existing")

    resolveTarget?.({ directory: "/repo/main", title: "Resolved once" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.opened).toEqual([
      {
        name: "openSession",
        directory: "/repo/main",
        sessionId: "ses-coalesced",
        title: "Resolved once",
        focus: undefined,
        sessionRef: {
          sessionId: "ses-coalesced",
          host: "workspace",
          cwd: "/repo/main",
          toolSandbox: { kind: "local", cwd: "/repo/main" },
        },
      },
    ])
    expect(
      Array.from(harness.meta.values()).filter((item) => item.type === "session"),
    ).toHaveLength(1)
    expect(harness.refreshCalls).toEqual(["/repo/main"])
    expect(harness.focused()).toBe("session:ses-coalesced")
  })

  test("session route without workspace builds a SessionRef from resolver metadata", async () => {
    const harness = createHarness({
      focused: "existing",
      sessionInventory: {
        loaded: false,
      },
      resolveSession: async () => ({
        directory: "ws_meta_cloud",
        workspaceId: "ws_meta_cloud",
        environment: { kind: "cloud" },
        title: "Meta cloud session",
      }),
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-meta",
      sessionTitle: "Fallback",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.opened).toEqual([{
      name: "openSession",
      directory: "ws_meta_cloud",
      sessionId: "ses-meta",
      title: "Meta cloud session",
      focus: undefined,
      sessionRef: {
        sessionId: "ses-meta",
        host: "workspace",
        workspaceId: "ws_meta_cloud",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_meta_cloud",
          hosting: "cloud",
        },
      },
    }])
    expect(harness.refreshCalls).toEqual(["ws_meta_cloud"])
    expect(harness.focused()).toBe("session:ses-meta")
  })

  test("session route without workspace activates an existing typed workspace session", () => {
    const harness = createHarness({
      focused: "other",
      meta: [
        {
          id: "workspace-session",
          type: "session",
          scope: "directory",
          directory: "/workspace/main",
          sessionId: "ses-existing",
          content: {
            type: "session",
            directory: "/workspace/main",
            sessionId: "ses-existing",
            title: "Workspace session",
            sessionRef: {
              sessionId: "ses-existing",
              host: "workspace",
              cwd: "/workspace/main",
              toolSandbox: { kind: "local", cwd: "/workspace/main" },
            },
          },
        },
      ],
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-existing",
      sessionTitle: "Session",
    })

    expect(harness.opened).toEqual([])
    expect(harness.shown).toEqual(["workspace-session"])
    expect(harness.focused()).toBe("workspace-session")
  })

  test("session route without workspace opens the inventory-backed workspace session when unique", () => {
    const harness = createHarness({
      sessionInventory: {
        byWorkspace: {
          ws_cloud_1: {
            workspaceId: "ws_cloud_1",
            directory: "/workspace/cloud",
            sessions: [{ id: "ses-cloud", title: "Cloud session", environment: { kind: "cloud" } }],
          },
        },
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-cloud",
      sessionTitle: "Fallback",
    })

    expect(harness.opened).toEqual([{
      name: "openSession",
      directory: "ws_cloud_1",
      sessionId: "ses-cloud",
      title: "Cloud session",
      focus: undefined,
      sessionRef: {
        sessionId: "ses-cloud",
        host: "workspace",
        workspaceId: "ws_cloud_1",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_cloud_1",
          hosting: "cloud",
        },
      },
    }])
    expect(harness.refreshCalls).toEqual(["ws_cloud_1"])
    expect(harness.focused()).toBe("session:ses-cloud")
  })

  test("session inventory preserves harness refs on workspace sessions", () => {
    const harness = createHarness({
      sessionInventory: {
        byWorkspace: {
          ws_cloud_1: {
            workspaceId: "ws_cloud_1",
            directory: "/workspace/cloud",
            sessions: [{
              id: "ses-cloud",
              title: "Cloud session",
              environment: { kind: "cloud" },
              harness: { type: "codex-acp" },
            }],
          },
        },
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-cloud",
      sessionTitle: "Fallback",
    })

    expect(harness.opened[0]?.sessionRef?.harness).toEqual({ id: "codex-acp" })
  })

  test("session route without workspace uses workspace id instead of placeholder /workspace keys", () => {
    const harness = createHarness({
      sessionInventory: {
        byWorkspace: {
          "/workspace": {
            key: "/workspace",
            workspaceId: "ws_cloud_real",
            sessions: [{ id: "ses-cloud", title: "Cloud session", environment: { kind: "cloud" } }],
          },
        },
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-cloud",
      sessionTitle: "Fallback",
    })

    expect(harness.opened).toEqual([{
      name: "openSession",
      directory: "ws_cloud_real",
      sessionId: "ses-cloud",
      title: "Cloud session",
      focus: undefined,
      sessionRef: {
        sessionId: "ses-cloud",
        host: "workspace",
        workspaceId: "ws_cloud_real",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_cloud_real",
          hosting: "cloud",
        },
      },
    }])
    expect(harness.refreshCalls).toEqual(["ws_cloud_real"])
  })

  test("session route without workspace does not treat placeholder /workspace duplicates as unique", () => {
    const harness = createHarness({
      sessionInventory: {
        byWorkspace: {
          "/workspace": {
            key: "/workspace",
            sessions: [{ id: "ses-ambiguous", title: "Placeholder cloud session" }],
          },
          ws_channel_spoofed: {
            workspaceId: "ws_channel_spoofed",
            sessions: [{ id: "ses-ambiguous", title: "Duplicate session", environment: { kind: "user-hosted" } }],
          },
        },
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-ambiguous",
      sessionTitle: "Central fallback",
    })

    expect(harness.opened).toEqual([{
      name: "openCentralSession",
      sessionId: "ses-ambiguous",
      title: "Central fallback",
      focus: undefined,
    }])
  })

  test("session route without workspace resolves sessions from the global inventory list", () => {
    const harness = createHarness({
      sessionInventory: {
        global: [{
          id: "ses-local",
          directory: "/repo/main",
          title: "Local session",
        }],
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-local",
      sessionTitle: "Fallback",
    })

    expect(harness.opened).toEqual([{
      name: "openSession",
      directory: "/repo/main",
      sessionId: "ses-local",
      title: "Local session",
      focus: undefined,
      sessionRef: {
        sessionId: "ses-local",
        host: "workspace",
        cwd: "/repo/main",
        toolSandbox: {
          kind: "local",
          cwd: "/repo/main",
        },
      },
    }])
    expect(harness.refreshCalls).toEqual(["/repo/main"])
  })

  test("session route without workspace lets inventory supersede an existing central placeholder", () => {
    const harness = createHarness({
      focused: "central-session:ses-cloud",
      meta: [
        {
          id: "central-session:ses-cloud",
          type: "session",
          scope: "global",
          sessionId: "ses-cloud",
          content: {
            type: "session",
            sessionId: "ses-cloud",
            title: "Central placeholder",
            sessionRef: {
              sessionId: "ses-cloud",
              host: "central",
              toolSandbox: { kind: "virtual" },
            },
          },
        },
      ],
      sessionInventory: {
        byWorkspace: {
          ws_cloud_1: {
            workspaceId: "ws_cloud_1",
            sessions: [{ id: "ses-cloud", title: "Cloud session", environment: { kind: "cloud" } }],
          },
        },
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-cloud",
      sessionTitle: "Fallback",
    })

    expect(harness.opened).toEqual([{
      name: "openSession",
      directory: "ws_cloud_1",
      sessionId: "ses-cloud",
      title: "Cloud session",
      focus: undefined,
      sessionRef: {
        sessionId: "ses-cloud",
        host: "workspace",
        workspaceId: "ws_cloud_1",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_cloud_1",
          hosting: "cloud",
        },
      },
    }])
  })

  test("session route without workspace falls back to central when inventory is ambiguous", () => {
    const harness = createHarness({
      sessionInventory: {
        byWorkspace: {
          ws_cloud_1: {
            workspaceId: "ws_cloud_1",
            sessions: [{ id: "ses-ambiguous" }],
          },
          ws_cloud_2: {
            workspaceId: "ws_cloud_2",
            sessions: [{ id: "ses-ambiguous" }],
          },
        },
      },
    })

    harness.receive({
      workspaceId: undefined,
      sessionId: "ses-ambiguous",
      sessionTitle: "Central fallback",
    })

    expect(harness.opened).toEqual([{
      name: "openCentralSession",
      sessionId: "ses-ambiguous",
      title: "Central fallback",
      focus: undefined,
    }])
  })

  test("session route without workspace ignores empty session roots", () => {
    const harness = createHarness({ focused: "existing" })

    harness.receive({
      workspaceId: undefined,
      sessionId: undefined,
    })

    expect(harness.opened).toEqual([])
    expect(harness.focused()).toBe("existing")
  })

  test("workspace session root opens the requested workspace instead of keeping stale focus", () => {
    const harness = createHarness({ focused: "stale-session" })

    harness.receive({
      workspaceId: "workspace:ws_local_image_codex",
    })

    expect(harness.opened).toEqual([
      {
        name: "openSession",
        directory: "workspace:ws_local_image_codex",
        sessionId: "new",
        title: "New Session",
        focus: undefined,
        workspaceRouteId: "ws_main",
      },
    ])
    expect(harness.refreshCalls).toEqual(["workspace:ws_local_image_codex"])
    expect(harness.focused()).toBe("session:workspace:ws_local_image_codex:new")
  })

  test("workspace session root carries signed workspace backing from inventory", () => {
    const harness = createHarness({
      focused: "stale-session",
      sessionInventory: {
        byWorkspace: {
          ws_viewer_cloud: {
            workspaceId: "ws_viewer_cloud",
            directory: "/workspace/viewer-cloud",
            sessions: [{ id: "ses-viewer", title: "Viewer session", environment: { kind: "cloud" } }],
          },
        },
      },
    })

    harness.receive({
      workspaceId: "ws_viewer_cloud",
    })

    expect(harness.opened).toEqual([
      {
        name: "openSession",
        directory: "ws_viewer_cloud",
        sessionId: "new",
        title: "New Session",
        focus: undefined,
        workspaceRouteId: "ws_main",
        sessionRef: {
          sessionId: "new",
          host: "workspace",
          workspaceId: "ws_viewer_cloud",
          toolSandbox: {
            kind: "workspace",
            workspaceId: "ws_viewer_cloud",
            hosting: "cloud",
          },
        },
      },
    ])
    expect(harness.refreshCalls).toEqual(["ws_viewer_cloud"])
    expect(harness.focused()).toBe("session:ws_viewer_cloud:new")
  })

  test("workspace session root does not reuse a draft from another route sharing the same directory", () => {
    const harness = createHarness({
      focused: "draft-a",
      meta: [{
        id: "draft-a",
        type: "session",
        scope: "directory",
        directory: "/workspace",
        sessionId: "new",
        content: {
          type: "session",
          directory: "/workspace",
          sessionId: "new",
          workspaceRouteId: "ws_a",
        },
      }],
    })

    harness.receive({ workspaceId: "/workspace", workspaceRouteId: "ws_b" })

    expect(harness.opened).toEqual([{
      name: "openSession",
      directory: "/workspace",
      sessionId: "new",
      title: "New Session",
      focus: undefined,
      workspaceRouteId: "ws_b",
      sessionRef: {
        sessionId: "new",
        host: "workspace",
        cwd: "/workspace",
        toolSandbox: { kind: "local", cwd: "/workspace" },
      },
    }])
  })

  test("workspace session root upgrades an existing draft when signed inventory arrives", () => {
    const harness = createHarness({
      focused: "session:ws_viewer_cloud:new",
      meta: [
        {
          id: "session:ws_viewer_cloud:new",
          type: "session",
          scope: "directory",
          directory: "ws_viewer_cloud",
          sessionId: "new",
          content: {
            type: "session",
            directory: "ws_viewer_cloud",
            sessionId: "new",
            title: "New Session",
            workspaceRouteId: "ws_main",
          },
        },
      ],
      sessionInventory: {
        byWorkspace: {
          ws_viewer_cloud: {
            workspaceId: "ws_viewer_cloud",
            directory: "/workspace/viewer-cloud",
            sessions: [{ id: "ses-viewer", title: "Viewer session", environment: { kind: "cloud" } }],
          },
        },
      },
    })

    harness.receive({
      workspaceId: "ws_viewer_cloud",
    })

    expect(harness.opened).toEqual([])
    expect(harness.patches).toEqual([{
      id: "session:ws_viewer_cloud:new",
      patch: {
        content: {
          type: "session",
          directory: "ws_viewer_cloud",
          sessionId: "new",
          title: "New Session",
          workspaceRouteId: "ws_main",
          sessionRef: {
            sessionId: "new",
            host: "workspace",
            workspaceId: "ws_viewer_cloud",
            toolSandbox: {
              kind: "workspace",
              workspaceId: "ws_viewer_cloud",
              hosting: "cloud",
            },
          },
        },
      },
    }])
    expect(harness.focused()).toBe("session:ws_viewer_cloud:new")
  })

  test("same-workspace session switch skips workspace warmup", () => {
    const harness = createHarness({
      focused: "workspace-session",
      meta: [
        {
          id: "workspace-session",
          type: "session",
          scope: "directory",
          directory: "/workspace/main",
          sessionId: "ses-old",
          content: {
            type: "session",
            directory: "/workspace/main",
            sessionId: "ses-old",
            title: "Old session",
          },
        },
      ],
    })

    harness.receive({
      workspaceId: "/workspace/main",
      sessionId: "ses-next",
      sessionTitle: "Next session",
    })

    expect(harness.refreshCalls).toEqual([])
    expect(harness.opened).toEqual([{
      name: "openSession",
      directory: "/workspace/main",
      sessionId: "ses-next",
      title: "Next session",
      focus: true,
      sessionRef: {
        sessionId: "ses-next",
        host: "workspace",
        cwd: "/workspace/main",
        toolSandbox: {
          kind: "local",
          cwd: "/workspace/main",
        },
      },
      workspaceRouteId: "ws_main",
    }])
  })

  test("workspace session root keeps the already focused draft tab", () => {
    const harness = createHarness({
      focused: "draft-existing",
      meta: [
        {
          id: "draft-existing",
          type: "session",
          scope: "directory",
          directory: "/workspace/main",
          sessionId: "new",
          content: {
            type: "session",
            directory: "/workspace/main",
            sessionId: "new",
            title: "New Session",
            workspaceRouteId: "ws_main",
          },
        },
      ],
    })

    harness.receive({})

    expect(harness.opened).toEqual([])
    expect(harness.shown).toEqual([])
    expect(harness.focused()).toBe("draft-existing")
  })

  test("workspace session root focuses an existing draft instead of opening a duplicate", () => {
    const harness = createHarness({
      focused: "session-existing",
      meta: [
        {
          id: "session-existing",
          type: "session",
          scope: "directory",
          directory: "/workspace/main",
          sessionId: "ses-1",
          content: {
            type: "session",
            directory: "/workspace/main",
            sessionId: "ses-1",
            title: "Existing",
          },
        },
        {
          id: "draft-existing",
          type: "session",
          scope: "directory",
          directory: "/workspace/main",
          sessionId: "new",
          content: {
            type: "session",
            directory: "/workspace/main",
            sessionId: "new",
            title: "New Session",
            workspaceRouteId: "ws_main",
          },
        },
      ],
    })

    harness.receive({})

    expect(harness.opened).toEqual([])
    expect(harness.shown).toEqual(["draft-existing"])
    expect(harness.focused()).toBe("draft-existing")
  })

  test("workspace session root does not recreate a draft immediately after user close", () => {
    const harness = createHarness()

    markRouteIntentClosed({ workspaceId: "/workspace/main" })
    harness.receive({})

    expect(harness.opened).toEqual([])
    expect(harness.focused()).toBeNull()
  })

  test("session deep-links reuse an existing content instead of creating a duplicate", () => {
    const harness = createHarness({
      canUseDocuments: true,
      focused: null,
      meta: [
        {
          id: "session-existing",
          type: "session",
          directory: "/workspace/main",
          sessionId: "ses-1",
          content: {
            type: "session",
            directory: "/workspace/main",
            sessionId: "ses-1",
            title: "Existing",
          },
        },
      ],
    })

    harness.receive({ sessionId: "ses-1", sessionTitle: "Existing" })

    expect(harness.focused()).toBe("session-existing")
    expect(
      Array.from(harness.meta.values()).filter((item) => item.type === "session"),
    ).toHaveLength(1)
  })

  test("signed workspace session routes preserve canonical workspace backing with a filesystem runtime directory", () => {
    const harness = createHarness()

    harness.receive({
      workspaceId: "/tmp/signed-runtime",
      workspaceBacking: { workspaceId: "ws_signed", kind: "user-hosted" },
      sessionId: "ses-signed",
      sessionTitle: "Signed session",
    })

    expect(harness.opened).toEqual([{
      name: "openSession",
      directory: "/tmp/signed-runtime",
      sessionId: "ses-signed",
      title: "Signed session",
      focus: true,
      sessionRef: {
        sessionId: "ses-signed",
        host: "workspace",
        workspaceId: "ws_signed",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_signed",
          hosting: "user-hosted",
        },
      },
      workspaceRouteId: "ws_main",
    }])
  })

  test("legacy filesystem session routes remain local without explicit workspace backing", () => {
    const harness = createHarness()

    harness.receive({
      workspaceId: "/tmp/local-runtime",
      sessionId: "ses-local",
      sessionTitle: "Local session",
    })

    expect(harness.opened[0]?.sessionRef).toEqual({
      sessionId: "ses-local",
      host: "workspace",
      cwd: "/tmp/local-runtime",
      toolSandbox: { kind: "local", cwd: "/tmp/local-runtime" },
    })
  })

  test("signed route backing upgrades a reused local session surface", () => {
    const harness = createHarness({
      focused: "session-existing-local",
      meta: [{
        id: "session-existing-local",
        type: "session",
        directory: "/tmp/signed-runtime",
        sessionId: "ses-signed",
        content: {
          type: "session",
          directory: "/tmp/signed-runtime",
          sessionId: "ses-signed",
          title: "Signed session",
          workspaceRouteId: "ws_main",
          sessionRef: {
            sessionId: "ses-signed",
            host: "workspace",
            cwd: "/tmp/signed-runtime",
            toolSandbox: { kind: "local", cwd: "/tmp/signed-runtime" },
          },
        },
      }],
    })

    harness.receive({
      workspaceId: "/tmp/signed-runtime",
      workspaceBacking: { workspaceId: "ws_signed", kind: "cloud" },
      sessionId: "ses-signed",
      sessionTitle: "Signed session",
    })

    expect(harness.patches).toContainEqual({
      id: "session-existing-local",
      patch: {
        content: {
          type: "session",
          directory: "/tmp/signed-runtime",
          sessionId: "ses-signed",
          title: "Signed session",
          workspaceRouteId: "ws_main",
          sessionRef: {
            sessionId: "ses-signed",
            host: "workspace",
            workspaceId: "ws_signed",
            toolSandbox: { kind: "workspace", workspaceId: "ws_signed", hosting: "cloud" },
          },
        },
      },
    })
  })

  test("session deep-links do not recreate a just-closed session", () => {
    const harness = createHarness()

    markRouteIntentClosed({ sessionId: "ses-closed" })
    harness.receive({ workspaceId: undefined, sessionId: "ses-closed", sessionTitle: "Closed" })

    expect(harness.opened).toEqual([])
    expect(harness.focused()).toBeNull()
  })

  test("repeated closed session route intents do not reopen the tab", () => {
    const harness = createHarness()

    markRouteIntentClosed({ sessionId: "ses-closed-repeat" })
    harness.receive({ workspaceId: undefined, sessionId: "ses-closed-repeat", sessionTitle: "Closed" })
    harness.receive({ workspaceId: undefined, sessionId: "ses-closed-repeat", sessionTitle: "Closed" })

    expect(harness.opened).toEqual([])
    expect(harness.focused()).toBeNull()
  })

  test("back and forward session route intents focus existing panes without duplicating content", () => {
    const harness = createHarness()

    harness.receive({ sessionId: "ses-1", sessionTitle: "First" })
    harness.receive({ sessionId: "ses-2", sessionTitle: "Second" })
    harness.receive({ sessionId: "ses-1", sessionTitle: "First" })

    expect(harness.focused()).toBe("session:ses-1")
    expect(
      Array.from(harness.meta.values()).filter((item) => item.type === "session"),
    ).toEqual([
      expect.objectContaining({ id: "session:ses-1", sessionId: "ses-1" }),
      expect.objectContaining({ id: "session:ses-2", sessionId: "ses-2" }),
    ])

    harness.receive({ sessionId: "ses-2", sessionTitle: "Second" })

    expect(harness.focused()).toBe("session:ses-2")
    expect(
      Array.from(harness.meta.values()).filter((item) => item.type === "session"),
    ).toHaveLength(2)
  })

  test("repeating the same session route intent keeps a single Workbench surface", () => {
    const harness = createHarness()

    harness.receive({ sessionId: "ses-1", sessionTitle: "First" })
    harness.receive({ sessionId: "ses-1", sessionTitle: "First" })
    harness.receive({ sessionId: "ses-1", sessionTitle: "First" })

    expect(harness.focused()).toBe("session:ses-1")
    expect(
      Array.from(harness.meta.values()).filter((item) => item.type === "session"),
    ).toHaveLength(1)
  })

  test("session deep-links preserve a focused context surface for the same workspace", () => {
    const harness = createHarness({
      focused: "context-1",
      meta: [
        {
          id: "context-1",
          type: "context",
          directory: "/workspace/main",
          sessionId: "ses-context",
          content: {
            type: "context",
            directory: "/workspace/main",
            sessionId: "ses-context",
            workspaceRouteId: "ws_main",
          },
        },
      ],
    })

    harness.receive({ sessionId: "ses-2", sessionTitle: "Background session" })

    expect(harness.opened).toContainEqual({
      name: "openSession",
      directory: "/workspace/main",
      sessionId: "ses-2",
      title: "Background session",
      focus: false,
      sessionRef: {
        sessionId: "ses-2",
        host: "workspace",
        cwd: "/workspace/main",
        toolSandbox: { kind: "local", cwd: "/workspace/main" },
      },
      workspaceRouteId: "ws_main",
    })
    expect(harness.focused()).toBe("context-1")
  })

  test("page deep-links reuse a page by id and clear stale session focus", () => {
    const harness = createHarness({
      canUseDocuments: true,
      focused: null,
      meta: [
        {
          id: "page-existing",
          type: "page",
          scope: "directory",
          directory: "/workspace/old",
          pageId: "page-1",
          sessionId: "ses-stale",
          content: {
            type: "page",
            pageId: "page-1",
            directory: "/workspace/old",
            title: "Spec",
          },
        },
      ],
    })

    harness.receive({ pageId: "page-1" })

    expect(harness.patches).toEqual([
      { id: "page-existing", patch: { sessionId: undefined } },
    ])
    expect(harness.meta.get("page-existing")?.directory).toBe("/workspace/main")
    expect(harness.meta.get("page-existing")?.sessionId).toBeUndefined()
    expect(harness.focused()).toBe("page-existing")
  })

  test("page index deep-links open pages-index when pages are unavailable", async () => {
    const harness = createHarness({ canUseDocuments: false })

    harness.receive({ pageId: "__index__" })
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(harness.opened).toContainEqual({
      name: "openPagesIndex",
      directory: "/workspace/main",
      workspaceRouteId: "ws_main",
    })
    expect(harness.navigateCalls).toEqual([])
  })

  test("page index deep-links open pages-index while page access is unresolved", async () => {
    const harness = createHarness()

    harness.receive({ pageId: "__index__" })
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(harness.opened).toContainEqual({
      name: "openPagesIndex",
      directory: "/workspace/main",
      workspaceRouteId: "ws_main",
    })
    expect(harness.navigateCalls).toEqual([])
  })

  test("page deep-links redirect when pages are unavailable", async () => {
    const harness = createHarness({ canUseDocuments: false })

    harness.receive({ pageId: "page-1" })
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(harness.opened).toEqual([])
    expect(harness.navigateCalls).toContainEqual({
      path: workspaceSessionRoute("ws_main"),
      replace: true,
    })
  })

  // --- CONFIRMED BUG (compact tabs "circles") ---
  // Closing a tab is supposed to mark its route closed so the follow-up
  // navigation doesn't recreate it. The existing test
  //   "workspace session root does not recreate a draft immediately after user close"
  // proves this works when the CLOSED surface is a draft (sessionId === "new"),
  // because ClaxedoLayout.onTabClose marks { workspaceId } in that case.
  //
  // For a REAL session that { workspaceId } mark is skipped — it is guarded
  // behind `closedSurface.sessionId === "new" || !closedSurface.sessionId`.
  // onTabClose only marks { workspaceId, sessionId } and { sessionId }. With no
  // next surface it then navigates to the workspace ROOT, which feeds back as a
  // session-less workspace intent keyed `${workspaceId}\0` — a key that was never
  // marked closed. So `receive` is NOT suppressed and immediately re-opens a
  // "New Session" draft. The tab the user just closed reappears, focus moves to
  // it, and it looks like the tab never closes (the reported "circles").
  test("closing a real workspace session does not respawn a draft on the fallback route", () => {
    const harness = createHarness()

    // Mirror ClaxedoLayout.onTabClose for closedSurface = { directory: "/workspace/main", sessionId: "ses-1" }:
    markRouteIntentClosed({ workspaceId: "/workspace/main", sessionId: "ses-1" })
    markRouteIntentClosed({ sessionId: "ses-1" })
    // The fallback-to-workspace-root branch now marks the bare workspace closed
    // too, so the root navigation below does not respawn a "New Session" draft.
    markRouteIntentClosed({ workspaceId: "/workspace/main" })

    // onTabClose has no next surface, so it navigates to the workspace root,
    // which the route layer delivers back as a session-less workspace intent.
    harness.receive({ workspaceId: "/workspace/main", sessionId: undefined })

    // The just-closed workspace must NOT immediately respawn a draft tab.
    expect(harness.opened).toEqual([])
    expect(harness.focused()).toBeNull()
  })

  test("terminal deep-links recover real terminal contents and activate existing ones", () => {
    const missing = createHarness({ focused: "session-existing" })
    missing.receive({ terminalId: "pty-missing" })
    expect(missing.opened).toEqual([
      {
        name: "openTerminal",
        directory: "/workspace/main",
        terminalId: "pty-missing",
        title: "Terminal",
        focus: undefined,
        workspaceRouteId: "ws_main",
      },
    ])
    expect(missing.focused()).toBe("terminal:pty-missing")
    expect(missing.workspacePanelCloseCalls).toEqual(["close"])

    const existing = createHarness({
      focused: "session-existing",
      meta: [
        {
          id: "terminal-existing",
          type: "terminal",
          scope: "directory",
          directory: "/workspace/main",
          terminalId: "pty-1",
          content: {
            type: "terminal",
            directory: "/workspace/main",
            terminalId: "pty-1",
            workspaceRouteId: "ws_main",
          },
        },
      ],
    })
    existing.receive({ terminalId: "pty-1" })
    expect(existing.opened).toEqual([])
    expect(existing.shown).toEqual(["terminal-existing"])
    expect(existing.focused()).toBe("terminal-existing")
    expect(existing.workspacePanelCloseCalls).toEqual(["close"])
  })

  test("stale pending terminal routes redirect to the workspace session", async () => {
    const harness = createHarness({ focused: "session-existing" })
    harness.receive({ terminalId: "pending-old" })
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(harness.opened).toEqual([])
    expect(harness.shown).toEqual([])
    expect(harness.focused()).toBe("session-existing")
    expect(harness.workspacePanelCloseCalls).toEqual(["close"])
    expect(harness.navigateCalls).toEqual([
      { path: workspaceSessionRoute("ws_main"), replace: true },
    ])
  })

  test("active pending terminal routes activate the pending terminal instead of redirecting", async () => {
    const harness = createHarness({
      focused: "session-existing",
      meta: [
        {
          id: "terminal-pending",
          type: "terminal",
          scope: "directory",
          directory: "/workspace/main",
          terminalId: "pending-new",
        },
      ],
    })
    harness.receive({ terminalId: "pending-new" })
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(harness.shown).toEqual(["terminal-pending"])
    expect(harness.focused()).toBe("terminal-pending")
    expect(harness.workspacePanelCloseCalls).toEqual(["close"])
    expect(harness.navigateCalls).toEqual([])
  })
})

describe("closed-route marker eviction", () => {
  afterEach(() => {
    resetRouteIntentClosedForTest()
    setSystemTime()
  })

  // setSystemTime(new Date(0)) is treated by bun as "reset to real clock", so
  // anchor on a nonzero base instant.
  const T0 = 1_000_000

  test("sweeps TTL-expired markers on the next write so stale entries do not accumulate", () => {
    resetRouteIntentClosedForTest()
    setSystemTime(new Date(T0))
    markRouteIntentClosed({ sessionId: "ses-old" })
    expect(routeIntentClosedSizeForTest()).toBe(1)
    expect(isRouteIntentClosed({ sessionId: "ses-old" })).toBe(true)

    // Past the 10s TTL, the next write sweeps the expired marker.
    setSystemTime(new Date(T0 + 11_000))
    markRouteIntentClosed({ sessionId: "ses-new" })

    expect(routeIntentClosedSizeForTest()).toBe(1)
    expect(isRouteIntentClosed({ sessionId: "ses-old" })).toBe(false)
    expect(isRouteIntentClosed({ sessionId: "ses-new" })).toBe(true)
  })

  test("caps the retained set under a burst of closes within the TTL window", () => {
    resetRouteIntentClosedForTest()
    setSystemTime(new Date(T0))
    for (let i = 0; i < CLOSED_ROUTE_MAX + 50; i++) {
      markRouteIntentClosed({ sessionId: `ses-${i}` })
    }
    expect(routeIntentClosedSizeForTest()).toBeLessThanOrEqual(CLOSED_ROUTE_MAX)
  })
})
