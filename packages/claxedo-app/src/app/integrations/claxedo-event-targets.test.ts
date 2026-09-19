import { describe, expect, test } from "bun:test"
import {
  claxedoEventRouteSessionID,
  claxedoEventStreamTargets,
  routeAwaitsWorkspaceStream,
  eventStreamFetch,
  eventStreamFrameAddress,
  eventStreamTargetKey,
  WORKSPACE_EVENTS_PATH,
  type HostAggregateEventStreamTarget,
} from "./claxedo-event-targets"
import {
  holdSessionEventScope,
  resetSessionEventScope,
  sessionEventScopeId,
  setSessionEventRouteScope,
} from "@/platform/runtime/session-event-scope"

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
  const localProjects = [{
    workspaces: {
      "/repo/local": {
        workspaceId: "ws_local",
        kind: "local" as const,
        directory: "/repo/local",
      },
    },
  }]

  const loopbackCp = { kind: "cp", url: new URL("http://127.0.0.1:3001/api/cp/events"), transport: "server" }
  const hostAggregate = { kind: "wr", scope: "host", serverUrl: "http://127.0.0.1:3001" }

  test("a loopback surface reads its daemon's cp stream and the host aggregate, signed or not", () => {
    // The daemon hosts the local runtime, so its frames are already on the
    // aggregate: a second, directory-scoped connection would be them twice.
    for (const accountSigned of [false, true]) {
      expect(claxedoEventStreamTargets({
        hostAggregate: true,
        serverUrl: "http://127.0.0.1:3001",
        directory: "/repo/local",
        accountSigned,
        projects: localProjects,
      })).toEqual([loopbackCp, hostAggregate])
    }
  })

  test("a loopback surface with no route open still reads the aggregate", () => {
    expect(claxedoEventStreamTargets({ hostAggregate: true, serverUrl: "http://127.0.0.1:3001" })).toEqual([loopbackCp, hostAggregate])
  })

  test.each(["cloud", "user-hosted"] as const)("a signed desktop adds the routed %s workspace's relay stream", (kind) => {
    expect(claxedoEventStreamTargets({
      hostAggregate: true,
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/remote",
      accountSigned: true,
      accountStream: true,
      projects: [{
        workspaces: {
          "/repo/remote": { workspaceId: "ws_remote", kind, directory: "/repo/remote" },
          ...localProjects[0].workspaces,
        },
      }],
    })).toEqual([
      loopbackCp,
      { ...loopbackCp, transport: "account" },
      hostAggregate,
      {
        kind: "wr",
        serverUrl: "http://127.0.0.1:3001",
        workspaceId: "ws_remote",
        workspaceKind: kind,
        directory: "/repo/remote",
      },
    ])
  })

  test("a signed desktop on a local route reads the aggregate and no workspace stream", () => {
    expect(claxedoEventStreamTargets({
      hostAggregate: true,
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/local",
      accountSigned: true,
      accountStream: true,
      projects: localProjects,
    })).toEqual([loopbackCp, { ...loopbackCp, transport: "account" }, hostAggregate])
  })

  test("a server that declares no aggregate hands the local workspace its own stream, loopback or not", () => {
    // The self-hosted node runs its embedded issuer on localhost and mounts no
    // aggregate when it does. Reading the URL alone would leave every local
    // workspace with no stream at all behind a route that answers nothing.
    const forServer = (serverUrl: string, accountSigned: boolean) => claxedoEventStreamTargets({
      hostAggregate: false,
      serverUrl,
      directory: "/repo/local",
      accountSigned,
      projects: localProjects,
    })
    const localWorkspaceStream = (serverUrl: string) => ({
      kind: "wr",
      serverUrl,
      workspaceId: "ws_local",
      workspaceKind: "local",
      directory: "/repo/local",
    })

    expect(forServer("http://127.0.0.1:3001", true)).toEqual([
      loopbackCp,
      localWorkspaceStream("http://127.0.0.1:3001"),
    ])
    expect(forServer("https://node.example.test", true)).toEqual([
      { kind: "cp", url: new URL("https://node.example.test/api/cp/events"), transport: "server" },
      localWorkspaceStream("https://node.example.test"),
    ])
    expect(forServer("https://node.example.test", false)).toEqual([localWorkspaceStream("https://node.example.test")])
  })

  test("a loopback server that has not answered yet opens no wr stream, and the route waits", () => {
    // `false` and "not declared" are different answers. Opening the aggregate
    // on a guess holds a permanently retrying 403 against a signed node;
    // opening the scoped stream on a guess feeds every local frame twice once
    // the aggregate turns out to be served.
    const input = {
      hostAggregate: undefined,
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/local",
      accountSigned: true,
      accountStream: true,
      projects: localProjects,
    }
    expect(claxedoEventStreamTargets(input)).toEqual([loopbackCp, { ...loopbackCp, transport: "account" }])
    expect(routeAwaitsWorkspaceStream(input)).toBe(true)
    // A route naming no workspace has no frames to wait for.
    expect(routeAwaitsWorkspaceStream({ ...input, directory: undefined })).toBe(false)
  })

  test("a filesystem path the catalog has not placed rides the aggregate rather than opening a second stream", () => {
    // What Tier R's daemon answers before its workspace store has registered
    // the worktree: a project with a worktree and no `workspaces` map at all.
    // The daemon serves the paths on its OWN machine, so a path is local by
    // construction and only a catalog entry naming one cloud or user-hosted is
    // another machine's runtime.
    const directory = "/private/var/folders/claxedo-tier-real-two-streams"
    const input = {
      hostAggregate: true,
      serverUrl: "http://127.0.0.1:3001",
      directory,
      projects: [{ id: "engine-hash", worktree: directory }],
    }
    expect(claxedoEventStreamTargets(input)).toEqual([loopbackCp, hostAggregate])
    expect(routeAwaitsWorkspaceStream(input)).toBe(false)
  })

  test("the aggregate is one stream of its own, whatever else is open", () => {
    const targets = claxedoEventStreamTargets({
      hostAggregate: true,
      serverUrl: "http://127.0.0.1:3001",
      directory: "ws_cloud",
      accountSigned: true,
      accountStream: true,
    })
    expect(targets.filter((target) => eventStreamTargetKey(target) === "wr:host:http://127.0.0.1:3001")).toEqual([hostAggregate])
    expect(new Set(targets.map((target) => eventStreamTargetKey(target))).size).toBe(targets.length)
  })

  test("a workspace the catalog lists as local rides the aggregate even under a relay-shaped id", () => {
    // `sessionWorkspaceRuntimeRef` calls a `ws_`-shaped id optimistically
    // relay-backed, and the daemon serves a local workspace on the
    // relay-shaped path all the same: the scoped stream would be the
    // aggregate's own frames a second time.
    expect(claxedoEventStreamTargets({
      hostAggregate: true,
      serverUrl: "http://127.0.0.1:3001",
      directory: "ws_shaped_local",
      accountSigned: true,
      projects: [{
        workspaces: {
          "/repo/shaped": { workspaceId: "ws_shaped_local", kind: "local" as const, directory: "/repo/shaped" },
        },
      }],
    })).toEqual([loopbackCp, hostAggregate])
  })

  test("the aggregate's key names its server, so another daemon is another stream", () => {
    const aggregate: HostAggregateEventStreamTarget = { kind: "wr", scope: "host", serverUrl: "http://127.0.0.1:3001" }
    expect(eventStreamTargetKey(aggregate))
      .not.toBe(eventStreamTargetKey({ ...aggregate, serverUrl: "http://127.0.0.1:4001" }))
  })

  test("omits the hosted cp stream an unsigned page has no route to", () => {
    expect(claxedoEventStreamTargets({
      hostAggregate: true,
      serverUrl: "https://control.example.test",
      accountSigned: false,
      directory: "/repo/local",
      projects: localProjects,
    })).toEqual([{
      kind: "wr",
      serverUrl: "https://control.example.test",
      workspaceId: "ws_local",
      workspaceKind: "local",
      directory: "/repo/local",
    }])
  })

  test("a signed remote workspace's wr target is a relay target carrying the route's session as the fallback scope", () => {
    const targets = claxedoEventStreamTargets({
      hostAggregate: true,
      serverUrl: "https://control.example.test",
      accountSigned: true,
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
    expect(targets).toEqual([
      { kind: "cp", url: new URL("https://control.example.test/api/cp/events"), transport: "server" },
      {
        kind: "wr",
        serverUrl: "https://control.example.test",
        workspaceId: "ws_cloud",
        workspaceKind: "cloud",
        directory: "/repo/cloud",
        sessionID: "session-cloud",
      },
    ])
    expect(targets[1]).not.toHaveProperty("url")
  })

  test.each(["ws_cloud", "workspace:ws_cloud"])("resolves the workspace from a %s route", (directory) => {
    // The loopback surface holds the aggregate between the two; the web one
    // has no aggregate, so its pair is pinned at exactly two.
    for (const [serverUrl, count] of [["https://control.example.test", 2], ["http://127.0.0.1:3001", 3]] as const) {
      const targets = claxedoEventStreamTargets({ hostAggregate: true, serverUrl, accountSigned: true, directory, sessionID: "session-cloud" })
      expect(targets).toHaveLength(count)
      expect(targets[0]).toEqual({ kind: "cp", url: new URL(`${serverUrl}/api/cp/events`), transport: "server" })
      expect(targets.at(-1)).toMatchObject({ kind: "wr", serverUrl, workspaceId: "ws_cloud", sessionID: "session-cloud" })
    }
  })

  test("a draft route carries no fallback session; the held scope does once the session exists", () => {
    // The first turn of a new session creates it under a reserved id and only
    // then navigates, so the draft route names no session. The scope owner —
    // not the route — is what a refused reader retries with.
    const draftRoute = claxedoEventRouteSessionID("/w/ws_cloud/session/new")
    expect(draftRoute).toBeUndefined()
    setSessionEventRouteScope(draftRoute)
    expect(claxedoEventStreamTargets({
      hostAggregate: true,
      serverUrl: "https://control.example.test",
      accountSigned: true,
      directory: "ws_cloud",
      sessionID: sessionEventScopeId(),
    })[1]).not.toHaveProperty("sessionID")

    holdSessionEventScope("ses_created")
    try {
      expect(claxedoEventStreamTargets({
        hostAggregate: true,
        serverUrl: "https://control.example.test",
        accountSigned: true,
        directory: "ws_cloud",
        sessionID: sessionEventScopeId(),
      })[1]).toMatchObject({ kind: "wr", workspaceId: "ws_cloud", sessionID: "ses_created" })
    } finally {
      resetSessionEventScope()
    }
  })

  test("a workspace-only route still opens the workspace's stream", () => {
    // A terminal route names no session, and the bytes a terminal renders ride
    // `pty.stream` on the workspace bus — a stream that belongs to no session.
    expect(claxedoEventStreamTargets({
      hostAggregate: true,
      serverUrl: "https://control.example.test",
      accountSigned: true,
      directory: "ws_user_hosted",
    })).toEqual([
      { kind: "cp", url: new URL("https://control.example.test/api/cp/events"), transport: "server" },
      {
        kind: "wr",
        serverUrl: "https://control.example.test",
        workspaceId: "ws_user_hosted",
        workspaceKind: "user-hosted",
        directory: "ws_user_hosted",
      },
    ])
  })

  test("reads the managed session only from canonical session routes", () => {
    expect(claxedoEventRouteSessionID("/s/session%2Fone")).toBe("session/one")
    expect(claxedoEventRouteSessionID("/w/ws_cloud/session/session-two")).toBe("session-two")
    expect(claxedoEventRouteSessionID("/w/ws_cloud/session/new")).toBeUndefined()
    expect(claxedoEventRouteSessionID("/w/ws_cloud")).toBeUndefined()
  })

  test("the fallback session is not part of a wr stream's identity", () => {
    const base = {
      kind: "wr" as const,
      serverUrl: "https://control.example.test",
      workspaceId: "ws_cloud",
      workspaceKind: "cloud" as const,
    }
    expect(eventStreamTargetKey({ ...base, sessionID: "session-a" }))
      .toBe(eventStreamTargetKey({ ...base, sessionID: "session-b" }))
    expect(eventStreamTargetKey({ ...base, directory: "ws_cloud" }))
      .toBe(eventStreamTargetKey({ ...base, directory: "workspace:ws_cloud" }))
  })

  test("a signed desktop reads its daemon's cp stream AND the hosted control plane's through the account bridge", () => {
    const targets = claxedoEventStreamTargets({
      hostAggregate: true,
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/local",
      accountSigned: true,
      accountStream: true,
      projects: localProjects,
    })
    expect(targets.slice(0, 2)).toEqual([
      { kind: "cp", url: new URL("http://127.0.0.1:3001/api/cp/events"), transport: "server" },
      { kind: "cp", url: new URL("http://127.0.0.1:3001/api/cp/events"), transport: "account" },
    ])
    expect(new Set(targets.map((target) => eventStreamTargetKey(target))).size).toBe(targets.length)
    // Signed web has one control plane: the server's stream is the hosted one.
    expect(claxedoEventStreamTargets({ hostAggregate: true, serverUrl: "https://control.example.test", accountSigned: true, accountStream: true })).toEqual([
      { kind: "cp", url: new URL("https://control.example.test/api/cp/events"), transport: "server" },
    ])
  })

  // A scoped target with no workspace id does not fail loudly: on a loopback
  // placement `workspaceRuntimeId` returns undefined for it, and the open
  // silently becomes the daemon's own `?directory=` route — the same request
  // the aggregate already answers, delivering every frame of that workspace
  // twice. Only a non-loopback placement throws.
  test("every scoped target names a workspace, whatever the route and catalog", () => {
    type Catalog = NonNullable<Parameters<typeof claxedoEventStreamTargets>[0]["projects"]>
    const catalogs: Catalog[] = [
      [],
      [{ worktree: "/repo/local" }],
      [{ id: "5f1e4a2b-1c3d-4e5f-8a9b-0c1d2e3f4a5b", worktree: "/repo/local" }],
      [{ workspaces: { "": { workspaceId: "", kind: "local", directory: "/repo/local" } } }],
      [{ workspaces: { "/repo/local": { kind: "local", directory: "/repo/local" } } }],
      [{ workspaces: { "/repo/remote": { workspaceId: "ws_remote", kind: "cloud", directory: "/repo/remote" } } }],
      localProjects,
    ]
    const routes = [
      "/repo/local", "/repo/remote", "ws_remote", "ws_unknown", "workspace:ws_remote",
      "5f1e4a2b-1c3d-4e5f-8a9b-0c1d2e3f4a5b", "workspace:5f1e4a2b-1c3d-4e5f-8a9b-0c1d2e3f4a5b", "",
    ]
    const nameless: unknown[] = []
    for (const projects of catalogs) {
      for (const directory of routes) {
        for (const serverUrl of ["http://127.0.0.1:3001", "https://control.example.test"]) {
          for (const hostAggregate of [true, false, undefined]) {
            for (const target of claxedoEventStreamTargets({ serverUrl, directory, projects, hostAggregate, accountSigned: true })) {
              if (target.kind !== "wr" || target.scope === "host") continue
              if (!target.workspaceId) nameless.push({ directory, serverUrl, hostAggregate, target })
            }
          }
        }
      }
    }
    expect(nameless).toEqual([])
  })
})

