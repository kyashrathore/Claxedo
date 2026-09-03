import { describe, expect, test } from "bun:test"
import {
  localWorkspaceShareTarget,
  registerUserHostedWorkspace,
  unregisterUserHostedWorkspace,
  workspaceShareUrl,
} from "./share-workspace"

describe("share workspace helpers", () => {
  test("keeps share workspace URLs local to the utility", async () => {
    expect(await Bun.file(new URL("./share-workspace.ts", import.meta.url)).text()).not.toContain("RuntimeGateway")
  })

  test("resolves the local root workspace id from project workspace metadata", () => {
    expect(localWorkspaceShareTarget({
      directory: "/repo/main",
      project: {
        id: "project_1",
        worktree: "/repo/main",
        expanded: true,
        workspaces: {
          ws_local: {
            id: "ws_local",
            directory: "/repo/main",
            kind: "local",
          },
        },
      } as never,
    })).toEqual({
      workspaceId: "ws_local",
      directory: "/repo/main",
    })
  })

  test("resolves git worktree rows keyed by workspace id", () => {
    expect(localWorkspaceShareTarget({
      directory: "ws_feature",
      project: {
        id: "project_1",
        worktree: "/repo/main",
        expanded: true,
        workspaces: {
          ws_feature: {
            id: "ws_feature",
            directory: "/repo/feature",
            kind: "local",
          },
        },
      } as never,
    })).toEqual({
      workspaceId: "ws_feature",
      directory: "/repo/feature",
    })
  })

  test("does not share cloud or non-filesystem workspace refs as local hosts", () => {
    expect(localWorkspaceShareTarget({
      directory: "ws_cloud",
      project: {
        id: "project_1",
        worktree: "/repo/main",
        expanded: true,
        workspaces: {
          ws_cloud: {
            id: "ws_cloud",
            directory: "/workspace",
            kind: "cloud",
          },
        },
      } as never,
    })).toBeUndefined()
    expect(localWorkspaceShareTarget({
      directory: "workspace:ws_shared",
      project: {
        id: "project_1",
        worktree: "/repo/main",
        expanded: true,
      } as never,
    })).toBeUndefined()
  })

  test("builds a stable workspace share URL", () => {
    expect(workspaceShareUrl({ origin: "https://app.example.test", workspaceId: "ws_1" }))
      .toBe("https://app.example.test/w/ws_1")
  })

  /**
   * The wire contract, pinned against the route that actually exists.
   *
   * `POST /api/workspace/:id/host-assignment` replaced the retired
   * `/user-hosted/register`, and its body schema is `.strict()` with exactly
   * two optional fields (`displayName`, `orgId`) — plus an explicit 400 for a
   * client-supplied `hostId`, because the machine identity is server-owned.
   * So "what we send" is as load-bearing as "where we send it": one extra key
   * is a rejected share, not a tolerated one.
   */
  test("assigns a workspace to this machine on the host-assignment route", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const capture = async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    await registerUserHostedWorkspace({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_local",
      displayName: "Main",
      request: capture,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://control.example.test/api/workspace/ws_local/host-assignment")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ displayName: "Main" })
  })

  test("omits displayName entirely rather than sending an empty one", async () => {
    // `displayName` is `.min(1)` on the server, so a blank string is a 400.
    // Machine-level auto-share always has a label, but the helper's optional
    // parameter must still produce a valid body without one.
    const calls: Array<{ url: string; init?: RequestInit }> = []
    await registerUserHostedWorkspace({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_local",
      request: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response("{}", { headers: { "Content-Type": "application/json" } })
      },
    })

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({})
  })

  test("never sends a hostId — the machine identity is the server's to decide", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    await registerUserHostedWorkspace({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_local",
      displayName: "Main",
      request: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response("{}", { headers: { "Content-Type": "application/json" } })
      },
    })

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(["displayName"])
    expect(body.hostId).toBeUndefined()
  })

  test("a rejected assignment surfaces the server's own message", async () => {
    await expect(registerUserHostedWorkspace({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_cloud",
      request: async () => new Response(
        JSON.stringify({
          error: {
            code: "host_assignment_local_workspace_required",
            message: "Only local workspaces can be assigned for user-hosted sharing",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    })).rejects.toThrow("Only local workspaces can be assigned for user-hosted sharing")
  })

  test("withdrawing one workspace deletes the same assignment", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    await unregisterUserHostedWorkspace({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_local",
      request: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response("{}", { headers: { "Content-Type": "application/json" } })
      },
    })

    expect(calls[0]?.url).toBe("https://control.example.test/api/workspace/ws_local/host-assignment")
    expect(calls[0]?.init?.method).toBe("DELETE")
  })
})
