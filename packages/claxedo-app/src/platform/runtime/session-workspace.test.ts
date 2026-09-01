import { describe, expect, test } from "bun:test"
import { sessionPaneWorkspaceConnection, sessionPaneWorkspaceKey, sessionWorkspaceRuntimeRef } from "./session-workspace"

describe("session workspace key", () => {
  test("keys a directory-less central pane by its canonical session id", () => {
    expect(sessionPaneWorkspaceKey({
      directory: "",
      sessionRef: {
        sessionId: "ses_pi",
        host: "central",
        harness: { id: "pi" },
        toolSandbox: { kind: "virtual" },
      },
    })).toBe("ses_pi")
  })

  test("uses typed workspace backing before directory shape", () => {
    const ref = {
      sessionId: "ses_1",
      host: "workspace" as const,
      cwd: "/repo/local",
      toolSandbox: { kind: "workspace" as const, workspaceId: "ws_cloud_1", hosting: "cloud" as const },
    }

    expect(sessionWorkspaceRuntimeRef({ directory: "/repo/local", sessionRef: ref })).toEqual({
      workspaceId: "ws_cloud_1",
      kind: "cloud",
    })
    expect(sessionPaneWorkspaceKey({ directory: "/repo/local", sessionRef: ref })).toBe("ws_cloud_1")
  })

  test("uses a draft pane's explicit workspace route over its local provider directory", () => {
    const projects = [{
      workspaces: {
        ws_cloud_route: { workspaceId: "ws_cloud_route", kind: "cloud", directory: "/runtime/repo" },
      },
    }]
    const input = {
      directory: "/local/project",
      workspaceId: "ws_cloud_route",
      sessionRef: {
        sessionId: "new",
        host: "workspace" as const,
        cwd: "/local/project",
        toolSandbox: { kind: "local" as const, cwd: "/local/project" },
      },
      projects,
    }

    expect(sessionWorkspaceRuntimeRef(input)).toEqual({ workspaceId: "ws_cloud_route", kind: "cloud" })
    expect(sessionPaneWorkspaceConnection(input)).toEqual({ workspaceId: "ws_cloud_route", kind: "cloud" })
    expect(sessionPaneWorkspaceKey(input)).toBe("ws_cloud_route")
  })

  test("does not treat central virtual authz scope as real workspace backing", () => {
    const ref = {
      sessionId: "ses_central",
      host: "central" as const,
      workspaceId: "ws_authz_only",
      toolSandbox: { kind: "virtual" as const },
    }

    expect(sessionWorkspaceRuntimeRef({ directory: "workspace:ws_authz_only", sessionRef: ref })).toBeUndefined()
    expect(sessionPaneWorkspaceKey({ directory: "workspace:ws_authz_only", sessionRef: ref })).toBe("workspace:ws_authz_only")
  })

  test("keeps bounded workspace selector compatibility behind the shell workspace key", () => {
    // When the kind cannot be resolved from the signed inventory, the directory
    // path no longer defaults to "cloud" (which would run the provisioning
    // resolve and fail for a user-hosted workspace whose mint returns 200). Both
    // kinds route through the relay; "user-hosted" drives readiness off the
    // mint+health path, which is the source of truth.
    expect(sessionWorkspaceRuntimeRef({ directory: "ws_raw" })).toEqual({
      workspaceId: "ws_raw",
      kind: "user-hosted",
    })
    expect(sessionWorkspaceRuntimeRef({ directory: "workspace:ws_prefixed" })).toEqual({
      workspaceId: "ws_prefixed",
      kind: "user-hosted",
    })
    expect(sessionWorkspaceRuntimeRef({ directory: "workspace:608c72e3-405a-4d2a-bf7f-883b8c76ea8e" })).toBeUndefined()
    expect(sessionWorkspaceRuntimeRef({ directory: "608c72e3-405a-4d2a-bf7f-883b8c76ea8e" })).toBeUndefined()
    expect(sessionWorkspaceRuntimeRef({ directory: "/repo/local" })).toBeUndefined()
  })

  test("does not mint a relay connection for a local association ref", () => {
    const localRef = {
      sessionId: "ses_local",
      host: "workspace" as const,
      cwd: "/repo/local",
      toolSandbox: { kind: "local" as const, cwd: "/repo/local" },
    }

    expect(sessionWorkspaceRuntimeRef({
      directory: "workspace:608c72e3-405a-4d2a-bf7f-883b8c76ea8e",
      sessionRef: localRef,
    })).toBeUndefined()
  })

  test("lets canonical local inventory override a transient workspace-backed session ref", () => {
    const workspaceId = "608c72e3-405a-4d2a-bf7f-883b8c76ea8e"
    expect(sessionWorkspaceRuntimeRef({
      directory: "/repo/local",
      sessionRef: {
        sessionId: "ses_local",
        host: "workspace",
        workspaceId,
        toolSandbox: { kind: "workspace", workspaceId, hosting: "user-hosted" },
      },
      projects: [{
        workspaces: {
          [workspaceId]: { id: workspaceId, workspaceId, directory: "/repo/local", kind: "local" },
        },
      }],
    })).toBeUndefined()
  })

  test("resolves the real kind from the signed inventory when present", () => {
    const projects = [
      {
        workspaces: {
          ws_cleantest1: { workspaceId: "ws_cleantest1", kind: "user-hosted", directory: "/repo/hosted" },
          ws_cloud_1: { workspaceId: "ws_cloud_1", kind: "cloud", directory: "/repo/cloud" },
        },
      },
    ]
    // user-hosted resolved by id-ref form
    expect(sessionWorkspaceRuntimeRef({ directory: "workspace:ws_cleantest1", projects })).toEqual({
      workspaceId: "ws_cleantest1",
      kind: "user-hosted",
    })
    // cloud resolved from the inventory (NOT defaulted to user-hosted)
    expect(sessionWorkspaceRuntimeRef({ directory: "ws_cloud_1", projects })).toEqual({
      workspaceId: "ws_cloud_1",
      kind: "cloud",
    })
    // Bare UUIDs are ambiguous with local project/workspace ids. They only become
    // runtime-backed when the signed inventory confirms a cloud/user-hosted match.
    expect(sessionWorkspaceRuntimeRef({ directory: "608c72e3-405a-4d2a-bf7f-883b8c76ea8e", projects: [
      {
        workspaces: {
          "608c72e3-405a-4d2a-bf7f-883b8c76ea8e": {
            workspaceId: "608c72e3-405a-4d2a-bf7f-883b8c76ea8e",
            kind: "cloud",
          },
        },
      },
    ] })).toEqual({
      workspaceId: "608c72e3-405a-4d2a-bf7f-883b8c76ea8e",
      kind: "cloud",
    })
  })

  test("keeps a workspace-shaped local project id off the relay", () => {
    const workspaceId = "608c72e3-405a-4d2a-bf7f-883b8c76ea8e"
    const projects = [{
      workspaces: {
        [workspaceId]: {
          id: workspaceId,
          workspaceId,
          kind: "local",
          directory: "/repo/local",
        },
      },
    }]

    expect(sessionWorkspaceRuntimeRef({ directory: `workspace:${workspaceId}`, projects })).toBeUndefined()
    expect(sessionWorkspaceRuntimeRef({ directory: workspaceId, projects })).toBeUndefined()
  })

  test("resolves a relay workspace from its filesystem worktree directory via the inventory", () => {
    const projects = [
      {
        workspaces: {
          ws_cleantest1: {
            workspaceId: "ws_cleantest1",
            kind: "user-hosted",
            directory: "/tmp/claxedo-portability/ws_cleantest1-dir",
          },
        },
      },
    ]
    // Session rows carry the runtime's real filesystem directory (the
    // registration-stored remote_directory), not a ws_ ref. The pane MUST
    // still resolve the relay backing — otherwise the gate never acquires the
    // connection and isWorkspaceReady stays false for every gated query.
    expect(sessionWorkspaceRuntimeRef({ directory: "/tmp/claxedo-portability/ws_cleantest1-dir", projects })).toEqual({
      workspaceId: "ws_cleantest1",
      kind: "user-hosted",
    })
    // macOS /private alias of the same worktree resolves too
    expect(sessionWorkspaceRuntimeRef({ directory: "/private/tmp/claxedo-portability/ws_cleantest1-dir", projects })).toEqual({
      workspaceId: "ws_cleantest1",
      kind: "user-hosted",
    })
    // An unknown filesystem directory still resolves to local (undefined)
    expect(sessionWorkspaceRuntimeRef({ directory: "/repo/unknown", projects })).toBeUndefined()
  })

  test("a session pane and a secondary surface of the same workspace converge on ONE connection key", () => {
    // Behavior 19 (e2e core-panes-split-tabs): two panes on the same relay-backed
    // workspace must share ONE ref-counted connection. The two surfaces reach the
    // resolver by DIFFERENT directory shapes:
    //   - the session pane carries the workspace's filesystem worktree (its
    //     sessionRef cwd / meta.directory), and
    //   - a newly opened terminal inherits `activeDirectory` — the relay-backed
    //     workspace id itself (route key).
    // Both MUST resolve the SAME workspaceId+kind, otherwise the second surface
    // opens (or skips) a different connection entry and refs never reaches 2.
    const projects = [
      {
        workspaces: {
          ws_cloud_1: { workspaceId: "ws_cloud_1", kind: "cloud", directory: "/tmp/e2e-cloud-dir" },
        },
      },
    ]
    const fromWorktree = sessionWorkspaceRuntimeRef({ directory: "/tmp/e2e-cloud-dir", projects })
    const fromWorkspaceId = sessionWorkspaceRuntimeRef({ directory: "ws_cloud_1", projects })
    expect(fromWorktree).toEqual({ workspaceId: "ws_cloud_1", kind: "cloud" })
    expect(fromWorkspaceId).toEqual({ workspaceId: "ws_cloud_1", kind: "cloud" })
    expect(sessionPaneWorkspaceKey({ directory: "/tmp/e2e-cloud-dir", projects })).toBe(
      sessionPaneWorkspaceKey({ directory: "ws_cloud_1", projects }),
    )

    // The failure mode that made behavior 19 stall at refs=1: a secondary surface
    // whose inherited directory is a `local-<sessionId>` id the inventory does NOT
    // carry resolves to local (undefined) and takes no ref. This is exactly what
    // the default mock `/api/workspace/resolve` produced before the harness was
    // made faithful to the cloud inventory.
    expect(sessionWorkspaceRuntimeRef({ directory: "local-ses_cloud_1", projects })).toBeUndefined()
  })

  test("does not mint a local project UUID as a user-hosted relay workspace", () => {
    const projectId = "c4955849-a3c1-4f3e-8481-1fd1bdec3962"
    const directory = "/private/tmp/claxedo-agent-plugins-real-app/plugins-e2e"
    const projects = [{
      id: projectId,
      worktree: directory,
      workspaces: {
        [directory]: { id: projectId, directory, kind: "local" },
      },
    }]

    expect(sessionWorkspaceRuntimeRef({
      directory,
      workspaceId: projectId,
      projects,
    })).toBeUndefined()
    expect(sessionPaneWorkspaceConnection({
      directory,
      workspaceId: projectId,
      projects,
    })).toEqual({ workspaceId: undefined, kind: "local" })

    // Stale session rows used to claim user-hosted hosting for the local UUID.
    expect(sessionWorkspaceRuntimeRef({
      directory,
      workspaceId: projectId,
      projects,
      sessionRef: {
        sessionId: "new",
        host: "workspace",
        workspaceId: projectId,
        toolSandbox: { kind: "workspace", workspaceId: projectId, hosting: "user-hosted" },
      },
    })).toBeUndefined()

    // Even before inventory loads, a bare UUID is the local route id — not a ws_ relay.
    expect(sessionWorkspaceRuntimeRef({
      directory,
      workspaceId: projectId,
      sessionRef: {
        sessionId: "new",
        host: "workspace",
        workspaceId: projectId,
        toolSandbox: { kind: "workspace", workspaceId: projectId, hosting: "user-hosted" },
      },
    })).toBeUndefined()
  })

  test("keeps optimistic relay backing for ws_ ids before inventory loads", () => {
    expect(sessionWorkspaceRuntimeRef({
      directory: "/local/project",
      workspaceId: "ws_cloud_route",
    })).toEqual({ workspaceId: "ws_cloud_route", kind: "user-hosted" })
  })
})