describe("eventStreamFetch", () => {
  test("opens the workspace stream through the relay with the Runtime Access Token, unscoped by default", async () => {
    const seen: Array<{ url: string; auth: string | null; accept: string | null }> = []
    const request = fetchDouble(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input).url
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

    const target = {
      kind: "wr" as const,
      serverUrl: "https://control.example.test",
      workspaceId: "ws_events_relay",
      workspaceKind: "cloud" as const,
      sessionID: "session-events",
    }
    const res = await eventStreamFetch(target, { headers: { Accept: "text/event-stream" } }, { request, relayRequest: request })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe("https://relay.events.test/workspaces/ws_events_relay/api/wr/events")
    expect(seen[0].url).not.toContain("control.example.test")
    expect(seen[0].auth).toBe("Bearer rat_events")
    expect(seen[0].accept).toBe("text/event-stream")

    await eventStreamFetch(target, { headers: { Accept: "text/event-stream" } }, { request, relayRequest: request, scope: "session" })
    expect(seen[1].url).toBe("https://relay.events.test/workspaces/ws_events_relay/api/wr/events?sessionID=session-events")
  })

  test("fetches the cp stream directly (no relay)", async () => {
    let hit: string | undefined
    const request = fetchDouble(async (input) => {
      hit = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input).url
      return new Response("data: {\"type\":\"heartbeat\"}\n\n", { status: 200 })
    })

    await eventStreamFetch(
      { kind: "cp", url: new URL("https://control.example.test/api/cp/events"), transport: "server" },
      {},
      { request },
    )
    expect(hit).toBe("https://control.example.test/api/cp/events")
  })

  test("keeps the session scope on a scoped stream's replay reconnects", async () => {
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
      kind: "wr" as const,
      serverUrl: "https://control.example.test",
      workspaceId: "ws_reconnect",
      workspaceKind: "cloud" as const,
      sessionID: "session-reconnect",
    }

    await eventStreamFetch(target, { headers: { Accept: "text/event-stream" } }, { request, relayRequest: request, scope: "session" })
    await eventStreamFetch(target, {
      headers: { Accept: "text/event-stream", "Last-Event-ID": "19" },
    }, { request, relayRequest: request, scope: "session" })

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
        xdir: headers.get("x-claxedo-directory"),
      })
      return new Response("data: {\"type\":\"heartbeat\"}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    }

    const res = await eventStreamFetch(
      {
        kind: "wr",
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

  test("a desktop reads a cloud workspace's stream through its daemon's proxy, cursor forwarded, no browser relay mint", async () => {
    const seen: Array<{ url: string; auth: string | null; cursor: string | null }> = []
    const request: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      if (url.includes("/connection")) throw new Error(`unexpected relay connection mint: ${url}`)
      seen.push({ url, auth: headers.get("authorization"), cursor: headers.get("last-event-id") })
      return new Response("data: {\"type\":\"heartbeat\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const res = await eventStreamFetch(
      { kind: "wr", serverUrl: "http://127.0.0.1:3001", workspaceId: "ws_cloud", workspaceKind: "cloud" },
      { headers: { Accept: "text/event-stream", Authorization: "Bearer browser-token", "Last-Event-ID": "7" } },
      { request },
    )
    expect(res.status).toBe(200)
    expect(seen).toEqual([{ url: "http://127.0.0.1:3001/workspaces/ws_cloud/api/wr/events", auth: null, cursor: "7" }])
  })

  test("opens the host aggregate on the daemon itself, naming no workspace", async () => {
    const seen: Array<{ url: string; cursor: string | null }> = []
    const request = fetchDouble(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/connection")) throw new Error(`unexpected relay connection mint: ${url}`)
      seen.push({ url, cursor: new Headers(init?.headers).get("Last-Event-ID") })
      return new Response('data: {"type":"heartbeat"}\n\n', { status: 200 })
    })

    const res = await eventStreamFetch(
      { kind: "wr", scope: "host", serverUrl: "http://127.0.0.1:3001" },
      { headers: { Accept: "text/event-stream", "Last-Event-ID": "11" } },
      { request },
    )

    expect(res.status).toBe(200)
    expect(seen).toEqual([{ url: "http://127.0.0.1:3001/api/wr/events", cursor: "11" }])
  })

  test("the workspace events path is the runtime's one stream", () => {
    expect(WORKSPACE_EVENTS_PATH).toBe("/api/wr/events")
  })
})

