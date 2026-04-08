import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"
import type { TabItem } from "./types"
import { createRouteIntentAdapter, isDefaultSessionTitle } from "./route-intent"

type AdapterInput = Parameters<typeof createRouteIntentAdapter>[0]

function waitTick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function baseTopTabs(input?: {
  items?: TabItem[]
  active?: TabItem | undefined
  activeId?: string | null
  addSession?: (
    directory: string,
    sessionId: string,
    title: string,
    badge?: { additions: number; deletions: number },
  ) => string | undefined
  addPagesIndex?: (directory?: string) => string | undefined
  addPage?: (pageId: string, title: string, directory?: string) => string | undefined
  addWorkgraph?: (directory?: string) => string | undefined
  addReviewWorkspace?: (
    directory: string,
    sessionId: string,
    title: string,
    badge?: { additions: number; deletions: number },
    reviewMode?: TabItem["reviewMode"],
    reviewFromRef?: string,
    reviewToRef?: string,
  ) => string | undefined
}) {
  let items = input?.items ?? []
  let active = input?.active
  let activeId = input?.activeId ?? null
  return {
    addSession:
      input?.addSession ??
      ((directory: string, sessionId: string, title: string) => {
        const id = `tab-${sessionId}`
        items = [...items, { id, type: "session", directory, sessionId, title, closable: true }]
        return id
      }),
    addTerminal: () => undefined,
    addPagesIndex: input?.addPagesIndex ?? (() => "tab-pages"),
    addPage:
      input?.addPage ??
      ((pageId: string, _title: string) => {
        return `page-${pageId}`
      }),
    addWorkgraph: input?.addWorkgraph ?? (() => "tab-workgraph"),
    addFile: () => undefined,
    addReview: () => undefined,
    addReviewWorkspace: input?.addReviewWorkspace ?? (() => undefined),
    addContext: () => undefined,
    setActive: (tabId: string) => {
      activeId = tabId
      active = items.find((tab) => tab.id === tabId)
    },
    activeId: () => activeId,
    active: () => active,
    orderedItems: () => items,
    findSession: (directory: string, sessionId: string) =>
      items.find((tab) => tab.type === "session" && tab.directory === directory && tab.sessionId === sessionId),
    patch: (tabId: string, patch: Partial<TabItem>) => {
      items = items.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab))
    },
    close: (tabId: string) => {
      items = items.filter((tab) => tab.id !== tabId)
    },
  }
}

