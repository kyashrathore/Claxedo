import { describe, expect, test } from "bun:test"
import {
  accountCanShareWorkspace,
  localWorkspaceShareTarget,
  publishWorkspacePlacement,
  withdrawWorkspacePlacement,
  workspaceShareUrl,
} from "./share-workspace"

describe("share workspace helpers", () => {
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

  test("share is available only for a signed account", () => {
    expect(accountCanShareWorkspace("signed")).toBe(true)
    expect(accountCanShareWorkspace("unsigned")).toBe(false)
    expect(accountCanShareWorkspace("pending")).toBe(false)
    expect(accountCanShareWorkspace(undefined)).toBe(false)
  })

  test("builds a stable workspace share URL", () => {
    expect(workspaceShareUrl({ origin: "https://app.example.test", workspaceId: "ws_1" }))
      .toBe("https://app.example.test/w/ws_1")
  })

  /**
   * The wire contract, pinned against the route that actually exists.
   *
   * `POST /api/workspace/:id/host-assignment` is the route, and its body
   * schema is `.strict()` with exactly
   * two optional fields (`displayName`, `orgId`) — plus an explicit 400 for a
   * client-supplied `hostId`, because the machine identity is server-owned.
   * So "what we send" is as load-bearing as "where we send it": one extra key
   * is a rejected share, not a tolerated one.
   */
  test("assigns a workspace to this machine on the host-assignment route", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const capture = async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init })
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    await publishWorkspacePlacement({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_local",
      displayName: "Main",
      request: capture,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://control.example.test/api/workspace/ws_local/host-assignment")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(requestJson(calls[0]?.init)).toEqual({ displayName: "Main" })
  })

  test("omits displayName entirely rather than sending an empty one", async () => {
    // `displayName` is `.min(1)` on the server, so a blank string is a 400.
    // Machine-level auto-share always has a label, but the helper's optional
    // parameter must still produce a valid body without one.
    const calls: Array<{ url: string; init?: RequestInit }> = []
    await publishWorkspacePlacement({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_local",
      request: async (url, init) => {
        calls.push({ url: requestUrl(url), init })
        return new Response("{}", { headers: { "Content-Type": "application/json" } })
      },
    })

    expect(requestJson(calls[0]?.init)).toEqual({})
  })

  test("never sends a hostId — the machine identity is the server's to decide", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    await publishWorkspacePlacement({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_local",
      displayName: "Main",
      request: async (url, init) => {
        calls.push({ url: requestUrl(url), init })
        return new Response("{}", { headers: { "Content-Type": "application/json" } })
      },
    })

    const body = requestJson(calls[0]?.init) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(["displayName"])
    expect(body.hostId).toBeUndefined()
  })

  test("a rejected assignment surfaces the server's own message", async () => {
    await expect(publishWorkspacePlacement({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_cloud",
      request: async () => new Response(
        JSON.stringify({
          error: {
            code: "host_assignment_local_workspace_required",
            message: "Only a workspace this machine serves can be assigned to a machine",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    })).rejects.toThrow("Only a workspace this machine serves can be assigned to a machine")
  })

  test("withdrawing one workspace deletes the same assignment", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    await withdrawWorkspacePlacement({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_local",
      request: async (url, init) => {
        calls.push({ url: requestUrl(url), init })
        return new Response("{}", { headers: { "Content-Type": "application/json" } })
      },
    })

    expect(calls[0]?.url).toBe("https://control.example.test/api/workspace/ws_local/host-assignment")
    expect(calls[0]?.init?.method).toBe("DELETE")
  })
})

/**
 * The URL a fetch call targeted. `fetch` accepts a string, a `URL` or a
 * `Request`, and only the first two survive `String(...)` — a `Request` would
 * stringify to `[object Request]`.
 */
function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input)
}

/** The JSON a fetch call carried. A non-string body is not something we send. */
function requestJson(init?: RequestInit): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined
}
