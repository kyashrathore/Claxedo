import { describe, expect, test } from "bun:test"
import {
  resolveSessionDirectory,
  resolveSessionIdentity,
  resolveSignedSessionWorkspaceId,
} from "./session-identity"

describe("resolveSessionIdentity", () => {
  test("resets a remembered pane session when switching to an explicit new session", () => {
    expect(resolveSessionIdentity({
      previous: { id: "74ae9dd7-6ce8-4776-a939-8a80e0a1dda3", scope: "pane", directory: "/repo" },
      pane: { id: "new", directory: "/repo/formlink" },
    }).id).toBe("new")
  })

  test("keeps a real pane session through transient missing ids in the same surface", () => {
    expect(resolveSessionIdentity({
      previous: {
        id: "ses_existing",
        scope: "pane",
        directory: "/repo",
        surfaceId: "surface-1",
      },
      pane: { directory: "/repo", surfaceId: "surface-1" },
    }).id).toBe("ses_existing")
  })

  test("does not carry a pane session into another directory", () => {
    expect(resolveSessionIdentity({
      previous: {
        id: "ses_existing",
        scope: "pane",
        directory: "/repo-a",
        surfaceId: "surface-1",
      },
      pane: { directory: "/repo-b", surfaceId: "surface-1" },
    }).id).toBeUndefined()
  })

  test("returns an empty pane identity when pane params are absent", () => {
    expect(resolveSessionIdentity({}).id).toBeUndefined()
  })
})

describe("resolveSessionDirectory", () => {
  test("uses route directory when the session has no local backing ref", () => {
    expect(resolveSessionDirectory({ routeDirectory: "/repo" })).toBe("/repo")
  })

  test("uses inventory directory before a placeholder session route directory", () => {
    expect(resolveSessionDirectory({
      routeDirectory: "opencode",
      inventoryDirectory: "/repo/main",
    })).toBe("/repo/main")
  })

  test("uses local session ref cwd for session-first views", () => {
    expect(resolveSessionDirectory({
      routeDirectory: "",
      inventoryDirectory: "/repo/inventory",
      sessionRef: {
        sessionId: "ses_1",
        host: "workspace",
        cwd: "/repo/main",
        toolSandbox: { kind: "local", cwd: "/repo/main" },
      },
    })).toBe("/repo/main")
  })

  test("uses canonical inventory directory instead of a workspace-ref cwd", () => {
    expect(resolveSessionDirectory({
      routeDirectory: "ws_signed",
      inventoryDirectory: "/private/runtime/workspace",
      sessionRef: {
        sessionId: "ses_1",
        host: "workspace",
        cwd: "workspace:ws_signed",
        toolSandbox: { kind: "workspace", workspaceId: "ws_signed" },
      },
    })).toBe("/private/runtime/workspace")
  })

  test("keeps a workspace-ref cwd until canonical inventory resolves", () => {
    expect(resolveSessionDirectory({
      routeDirectory: "ws_signed",
      sessionRef: {
        sessionId: "ses_1",
        host: "workspace",
        cwd: "workspace:ws_signed",
        toolSandbox: { kind: "workspace", workspaceId: "ws_signed" },
      },
    })).toBe("workspace:ws_signed")
  })
})

describe("resolveSignedSessionWorkspaceId", () => {
  test("workspace-session route ownership beats stale inventory workspace ownership", () => {
    expect(resolveSignedSessionWorkspaceId({
      signedControlPlane: true,
      routeDirectory: "ws_route",
      inventoryWorkspaceId: "ws_stale_inventory",
      projectWorkspaceId: "ws_project",
      workspaceId: "ws_runtime",
    })).toBe("ws_route")
  })

  test("returns no workspace id for loopback sessions", () => {
    expect(resolveSignedSessionWorkspaceId({
      signedControlPlane: false,
      routeDirectory: "ws_route",
    })).toBeUndefined()
  })
})