describe("route intent adapter", () => {
  test("activates routed tab and dispatches focus/default commands", async () => {
    const dispatchCalls: Array<{ type: string; [key: string]: unknown }> = []
    const setActiveCalls: string[] = []
    const syncCalls: string[] = []

    const groupTabs: TabItem[] = [
      {
        id: "t-1",
        type: "session",
        directory: "/ws",
        sessionId: "s-1",
        title: "Session",
        closable: true,
      },
    ]

    const input: AdapterInput = {
      claxedo: {
        dispatch(command) {
          dispatchCalls.push(command as { type: string; [key: string]: unknown })
          return
        },
        findTabGroup(tabId) {
          if (tabId === "t-1") return "g-1"
          return
        },
        split: {
          focusedId: () => "g-2",
        },
        groupTabs: () => ({
          items: () => groupTabs,
          activeId: () => null,
          setActive(tabId: string) {
            setActiveCalls.push(tabId)
          },
        }),
        groupWorktree: () => ({
          setDefault: () => undefined,
        }),
        topTabs: baseTopTabs(),
      },
      globalSync: {
        child(directory) {
          syncCalls.push(directory)
          return [{ session: [] }, undefined]
        },
      },
      globalSDK: {
        url: "https://example.com",
        client: {
          session: {
            update: async () => undefined,
          },
        },
      },
      navigate: () => undefined,
    }

    const adapter = createRouteIntentAdapter(input)
    adapter.receive({
      ready: true,
      workspaceId: "/ws",
      tabId: "t-1",
      sessionId: undefined,
      pageId: undefined,
      sessionTitle: "",
      sessionBadge: undefined,
    })
    await waitTick()

    expect(syncCalls).toEqual(["/ws"])
    expect(setActiveCalls).toEqual(["t-1"])
    expect(dispatchCalls[0]?.type).toBe("RouteIntentReceived")
    expect(dispatchCalls[1]).toMatchObject({ type: "SplitFocusRequested", groupId: "g-1" })
    expect(dispatchCalls[2]).toMatchObject({
      type: "GroupWorktreeDefaultSetRequested",
      groupId: "g-1",
      directory: "/ws",
    })
  })

  test("session route opens a separate real session tab and activates it instead of staying on the draft new tab", async () => {
    const setActiveCalls: string[] = []
    const addCalls: Array<{ directory: string; sessionId: string; title: string }> = []
    const navCalls: string[] = []

    const topTabs = baseTopTabs({
      items: [
        {
          id: "tab-new",
          type: "session",
          directory: "/ws",
          sessionId: "new",
          title: "New Session",
          closable: true,
        },
      ],
    })
    const addSession = topTabs.addSession

    const input: AdapterInput = {
      claxedo: {
        dispatch: () => undefined,
        findTabGroup: () => undefined,
        split: {
          focusedId: () => "g-1",
        },
        groupTabs: () => ({
          items: () => [],
          activeId: () => null,
          setActive: () => undefined,
        }),
        groupWorktree: () => ({
          setDefault: () => undefined,
        }),
        topTabs: {
          ...topTabs,
          addSession(directory: string, sessionId: string, title: string, badge) {
            addCalls.push({ directory, sessionId, title })
            return addSession(directory, sessionId, title, badge)
          },
          setActive(tabId: string) {
            setActiveCalls.push(tabId)
            topTabs.setActive(tabId)
          },
        },
      },
      globalSync: {
        child: () => [{ session: [] }, undefined],
      },
      globalSDK: {
        url: "https://example.com",
        client: {
          session: {
            update: async () => undefined,
          },
        },
      },
      navigate(path) {
        navCalls.push(path)
      },
    }

    const adapter = createRouteIntentAdapter(input)
    adapter.receive({
      ready: true,
      workspaceId: "/ws",
      tabId: undefined,
      sessionId: "s-1",
      pageId: undefined,
      sessionTitle: "Session 1",
      sessionBadge: { additions: 3, deletions: 2 },
    })
    await waitTick()

    expect(addCalls).toEqual([{ directory: "/ws", sessionId: "s-1", title: "Session 1" }])
    expect(setActiveCalls).toEqual(["tab-s-1"])
    expect(topTabs.orderedItems().map((tab) => tab.sessionId)).toEqual(["new", "s-1"])
    expect(topTabs.activeId()).toBe("tab-s-1")
    expect(topTabs.active()?.sessionId).toBe("s-1")
    expect(navCalls).toEqual([])
  })

  test("keeps existing session title when route title has not loaded yet", async () => {
    const addCalls: Array<{ directory: string; sessionId: string; title: string }> = []

    const topTabs = baseTopTabs({
      items: [
        {
          id: "tab-s-1",
          type: "session",
          directory: "/ws",
          sessionId: "s-1",
          title: "Existing Title",
          closable: true,
        },
      ],
      addSession(directory, sessionId, title) {
        addCalls.push({ directory, sessionId, title })
        return "tab-s-1"
      },
    })

    const input: AdapterInput = {
      claxedo: {
        dispatch: () => undefined,
        findTabGroup: () => undefined,
        split: {
          focusedId: () => "g-1",
        },
        groupTabs: () => ({
          items: () => [],
          activeId: () => null,
          setActive: () => undefined,
        }),
        groupWorktree: () => ({
          setDefault: () => undefined,
        }),
        topTabs,
      },
      globalSync: {
        child: () => [{ session: [] }, undefined],
      },
      globalSDK: {
        url: "https://example.com",
        client: {
          session: {
            update: async () => undefined,
          },
        },
      },
      navigate: () => undefined,
    }

    const adapter = createRouteIntentAdapter(input)
    adapter.receive({
      ready: true,
      workspaceId: "/ws",
      tabId: undefined,
      sessionId: "s-1",
      pageId: undefined,
      sessionTitle: "",
      sessionBadge: undefined,
    })
    await waitTick()

    expect(addCalls).toEqual([{ directory: "/ws", sessionId: "s-1", title: "Existing Title" }])
  })

  test("does not replace a settled session tab title during route resync", async () => {
    const addCalls: Array<{ directory: string; sessionId: string; title: string }> = []

    const topTabs = baseTopTabs({
      items: [
        {
          id: "tab-s-1",
          type: "session",
          directory: "/ws",
          sessionId: "s-1",
          title: "hello opencode hello opencode",
          closable: true,
        },
      ],
      addSession(directory, sessionId, title) {
        addCalls.push({ directory, sessionId, title })
        return "tab-s-1"
      },
    })

    const input: AdapterInput = {
      claxedo: {
        dispatch: () => undefined,
        findTabGroup: () => undefined,
        split: {
          focusedId: () => "g-1",
        },
        groupTabs: () => ({
          items: () => [],
          activeId: () => null,
          setActive: () => undefined,
        }),
        groupWorktree: () => ({
          setDefault: () => undefined,
        }),
        topTabs,
      },
      globalSync: {
        child: () => [{ session: [] }, undefined],
      },
      globalSDK: {
        url: "https://example.com",
        client: {
          session: {
            update: async () => undefined,
          },
        },
      },
      navigate: () => undefined,
    }

    const adapter = createRouteIntentAdapter(input)
    adapter.receive({
      ready: true,
      workspaceId: "/ws",
      tabId: undefined,
      sessionId: "s-1",
      pageId: undefined,
      sessionTitle: "Intro message: hello opencode",
      sessionBadge: undefined,
    })
    await waitTick()

    expect(addCalls).toEqual([{ directory: "/ws", sessionId: "s-1", title: "hello opencode hello opencode" }])
  })

  test("normalizes page route to tab route for existing page tab", async () => {
    const patchCalls: Array<{ tabId: string; patch: Partial<TabItem> }> = []
    const setActiveCalls: string[] = []
    const navCalls: string[] = []

    const pageTab: TabItem = {
      id: "tab-page-1",
      type: "page",
      directory: "/ws",
      pageId: "page-1",
      sessionId: "s-page",
      title: "Page",
      closable: true,
    }

    const topTabs = baseTopTabs({ items: [pageTab], activeId: null })

    const input: AdapterInput = {
      claxedo: {
        dispatch: () => undefined,
        findTabGroup: () => undefined,
        split: {
          focusedId: () => "g-1",
        },
        groupTabs: () => ({
          items: () => [],
          activeId: () => null,
          setActive: () => undefined,
        }),
        groupWorktree: () => ({
          setDefault: () => undefined,
        }),
        topTabs: {
          ...topTabs,
          patch(tabId: string, patch: Partial<TabItem>) {
            patchCalls.push({ tabId, patch })
          },
          setActive(tabId: string) {
            setActiveCalls.push(tabId)
          },
        },
      },
      globalSync: {
        child: () => [{ session: [] }, undefined],
      },
      globalSDK: {
        url: "https://example.com",
        client: {
          session: {
            update: async () => undefined,
          },
        },
      },
      navigate(path) {
        navCalls.push(path)
      },
    }

    const adapter = createRouteIntentAdapter(input)
    adapter.receive({
      ready: true,
      workspaceId: "/ws",
      tabId: undefined,
      sessionId: undefined,
      pageId: "page-1",
      sessionTitle: "",
      sessionBadge: undefined,
    })
    await waitTick()

    expect(patchCalls).toEqual([{ tabId: "tab-page-1", patch: { sessionId: undefined } }])
    expect(setActiveCalls).toEqual(["tab-page-1"])
    expect(navCalls).toEqual([`/${base64Encode("/ws")}/tab/tab-page-1`])
  })

  test("opens pages index as a global page tab", async () => {
    const addIndexCalls: Array<{ directory?: string }> = []
    const setActiveCalls: string[] = []
    const navCalls: string[] = []

    const input: AdapterInput = {
      claxedo: {
        dispatch: () => undefined,
        findTabGroup: () => undefined,
        split: {
          focusedId: () => "g-1",
        },
        groupTabs: () => ({
          items: () => [],
          activeId: () => null,
          setActive: () => undefined,
        }),
        groupWorktree: () => ({
          setDefault: () => undefined,
        }),
        topTabs: {
          ...baseTopTabs({
            addPagesIndex(directory) {
              addIndexCalls.push({ directory })
              return "tab-pages"
            },
          }),
          setActive(tabId: string) {
            setActiveCalls.push(tabId)
          },
        },
      },
      globalSync: {
        child: () => [{ session: [] }, undefined],
      },
      globalSDK: {
        url: "https://example.com",
        client: {
          session: {
            update: async () => undefined,
          },
        },
      },
      navigate(path) {
        navCalls.push(path)
      },
    }

    const adapter = createRouteIntentAdapter(input)
    adapter.receive({
      ready: true,
      workspaceId: "/ws",
      tabId: undefined,
      sessionId: undefined,
      pageId: "__index__",
      sessionTitle: "",
      sessionBadge: undefined,
    })
    await waitTick()

    expect(addIndexCalls).toEqual([{ directory: undefined }])
    expect(setActiveCalls).toEqual(["tab-pages"])
    expect(navCalls).toEqual([`/${base64Encode("/ws")}/tab/tab-pages`])
  })

  test("redirects workgraph routes back to the workspace session when disabled", async () => {
    const addWorkgraphCalls: Array<{ directory?: string }> = []
    const navCalls: string[] = []

    const input: AdapterInput = {
      claxedo: {
        dispatch: () => undefined,
        findTabGroup: () => undefined,
        split: {
          focusedId: () => "g-1",
        },
        groupTabs: () => ({
          items: () => [],
          activeId: () => null,
          setActive: () => undefined,
        }),
        groupWorktree: () => ({
          setDefault: () => undefined,
        }),
        topTabs: baseTopTabs({
          addWorkgraph(directory) {
            addWorkgraphCalls.push({ directory })
            return "tab-workgraph"
          },
        }),
      },
      globalSync: {
        child: () => [{ session: [] }, undefined],
      },
      globalSDK: {
        url: "https://example.com",
        client: {
          session: {
            update: async () => undefined,
          },
        },
      },
      workgraphEnabled: () => false,
      navigate(path) {
        navCalls.push(path)
      },
    }

    const adapter = createRouteIntentAdapter(input)
    adapter.receive({
      ready: true,
      workspaceId: "/ws",
      tabId: undefined,
      sessionId: undefined,
      pageId: "__workgraph__",
      sessionTitle: "",
      sessionBadge: undefined,
    })
    await waitTick()

    expect(addWorkgraphCalls).toEqual([])
    expect(navCalls).toEqual([`/${base64Encode("/ws")}/session`])
  })

  test("workspace root with no tabs creates a new session without redirecting to a tab route", async () => {
    const addCalls: Array<{ directory: string; sessionId: string; title: string }> = []
    const setActiveCalls: string[] = []
    const navCalls: string[] = []

    const topTabs = baseTopTabs({
      items: [],
      addSession(directory, sessionId, title) {
        addCalls.push({ directory, sessionId, title })
        return `tab-${sessionId}`
      },
    })

    const input: AdapterInput = {
      claxedo: {
        dispatch: () => undefined,
        findTabGroup: () => undefined,
        split: { focusedId: () => "g-1" },
        groupTabs: () => ({
          items: () => [],
          activeId: () => null,
          setActive: () => undefined,
        }),
        groupWorktree: () => ({ setDefault: () => undefined }),
        topTabs: {
          ...topTabs,
          setActive(tabId: string) { setActiveCalls.push(tabId) },
        },
      },
      globalSync: { child: () => [{ session: [] }, undefined] },
      globalSDK: {
        url: "https://example.com",
        client: { session: { update: async () => undefined } },
      },
      navigate(path) { navCalls.push(path) },
    }

    const adapter = createRouteIntentAdapter(input)
    adapter.receive({
      ready: true,
      workspaceId: "/ws",
      tabId: undefined,
      sessionId: undefined,
      pageId: undefined,
      sessionTitle: "",
      sessionBadge: undefined,
    })
    await waitTick()

    // Route-intent should auto-create a session for workspace root with no tabs
    expect(addCalls).toEqual([{ directory: "/ws", sessionId: "new", title: "New Session" }])
    expect(setActiveCalls).toEqual(["tab-new"])
    expect(navCalls).toEqual([])
  })

  test("workspace root with an existing draft session activates it without redirecting", async () => {
    const setActiveCalls: string[] = []
    const navCalls: string[] = []

    const existingTab: TabItem = {
      id: "tab-existing",
      type: "session",
      directory: "/ws",
      sessionId: "new",
      title: "New Session",
      closable: true,
    }

    const topTabs = baseTopTabs({
      items: [existingTab],
      activeId: null,
    })

    const input: AdapterInput = {
      claxedo: {
        dispatch: () => undefined,
        findTabGroup: () => undefined,
        split: { focusedId: () => "g-1" },
        groupTabs: () => ({
          items: () => [],
          activeId: () => null,
          setActive: () => undefined,
        }),
        groupWorktree: () => ({ setDefault: () => undefined }),
        topTabs: {
          ...topTabs,
          setActive(tabId: string) { setActiveCalls.push(tabId) },
        },
      },
      globalSync: { child: () => [{ session: [] }, undefined] },
      globalSDK: {
        url: "https://example.com",
        client: { session: { update: async () => undefined } },
      },
      navigate(path) { navCalls.push(path) },
    }

    const adapter = createRouteIntentAdapter(input)
    adapter.receive({
      ready: true,
      workspaceId: "/ws",
      tabId: undefined,
      sessionId: undefined,
      pageId: undefined,
      sessionTitle: "",
      sessionBadge: undefined,
    })
    await waitTick()

    // Should activate the existing draft session, not redirect to a volatile tab URL
    expect(setActiveCalls).toEqual(["tab-existing"])
    expect(navCalls).toEqual([])
  })

  test("default title guard matches generated new-session titles", () => {
    expect(isDefaultSessionTitle("New session - 2026-01-01T10:00:00.000Z")).toBe(true)
    expect(isDefaultSessionTitle("Child session - 2026-01-01T10:00:00.000Z")).toBe(true)
    expect(isDefaultSessionTitle("Session title")).toBe(false)
  })

  test("recovers review workspace tabs with review refs", async () => {
    const addCalls: Array<{
      directory: string
      sessionId: string
      title: string
      reviewMode: TabItem["reviewMode"] | undefined
      reviewFromRef: string | undefined
      reviewToRef: string | undefined
    }> = []
    const navCalls: string[] = []

    const input: AdapterInput = {
      claxedo: {
        dispatch: () => undefined,
        findTabGroup: () => undefined,
        split: {
          focusedId: () => "g-1",
        },
        groupTabs: () => ({
          items: () => [],
          activeId: () => null,
          setActive: () => undefined,
        }),
        groupWorktree: () => ({
          setDefault: () => undefined,
        }),
        topTabs: {
          ...baseTopTabs({
            addReviewWorkspace(directory, sessionId, title, _badge, reviewMode, reviewFromRef, reviewToRef) {
              addCalls.push({
                directory,
                sessionId,
                title,
                reviewMode,
                reviewFromRef,
                reviewToRef,
              })
              return "tab-review"
            },
          }),
          setActive: () => undefined,
        },
      },
      globalSync: {
        child: () => [{ session: [] }, undefined],
      },
      globalSDK: {
        url: "https://example.com",
        client: {
          session: {
            update: async () => undefined,
          },
        },
      },
      navigate(path) {
        navCalls.push(path)
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            context: {
              tabId: "review-tab",
              tabType: "review-workspace",
              directory: "/ws",
              title: "Review: Uncommitted",
              sessionId: "s-review",
              reviewMode: "uncommitted",
              reviewFromRef: "main",
              reviewToRef: "HEAD",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    }

    const adapter = createRouteIntentAdapter(input)
    adapter.receive({
      ready: true,
      workspaceId: "/ws",
      tabId: "review-tab",
      sessionId: undefined,
      pageId: undefined,
      sessionTitle: "",
      sessionBadge: undefined,
    })
    await waitTick()
    await waitTick()

    expect(addCalls).toEqual([
      {
        directory: "/ws",
        sessionId: "s-review",
        title: "Review: Uncommitted",
        reviewMode: "uncommitted",
        reviewFromRef: "main",
        reviewToRef: "HEAD",
      },
    ])
    expect(navCalls).toEqual([`/${base64Encode("/ws")}/tab/tab-review`])
  })
})
