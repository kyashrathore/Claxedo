import { describe, expect, test } from "bun:test"
import { localWorkspaceShareTarget, registerUserHostedWorkspace, workspaceShareUrl } from "./share-workspace"

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

  test("registers user-hosted workspace without the legacy tunnel opt-in", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    await registerUserHostedWorkspace({
      serverUrl: "https://control.example.test/",
      workspaceId: "ws_local",
      displayName: "Main",
      request: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        })
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://control.example.test/api/workspace/ws_local/user-hosted/register")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      displayName: "Main",
    })
  })
})
