import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { aliasTerminalLogSummary, cachedTerminalLogSummary, loadTerminalLogSummary } from "./terminal-log-summary"

const originalFetch = globalThis.fetch

describe("terminal log summary", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    queryClient.clear()
  })

  test("loads and caches a summary from process logs", async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response("one\ntwo\nthree")
    }) as typeof fetch

    const summary = await loadTerminalLogSummary("http://localhost:3099", "pty_1", "/repo")

    expect(summary).toEqual({
      title: "three",
      task: "one two three",
      recent: ["one", "two", "three"],
    })
    expect(cachedTerminalLogSummary("http://localhost:3099", "pty_1", "/repo")).toEqual(summary)
    expect(calls).toEqual(["http://localhost:3099/api/wr/process/logs?terminal_id=pty_1&directory=%2Frepo&lines=40"])
  })

  test("coalesces concurrent summary loads and serves later reads from cache", async () => {
    // The in-flight request and response cache both live in the shared Query
    // client. Two concurrent loads for the same target join a single request,
    // and a later load (plus the synchronous reader) hit the cache — proving
    // no module-private Map owns this state.
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response("alpha\nbeta")
    }) as typeof fetch

    const [first, second] = await Promise.all([
      loadTerminalLogSummary("http://localhost:3098", "pty_coalesce", "/repo"),
      loadTerminalLogSummary("http://localhost:3098", "pty_coalesce", "/repo"),
    ])

    expect(first?.recent).toEqual(["alpha", "beta"])
    expect(second).toEqual(first)

    const cachedRead = cachedTerminalLogSummary("http://localhost:3098", "pty_coalesce", "/repo")
    expect(cachedRead).toEqual(first)
    expect(await loadTerminalLogSummary("http://localhost:3098", "pty_coalesce", "/repo")).toEqual(first)
    expect(calls).toBe(1)
  })

  test("uses the provided request through transport for non-loopback process logs", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url}`)
      return new Response("remote\nsummary")
    }) as typeof fetch

    const summary = await loadTerminalLogSummary("http://server.test", "pty_remote", "/repo", request)

    expect(summary?.title).toBe("summary")
    expect(calls).toEqual([
      "GET http://server.test/api/wr/process/logs?terminal_id=pty_remote&directory=%2Frepo&lines=40",
    ])
  })

  test("routes non-loopback workspace logs through Workspace Relay", async () => {
    const seen: Array<{ url: string; authorization: string | null; directory: string | null }> = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      seen.push({
        url: req.url,
        authorization: req.headers.get("Authorization"),
        directory: req.headers.get("x-opencode-directory"),
      })

      if (req.url === "http://server.test/api/workspace/ws_logs/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_logs",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_logs",
          role: "editor",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }

      if (req.url === "https://relay.test/workspaces/ws_logs/api/wr/process/logs?terminal_id=pty_cloud&lines=40") {
        return new Response("cloud\nlogs")
      }

      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch

    const summary = await loadTerminalLogSummary("http://server.test", "pty_cloud", "/workspace", {
      request,
      resolveWorkspaceRuntime: async () => ({
        kind: "cloud",
        workspaceId: "ws_logs",
      }),
    })

    expect(summary?.recent).toEqual(["cloud", "logs"])
    expect(seen.map((item) => item.url)).toEqual([
      "http://server.test/api/workspace/ws_logs/connection",
      "https://relay.test/workspaces/ws_logs/api/wr/process/logs?terminal_id=pty_cloud&lines=40",
    ])
    expect(seen[1]?.authorization).toBe("Bearer rat_logs")
    expect(seen[1]?.directory).toBe("workspace:ws_logs")
  })

  test("follows terminal id aliases", async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response("aliased")
    }) as typeof fetch

    aliasTerminalLogSummary("pty_old", "pty_new")
    await loadTerminalLogSummary("http://localhost:3100", "pty_old", "/repo")

    expect(calls[0]).toContain("terminal_id=pty_new")
  })
})
