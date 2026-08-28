import { describe, expect, test } from "bun:test"
import {
  claxedoEventRouteSessionID,
  claxedoEventStreamTargets,
  eventStreamFetch,
  eventStreamTargetKey,
  CLAXEDO_EVENTS_RELAY_PATH,
  normalizeClaxedoStreamEvent,
} from "./claxedo-events"

/**
 * A `typeof fetch` test double, without a cast.
 *
 * The casts these replaced were bridging exactly one missing member —
 * `preconnect` — not a genuine incompatibility. Attaching it makes the double a
 * real `typeof fetch`, so the type checker verifies the call signature instead of
 * being told to stop looking. Nothing here ever calls `preconnect`.
 */
function fetchDouble(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: () => undefined })
}

describe("claxedoEventStreamTargets", () => {
  test("adds a workspace runtime stream for local workspaces", () => {
    expect(claxedoEventStreamTargets({
      serverUrl: "https://control.example.test",
      directory: "/repo/local",
      sessionID: "session-local",
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
      { kind: "central", url: new URL("https://control.example.test/api/claxedo/events") },
      {
        kind: "workspace",
        serverUrl: "https://control.example.test",
        workspaceId: "ws_local",
        workspaceKind: "local",
        directory: "/repo/local",
      },
    ])
  })

  test("adds a relay-backed workspace runtime stream for signed remote workspaces", () => {
    const targets = claxedoEventStreamTargets({
      serverUrl: "https://control.example.test",
      directory: "/repo/cloud",
      sessionID: "session-cloud",
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
      url: new URL("https://control.example.test/api/claxedo/events"),
    })
    // …while the per-workspace stream is a relay target (NOT a central
    // /workspaces/:id URL): the events provider opens it through the relay
    // connection with the Runtime Access Token, like provider/file/PTY reads.
    expect(targets[1]).toEqual({
      kind: "workspace",
      serverUrl: "https://control.example.test",
      workspaceId: "ws_cloud",
      workspaceKind: "cloud",
      directory: "/repo/cloud",
      sessionID: "session-cloud",
    })
    // It must NOT be a central URL target.
    expect(targets[1]).not.toHaveProperty("url")
  })

  test("treats workspace id routes as relay-backed workspace streams", () => {
    const targets = claxedoEventStreamTargets({
      serverUrl: "https://control.example.test",
      directory: "ws_cloud",
      sessionID: "session-cloud",
    })
    expect(targets[0]).toEqual({
      kind: "central",
      url: new URL("https://control.example.test/api/claxedo/events"),
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
      sessionID: "session-cloud",
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
      sessionID: "session-cloud",
    })
    expect(targets[0]).toEqual({ kind: "central", url: new URL("http://127.0.0.1:3001/api/claxedo/events") })
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
      sessionID: "session-cloud",
    })
    expect(targets[0]).toEqual({ kind: "central", url: new URL("http://127.0.0.1:3001/api/claxedo/events") })
    expect(targets[1]).toMatchObject({
      kind: "workspace",
      serverUrl: "http://127.0.0.1:3001",
      workspaceId: "ws_cloud",
    })
  })

  test("does not open an unscoped relay stream from a workspace-only route", () => {
    expect(claxedoEventStreamTargets({
      serverUrl: "https://control.example.test",
      directory: "ws_cloud",
    })).toEqual([
      { kind: "central", url: new URL("https://control.example.test/api/wr/events") },
    ])
  })

  test("reads the managed session only from canonical session routes", () => {
    expect(claxedoEventRouteSessionID("/s/session%2Fone")).toBe("session/one")
    expect(claxedoEventRouteSessionID("/w/ws_cloud/session/session-two")).toBe("session-two")
    expect(claxedoEventRouteSessionID("/w/ws_cloud/session/new")).toBeUndefined()
    expect(claxedoEventRouteSessionID("/w/ws_cloud")).toBeUndefined()
  })

  test("uses the session as part of a managed stream identity", () => {
    const base = {
      kind: "workspace" as const,
      serverUrl: "https://control.example.test",
      workspaceId: "ws_cloud",
      workspaceKind: "cloud" as const,
    }
    expect(eventStreamTargetKey({ ...base, sessionID: "session-a" }))
      .not.toBe(eventStreamTargetKey({ ...base, sessionID: "session-b" }))
  })
})

