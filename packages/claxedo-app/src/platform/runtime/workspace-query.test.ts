import { afterEach, describe, expect, test } from "bun:test"
import type { VcsInfo } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "@/platform/query/query-client"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"

afterEach(() => queryClient.clear())

const missingWorkspaceRequest: typeof fetch = async () => new Response("missing", { status: 404 })

describe("workspace vcs query", () => {
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

    expect(query.queryKey).toEqual(["runtime", "http://runtime.test", "vcs", "/tmp/ws", ""])
    expect(await query.queryFn()).toMatchObject({ branch: "feature", default_branch: "dev" })
  })

  test("freshness is event-owned, so the entry never expires on a wall clock", () => {
    // WorkspaceVcsCacheHonesty invalidates this key from the workspace's own
    // event stream. A staleTime here would make a session switch pay a refetch
    // for no reason other than elapsed time.
    expect(
      workspaceVcsQuery({
        baseUrl: "http://runtime.test",
        directory: "/tmp/ws",
        request: missingWorkspaceRequest,
        client: { vcs: { get: async () => ({ data: {} }) } },
      }).staleTime,
    ).toBe(Infinity)
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

    expect(query.queryKey).toEqual(["runtime", "http://runtime.test", "vcs", "/tmp/cloud-alias", "ws_known"])
    expect(await query.queryFn()).toMatchObject({ branch: "cloud", default_branch: "dev" })
    expect(calls).toEqual([
      "http://runtime.test/api/workspace/ws_known/connection",
      "https://relay.runtime.test/workspaces/ws_known/vcs",
    ])
  })
})
