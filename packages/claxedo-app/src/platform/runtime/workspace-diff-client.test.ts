import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { createWorkspaceDiffClient } from "./workspace-diff-client"
import { requestUrl } from "@/lib/url"

afterEach(() => queryClient.clear())

describe("workspace diff client relay transport", () => {
  test("strict refs preserve load failures while legacy refs consumers keep their empty fallback", async () => {
    const client = createWorkspaceDiffClient({
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/main",
      request: async () => new Response("unavailable", { status: 503 }),
      resolveWorkspaceRuntime: async () => undefined,
    })

    await expect(client.refsRequired("/repo/main")).rejects.toThrow("Failed to load Git refs: 503")
    await expect(client.refs("/repo/main")).resolves.toEqual({ branches: [], tags: [], recent: [] })
  })

  test("keeps local diff requests on unsigned loopback runtime paths", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null }> = []
    const request = (async (input, init) => {
      const req = new Request(requestUrl(input), init)
      calls.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("Authorization"),
      })

      if (req.url === "http://127.0.0.1:3001/api/wr/diff/vcs?directory=%2Frepo%2Fmain&mode=uncommitted&content=summary") {
        return Response.json([{ file: "README.md", before: "", after: "ok", additions: 1, deletions: 0, status: "added" }])
      }

      if (req.url === "http://127.0.0.1:3001/api/wr/diff/vcs/file?directory=%2Frepo%2Fmain&mode=uncommitted&file=README.md") {
        return Response.json({ file: "README.md", patch: "diff --git a/README.md b/README.md" })
      }

      if (req.url === "http://127.0.0.1:3001/api/wr/diff/refs?directory=%2Frepo%2Fmain") {
        return Response.json({ branches: ["main"], tags: [], recent: [] })
      }

      if (req.url === "http://127.0.0.1:3001/api/wr/diff/targets?directory=%2Frepo%2Fmain") {
        return Response.json({ defaultRef: "origin/dev", candidates: ["origin/dev"] })
      }

      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch

    const client = createWorkspaceDiffClient({
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/main",
      request,
      resolveWorkspaceRuntime: async () => undefined,
    })

    expect(await client.vcs({ directory: "/repo/main", mode: "uncommitted", content: "summary" })).toHaveLength(1)
    expect(await client.vcsFile({ directory: "/repo/main", mode: "uncommitted", file: "README.md" })).toEqual({
      file: "README.md",
      patch: "diff --git a/README.md b/README.md",
    })
    expect(await client.refs("/repo/main")).toEqual({ branches: ["main"], tags: [], recent: [] })
    expect(await client.targets("/repo/main")).toEqual({ defaultRef: "origin/dev", candidates: ["origin/dev"] })

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://127.0.0.1:3001/api/wr/diff/vcs?directory=%2Frepo%2Fmain&mode=uncommitted&content=summary",
      "GET http://127.0.0.1:3001/api/wr/diff/vcs/file?directory=%2Frepo%2Fmain&mode=uncommitted&file=README.md",
      "GET http://127.0.0.1:3001/api/wr/diff/refs?directory=%2Frepo%2Fmain",
      "GET http://127.0.0.1:3001/api/wr/diff/targets?directory=%2Frepo%2Fmain",
    ])
    expect(calls.every((call) => call.authorization === null)).toBe(true)
  })

  test("routes cloud diff requests through Workspace Relay", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null }> = []
    const request = (async (input, init) => {
      const req = new Request(requestUrl(input), init)
      calls.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("Authorization"),
      })

      if (req.url.startsWith("http://server.test/api/wr/diff")) {
        throw new Error(`Unexpected claxedo-server diff proxy request: ${req.method} ${req.url}`)
      }

      if (req.url === "http://server.test/api/workspace/ws_1/connection") {
        return Response.json({
          backing: "cloud-vm",
          sessionAuthority: "managed-private",
          workspaceId: "ws_1",
          role: "admin",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: "rat_1",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }

      if (req.url === "https://relay.example.test/workspaces/ws_1/api/wr/diff/vcs?mode=uncommitted&content=summary") {
        return Response.json([{ file: "README.md", before: "", after: "ok", additions: 1, deletions: 0, status: "added" }])
      }

      if (req.url === "https://relay.example.test/workspaces/ws_1/api/wr/diff/vcs/file?mode=uncommitted&file=README.md") {
        return Response.json({ file: "README.md", patch: "diff --git a/README.md b/README.md" })
      }

      if (req.url === "https://relay.example.test/workspaces/ws_1/api/wr/diff/refs") {
        return Response.json({ branches: ["main"], tags: [], recent: [] })
      }

      if (req.url === "https://relay.example.test/workspaces/ws_1/api/wr/diff/targets") {
        return Response.json({ defaultRef: "origin/dev", candidates: ["origin/dev"] })
      }

      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch

    const client = createWorkspaceDiffClient({
      serverUrl: "http://server.test",
      directory: "/workspace",
      request,
      resolveWorkspaceRuntime: async () => ({
        kind: "provisioner",
        workspaceId: "ws_1",
      }),
    })

    expect(await client.vcs({ directory: "/workspace", mode: "uncommitted", content: "summary" })).toHaveLength(1)
    expect(await client.vcsFile({ directory: "/workspace", mode: "uncommitted", file: "README.md" })).toEqual({
      file: "README.md",
      patch: "diff --git a/README.md b/README.md",
    })
    expect(await client.refs("/workspace")).toEqual({ branches: ["main"], tags: [], recent: [] })
    expect(await client.targets("/workspace")).toEqual({ defaultRef: "origin/dev", candidates: ["origin/dev"] })

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://server.test/api/workspace/ws_1/connection",
      "GET https://relay.example.test/workspaces/ws_1/api/wr/diff/vcs?mode=uncommitted&content=summary",
      "GET https://relay.example.test/workspaces/ws_1/api/wr/diff/vcs/file?mode=uncommitted&file=README.md",
      "GET https://relay.example.test/workspaces/ws_1/api/wr/diff/refs",
      "GET https://relay.example.test/workspaces/ws_1/api/wr/diff/targets",
    ])
    expect(calls.slice(1).every((call) => call.authorization === "Bearer rat_1")).toBe(true)
  })
  // The route's body used to be handed straight back under whatever type the
  // call site named. These assert what the readers actually keep, so a future
  // "just cast it" regression fails here instead of surfacing an `undefined`
  // label in a ref picker.
  test("drops malformed entries from a refs body instead of surfacing them", async () => {
    const client = createWorkspaceDiffClient({
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/main",
      request: (async () =>
        Response.json({
          branches: ["main", 7, null],
          branchChoices: [{ gitRef: "origin/dev", sourceBranch: "dev" }, { sourceBranch: "orphan" }],
          tags: "v1",
          recent: [{ hash: "abc", subject: "first" }, { hash: "def" }],
        })) as typeof fetch,
      resolveWorkspaceRuntime: async () => undefined,
    })

    expect(await client.refs("/repo/main")).toEqual({
      branches: ["main"],
      branchChoices: [{ gitRef: "origin/dev", sourceBranch: "dev" }],
      tags: [],
      recent: [{ hash: "abc", subject: "first" }],
    })
  })

  test("keeps only the fields a diff row and a targets body actually carry", async () => {
    const bodyFor = (url: string) =>
      url.includes("/vcs/file")
        ? Response.json({ file: "README.md", additions: 3, deletions: "many", patch: 12 })
        : Response.json({ defaultRef: 4, candidates: ["origin/dev", 9] })
    const client = createWorkspaceDiffClient({
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/main",
      request: (async (input) => bodyFor(requestUrl(input))) as typeof fetch,
      resolveWorkspaceRuntime: async () => undefined,
    })

    expect(await client.vcsFile({ directory: "/repo/main", mode: "uncommitted", file: "README.md" })).toEqual({
      file: "README.md",
      additions: 3,
    })
    expect(await client.targets("/repo/main")).toEqual({ candidates: ["origin/dev"] })
  })

  test("answers undefined for a diff row with no file path", async () => {
    const client = createWorkspaceDiffClient({
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/main",
      request: (async () => Response.json({ patch: "diff --git a/x b/x" })) as typeof fetch,
      resolveWorkspaceRuntime: async () => undefined,
    })

    expect(await client.vcsFile({ directory: "/repo/main", mode: "uncommitted", file: "x" })).toBeUndefined()
  })
})
