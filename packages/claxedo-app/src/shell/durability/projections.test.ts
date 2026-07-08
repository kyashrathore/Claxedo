import { describe, expect, test } from "bun:test"
import {
  clearProjectionCacheOnSignOut,
  createHarnessConfigProjection,
  createHarnessConfigProjectionRehydrator,
  createWorkbenchProjection,
  createWorkbenchProjectionRehydrator,
  isProjectionCacheKey,
  migrateHarnessConfigProjection,
  migrateWorkbenchProjection,
  projectionScopeKey,
  harnessConfigProjectionKey,
  workbenchProjectionKey,
} from "./projections"

const scope = { userId: "user_1", workspaceId: "ws_1" }

function memoryCache() {
  const storage = new Map<string, string>()
  return {
    async get<T>(key: string) {
      const value = storage.get(key)
      return value === undefined ? undefined : JSON.parse(value) as T
    },
    async set<T>(key: string, value: T) {
      storage.set(key, JSON.stringify(value))
    },
    async delete(key: string) {
      storage.delete(key)
    },
    async clear() {
      storage.clear()
    },
  }
}

function delayed<T>() {
  const state = {} as { resolve: (value: T) => void }
  const promise = new Promise<T>((resolve) => {
    state.resolve = resolve
  })
  return { promise, resolve: state.resolve }
}

