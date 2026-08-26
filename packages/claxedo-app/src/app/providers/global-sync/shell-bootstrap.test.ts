import { describe, expect, test } from "bun:test"
import { bootstrapInitialShell, fetchShellBootstrap } from "./shell-bootstrap"

describe("fetchShellBootstrap", () => {
  test("requests only the lightweight shell projection", async () => {
    let requestUrl = ""
    const result = await fetchShellBootstrap({
      baseUrl: "http://127.0.0.1:3101",
      request: Object.assign(
        async (input: URL | RequestInfo) => {
          requestUrl = input.toString()
          return Response.json({
            healthy: true,
            path: { home: "/Users/test", state: "/state", config: "/config", worktree: "", directory: "" },
            project: [{ id: "project-1", worktree: "/repo", name: "repo" }],
          })
        },
        { preconnect: fetch.preconnect },
      ),
    })

    expect(new URL(requestUrl).searchParams.get("scope")).toBe("shell")
    expect(result?.project[0]?.id).toBe("project-1")
  })

  test("does not accept a partial response as a ready shell", async () => {
    const result = await fetchShellBootstrap({
      baseUrl: "http://127.0.0.1:3101",
      request: Object.assign(async () => Response.json({ healthy: true, project: [] }), {
        preconnect: fetch.preconnect,
      }),
    })

    expect(result).toBeUndefined()
  })

  test("publishes only shell state and leaves provider/config caches cold", async () => {
    const patches: object[] = []
    await bootstrapInitialShell({
      baseUrl: "http://127.0.0.1:3101",
      request: Object.assign(
        async () =>
          Response.json({
            healthy: true,
            path: { home: "/Users/test", state: "/state", config: "/config", worktree: "", directory: "" },
            project: [{ id: "project-1", worktree: "/repo", name: "repo" }],
          }),
        { preconnect: fetch.preconnect },
      ),
      setGlobalState: (patch) => patches.push(patch),
      fallback: async () => expect.unreachable(),
    })

    expect(patches).toEqual([
      {
        path: { home: "/Users/test", state: "/state", config: "/config", worktree: "", directory: "" },
        project: [{ id: "project-1", worktree: "/repo", name: "repo" }],
        ready: true,
      },
    ])
  })

  test("falls back to the full bootstrap when shell projection fails", async () => {
    let fallback = 0
    await bootstrapInitialShell({
      baseUrl: "http://127.0.0.1:3101",
      request: Object.assign(async () => new Response(null, { status: 503 }), { preconnect: fetch.preconnect }),
      setGlobalState: () => expect.unreachable(),
      fallback: async () => {
        fallback += 1
      },
    })

    expect(fallback).toBe(1)
  })
})
