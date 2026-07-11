import { beforeEach, describe, expect, test } from "bun:test"
import {
  globalBootstrapFetch,
  shouldUseSignedRouteBootstrap,
  workspaceScopedCacheKey,
} from "@/shell/data/bootstrap-orchestrator"
import {
  shouldUseSignedControlPlaneInventory,
  shouldUseSignedSessionInventory,
  shouldUseSignedProjectSessionInventory,
} from "@/context/global-sync"
import { normalizeClaxedoSessionLifecycleEvent } from "@/shell/data/event-ingress"
import { queryClient } from "../shared/query/query-client"
import { queryKeys } from "../shared/query/keys"

if (typeof localStorage === "undefined") {
  const memory = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => memory.clear(),
      getItem: (key: string) => memory.get(key) ?? null,
      removeItem: (key: string) => memory.delete(key),
      setItem: (key: string, value: string) => memory.set(key, value),
    },
  })
}

describe("global sync inventory source", () => {
  beforeEach(() => {
    localStorage.clear()
    queryClient.clear()
  })

  test("uses local inventory for signed-in loopback local directories", () => {
    expect(shouldUseSignedControlPlaneInventory({
      hasSignedAccess: true,
      baseUrl: "http://127.0.0.1:3001",
      directory: "/Users/yashvardhansingh/test/opencode",
    })).toBe(false)
  })

  test("uses signed inventory for signed-in loopback directories backed by a remote workspace alias", () => {
    queryClient.setQueryData(queryKeys.controlPlane.projects("http://127.0.0.1:3001"), [
      {
        id: "project_1",
        worktree: "/Users/yashvardhansingh/test/opencode",
        sandboxes: ["/Users/yashvardhansingh/test/opencode"],
        time: { created: 0, updated: 0 },
        workspaces: {
          "/Users/yashvardhansingh/test/opencode": {
            id: "ws_user_hosted",
            kind: "user-hosted",
            directory: "/Users/yashvardhansingh/test/opencode",
          },
        },
      },
    ])

    expect(shouldUseSignedControlPlaneInventory({
      hasSignedAccess: true,
      baseUrl: "http://127.0.0.1:3001",
      directory: "/Users/yashvardhansingh/test/opencode",
    })).toBe(true)
  })

  test("uses signed inventory for signed-in loopback cloud workspace refs", () => {
    expect(shouldUseSignedControlPlaneInventory({
      hasSignedAccess: true,
      baseUrl: "http://127.0.0.1:3001",
      directory: "workspace:ws_123",
    })).toBe(true)
  })

  test("uses local inventory for signed-in loopback global workspace lists (Local Personal Mode)", () => {
    // Loopback global queries (no directory) must stay on the unsigned local
    // path so Local Personal Mode does not bounce against an empty Convex
    // workspace list and lose the local session inventory.
    expect(shouldUseSignedControlPlaneInventory({
      hasSignedAccess: true,
      baseUrl: "http://127.0.0.1:3001",
    })).toBe(false)
  })

  test("uses signed project session inventory for loopback cloud workspaces", () => {
    expect(shouldUseSignedSessionInventory({
      hasSignedAccess: true,
      signedRoute: false,
      baseUrl: "http://127.0.0.1:3001",
    })).toBe(false)
    expect(shouldUseSignedProjectSessionInventory({
      hasSignedAccess: true,
      baseUrl: "http://127.0.0.1:3001",
      project: {
        worktree: "/Users/yashvardhansingh/test/opencode",
        sandboxes: ["workspace:ws_123"],
        workspaces: {
          "workspace:ws_123": { kind: "cloud" },
        },
      },
    })).toBe(true)
  })

  test("uses signed global session inventory for loopback workspace routes", () => {
    expect(shouldUseSignedSessionInventory({
      hasSignedAccess: true,
      signedRoute: true,
      baseUrl: "http://127.0.0.1:3001",
    })).toBe(true)
  })

  test("uses signed global session inventory for hosted workspace lists", () => {
    expect(shouldUseSignedSessionInventory({
      hasSignedAccess: true,
      signedRoute: false,
      baseUrl: "https://app.claxedo.test",
    })).toBe(true)
    expect(shouldUseSignedProjectSessionInventory({
      hasSignedAccess: true,
      baseUrl: "https://app.claxedo.test",
      project: {
        worktree: "workspace:ws_123",
        sandboxes: ["workspace:ws_456"],
        workspaces: {
          "workspace:ws_123": { kind: "cloud" },
        },
      },
    })).toBe(true)
  })

  test("uses signed inventory for non-loopback deployments", () => {
    expect(shouldUseSignedControlPlaneInventory({
      hasSignedAccess: true,
      baseUrl: "https://app.claxedo.test",
      directory: "/workspace",
    })).toBe(true)
  })

  test("uses local loopback fetch for localhost bootstrap even when platform auth fetch exists", () => {
    const platformFetch = (async () => new Response()) as typeof fetch

    expect(globalBootstrapFetch("http://localhost:3001", platformFetch)).toBe(globalThis.fetch)
  })

  test("keys workspace-backed SDK cache by workspaceId instead of directory aliases", () => {
    expect(workspaceScopedCacheKey({
      directory: "/Users/me/repo",
      workspaceId: "ws_cloud",
    })).toBe("ws_cloud")
    expect(workspaceScopedCacheKey({
      directory: "ws_cloud",
      workspaceId: "ws_cloud",
    })).toBe("ws_cloud")
    expect(workspaceScopedCacheKey({
      directory: "workspace:ws_cloud",
      workspaceId: "ws_cloud",
    })).toBe("ws_cloud")
    expect(workspaceScopedCacheKey({
      directory: "/Users/me/local",
    })).toBe("/Users/me/local")
  })

  test("does not force signed workspace-route bootstrap on loopback", () => {
    const platformFetch = (async () => new Response()) as typeof fetch

    expect(shouldUseSignedRouteBootstrap({
      signedRoute: true,
      baseUrl: "http://127.0.0.1:3001",
      platformFetch,
    })).toBe(false)
  })

  test("uses signed workspace-route bootstrap only for hosted URLs", () => {
    const platformFetch = (async () => new Response()) as typeof fetch

    expect(shouldUseSignedRouteBootstrap({
      signedRoute: true,
      baseUrl: "https://app.claxedo.test",
      platformFetch,
    })).toBe(true)
  })

  test("uses platform fetch for non-loopback bootstrap", () => {
    const platformFetch = (async () => new Response()) as typeof fetch

    expect(globalBootstrapFetch("https://app.claxedo.test", platformFetch)).toBe(platformFetch)
  })

  test("normalizes valid Claxedo session lifecycle events", () => {
    const event = normalizeClaxedoSessionLifecycleEvent({
      type: "session.lifecycle",
      phase: "created",
      directory: "workspace:ws_123",
      sessionID: "ses_1",
      info: {
        id: "ses_1",
        slug: "ses-1",
        projectID: "proj_1",
        directory: "workspace:ws_123",
        title: "Session 1",
        version: "1",
        time: { created: 1, updated: 2 },
      },
      ts: 3,
    })

    expect(event?.info?.id).toBe("ses_1")
    expect(event?.info?.directory).toBe("workspace:ws_123")
  })

  test("fills lifecycle session directory from event envelope", () => {
    const event = normalizeClaxedoSessionLifecycleEvent({
      type: "session.lifecycle",
      phase: "created",
      directory: "workspace:ws_123",
      sessionID: "ses_1",
      info: {
        id: "ses_1",
        slug: "ses-1",
        projectID: "proj_1",
        title: "Session 1",
        version: "1",
        time: { created: 1, updated: 2 },
      },
      ts: 3,
    })

    expect(event?.info?.directory).toBe("workspace:ws_123")
  })

  test("rejects created Claxedo session lifecycle events without session info", () => {
    expect(normalizeClaxedoSessionLifecycleEvent({
      type: "session.lifecycle",
      phase: "created",
      directory: "workspace:ws_123",
      sessionID: "ses_1",
      info: { id: "ses_1" },
      ts: 3,
    })).toBeUndefined()
  })
})
