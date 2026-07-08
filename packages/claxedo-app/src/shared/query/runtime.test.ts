import { afterEach, describe, expect, test } from "bun:test"
import type { VcsInfo } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "./query-client"
import { workspaceResolveQuery, workspaceVcsQuery } from "./runtime"

afterEach(() => queryClient.clear())

const missingWorkspaceRequest: typeof fetch = async () => new Response("missing", { status: 404 })

describe("workspace resolve query", () => {
  test("builds a directory-scoped resolve query", async () => {
    const request: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      expect(req.url).toBe("http://runtime.test/api/workspace/resolve?directory=%2Ftmp%2Fws")
      return new Response(JSON.stringify({
        workspaceId: "ws_1",
        directory: "/tmp/ws",
        kind: "cloud",
        status: "stopped",
      }), { status: 200 })
    }

    const query = workspaceResolveQuery({
      baseUrl: "http://runtime.test/",
      request,
      directory: "/tmp/ws",
    })

    expect(query.queryKey).toEqual(["runtime", "http://runtime.test", "workspace", "", "/tmp/ws", "read"])
    expect(await query.queryFn()).toMatchObject({
      workspaceId: "ws_1",
      kind: "cloud",
      status: "stopped",
    })
  })

  test("returns null on missing workspaces", async () => {
    const query = workspaceResolveQuery({
      baseUrl: "http://runtime.test",
      request: missingWorkspaceRequest,
      workspaceId: "ws_missing",
    })

    expect(await query.queryFn()).toBeNull()
  })

  test("workspaceVcsQuery is directory-scoped", async () => {
    const query = workspaceVcsQuery({
      baseUrl: "http://runtime.test",
      directory: "/tmp/ws",
      request: missingWorkspaceRequest,
      client: {
        vcs: {
          get: async () => ({ data: { branch: "feature", default_branch: "dev" } satisfies VcsInfo }),
        },
      },
    })

    expect(query.queryKey).toEqual(["runtime", "http://runtime.test", "vcs", "", "/tmp/ws"])
    expect(await query.queryFn()).toMatchObject({ branch: "feature", default_branch: "dev" })
  })

  test("workspaceVcsQuery uses a known workspace id without resolving the directory alias", async () => {
    const calls: string[] = []
    const request = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(req.url)
      if (req.url.includes("/api/workspace/resolve")) {
        throw new Error(`unexpected workspace resolve: ${req.url}`)
      }
      if (req.url === "http://runtime.test/api/workspace/ws_known/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_known",
          relayUrl: "https://relay.runtime.test",
          runtimeAccessToken: "rat_known",
          tokenExpiresAt: Date.now() + 120_000,
          role: "editor",
        })
      }
      if (req.url === "https://relay.runtime.test/workspaces/ws_known/vcs") {
        return Response.json({ branch: "cloud", default_branch: "dev" })
      }
      throw new Error(`unexpected request: ${req.url}`)
    }) as typeof fetch
    const query = workspaceVcsQuery({
      baseUrl: "http://runtime.test",
      directory: "/tmp/cloud-alias",
      request,
      workspaceId: "ws_known",
      signedControlPlane: true,
      client: {
        vcs: {
          get: async () => {
            throw new Error("expected relay VCS fetch")
          },
        },
      },
    })

    expect(query.queryKey).toEqual(["runtime", "http://runtime.test", "vcs", "ws_known", "/tmp/cloud-alias"])
    expect(await query.queryFn()).toMatchObject({ branch: "cloud", default_branch: "dev" })
    expect(calls).toEqual([
      "http://runtime.test/api/workspace/ws_known/connection",
      "https://relay.runtime.test/workspaces/ws_known/vcs",
    ])
  })

})