describe("server-owned projections", () => {
  test("keys durable projections by user and workspace", () => {
    expect(projectionScopeKey(scope)).toBe("user_1:ws_1")
    expect(workbenchProjectionKey(scope)).toBe("projection:workbench:user_1:ws_1")
    expect(harnessConfigProjectionKey({ userId: "user_1" })).toBe("projection:harness-config:user_1:global")
  })

  test("identifies warm projection cache keys without matching server durable records", () => {
    expect(isProjectionCacheKey("projection:workbench:user_1:ws_1")).toBe(true)
    expect(isProjectionCacheKey("projection:harness-config:user_1:global")).toBe(true)
    expect(isProjectionCacheKey("server:durable:projection:workbench:user_1:ws_1")).toBe(false)
  })

  test("creates workbench projection with LayoutConfig plus existing workbench split tree", () => {
    const projection = createWorkbenchProjection({
      scope,
      updatedAt: 1,
      value: {
        workbench: {
          panes: [{ id: "pane_1", contentId: "content_1" }],
          split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_1" } },
          contentIds: ["content_1"],
          contentRecency: ["content_1"],
          focusedPaneId: "pane_1",
          layoutSnapshots: {},
        },
        meta: {
          content_1: {
            id: "content_1",
            type: "session",
            directory: "/repo",
            sessionId: "ses_1",
          },
        },
      },
    })

    expect(projection.type).toBe("workbench")
    expect(projection.value.layout.regions.workbench.slot).toBe("workbench")
    expect(projection.value.workbench.focusedPaneId).toBe("pane_1")
    expect(projection.value.meta.content_1?.sessionId).toBe("ses_1")
  })

  test("migrates old flat claxedo state into a server-owned workbench projection", () => {
    const result = migrateWorkbenchProjection({
      scope,
      updatedAt: 2,
      stored: {
        workbench: {
          panes: [{ id: "pane_1", contentId: null }],
          split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_1" } },
          contentIds: [],
          contentRecency: [],
          focusedPaneId: "pane_1",
          layoutSnapshots: {},
        },
        rail: { collapsed: true, pinned: false },
        workspacePanel: { open: true },
      },
    })

    expect(result.dirty).toBe(true)
    expect(result.projection.scope).toEqual(scope)
    expect(result.projection.updatedAt).toBe(2)
    expect(result.projection.value.layout.regions.rail.size).toEqual({ unit: "px", value: 0 })
    expect(result.projection.value.layout.regions.workspacePanel.visible).toBe(true)
  })

  test("creates and migrates harness config projection from legacy runner arrays", () => {
    const result = migrateHarnessConfigProjection({
      scope,
      updatedAt: 3,
      stored: {
        runners: [
          {
            id: "runner_1",
            kind: "claude-sdk",
            label: "Claude SDK",
            model: "sonnet",
            workspaceId: "ws_1",
          },
        ],
        selectedRunnerIdBySession: {
          ses_1: "runner_1",
          ignored: null,
        },
      },
    })

    expect(result.dirty).toBe(true)
    expect(result.projection).toEqual(createHarnessConfigProjection({
      scope,
      updatedAt: 3,
      profiles: [{
        id: "runner_1",
        kind: "claude-sdk",
        label: "Claude SDK",
        model: { providerID: "claude-sdk", modelID: "sonnet" },
        scope: "workspace",
        workspaceId: "ws_1",
      }],
      selectedHarnessIdBySession: { ses_1: "runner_1" },
    }))
  })

  test("harness config projection keeps credential references but drops raw secrets", () => {
    const result = migrateHarnessConfigProjection({
      scope,
      updatedAt: 4,
      stored: {
        runners: [
          {
            id: "runner_secret",
            kind: "claude-sdk",
            label: "Claude SDK",
            model: { providerID: "anthropic", modelID: "sonnet" },
            credentialRef: "credential:anthropic",
            apiKey: "sk-raw",
            token: "token-raw",
            secret: "secret-raw",
            password: "password-raw",
          },
        ],
      },
    })

    expect(result.projection.value.profiles).toEqual([{
      id: "runner_secret",
      kind: "claude-sdk",
      label: "Claude SDK",
      model: { providerID: "anthropic", modelID: "sonnet" },
      credentialRef: "credential:anthropic",
      scope: "user",
    }])
    expect(JSON.stringify(result.projection.value)).not.toContain("sk-raw")
    expect(JSON.stringify(result.projection.value)).not.toContain("token-raw")
    expect(JSON.stringify(result.projection.value)).not.toContain("secret-raw")
    expect(JSON.stringify(result.projection.value)).not.toContain("password-raw")
  })

  test("sign out clears warm projection cache only", async () => {
    const cache = memoryCache()
    await cache.set(workbenchProjectionKey(scope), { cached: "workbench" })
    await cache.set(harnessConfigProjectionKey(scope), { cached: "runner" })
    await cache.set("server:durable:untouched", { keep: true })

    await clearProjectionCacheOnSignOut({ cache, scope })

    expect(await cache.get(workbenchProjectionKey(scope))).toBeUndefined()
    expect(await cache.get(harnessConfigProjectionKey(scope))).toBeUndefined()
    expect(await cache.get("server:durable:untouched")).toEqual({ keep: true })
  })

  test("rehydrates workbench projection from warm cache then lets server live state win", async () => {
    const cache = memoryCache()
    const warm = createWorkbenchProjection({ scope, updatedAt: 1 })
    const live = createWorkbenchProjection({ scope, updatedAt: 2 })
    await cache.set(workbenchProjectionKey(scope), warm)

    const rehydrator = createWorkbenchProjectionRehydrator({
      cache,
      scope,
      loadLive: async () => live,
    })

    expect(await rehydrator.warm()).toEqual({ phase: "warm", value: warm })
    expect(await rehydrator.live()).toEqual({ phase: "live", value: live })
    expect(await cache.get(workbenchProjectionKey(scope))).toEqual(live)
  })

  test("workspace-backed cold boot exposes warm layout before delayed live state resolves", async () => {
    const cache = memoryCache()
    const liveState = delayed<ReturnType<typeof createWorkbenchProjection> | undefined>()
    const warm = createWorkbenchProjection({
      scope,
      updatedAt: 1,
      value: {
        workbench: {
          panes: [{ id: "pane_warm", contentId: "content_warm" }],
          split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_warm" } },
          contentIds: ["content_warm"],
          contentRecency: ["content_warm"],
          focusedPaneId: "pane_warm",
          layoutSnapshots: {},
        },
      },
    })
    const live = createWorkbenchProjection({ scope, updatedAt: 2 })
    await cache.set(workbenchProjectionKey(scope), warm)

    const rehydrator = createWorkbenchProjectionRehydrator({
      cache,
      scope,
      loadLive: () => liveState.promise,
    })
    const livePromise = rehydrator.live()

    expect(await rehydrator.warm()).toEqual({ phase: "warm", value: warm })
    expect(rehydrator.snapshot()).toEqual({ phase: "warm", value: warm })

    liveState.resolve(live)
    expect(await livePromise).toEqual({ phase: "live", value: live })
    expect(await cache.get(workbenchProjectionKey(scope))).toEqual(live)
  })

  test("rehydrates harness config projection through the same server-owned path", async () => {
    const cache = memoryCache()
    const live = createHarnessConfigProjection({
      scope,
      updatedAt: 2,
      profiles: [{
        id: "runner_live",
        kind: "claude-sdk",
        label: "Live",
        model: { providerID: "anthropic", modelID: "sonnet" },
        scope: "workspace",
        workspaceId: "ws_1",
      }],
    })

    const rehydrator = createHarnessConfigProjectionRehydrator({
      cache,
      scope,
      loadLive: async () => live,
    })

    expect(await rehydrator.run()).toEqual({ phase: "live", value: live })
    expect(await cache.get(harnessConfigProjectionKey(scope))).toEqual(live)
  })

  test("server-owned workbench and harness config survive web and desktop cache changes", async () => {
    const webCache = memoryCache()
    const desktopCache = memoryCache()
    const liveWorkbench = createWorkbenchProjection({ scope, updatedAt: 10 })
    const liveRunner = createHarnessConfigProjection({
      scope,
      updatedAt: 10,
      profiles: [{
        id: "runner_server",
        kind: "claude-sdk",
        label: "Server Runner",
        model: { providerID: "anthropic", modelID: "sonnet" },
        scope: "workspace",
        workspaceId: "ws_1",
      }],
      selectedHarnessIdBySession: { ses_1: "runner_server" },
    })

    await webCache.set(workbenchProjectionKey(scope), createWorkbenchProjection({ scope, updatedAt: 1 }))
    await webCache.set(harnessConfigProjectionKey(scope), createHarnessConfigProjection({ scope, updatedAt: 1 }))

    expect(await createWorkbenchProjectionRehydrator({
      cache: webCache,
      scope,
      loadLive: async () => liveWorkbench,
    }).run()).toEqual({ phase: "live", value: liveWorkbench })
    expect(await createHarnessConfigProjectionRehydrator({
      cache: webCache,
      scope,
      loadLive: async () => liveRunner,
    }).run()).toEqual({ phase: "live", value: liveRunner })
    expect(await createWorkbenchProjectionRehydrator({
      cache: desktopCache,
      scope,
      loadLive: async () => liveWorkbench,
    }).run()).toEqual({ phase: "live", value: liveWorkbench })
    expect(await createHarnessConfigProjectionRehydrator({
      cache: desktopCache,
      scope,
      loadLive: async () => liveRunner,
    }).run()).toEqual({ phase: "live", value: liveRunner })

    expect(await webCache.get(workbenchProjectionKey(scope))).toEqual(liveWorkbench)
    expect(await desktopCache.get(workbenchProjectionKey(scope))).toEqual(liveWorkbench)
    expect(await webCache.get(harnessConfigProjectionKey(scope))).toEqual(liveRunner)
    expect(await desktopCache.get(harnessConfigProjectionKey(scope))).toEqual(liveRunner)
  })
})