describe("eventStreamFrameAddress", () => {
  // The producer only ever knows its own path. On a relay-backed workspace that
  // machine is not this one, so the frame has to be re-addressed to the form
  // every pane, rail section and session row of that workspace is keyed by.
  test("addresses a relay-backed workspace's frames by workspace", () => {
    for (const workspaceKind of ["user-hosted", "cloud"] as const) {
      const address = eventStreamFrameAddress({
        kind: "wr",
        serverUrl: "https://control.example",
        workspaceId: "ws_1",
        workspaceKind,
        directory: "/Users/owner/repo",
      })
      expect(address("/Users/owner/repo")).toBe("workspace:ws_1")
      expect(address("/some/other/path/the/host/reported")).toBe("workspace:ws_1")
    }
  })

  // A local workspace is served by this surface's own runtime over loopback, so
  // its path IS this machine's and every consumer is keyed by it.
  test("leaves a local workspace's own paths alone", () => {
    const address = eventStreamFrameAddress({
      kind: "wr",
      serverUrl: "http://127.0.0.1:3001",
      workspaceId: "ws_local",
      workspaceKind: "local",
      directory: "/repo/local",
    })
    expect(address("/repo/local")).toBe("/repo/local")
  })

  // The aggregate carries many runtimes, each stamping its own path — all of
  // them this machine's — so there is no one workspace to re-address them to.
  test("leaves every path the host aggregate delivers alone", () => {
    const address = eventStreamFrameAddress({ kind: "wr", scope: "host", serverUrl: "http://127.0.0.1:3001" })
    expect(address("/repo/one")).toBe("/repo/one")
    expect(address("/repo/two")).toBe("/repo/two")
  })

  test("leaves the cp stream alone", () => {
    const address = eventStreamFrameAddress({ kind: "cp", url: new URL("https://control.example/api/cp/events"), transport: "server" })
    expect(address("/repo/local")).toBe("/repo/local")
    expect(address("global")).toBe("global")
  })
})