describe("eventStreamFetch", () => {
  test("opens the per-workspace stream through the relay with the Runtime Access Token (NOT central)", async () => {
    const seen: Array<{ url: string; auth: string | null; accept: string | null }> = []
    const request = fetchDouble(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
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
    })

    const res = await eventStreamFetch(
      {
        kind: "workspace",
        serverUrl: "https://control.example.test",
        workspaceId: "ws_events_relay",
        workspaceKind: "cloud",
        sessionID: "session-events",
      },
      { headers: { Accept: "text/event-stream" } },
      { request, relayRequest: request },
    )
    expect(res.status).toBe(200)
    // The stream request hit the relay (NOT central) with the RAT bearer.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe("https://relay.events.test/workspaces/ws_events_relay/api/wr/events?sessionID=session-events")
    expect(seen[0]!.url).not.toContain("control.example.test")
    expect(seen[0]!.auth).toBe("Bearer rat_events")
    expect(seen[0]!.accept).toBe("text/event-stream")
  })

  test("fetches the central global stream directly (no relay)", async () => {
    let hit: string | undefined
    const request = fetchDouble(async (input) => {
      hit = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
      return new Response("data: {\"type\":\"heartbeat\"}\n\n", { status: 200 })
    })

    await eventStreamFetch(
      { kind: "central", url: new URL("https://control.example.test/api/claxedo/events") },
      {},
      { request },
    )
    expect(hit).toBe("https://control.example.test/api/claxedo/events")
  })

  test("keeps the canonical session query on managed replay reconnects", async () => {
    const seen: Array<{ url: string; cursor: string | null }> = []
    const request = fetchDouble(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url.includes("/api/workspace/ws_reconnect/connection")) {
        return new Response(JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          role: "editor",
          workspaceId: "ws_reconnect",
          relayUrl: "https://relay.events.test",
          runtimeAccessToken: "rat_reconnect",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      seen.push({ url: request.url, cursor: request.headers.get("Last-Event-ID") })
      return new Response('data: {"type":"heartbeat"}\n\n', { status: 200 })
    })
    const target = {
      kind: "workspace" as const,
      serverUrl: "https://control.example.test",
      workspaceId: "ws_reconnect",
      workspaceKind: "cloud" as const,
      sessionID: "session-reconnect",
    }

    await eventStreamFetch(target, { headers: { Accept: "text/event-stream" } }, { request, relayRequest: request })
    await eventStreamFetch(target, {
      headers: { Accept: "text/event-stream", "Last-Event-ID": "19" },
    }, { request, relayRequest: request })

    expect(seen).toEqual([
      {
        url: "https://relay.events.test/workspaces/ws_reconnect/api/wr/events?sessionID=session-reconnect",
        cursor: null,
      },
      {
        url: "https://relay.events.test/workspaces/ws_reconnect/api/wr/events?sessionID=session-reconnect",
        cursor: "19",
      },
    ])
  })

  test("keeps loopback local workspace streams on the directory-scoped runtime", async () => {
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
      {
        kind: "workspace",
        serverUrl: "http://127.0.0.1:3001",
        workspaceId: "ws_loopback",
        workspaceKind: "local",
        directory: "/repo/local",
        sessionID: "session-local",
      },
      { headers: { Accept: "text/event-stream", Authorization: "Bearer browser-token" } },
      { request },
    )

    expect(res.status).toBe(200)
    expect(seen).toEqual([{
      url: "http://127.0.0.1:3001/api/wr/events?directory=%2Frepo%2Flocal",
      auth: null,
      xdir: null,
    }])
  })

  test("the relay events path is the runtime claxedo events resource", () => {
    expect(CLAXEDO_EVENTS_RELAY_PATH).toBe("/api/wr/events")
  })
})

describe("normalizeClaxedoStreamEvent", () => {
  test("keeps direct claxedo events unchanged", () => {
    expect(normalizeClaxedoStreamEvent({ type: "pty.deleted", id: "pty_1" })).toEqual({ type: "pty.deleted", id: "pty_1" })
  })

  test("unwraps runtime event envelopes and preserves the directory", () => {
    expect(normalizeClaxedoStreamEvent({
      directory: "/repo",
      payload: {
        type: "todo.updated",
        properties: {
          sessionID: "ses_todo",
          todos: [{ id: "todo_1", content: "Wire", status: "pending" }],
        },
      },
    })).toEqual({
      type: "todo.updated",
      directory: "/repo",
      properties: {
        sessionID: "ses_todo",
        todos: [{ id: "todo_1", content: "Wire", status: "pending" }],
      },
    })
  })
})
