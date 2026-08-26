import { describe, expect, test } from "bun:test"
import {
  resolveSessionDirectory,
  resolveSessionIdentity,
  resolveSignedSessionWorkspaceId,
  sessionSignedTransportAuthority,
  signedRouteSessionWorkspaceId,
} from "./session-identity"

describe("resolveSessionIdentity", () => {
  test("resets a remembered pane session when switching to an explicit new session", () => {
    expect(
      resolveSessionIdentity({
        previous: { id: "74ae9dd7-6ce8-4776-a939-8a80e0a1dda3", scope: "pane", directory: "/repo" },
        pane: { id: "new", directory: "/repo/formlink" },
      }).id,
    ).toBe("new")
  })

  test("keeps a real pane session through transient missing ids in the same surface", () => {
    expect(
      resolveSessionIdentity({
        previous: {
          id: "ses_existing",
          scope: "pane",
          directory: "/repo",
          surfaceId: "surface-1",
        },
        pane: { directory: "/repo", surfaceId: "surface-1" },
      }).id,
    ).toBe("ses_existing")
  })

  test("does not carry a pane session into another directory", () => {
    expect(
      resolveSessionIdentity({
        previous: {
          id: "ses_existing",
          scope: "pane",
          directory: "/repo-a",
          surfaceId: "surface-1",
        },
        pane: { directory: "/repo-b", surfaceId: "surface-1" },
      }).id,
    ).toBeUndefined()
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
    expect(
      resolveSessionDirectory({
        routeDirectory: "opencode",
        inventoryDirectory: "/repo/main",
      }),
    ).toBe("/repo/main")
  })

  test("uses local session ref cwd for session-first views", () => {
    expect(
      resolveSessionDirectory({
        routeDirectory: "",
        inventoryDirectory: "/repo/inventory",
        sessionRef: {
          sessionId: "ses_1",
          host: "workspace",
          cwd: "/repo/main",
          toolSandbox: { kind: "local", cwd: "/repo/main" },
        },
      }),
    ).toBe("/repo/main")
  })
})

describe("resolveSignedSessionWorkspaceId", () => {
  test("workspace-session route ownership beats stale inventory workspace ownership", () => {
    expect(
      resolveSignedSessionWorkspaceId({
        signedControlPlane: true,
        routeDirectory: "ws_route",
        inventoryWorkspaceId: "ws_stale_inventory",
        projectWorkspaceId: "ws_project",
        workspaceId: "ws_runtime",
      }),
    ).toBe("ws_route")
  })

  test("returns no workspace id for loopback sessions", () => {
    expect(
      resolveSignedSessionWorkspaceId({
        signedControlPlane: false,
        routeDirectory: "ws_route",
      }),
    ).toBeUndefined()
  })
})

describe("signedRouteSessionWorkspaceId", () => {
  test("accepts a canonical ws_-prefixed workspace route identity", () => {
    expect(signedRouteSessionWorkspaceId("/w/ws_signed/session/ses_1")).toBe("ws_signed")
  })

  test("accepts an explicitly branded UUID workspace route identity", () => {
    expect(signedRouteSessionWorkspaceId("/w/workspace%3A550e8400-e29b-41d4-a716-446655440000/session/ses_1")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    )
  })

  test("rejects local raw UUID, POSIX, and Windows directory routes", () => {
    expect(signedRouteSessionWorkspaceId("/w/550e8400-e29b-41d4-a716-446655440000/session/ses_1")).toBeUndefined()
    expect(signedRouteSessionWorkspaceId("/w/%2Ftmp%2Fclaxedo-e2e/session/ses_1")).toBeUndefined()
    expect(signedRouteSessionWorkspaceId("/w/C%3A%5Cclaxedo-e2e/session/ses_1")).toBeUndefined()
  })
})

describe("sessionSignedTransportAuthority", () => {
  test("keeps a signed test principal on a loopback filesystem workspace local", () => {
    expect(
      sessionSignedTransportAuthority({
        serverUrl: "http://127.0.0.1:3001",
        principalHasSignedAccess: true,
        sessionRef: {
          sessionId: "ses_local",
          host: "workspace",
          cwd: "/tmp/local",
          toolSandbox: { kind: "local", cwd: "/tmp/local" },
        },
      }),
    ).toBe(false)
  })

  test("accepts explicit route and signed project authority before principal hydration", () => {
    expect(
      sessionSignedTransportAuthority({
        serverUrl: "http://127.0.0.1:3001",
        principalHasSignedAccess: false,
        routeWorkspaceAuthorityId: "ws_signed",
      }),
    ).toBe(true)
    expect(
      sessionSignedTransportAuthority({
        serverUrl: "http://127.0.0.1:3001",
        principalHasSignedAccess: false,
        workspaceKind: "user-hosted",
      }),
    ).toBe(true)
  })

  test("accepts a signed principal on a hosted control plane", () => {
    expect(
      sessionSignedTransportAuthority({
        serverUrl: "https://control.example",
        principalHasSignedAccess: true,
      }),
    ).toBe(true)
  })
})
