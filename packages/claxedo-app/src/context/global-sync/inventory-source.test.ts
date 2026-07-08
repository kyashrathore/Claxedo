import { describe, expect, test } from "bun:test"
import type { WorkspaceGroup } from "@claxedo/shell/data/global-sync-types"
import {
  controlPlaneSessionToItem,
  controlMetaToGlobalSession,
  createInventoryPageSource,
  createSignedInventorySource,
  mergeWorkspaceGroups,
  shouldUseSignedControlPlaneInventory,
  signedWorkspaceHosting,
  toSessionInventoryRow,
  workspaceGroupKey,
} from "./inventory-source"

describe("global sync inventory source helpers", () => {
  test("inventory source does not depend on RuntimeGateway", async () => {
    expect(await Bun.file(new URL("./inventory-source.ts", import.meta.url)).text()).not.toContain("RuntimeGateway")
  })

  test("workspace group key prefers workspace identity over placeholder keys", () => {
    expect(workspaceGroupKey({
      key: "/workspace",
      workspaceId: "ws_1",
      directory: "/repo/a",
    })).toBe("ws_1")
    expect(workspaceGroupKey({
      key: "custom",
      directory: "/repo/a",
    })).toBe("custom")
    expect(workspaceGroupKey({
      key: "/workspace",
      directory: "/repo/a",
    })).toBe("/repo/a")
  })

  test("mergeWorkspaceGroups combines signed rows without mutating local groups", () => {
    const local = workspaceGroup("/repo/a", [
      session("ses_local", 1),
    ], { total: 1, hasMore: false })
    const signed = workspaceGroup("/repo/a", [
      session("ses_signed", 3),
    ], { total: 5, hasMore: true, nextCursor: 2 })

    const merged = mergeWorkspaceGroups([local], [signed])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.sessions.map((item) => item.id)).toEqual(["ses_signed", "ses_local"])
    expect(merged[0]?.total).toBe(5)
    expect(merged[0]?.hasMore).toBe(true)
    expect(merged[0]?.nextCursor).toBe(2)
    expect(local.sessions.map((item) => item.id)).toEqual(["ses_local"])
  })

  test("signedWorkspaceHosting accepts control-plane access and backing vocabulary", () => {
    expect(signedWorkspaceHosting({ access: "cloud" })).toBe("cloud")
    expect(signedWorkspaceHosting({ backing: "user-hosted" })).toBe("user-hosted")
    expect(signedWorkspaceHosting({ access: "local" })).toBeUndefined()
    expect(signedWorkspaceHosting(undefined)).toBeUndefined()
  })

  test("signed control-plane inventory predicate uses local route identity", () => {
    expect(shouldUseSignedControlPlaneInventory({
      hasSignedAccess: false,
      baseUrl: "https://app.test",
      directory: "workspace:ws_remote",
    })).toBe(false)
    expect(shouldUseSignedControlPlaneInventory({
      hasSignedAccess: true,
      baseUrl: "http://127.0.0.1:4096",
      directory: "/repo/local",
    })).toBe(false)
    expect(shouldUseSignedControlPlaneInventory({
      hasSignedAccess: true,
      baseUrl: "http://127.0.0.1:4096",
      directory: "workspace:ws_remote",
    })).toBe(true)
    expect(shouldUseSignedControlPlaneInventory({
      hasSignedAccess: true,
      baseUrl: "http://127.0.0.1:4096",
      directory: "/repo/.claxedo/user-hosted/workspaces/ws_1",
    })).toBe(true)
    expect(shouldUseSignedControlPlaneInventory({
      hasSignedAccess: true,
      baseUrl: "https://app.test",
      directory: "/repo/local",
    })).toBe(true)
  })

  test("controlPlaneSessionToItem maps control-plane fields into an inventory row", () => {
    expect(controlPlaneSessionToItem({
      directory: "workspace:ws_123",
      workspaceId: "ws_123",
      workspace: {
        workspace_name: "Cloud Workspace",
        project_id: "proj_123",
        access: "cloud",
        backing: "cloudflare",
      },
      session: {
        session_id: "ses_123",
        title: "Mapped session",
        created_at: 10,
        updated_at: 20,
        lastTurn: {
          status: "completed",
          completedAt: 19,
          assistantMessageId: "msg_1_r",
        },
      },
    })).toEqual({
      id: "ses_123",
      title: "Mapped session",
      directory: "workspace:ws_123",
      workspaceId: "ws_123",
      workspaceName: "Cloud Workspace",
      projectID: "proj_123",
      tags: [],
      attachments: [],
      environment: {
        kind: "cloud",
        driver: "cloudflare",
      },
      lastTurn: {
        status: "completed",
        completedAt: 19,
        assistantMessageId: "msg_1_r",
      },
      time: { created: 10, updated: 20 },
    })
  })

  test("controlPlaneSessionToItem maps camel-case fallbacks", () => {
    expect(controlPlaneSessionToItem({
      directory: "workspace:ws_456",
      workspaceId: "ws_456",
      workspace: {
        workspaceName: "User Workspace",
        projectID: "proj_456",
        backing: "user-hosted",
      },
      session: {
        sessionID: "ses_456",
        createdAt: 30,
        updatedAt: 40,
      },
    })).toMatchObject({
      id: "ses_456",
      title: "ses_456",
      directory: "workspace:ws_456",
      workspaceId: "ws_456",
      workspaceName: "User Workspace",
      projectID: "proj_456",
      environment: {
        kind: "user-hosted",
        driver: "user-hosted",
      },
      time: { created: 30, updated: 40 },
    })
  })

  test("toSessionInventoryRow maps SDK sessions with project fallback and filtered details", () => {
    expect(toSessionInventoryRow({
      id: "ses_sdk",
      title: "",
      directory: "/repo/sdk",
      parentID: "parent_1",
      time: { created: 100, updated: 150, archived: 200 },
      rootID: "root_1",
      workspaceID: "ws_1",
      tags: ["global", 12, "show"],
      attachments: [
        { kind: "file", targetID: "src/app.tsx" },
        { kind: "url", target_id: "https://example.test" },
        { kind: "missing-target" },
      ],
      environment: { kind: "cloud", provider: "cloudflare" },
      git: { repo: "repo", branch: "dev" },
      lastTurn: {
        status: "failed",
        completedAt: 120,
        error: "failed",
      },
    }, { projectID: "project_fallback" })).toEqual({
      id: "ses_sdk",
      title: "New Session",
      directory: "/repo/sdk",
      workspaceId: "ws_1",
      projectID: "project_fallback",
      parentID: "parent_1",
      rootID: "root_1",
      tags: ["global", "show"],
      attachments: [
        { kind: "file", targetID: "src/app.tsx" },
        { kind: "url", targetID: "https://example.test" },
      ],
      environment: { kind: "cloud", driver: "cloudflare" },
      git: { repo: "repo", branch: "dev" },
      archived: true,
      lastTurn: {
        status: "failed",
        completedAt: 120,
        error: "failed",
      },
      time: { created: 100, updated: 150 },
    })
  })

  test("controlMetaToGlobalSession maps local control metadata into SDK-like rows", () => {
    expect(controlMetaToGlobalSession({
      sessionID: "ses_local",
      title: "Local session",
      directory: "/repo/local",
      projectID: "project_local",
      parentID: "parent_2",
      rootID: "root_2",
      tags: ["workspace"],
      attachments: [{ kind: "file", targetID: "README.md" }],
      createdAt: 300,
      updatedAt: 400,
      archived: 500,
      lastTurn: {
        status: "completed",
        completedAt: 390,
      },
    })).toEqual({
      id: "ses_local",
      title: "Local session",
      directory: "/repo/local",
      projectID: "project_local",
      parentID: "parent_2",
      rootID: "root_2",
      tags: ["workspace"],
      attachments: [{ kind: "file", targetID: "README.md" }],
      lastTurn: {
        status: "completed",
        completedAt: 390,
      },
      time: {
        created: 300,
        updated: 400,
        archived: 500,
      },
    })
  })

  test("signed inventory source combines cloud and user-hosted workspace snapshots", async () => {
    const runtimeCalls: unknown[] = []
    const source = createSignedInventorySource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "https://app.test",
      owner: () => "user_1",
      authFetch: async (resource) => {
        const url = new URL(String(resource))
        if (url.pathname === "/api/workspace" && url.searchParams.get("access") === "cloud") {
          return jsonResponse({
            workspaces: [{
              workspace_id: "ws_cloud",
              workspace_name: "Cloud",
              project_id: "project_cloud",
              access: "cloud",
              backing: "cloudflare",
              remote_directory: "workspace:ws_cloud",
            }],
          })
        }
        if (url.pathname === "/api/workspace" && url.searchParams.get("access") === "user-hosted") {
          return jsonResponse({
            workspaces: [{
              workspace_id: "ws_user",
              workspace_name: "User Hosted",
              project_id: "project_user",
              access: "user-hosted",
              backing: "user-hosted",
              remote_directory: "workspace:ws_user",
            }],
          })
        }
        if (url.pathname === "/api/control/sessions" && url.searchParams.get("workspaceId") === "ws_cloud") {
          return jsonResponse({
            sessions: [
              { session_id: "ses_old", created_at: 1, updated_at: 1 },
              { session_id: "ses_new", created_at: 2, updated_at: 3 },
            ],
          })
        }
        return jsonResponse({ sessions: [] }, { status: 500 })
      },
      signedWorkspaceInfo: () => undefined,
      resolveWorkspace: async () => undefined,
      runtimeSessions: async (input) => {
        runtimeCalls.push(input)
        return [{ session_id: "ses_user", created_at: 4, updated_at: 4 }]
      },
    })

    const snapshot = await source.fetchSignedWorkspaceSnapshot()

    expect(snapshot.projects.map((project) => project.id).sort()).toEqual(["project_cloud", "project_user"])
    expect(snapshot.groups.map((group) => group.workspaceId).sort()).toEqual(["ws_cloud", "ws_user"])
    expect(snapshot.groups.find((group) => group.workspaceId === "ws_cloud")?.sessions.map((item) => item.id))
      .toEqual(["ses_new", "ses_old"])
    expect(snapshot.groups.find((group) => group.workspaceId === "ws_user")?.sessions.map((item) => item.id))
      .toEqual(["ses_user"])
    expect(runtimeCalls).toEqual([{
      workspaceId: "ws_user",
      directory: "workspace:ws_user",
      kind: "user-hosted",
    }])
  })

  test("signed directory fetch uses known workspace metadata before resolving runtime", async () => {
    let resolveCalls = 0
    const source = createSignedInventorySource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "https://app.test",
      owner: () => "user_1",
      authFetch: async () => jsonResponse({ sessions: [] }),
      signedWorkspaceInfo: (key) => key === "/repo/known"
        ? {
            workspaceId: "ws_known",
            directory: "workspace:ws_known",
            workspaceName: "Known",
            kind: "cloud",
          }
        : undefined,
      resolveWorkspace: async () => {
        resolveCalls++
        return { workspaceId: "ws_resolved", directory: "workspace:ws_resolved", kind: "cloud" }
      },
      runtimeSessions: async () => [{ session_id: "ses_known", created_at: 5, updated_at: 6 }],
    })

    const sessions = await source.fetchSignedDirectorySessions("/repo/known")

    expect(resolveCalls).toBe(0)
    expect(sessions).toMatchObject([{
      id: "ses_known",
      directory: "workspace:ws_known",
      workspaceId: "ws_known",
      workspaceName: "Known",
    }])
  })

  test("cloud control-plane empty result falls back to runtime sessions", async () => {
    const source = createSignedInventorySource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "https://app.test",
      owner: () => "user_1",
      authFetch: async () => jsonResponse({ sessions: [] }),
      signedWorkspaceInfo: () => undefined,
      resolveWorkspace: async () => undefined,
      runtimeSessions: async () => [{ session_id: "ses_runtime", created_at: 7, updated_at: 8 }],
    })

    expect(await source.fetchSignedWorkspaceSessions({
      workspaceId: "ws_cloud",
      directory: "workspace:ws_cloud",
      kind: "cloud",
    })).toEqual([{ session_id: "ses_runtime", created_at: 7, updated_at: 8 }])
  })

  test("non-OK control-plane responses return empty arrays", async () => {
    const source = createSignedInventorySource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "https://app.test",
      owner: () => "user_1",
      authFetch: async () => jsonResponse({}, { status: 503 }),
      signedWorkspaceInfo: () => undefined,
      resolveWorkspace: async () => undefined,
      runtimeSessions: async () => [],
    })

    expect(await source.fetchControlPlaneSessions("ws_down")).toEqual([])
    expect(await source.fetchControlPlaneWorkspaces("cloud")).toEqual([])
  })

  test("inventory page source uses local control sessions for loopback global pages", async () => {
    const source = createInventoryPageSource({
      baseUrl: () => "http://127.0.0.1:4096",
      pageSize: 2,
      platformFetch: () => async () => jsonResponse({
        sessions: [
          { sessionID: "ses_3", directory: "/repo/a", createdAt: 1, updatedAt: 3 },
          { sessionID: "ses_2", directory: "/repo/a", createdAt: 1, updatedAt: 2 },
          { sessionID: "ses_1", directory: "/repo/a", createdAt: 1, updatedAt: 1 },
        ],
      }),
      hasSignedAccess: () => false,
      signedWorkspaceProjects: () => [],
      signedInventorySource: emptySignedInventorySource(),
    })

    const page = await source.fetchGlobalList({ limit: 2 })

    expect(page.data.map((item) => item.id)).toEqual(["ses_3", "ses_2"])
    expect(page.cursor).toBe(2)
  })

  test("inventory page source dedupes concurrent workspace group requests", async () => {
    let calls = 0
    const source = createInventoryPageSource({
      baseUrl: () => "https://app.test",
      pageSize: 2,
      platformFetch: () => undefined,
      authFetch: async () => {
        calls++
        await Promise.resolve()
        return jsonResponse({
          groups: [workspaceGroup("/repo/a", [session("ses_remote", 9)])],
        })
      },
      hasSignedAccess: () => false,
      signedWorkspaceProjects: () => [],
      signedInventorySource: emptySignedInventorySource(),
    })

    const [first, second] = await Promise.all([
      source.fetchWorkspaceGrouped({ perGroup: 2 }),
      source.fetchWorkspaceGrouped({ perGroup: 2 }),
    ])

    expect(calls).toBe(1)
    expect(first).toEqual(second)
    expect(first[0]?.sessions.map((item) => item.id)).toEqual(["ses_remote"])
  })
})

function session(id: string, updated: number) {
  return {
    id,
    title: id,
    directory: "/repo/a",
    projectID: "project_a",
    attachments: [],
    time: { created: updated, updated },
  }
}

function workspaceGroup(
  directory: string,
  sessions: ReturnType<typeof session>[],
  extra: Partial<Pick<WorkspaceGroup, "total" | "hasMore" | "nextCursor">> = {},
): WorkspaceGroup {
  return {
    key: directory,
    directory,
    projectID: "project_a",
    sessions,
    hasMore: extra.hasMore ?? false,
    total: extra.total ?? sessions.length,
    nextCursor: extra.nextCursor,
  }
}

function immediateQueryClient() {
  return {
    fetchQuery: async (options: { queryFn: () => unknown }) => await options.queryFn(),
  } as never
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

function emptySignedInventorySource() {
  return {
    fetchSignedDirectorySessions: async () => [],
    fetchSignedWorkspaceGroups: async () => [],
  }
}
