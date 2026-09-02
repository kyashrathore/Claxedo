import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { WorkspaceGroup } from "@/features/session/data/sync/global-sync-types"
import { workspaceHostingKind } from "@/platform/runtime/agent/signed-workspace"
import {
  controlPlaneSessionToItem,
  controlMetaToGlobalSession,
  createInventoryPageSource,
  createSignedInventorySource,
  mergeWorkspaceGroups,
  shouldUseSignedControlPlaneInventory,
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

  test("workspaceHostingKind accepts control-plane access and backing vocabulary", () => {
    expect(workspaceHostingKind({ access: "cloud" })).toBe("cloud")
    expect(workspaceHostingKind({ backing: "user-hosted" })).toBe("user-hosted")
    expect(workspaceHostingKind({ access: "local" })).toBeUndefined()
    expect(workspaceHostingKind(undefined)).toBeUndefined()
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
      workspaceID: "ws_local",
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
      workspaceID: "ws_local",
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
      sessionRef: "central:ses_local",
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
      sessionRef: "central:ses_local",
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

  test("signed inventory source keeps user-hosted visibility authority-filtered", async () => {
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
        return jsonResponse({ sessions: [] })
      },
      signedWorkspaceInfo: () => undefined,
      resolveWorkspace: async () => undefined,
    })

    const snapshot = await source.fetchSignedWorkspaceSnapshot()

    expect(snapshot.groups.map((group) => group.workspaceId).sort()).toEqual(["ws_cloud"])
    expect(snapshot.groups.find((group) => group.workspaceId === "ws_cloud")?.sessions.map((item) => item.id))
      .toEqual(["ses_new", "ses_old"])
    expect(snapshot.groups.find((group) => group.workspaceId === "ws_user")).toBeUndefined()
  })

  // Falsifier for the boot request graph's serial cloud→user-hosted pair: the
  // two lists are independent reads (neither's result feeds the other), so a
  // serial `await` chain here is pure round-trip latency. If the snapshot
  // reverted to sequencing them, "user-hosted" would never start until
  // "cloud" first awaits this test's gate, and the test would time out.
  test("fetchSignedWorkspaceSnapshot requests cloud and user-hosted workspaces concurrently", async () => {
    const started: string[] = []
    let openCloudGate: () => void = () => {}
    let openUserHostedGate: () => void = () => {}
    const cloudGate = new Promise<void>((resolve) => { openCloudGate = resolve })
    const userHostedGate = new Promise<void>((resolve) => { openUserHostedGate = resolve })
    const source = createSignedInventorySource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "https://app.test",
      owner: () => "user_1",
      authFetch: async (resource) => {
        const access = new URL(String(resource)).searchParams.get("access")
        started.push(access!)
        if (access === "cloud") {
          openCloudGate()
          await userHostedGate
        } else {
          openUserHostedGate()
          await cloudGate
        }
        return jsonResponse({ workspaces: [] })
      },
      signedWorkspaceInfo: () => undefined,
      resolveWorkspace: async () => undefined,
    })

    await source.fetchSignedWorkspaceSnapshot()

    expect(started.sort()).toEqual(["cloud", "user-hosted"])
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
    })

    const sessions = await source.fetchSignedDirectorySessions("/repo/known")

    expect(resolveCalls).toBe(0)
    expect(sessions).toEqual([])
  })

  test("cloud control-plane inventory is authoritative when empty", async () => {
    const source = createSignedInventorySource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "https://app.test",
      owner: () => "user_1",
      authFetch: async () => jsonResponse({ sessions: [] }),
      signedWorkspaceInfo: () => undefined,
      resolveWorkspace: async () => undefined,
    })

    expect(await source.fetchSignedWorkspaceSessions({
      workspaceId: "ws_cloud",
      directory: "workspace:ws_cloud",
      kind: "cloud",
    })).toEqual([])
  })

  test("session and workspace authority failures reject", async () => {
    const source = createSignedInventorySource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "https://app.test",
      owner: () => "user_1",
      authFetch: async () => jsonResponse({}, { status: 503 }),
      signedWorkspaceInfo: () => undefined,
      resolveWorkspace: async () => undefined,
    })

    await expect(source.fetchControlPlaneSessions("ws_down"))
      .rejects.toThrow("Control-plane session list failed with 503")
    await expect(source.fetchControlPlaneWorkspaces("cloud"))
      .rejects.toThrow("Control-plane cloud workspace list failed with 503")
  })

  test("effective-access checks bypass cached session inventory and surface authority failures", async () => {
    let authorized = true
    let status = 200
    let requests = 0
    let cached: unknown
    const source = createSignedInventorySource({
      queryClient: {
        fetchQuery: async (options: { queryFn: () => Promise<unknown> }) => {
          if (cached !== undefined) return cached
          cached = await options.queryFn()
          return cached
        },
      } as never,
      baseUrl: () => "https://app.test",
      owner: () => "signed:user_1",
      authFetch: async () => {
        requests++
        return jsonResponse({
          sessions: authorized ? [{ session_id: "ses_shared" }] : [],
        }, { status })
      },
      signedWorkspaceInfo: () => undefined,
      resolveWorkspace: async () => undefined,
    })

    expect(await source.fetchControlPlaneSessions("ws_1")).toHaveLength(1)
    authorized = false
    expect(await source.hasControlPlaneSessionAccess({ workspaceId: "ws_1", sessionId: "ses_shared" })).toBe(false)
    expect(requests).toBe(2)

    status = 503
    await expect(source.hasControlPlaneSessionAccess({ workspaceId: "ws_1", sessionId: "ses_shared" }))
      .rejects.toThrow("Control-plane session list failed with 503")
  })

  // Falsifier for the boot request graph's ×8 control-plane session fan-out
  // (4 workspaces asked for once by the signed-workspace snapshot and again
  // by each directory's own bootstrap): `fetchSignedWorkspaceSessions` is the
  // shared helper behind both callers, so routing it through
  // `fetchControlPlaneSessions` collapses the pair into the one request the
  // dedupe cache already keys by workspace id.
  test("signed workspace session list shares the control-plane dedupe cache", async () => {
    let requests = 0
    const source = createSignedInventorySource({
      queryClient: new QueryClient(),
      baseUrl: () => "https://app.test",
      owner: () => "signed:user_1",
      authFetch: async () => {
        requests++
        return jsonResponse({ sessions: [{ session_id: "ses_shared" }] })
      },
      signedWorkspaceInfo: () => undefined,
      resolveWorkspace: async () => undefined,
    })

    // One caller reads through the named cache entry point, the other
    // through the helper `fetchSignedDirectorySessions`/the snapshot use —
    // both resolve to the same workspace id and must land on one fetch.
    const [viaSessions, viaWorkspace] = await Promise.all([
      source.fetchControlPlaneSessions("ws_1"),
      source.fetchSignedWorkspaceSessions({ workspaceId: "ws_1", directory: "workspace:ws_1", kind: "cloud" }),
    ])

    expect(requests).toBe(1)
    expect(viaSessions).toEqual(viaWorkspace)
  })

  test("signed workspace refresh bypasses cached authority after revocation", async () => {
    let authorized = true
    const source = createSignedInventorySource({
      // A real query client, matching production: `fetchControlPlaneSessions`
      // (used by the display-facing session list above) is allowed to reuse
      // this cache. `hasControlPlaneSessionAccess` is the actual authority
      // check and must never read it — it calls the network directly, so a
      // revoke lands on its very next call even while the display cache is
      // still warm.
      queryClient: new QueryClient(),
      baseUrl: () => "https://app.test",
      owner: () => "signed:user_1",
      authFetch: async () => jsonResponse({
        sessions: authorized ? [{ session_id: "ses_shared" }] : [],
      }),
      signedWorkspaceInfo: () => undefined,
      resolveWorkspace: async () => undefined,
    })

    expect(await source.fetchControlPlaneSessions("ws_1")).toHaveLength(1)
    authorized = false
    expect(await source.hasControlPlaneSessionAccess({ workspaceId: "ws_1", sessionId: "ses_shared" })).toBe(false)
  })

  test("inventory page source uses local control sessions for loopback global pages", async () => {
    const requests: string[] = []
    const source = createInventoryPageSource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "http://127.0.0.1:4096",
      pageSize: 2,
      platformFetch: () => async (resource) => {
        requests.push(String(resource))
        return jsonResponse({
          sessions: [
            { sessionID: "ses_3", directory: "/repo/a", createdAt: 1, updatedAt: 3 },
            { sessionID: "ses_2", directory: "/repo/a", createdAt: 1, updatedAt: 2 },
            { sessionID: "ses_1", directory: "/repo/a", createdAt: 1, updatedAt: 1 },
          ],
        })
      },
      hasSignedAccess: () => false,
      signedWorkspaceProjects: () => [],
      signedInventorySource: emptySignedInventorySource(),
    })

    const page = await source.fetchGlobalList({ limit: 2 })

    expect(page.data.map((item) => item.id)).toEqual(["ses_3", "ses_2"])
    expect(page.cursor).toBe(2)
    expect(requests.map((item) => new URL(item).pathname)).toEqual(["/api/claxedo/session"])
  })

  test("loopback grouping preserves a central session's authoritative workspace identity", async () => {
    const source = createInventoryPageSource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "http://127.0.0.1:4096",
      pageSize: 2,
      platformFetch: () => async () => jsonResponse({
        sessions: [{
          sessionID: "ses_central",
          sessionRef: "central:ses_central",
          workspaceID: "ws_authoritative",
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
      hasSignedAccess: () => false,
      signedWorkspaceProjects: () => [],
      signedInventorySource: emptySignedInventorySource(),
    })

    const groups = await source.fetchWorkspaceGrouped({ perGroup: 2 })

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      key: "ws_authoritative",
      directory: "ws_authoritative",
      workspaceId: "ws_authoritative",
      sessions: [{ id: "ses_central", sessionRef: "central:ses_central", workspaceId: "ws_authoritative" }],
    })
  })

  test("loopback grouping keeps a local workspace's filesystem transport directory", async () => {
    const source = createInventoryPageSource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "http://127.0.0.1:4096",
      pageSize: 2,
      platformFetch: () => async () => jsonResponse({
        sessions: [{
          sessionID: "ses_local",
          workspaceID: "ws_local",
          directory: "/repo/local",
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
      hasSignedAccess: () => false,
      signedWorkspaceProjects: () => [],
      signedInventorySource: emptySignedInventorySource(),
    })

    const groups = await source.fetchWorkspaceGrouped({ perGroup: 2 })

    expect(groups).toMatchObject([{
      key: "ws_local",
      directory: "/repo/local",
      workspaceId: "ws_local",
      sessions: [{ id: "ses_local", directory: "/repo/local", workspaceId: "ws_local" }],
    }])
  })

  test("inventory page source dedupes concurrent workspace group requests", async () => {
    let calls = 0
    const source = createInventoryPageSource({
      queryClient: immediateQueryClient(),
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

  // Guards the property behind upstream's "78x faster Home cold loading" fix
  // (#36214): session inventory must cost O(1) requests regardless of how
  // many directories exist. Our loopback path does one control-plane list and
  // groups client-side; a per-directory fan-out would fail this test.
  test("cold workspace inventory costs one request regardless of directory count", async () => {
    const requested: string[] = []
    const directories = Array.from({ length: 25 }, (_, index) => `/repo/project_${index}`)
    const sessions = directories.flatMap((directory, index) => [
      { sessionID: `ses_${index}_a`, directory, createdAt: 1, updatedAt: index * 2 + 2 },
      { sessionID: `ses_${index}_b`, directory, createdAt: 1, updatedAt: index * 2 + 1 },
    ])
    const source = createInventoryPageSource({
      queryClient: immediateQueryClient(),
      baseUrl: () => "http://127.0.0.1:4096",
      pageSize: 1,
      platformFetch: () => async (url) => {
        requested.push(String(url))
        return jsonResponse({ sessions })
      },
      hasSignedAccess: () => false,
      signedWorkspaceProjects: () => [],
      signedInventorySource: emptySignedInventorySource(),
    })

    const groups = await source.fetchWorkspaceGrouped({ perGroup: 1 })

    expect(requested).toHaveLength(1)
    expect(groups).toHaveLength(25)
    for (const group of groups) {
      expect(group.sessions).toHaveLength(1)
      expect(group.total).toBe(2)
      expect(group.hasMore).toBe(true)
    }
  })

  // Falsifier for the boot request graph's duplicate GET /api/claxedo/session:
  // the snapshot's flat + grouped fetches run concurrently, and an immediate
  // retry may arrive before consumers observe the snapshot. With a real query client the
  // local control list carries the same CONTROL_SESSIONS_DEDUPE_MS contract
  // as the signed control-plane lists, so all of them read ONE request.
  test("local control-session list is fetched once across the snapshot pair and an immediate retry", async () => {
    const requested: string[] = []
    const source = createInventoryPageSource({
      queryClient: new QueryClient(),
      baseUrl: () => "http://127.0.0.1:4096",
      pageSize: 2,
      platformFetch: () => async (url) => {
        requested.push(String(url))
        await Promise.resolve()
        return jsonResponse({
          sessions: [{ sessionID: "ses_1", directory: "/repo/a", createdAt: 1, updatedAt: 1 }],
        })
      },
      hasSignedAccess: () => false,
      signedWorkspaceProjects: () => [],
      signedInventorySource: emptySignedInventorySource(),
    })

    // The boot snapshot: flat list and grouped list, concurrently.
    const [flat, grouped] = await Promise.all([
      source.fetchGlobalList({ limit: 100 }),
      source.fetchWorkspaceGrouped({ perGroup: 2 }),
    ])
    // An immediate retry right after the snapshot settled.
    const reloaded = await source.fetchWorkspaceGrouped({ perGroup: 2 })

    expect(requested).toHaveLength(1)
    expect(flat.data.map((item) => item.id)).toEqual(["ses_1"])
    expect(grouped[0]?.sessions.map((item) => item.id)).toEqual(["ses_1"])
    expect(reloaded).toEqual(grouped)
  })

  test("local control-session dedupe is scoped per directory", async () => {
    const requested: string[] = []
    const source = createInventoryPageSource({
      queryClient: new QueryClient(),
      baseUrl: () => "http://127.0.0.1:4096",
      pageSize: 2,
      platformFetch: () => async (url) => {
        requested.push(String(url))
        return jsonResponse({ sessions: [] })
      },
      hasSignedAccess: () => false,
      signedWorkspaceProjects: () => [],
      signedInventorySource: emptySignedInventorySource(),
    })

    await source.fetchGlobalList({ limit: 2, directory: "/repo/a" })
    await source.fetchGlobalList({ limit: 2, directory: "/repo/b" })

    expect(requested.map((item) => new URL(item).searchParams.get("directory"))).toEqual(["/repo/a", "/repo/b"])
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
