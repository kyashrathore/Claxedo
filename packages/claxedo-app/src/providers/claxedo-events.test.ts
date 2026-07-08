import { describe, expect, test } from "bun:test"
import { claxedoEventStreamTargets, eventStreamFetch, CLAXEDO_EVENTS_RELAY_PATH } from "./claxedo-events"

describe("claxedoEventStreamTargets", () => {
  test("keeps local workspaces on the central event stream", () => {
    expect(claxedoEventStreamTargets({
      serverUrl: "https://control.example.test",
      directory: "/repo/local",
      projects: [{
        workspaces: {
          "/repo/local": {
            workspaceId: "ws_local",
            kind: "local",
            directory: "/repo/local",
          },
        },
      }],
    })).toEqual([
      { kind: "central", url: new URL("https://control.example.test/api/wr/events") },
    ])
  })

  test("adds a relay-backed workspace runtime stream for signed remote workspaces", () => {
    const targets = claxedoEventStreamTargets({
      serverUrl: "https://control.example.test",
      directory: "/repo/cloud",
      projects: [{
        workspaces: {
          "/repo/cloud": {
            workspaceId: "ws_cloud",
            kind: "cloud",
            directory: "/repo/cloud",
          },
        },
      }],
    })
    // The central stream is fetched directly from the control plane…
    expect(targets[0]).toEqual({
      kind: "central",
      url: new URL("https://control.example.test/api/wr/events"),
    })
    // …while the per-workspace stream is a relay target (NOT a central
    // /workspaces/:id URL): the events provider opens it through the relay
    // connection with the Runtime Access Token, like provider/file/PTY reads.
    expect(targets[1]).toEqual({
      kind: "workspace",
      serverUrl: "https://control.example.test",
      workspaceId: "ws_cloud",
      directory: "/repo/cloud",
    })
    // It must NOT be a central URL target.
    expect(targets[1]).not.toHaveProperty("url")
  })

  test("treats workspace id routes as relay-backed workspace streams", () => {
    const targets = claxedoEventStreamTargets({
      serverUrl: "https://control.example.test",
      directory: "ws_cloud",
    })
    expect(targets[0]).toEqual({
      kind: "central",
      url: new URL("https://control.example.test/api/wr/events"),
    })
    expect(targets[1]).toMatchObject({
      kind: "workspace",
      serverUrl: "https://control.example.test",
      workspaceId: "ws_cloud",
    })
  })

  test("treats legacy workspace directory routes as relay-backed workspace streams", () => {
    const targets = claxedoEventStreamTargets({
      serverUrl: "https://control.example.test",
      directory: "workspace:ws_cloud",
    })
    expect(targets[1]).toMatchObject({
      kind: "workspace",
      serverUrl: "https://control.example.test",
      workspaceId: "ws_cloud",
    })
  })

  test("adds a workspace stream for loopback workspace id routes", () => {
    const targets = claxedoEventStreamTargets({
      serverUrl: "http://127.0.0.1:3001",
      directory: "ws_cloud",
    })
    expect(targets[0]).toEqual({ kind: "central", url: new URL("http://127.0.0.1:3001/api/wr/events") })
    expect(targets[1]).toMatchObject({
      kind: "workspace",
      serverUrl: "http://127.0.0.1:3001",
      workspaceId: "ws_cloud",
    })
  })

  test("adds a workspace stream for loopback legacy workspace directory routes", () => {
    const targets = claxedoEventStreamTargets({
      serverUrl: "http://127.0.0.1:3001",
      directory: "workspace:ws_cloud",
    })
    expect(targets[0]).toEqual({ kind: "central", url: new URL("http://127.0.0.1:3001/api/wr/events") })
    expect(targets[1]).toMatchObject({
      kind: "workspace",
      serverUrl: "http://127.0.0.1:3001",
      workspaceId: "ws_cloud",
    })
  })
})

describe("eventStreamFetch", () => {
  test("opens the per-workspace stream through the relay with the Runtime Access Token (NOT central)", async () => {
    const seen: Array<{ url: string; auth: string | null; accept: string | null }> = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      // Mint the relay connection for the workspace.
      if (url.includes("/api/workspace/ws_events_relay/connection")) {
        return new Response(JSON.stringify({
          access: "user-hosted",
          backing: "local-worktree",
          role: "owner",
          workspaceId: "ws_events_relay",
          relayUrl: "https://relay.events.test",
          runtimeAccessToken: "rat_events",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      seen.push({ url, auth: headers.get("authorization"), accept: headers.get("accept") })
      return new Response("data: {\"type\":\"heartbeat\"}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
      // as-any: test double implements only the API surface exercised by this test.
    }) as unknown as typeof fetch

    const res = await eventStreamFetch(
      { kind: "workspace", serverUrl: "https://control.example.test", workspaceId: "ws_events_relay" },
      { headers: { Accept: "text/event-stream" } },
      { request, relayRequest: request },
    )
    expect(res.status).toBe(200)
    // The stream request hit the relay (NOT central) with the RAT bearer.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe("https://relay.events.test/workspaces/ws_events_relay/api/wr/events")
    expect(seen[0]!.url).not.toContain("control.example.test")
    expect(seen[0]!.auth).toBe("Bearer rat_events")
    expect(seen[0]!.accept).toBe("text/event-stream")
  })

  test("fetches the central global stream directly (no relay)", async () => {
    let hit: string | undefined
    const request = (async (input: string | URL | Request) => {
      hit = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      return new Response("data: {\"type\":\"heartbeat\"}\n\n", { status: 200 })
      // as-any: test double implements only the API surface exercised by this test.
    }) as unknown as typeof fetch

    await eventStreamFetch(
      { kind: "central", url: new URL("https://control.example.test/api/wr/events") },
      {},
      { request },
    )
    expect(hit).toBe("https://control.example.test/api/wr/events")
  })

  test("keeps loopback workspace streams on the local workspace proxy", async () => {
    const seen: Array<{ url: string; auth: string | null; xdir: string | null }> = []
    const request: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      if (url.includes("/api/workspace/ws_loopback/connection")) {
        throw new Error(`unexpected relay connection mint: ${url}`)
      }
      seen.push({
        url,
        auth: headers.get("authorization"),
        xdir: headers.get("x-opencode-directory"),
      })
      return new Response("data: {\"type\":\"heartbeat\"}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    }

    const res = await eventStreamFetch(
      { kind: "workspace", serverUrl: "http://127.0.0.1:3001", workspaceId: "ws_loopback", directory: "workspace:ws_loopback" },
      { headers: { Accept: "text/event-stream", Authorization: "Bearer browser-token" } },
      { request },
    )

    expect(res.status).toBe(200)
    expect(seen).toEqual([{
      url: "http://127.0.0.1:3001/workspaces/ws_loopback/api/wr/events",
      auth: null,
      xdir: "workspace:ws_loopback",
    }])
  })

  test("the relay events path is the runtime claxedo events resource", () => {
    expect(CLAXEDO_EVENTS_RELAY_PATH).toBe("/api/wr/events")
  })
})
