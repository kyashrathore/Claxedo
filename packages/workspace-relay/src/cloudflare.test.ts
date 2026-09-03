import { describe, expect, test } from "bun:test"
import { generateKeyPair } from "jose"
import { TUNNEL_PROTOCOL_VERSION } from "@claxedo/workspace-relay-protocol"
import { mintHostTunnelToken, mintRuntimeAccessToken, verifyRelayHostToken, type RuntimeAccessTokenClaims } from "./auth"
import { createWorkspaceRelayDirectory } from "./directory"
import {
  createWorkspaceRelayDurableObjectRoom,
  createWorkspaceRelayDurableObjectGateway,
  setWorkspaceRelayAppOrigins,
  setWorkspaceRelayAllowedOrigins,
  type WorkspaceRelayDurableObjectConnectWebSocket,
  workspaceRelayDurableObjectRoomName,
  workspaceRelayDurableObjectWorkspaceId,
  DEFAULT_RELAY_LOCATION_HINT,
  RELAY_LOCATION_HINTS,
  type WorkspaceRelaySocketAttachment,
  type WorkspaceRelayDurableObjectNamespace,
  type WorkspaceRelayDurableObjectSocketPair,
} from "./cloudflare"
import type { WorkspaceRelayTarget } from "./server"

function fakeNamespace() {
  const routed: Array<{ id: string; request: Request; options?: { locationHint?: string } }> = []
  const namespace: WorkspaceRelayDurableObjectNamespace = {
    idFromName: (name) => name,
    get: (id, options) => ({
      fetch: async (request) => {
        routed.push({ id: String(id), request, ...(options ? { options } : {}) })
        return Response.json({
          ok: true,
          room: String(id),
          path: new URL(request.url).pathname,
          upgrade: request.headers.get("upgrade"),
        })
      },
    }),
  }
  return { namespace, routed }
}

class FakeSocket {
  accepted = false
  readyState = 1
  closed: { code?: number; reason?: string } | undefined
  sent: Array<string | ArrayBuffer | Uint8Array> = []
  listeners = new Map<string, Array<(event?: { data?: unknown; code?: number; reason?: string }) => void>>()
  attachment: WorkspaceRelaySocketAttachment | undefined

  accept() {
    this.accepted = true
  }

  send(message: string | ArrayBuffer | Uint8Array) {
    this.sent.push(message)
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event?: { data?: unknown; code?: number; reason?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason }
    this.dispatch("close", { code, reason })
  }

  serializeAttachment(attachment: WorkspaceRelaySocketAttachment) {
    this.attachment = attachment
  }

  deserializeAttachment() {
    return this.attachment
  }

  dispatch(type: "open" | "close" | "error", event?: { code?: number; reason?: string }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  message(data: unknown) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data })
  }
}

class SilentCloseSocket extends FakeSocket {
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
  }
}

async function roomHarness(input: {
  resolveTarget?: "cloud" | "user-hosted" | ((claims: RuntimeAccessTokenClaims) => WorkspaceRelayTarget | undefined | Promise<WorkspaceRelayTarget | undefined>)
  fetch?: typeof fetch
  connectWebSocket?: WorkspaceRelayDurableObjectConnectWebSocket
  forwardTimeoutMs?: number
  now?: () => number
  upstreamWebSocketPreOpenQueueMaxFrames?: number
  upstreamWebSocketPreOpenQueueMaxBytes?: number
  createServerSocket?: () => FakeSocket
  tunnelPendingHttpCap?: number
  tunnelStartedStreamCap?: number
  tunnelChannelCap?: number
  tunnelRequestBodyMaxBytes?: number
  tunnelResponseBodyMaxBytes?: number
  slowConsumerHighWaterMarkBytes?: number
  slowConsumerTimeoutMs?: number
  runtimeAccessTokenActiveCheckIntervalMs?: number
  workspaceTargetActiveCheckIntervalMs?: number
  isRuntimeAccessTokenActive?: (claims: RuntimeAccessTokenClaims) => { active: true } | { active: false; code: string; reason: string } | Promise<{ active: true } | { active: false; code: string; reason: string }>
  resolverOutageGraceAttempts?: number
  hibernatedRevocationCheckIntervalMs?: number
  alarms?: {
    getAlarm: () => Promise<number | null> | number | null
    setAlarm: (scheduledTime: number) => Promise<void> | void
    deleteAlarm?: () => Promise<void> | void
  }
  hibernation?: boolean
  hibernatedSockets?: FakeSocket[]
  traceSampleRate?: number
  traceForceHeaderSecret?: string
  traceLog?: (event: {
    traceId: string
    routeKind: string
    status: number
    phases: Record<string, number>
  }) => void
} = {}) {
  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  const pairs: WorkspaceRelayDurableObjectSocketPair[] = []
  const hibernatedSockets: FakeSocket[] = input.hibernatedSockets ?? []
  const directory = createWorkspaceRelayDirectory({ sweepIntervalMs: 0, ...(input.now ? { now: input.now } : {}) })
  const room = createWorkspaceRelayDurableObjectRoom({
    runtimeAccessKey: runtime.publicKey,
    relayHostSigningKey: relayHost.privateKey,
    relayHostAlgorithm: "EdDSA",
    resolveTarget: async (claims) => typeof input.resolveTarget === "function"
      ? await input.resolveTarget(claims)
      : {
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "https://runtime.test",
          ...(input.resolveTarget === "user-hosted"
            ? { access: "user-hosted" as const, backing: "local-worktree" as const }
            : { access: "cloud" as const, backing: "cloud-vm" as const }),
        },
    directory,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.connectWebSocket ? { connectWebSocket: input.connectWebSocket } : {}),
    ...(input.forwardTimeoutMs !== undefined ? { forwardTimeoutMs: input.forwardTimeoutMs } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.upstreamWebSocketPreOpenQueueMaxFrames !== undefined ? { upstreamWebSocketPreOpenQueueMaxFrames: input.upstreamWebSocketPreOpenQueueMaxFrames } : {}),
    ...(input.upstreamWebSocketPreOpenQueueMaxBytes !== undefined ? { upstreamWebSocketPreOpenQueueMaxBytes: input.upstreamWebSocketPreOpenQueueMaxBytes } : {}),
    ...(input.tunnelPendingHttpCap !== undefined ? { tunnelPendingHttpCap: input.tunnelPendingHttpCap } : {}),
    ...(input.tunnelStartedStreamCap !== undefined ? { tunnelStartedStreamCap: input.tunnelStartedStreamCap } : {}),
    ...(input.tunnelChannelCap !== undefined ? { tunnelChannelCap: input.tunnelChannelCap } : {}),
    ...(input.tunnelRequestBodyMaxBytes !== undefined ? { tunnelRequestBodyMaxBytes: input.tunnelRequestBodyMaxBytes } : {}),
    ...(input.tunnelResponseBodyMaxBytes !== undefined ? { tunnelResponseBodyMaxBytes: input.tunnelResponseBodyMaxBytes } : {}),
    ...(input.slowConsumerHighWaterMarkBytes !== undefined ? { slowConsumerHighWaterMarkBytes: input.slowConsumerHighWaterMarkBytes } : {}),
    ...(input.slowConsumerTimeoutMs !== undefined ? { slowConsumerTimeoutMs: input.slowConsumerTimeoutMs } : {}),
    ...(input.runtimeAccessTokenActiveCheckIntervalMs !== undefined ? { runtimeAccessTokenActiveCheckIntervalMs: input.runtimeAccessTokenActiveCheckIntervalMs } : {}),
    ...(input.workspaceTargetActiveCheckIntervalMs !== undefined ? { workspaceTargetActiveCheckIntervalMs: input.workspaceTargetActiveCheckIntervalMs } : {}),
    ...(input.isRuntimeAccessTokenActive ? { isRuntimeAccessTokenActive: input.isRuntimeAccessTokenActive } : {}),
    ...(input.resolverOutageGraceAttempts !== undefined ? { resolverOutageGraceAttempts: input.resolverOutageGraceAttempts } : {}),
    ...(input.hibernatedRevocationCheckIntervalMs !== undefined ? { hibernatedRevocationCheckIntervalMs: input.hibernatedRevocationCheckIntervalMs } : {}),
    ...(input.alarms ? { alarms: input.alarms } : {}),
    ...(input.traceSampleRate !== undefined ? { traceSampleRate: input.traceSampleRate } : {}),
    ...(input.traceForceHeaderSecret !== undefined ? { traceForceHeaderSecret: input.traceForceHeaderSecret } : {}),
    ...(input.traceLog ? { traceLog: input.traceLog } : {}),
    ...(input.hibernation ? {
      hibernation: {
        acceptWebSocket: (socket) => hibernatedSockets.push(socket as FakeSocket),
        getWebSockets: () => hibernatedSockets.filter((socket) => !socket.closed),
      },
    } : {}),
    createWebSocketPair: () => {
      const pair = {
        client: new FakeSocket(),
        server: input.createServerSocket ? input.createServerSocket() : new FakeSocket(),
      }
      pairs.push(pair)
      return pair
    },
  })
  return {
    room,
    pairs,
    hibernatedSockets,
    directory,
    relayHost,
    hostTunnelToken: (workspaceIds = ["ws_1"]) => mintHostTunnelToken({
      subject: "host_1",
      hostId: "host_1",
      workspaceIds,
    }, runtime.privateKey, "EdDSA"),
    runtimeAccessToken: () => mintRuntimeAccessToken({
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA"),
  }
}

async function waitForSent(socket: FakeSocket, count: number) {
  for (let i = 0; i < 20; i++) {
    if (socket.sent.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function waitForClosed(socket: FakeSocket) {
  for (let i = 0; i < 20; i++) {
    if (socket.closed) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe("workspace relay Cloudflare Durable Object gateway", () => {
  test("uses stable workspace room names", () => {
    expect(workspaceRelayDurableObjectRoomName("ws_1")).toBe("workspace:ws_1")
  })

  test("extracts workspace ids from workspace and host tunnel relay routes", () => {
    expect(workspaceRelayDurableObjectWorkspaceId(new Request("https://relay.test/workspaces/ws_1/api/wr/health"))).toBe("ws_1")
    expect(workspaceRelayDurableObjectWorkspaceId(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_2"))).toBe("ws_2")
    expect(workspaceRelayDurableObjectWorkspaceId(new Request("https://relay.test/host-tunnels/host_1?workspace_id=ws_3"))).toBe("ws_3")
    expect(workspaceRelayDurableObjectWorkspaceId(new Request("https://relay.test/metrics"))).toBeUndefined()
  })

  test("routes workspace requests to the Durable Object room for that workspace", async () => {
    const { namespace, routed } = fakeNamespace()
    const gateway = createWorkspaceRelayDurableObjectGateway({ namespace })
    const res = await gateway.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health"))

    expect(res.status).toBe(200)
    expect(res.headers.get("x-claxedo-relay-location-hint")).toBe("apac")
    // Gateway timing is only appended when the room emitted its own
    // server-timing (i.e. the trace was sampled); plain responses stay clean.
    expect(res.headers.get("server-timing")).toBeNull()
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      room: "workspace:ws_1",
      path: "/workspaces/ws_1/api/wr/health",
    })
    expect(routed.map((item) => item.id)).toEqual(["workspace:ws_1"])
    expect(routed[0]?.options?.locationHint).toBe("apac")
  })

  test("appends gateway timing only when the room emitted sampled server-timing", async () => {
    const namespace: WorkspaceRelayDurableObjectNamespace = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => new Response("room-ok", {
          headers: { "server-timing": "relay-room;dur=1.5" },
        }),
      }),
    }
    const gateway = createWorkspaceRelayDurableObjectGateway({ namespace })
    const res = await gateway.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health"))

    expect(res.status).toBe(200)
    expect(res.headers.get("server-timing")).toContain("relay-room;dur=1.5")
    expect(res.headers.get("server-timing")).toContain("relay-gateway-route;dur=")
    expect(res.headers.get("server-timing")).toContain("relay-gateway;dur=")
  })

  test("uses deployment relay location hint for Durable Object routing", async () => {
    const { namespace, routed } = fakeNamespace()
    const gateway = createWorkspaceRelayDurableObjectGateway({ namespace })
    const res = await gateway.fetch(
      new Request("https://relay.test/workspaces/ws_1/api/wr/health"),
      { CLAXEDO_RELAY_LOCATION_HINT: "wnam" },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("x-claxedo-relay-location-hint")).toBe("wnam")
    expect(routed[0]?.options?.locationHint).toBe("wnam")
  })

  test("answers browser preflight for Claxedo app relay requests before auth", async () => {
    const gateway = createWorkspaceRelayDurableObjectGateway()
    const res = await gateway.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.claxedo.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    }))

    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.claxedo.com")
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization")
    expect(res.headers.get("access-control-allow-headers")).toContain("Last-Event-ID")
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Fetch-Bypass-Throttle")
  })

  test("allows deployment-configured app origins (exact and suffix) and still denies unknown ones", async () => {
    setWorkspaceRelayAppOrigins("https://claxedo-app-staging.pages.dev, https://*.claxedo-app-staging.pages.dev")
    try {
      const gateway = createWorkspaceRelayDurableObjectGateway()
      const preflight = (origin: string) => gateway.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }))

      const exact = await preflight("https://claxedo-app-staging.pages.dev")
      expect(exact.status).toBe(204)
      expect(exact.headers.get("access-control-allow-origin")).toBe("https://claxedo-app-staging.pages.dev")

      const preview = await preflight("https://bb9ffc1f.claxedo-app-staging.pages.dev")
      expect(preview.status).toBe(204)

      const unknown = await preflight("https://evil.pages.dev")
      expect(unknown.status).toBe(403)
      const insecure = await preflight("http://claxedo-app-staging.pages.dev")
      expect(insecure.status).toBe(403)
    } finally {
      setWorkspaceRelayAppOrigins(undefined)
    }
  })

  test("replacement allowed-origins list drops the built-in product origins", async () => {
    setWorkspaceRelayAllowedOrigins("https://selfhost.example.com, http://localhost:*")
    try {
      const gateway = createWorkspaceRelayDurableObjectGateway()
      const preflight = (origin: string) => gateway.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }))

      const selfhost = await preflight("https://selfhost.example.com")
      expect(selfhost.status).toBe(204)
      expect(selfhost.headers.get("access-control-allow-origin")).toBe("https://selfhost.example.com")

      const localhost = await preflight("http://localhost:5173")
      expect(localhost.status).toBe(204)

      // The default product origins are REPLACED, not merely extended.
      const product = await preflight("https://app.claxedo.com")
      expect(product.status).toBe(403)
      const upstreamProduct = await preflight("https://opencode.ai")
      expect(upstreamProduct.status).toBe(403)
    } finally {
      setWorkspaceRelayAllowedOrigins(undefined)
    }
  })

  test("routes host tunnel upgrades to the same workspace room as browser clients", async () => {
    const { namespace, routed } = fakeNamespace()
    const gateway = createWorkspaceRelayDurableObjectGateway({ namespace })
    const res = await gateway.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: "Bearer htt_1",
      },
    }))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      room: "workspace:ws_1",
      path: "/host-tunnels/host_1",
      upgrade: "websocket",
    })
    expect(routed[0]?.request.headers.get("authorization")).toBe("Bearer htt_1")
  })

  test("fails closed when the Durable Object binding is missing", async () => {
    const gateway = createWorkspaceRelayDurableObjectGateway()
    const res = await gateway.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health"))

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "relay_durable_object_unconfigured",
        message: "Workspace Relay Durable Object binding is not configured",
      },
    })
  })

  test("rejects host tunnel routes that do not name a workspace room", async () => {
    const { namespace } = fakeNamespace()
    const gateway = createWorkspaceRelayDurableObjectGateway({ namespace })
    const res = await gateway.fetch(new Request("https://relay.test/host-tunnels/host_1", {
      headers: { upgrade: "websocket" },
    }))

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "relay_workspace_required",
        message: "Workspace Relay requests must include a workspace id",
      },
    })
  })

  test("rejects host tunnel upgrades that name more than one workspace", async () => {
    const { namespace, routed } = fakeNamespace()
    const gateway = createWorkspaceRelayDurableObjectGateway({ namespace })
    const res = await gateway.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1&workspaceId=ws_2", {
      headers: {
        upgrade: "websocket",
        authorization: "Bearer htt_1",
      },
    }))

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "host_tunnel_single_workspace_required",
      },
    })
    expect(routed).toHaveLength(0)
  })

  test("routes host tunnel upgrades that repeat the same workspace id", async () => {
    const { namespace, routed } = fakeNamespace()
    const gateway = createWorkspaceRelayDurableObjectGateway({ namespace })
    const res = await gateway.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1&workspace_id=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: "Bearer htt_1",
      },
    }))

    expect(res.status).toBe(200)
    expect(routed.map((item) => item.id)).toEqual(["workspace:ws_1"])
  })

  test("serves health without requiring the Durable Object binding", async () => {
    const gateway = createWorkspaceRelayDurableObjectGateway()
    const res = await gateway.fetch(new Request("https://relay.test/health"))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: "workspace-relay",
      mode: "cloudflare-durable-object",
    })
  })
})

describe("workspace relay Cloudflare Durable Object room", () => {
  test("reports unhealthy and rejects new relay traffic while draining", async () => {
    const harness = await roomHarness()
    const healthy = await harness.room.fetch(new Request("https://relay.test/health"))
    expect(healthy.status).toBe(200)
    await expect(healthy.json()).resolves.toMatchObject({ ok: true, draining: false })

    harness.room.drain.setDraining(true)
    const draining = await harness.room.fetch(new Request("https://relay.test/health"))
    expect(draining.status).toBe(503)
    await expect(draining.json()).resolves.toMatchObject({ ok: false, draining: true })

    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health"))
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "relay_draining",
      },
    })
  })

  test("admits a signed host tunnel WebSocket and records room-local presence", async () => {
    const harness = await roomHarness()
    const res = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    expect(res.status).toBe(101)
    expect((harness.pairs[0]?.server as FakeSocket | undefined)?.accepted).toBe(true)
    expect(harness.room.state()).toMatchObject({
      hostTunnelCount: 1,
      clientCount: 0,
      hostIds: ["host_1"],
    })

    ;(harness.pairs[0]?.server as FakeSocket).dispatch("close")
    expect(harness.room.state()).toMatchObject({
      hostTunnelCount: 0,
      hostIds: [],
    })
  })

  test("rejects host tunnel admission when the room workspace is not in the signed token target set", async () => {
    const harness = await roomHarness()
    const res = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken(["ws_2"])}`,
      },
    }))

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "relay_token_workspace_mismatch",
      },
    })
    expect(harness.pairs).toHaveLength(0)
  })

  test("ignores malformed host tunnel messages without dropping presence", async () => {
    const harness = await roomHarness()
    const res = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    expect(res.status).toBe(101)
    ;(harness.pairs[0]?.server as FakeSocket).message("{")
    expect(harness.room.state()).toMatchObject({
      hostTunnelCount: 1,
      hostIds: ["host_1"],
    })
  })

  test("updates a host registration on the existing socket after re-authorizing the workspace set", async () => {
    const harness = await roomHarness()
    const response = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken(["ws_1"])}`,
      },
    }))
    expect(response.status).toBe(101)

    ;(harness.pairs[0]?.server as FakeSocket).message(JSON.stringify({
      type: "host.registration.update",
      protocol: 1,
      workspace_ids: ["ws_1", "ws_2"],
      token: await harness.hostTunnelToken(["ws_1", "ws_2"]),
    }))

    // The fake socket dispatches the async token verification without awaiting
    // its listener. Wait for the canonical room state, just as the Bun socket
    // integration test below waits for directory presence, instead of assuming
    // one macrotask is enough for WebCrypto on every CI host.
    const deadline = Date.now() + 1_000
    while (!harness.room.state().hostWorkspaceIds.host_1?.includes("ws_2") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(harness.room.state()).toMatchObject({
      hostTunnelCount: 1,
      hostWorkspaceIds: { host_1: ["ws_1", "ws_2"] },
    })
  })

  test("admits a cloud workspace client WebSocket after Runtime Access Token authorization", async () => {
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))

    expect(res.status).toBe(101)
    expect((harness.pairs[0]?.server as FakeSocket | undefined)?.accepted).toBe(true)
    expect(harness.room.state()).toMatchObject({
      hostTunnelCount: 0,
      clientCount: 1,
    })

    ;(harness.pairs[0]?.server as FakeSocket).dispatch("close")
    expect(harness.room.state()).toMatchObject({ clientCount: 0 })
  })

  test("closes active host tunnels and clients when draining starts", async () => {
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
    })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))

    harness.room.drain.setDraining(true)

    expect((harness.pairs[0]?.server as FakeSocket).closed).toEqual({
      code: 1012,
      reason: "Workspace relay is draining",
    })
    expect((harness.pairs[1]?.server as FakeSocket).closed).toEqual({
      code: 1012,
      reason: "Workspace relay is draining",
    })
  })

  test("bridges cloud workspace WebSocket frames to the runtime upstream", async () => {
    const upstreams: Array<{ url: string; headers: Record<string, string>; socket: FakeSocket }> = []
    const harness = await roomHarness({
      connectWebSocket: (url, init) => {
        const socket = new FakeSocket()
        upstreams.push({ url, headers: init.headers, socket })
        return socket
      },
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect?tab=1", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `claxedo-rat.${await harness.runtimeAccessToken()}`,
      },
    }))

    expect(res.status).toBe(101)
    expect(upstreams).toHaveLength(1)
    expect(upstreams[0]?.url).toBe("https://runtime.test/api/claxedo/pty/pty_1/connect?tab=1")
    expect(upstreams[0]?.headers.authorization).toStartWith("Bearer ")
    expect(upstreams[0]?.headers["sec-websocket-protocol"]).toBeUndefined()
    const clientSocket = harness.pairs[0]?.server as FakeSocket
    const upstreamSocket = upstreams[0]!.socket

    upstreamSocket.message("from-upstream")
    expect(clientSocket.sent).toEqual(["from-upstream"])

    clientSocket.message(new Uint8Array([1, 2, 3]))
    expect(upstreamSocket.sent).toEqual([new Uint8Array([1, 2, 3])])

    upstreamSocket.close(1000, "done")
    expect(clientSocket.closed).toEqual({ code: 1000, reason: "done" })
  })

  test("emits a relay.trace frame on the cloud WebSocket when the trace header opts in", async () => {
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        "x-claxedo-relay-ws-trace": "1",
      },
    }))
    expect(res.status).toBe(101)
    const clientSocket = harness.pairs[0]?.server as FakeSocket
    const first = clientSocket.sent[0]
    expect(typeof first).toBe("string")
    const trace = JSON.parse(first as string) as {
      type: string
      wsUpstreamOpenMs: number
      queuedFrames: number
      maxQueuedDelayMs: number
    }
    expect(trace.type).toBe("relay.trace")
    expect(typeof trace.wsUpstreamOpenMs).toBe("number")
    expect(trace.queuedFrames).toBe(0)
    expect(trace.maxQueuedDelayMs).toBe(0)
  })

  test("does not emit a relay.trace frame without the trace header", async () => {
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(101)
    const clientSocket = harness.pairs[0]?.server as FakeSocket
    expect(clientSocket.sent).toHaveLength(0)
  })

  test("relay.trace reports queued frames when the upstream opens after admit", async () => {
    const connecting = new FakeSocket()
    connecting.readyState = 0
    const harness = await roomHarness({
      connectWebSocket: () => connecting,
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        "x-claxedo-relay-ws-trace": "1",
      },
    }))
    expect(res.status).toBe(101)
    const clientSocket = harness.pairs[0]?.server as FakeSocket
    // Upstream is still connecting, so no trace has been emitted yet and
    // client frames queue behind the pending upstream open.
    expect(clientSocket.sent).toHaveLength(0)
    clientSocket.message("frame-1")
    clientSocket.message("frame-2")
    connecting.dispatch("open")
    const trace = JSON.parse(clientSocket.sent[0] as string) as {
      type: string
      queuedFrames: number
    }
    expect(trace.type).toBe("relay.trace")
    expect(trace.queuedFrames).toBe(2)
    // Queued frames flush to the upstream once it opens.
    expect(connecting.sent).toEqual(["frame-1", "frame-2"])
  })

  test("closes active cloud WebSocket clients when the Runtime Access Token is revoked", async () => {
    let revoked = false
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
      runtimeAccessTokenActiveCheckIntervalMs: 1,
      isRuntimeAccessTokenActive: () => revoked
        ? { active: false, code: "runtime_access_token_revoked", reason: "Runtime Access Token has been revoked" }
        : { active: true },
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(101)
    const clientSocket = harness.pairs[0]?.server as FakeSocket

    revoked = true
    await waitForClosed(clientSocket)

    expect(clientSocket.closed).toEqual({
      code: 1008,
      reason: "Runtime Access Token has been revoked",
    })
  })

  test("fails closed when the cloud runtime WebSocket upstream cannot connect", async () => {
    const harness = await roomHarness({
      connectWebSocket: () => {
        throw new Error("runtime down")
      },
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "upstream_unavailable",
      },
    })
    expect(harness.pairs).toHaveLength(0)
  })

  test("forwards cloud HTTP requests with a freshly minted Relay Host Token", async () => {
    const forwarded: Array<{ url: string; request: Request }> = []
    const harness = await roomHarness({
      fetch: ((url, init) => {
        forwarded.push({ url: String(url), request: new Request(url, init) })
        return Promise.resolve(new Response("cloud-ok", {
          status: 202,
          headers: {
            "content-type": "text/plain",
          },
        }))
      }) as typeof fetch,
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health?verbose=1", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        "x-forwarded-for": "203.0.113.1",
      },
    }))

    expect(res.status).toBe(202)
    await expect(res.text()).resolves.toBe("cloud-ok")
    expect(forwarded[0]?.url).toBe("https://runtime.test/api/wr/health?verbose=1")
    expect(forwarded[0]?.request.headers.get("x-forwarded-for")).toBeNull()
    expect(forwarded[0]?.request.headers.get("x-workspace-id")).toBe("ws_1")
    const relayHostToken = forwarded[0]?.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    expect(relayHostToken).toBeTruthy()
    await expect(verifyRelayHostToken(relayHostToken!, harness.relayHost.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).resolves.toMatchObject({
      access: "cloud",
      backing: "cloud-vm",
      role: "editor",
    })
  })

  test("propagates relay trace ids and reports HTTP phase timings", async () => {
    const forwarded: Array<{ request: Request }> = []
    const logs: Array<{
      traceId: string
      routeKind: string
      status: number
      phases: Record<string, number>
    }> = []
    const harness = await roomHarness({
      traceSampleRate: 1,
      traceLog: (event) => logs.push(event),
      fetch: ((url, init) => {
        forwarded.push({ request: new Request(url, init) })
        return Promise.resolve(new Response("cloud-ok"))
      }) as typeof fetch,
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        "x-claxedo-trace-id": "trace_test_1",
      },
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get("x-claxedo-trace-id")).toBe("trace_test_1")
    expect(res.headers.get("server-timing")).toContain("relay-auth;dur=")
    expect(res.headers.get("server-timing")).toContain("upstream-fetch;dur=")
    expect(res.headers.get("server-timing")).toContain("relay-room-total;dur=")
    expect(forwarded[0]?.request.headers.get("x-claxedo-trace-id")).toBe("trace_test_1")
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      traceId: "trace_test_1",
      routeKind: "cloud-http",
      status: 200,
    })
    expect(logs[0]?.phases["relay-auth"]).toBeNumber()
    expect(logs[0]?.phases["upstream-fetch"]).toBeNumber()
    expect(logs[0]?.phases["relay-room-total"]).toBeNumber()
  })

  test("omits server-timing and trace logs for unsampled requests", async () => {
    const logs: unknown[] = []
    const harness = await roomHarness({
      traceSampleRate: 0,
      traceLog: (event) => logs.push(event),
      fetch: (() => Promise.resolve(new Response("cloud-ok"))) as unknown as typeof fetch,
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: `Bearer ${await harness.runtimeAccessToken()}` },
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get("x-claxedo-trace-id")).toBeTruthy()
    expect(res.headers.get("server-timing")).toBeNull()
    expect(logs).toHaveLength(0)
  })

  test("ignores the trace force header when no force secret is configured", async () => {
    const logs: unknown[] = []
    const harness = await roomHarness({
      traceSampleRate: 0,
      traceLog: (event) => logs.push(event),
      fetch: (() => Promise.resolve(new Response("cloud-ok"))) as unknown as typeof fetch,
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        "x-claxedo-relay-trace": "1",
      },
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get("server-timing")).toBeNull()
    expect(logs).toHaveLength(0)
  })

  test("honors the trace force header only with the matching operator secret", async () => {
    const logs: unknown[] = []
    const forwarded: Array<{ request: Request }> = []
    const harness = await roomHarness({
      traceSampleRate: 0,
      traceForceHeaderSecret: "operator-secret",
      traceLog: (event) => logs.push(event),
      fetch: ((url, init) => {
        forwarded.push({ request: new Request(url, init) })
        return Promise.resolve(new Response("cloud-ok"))
      }) as typeof fetch,
    })

    const wrongSecret = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        "x-claxedo-relay-trace": "1",
        "x-claxedo-trace-sampled": "1",
      },
    }))
    expect(wrongSecret.headers.get("server-timing")).toBeNull()
    expect(logs).toHaveLength(0)
    // A client-spoofed sampled marker must not reach the upstream runtime.
    expect(forwarded[0]?.request.headers.get("x-claxedo-trace-sampled")).toBeNull()

    const rightSecret = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        "x-claxedo-relay-trace": "operator-secret",
      },
    }))
    expect(rightSecret.headers.get("server-timing")).toContain("relay-room-total;dur=")
    expect(logs).toHaveLength(1)
    expect(forwarded[1]?.request.headers.get("x-claxedo-trace-sampled")).toBe("1")
  })

  test("adds CORS headers to browser-origin cloud HTTP responses", async () => {
    const harness = await roomHarness({
      fetch: (() => Promise.resolve(new Response("cloud-ok"))) as unknown as typeof fetch,
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        origin: "https://app.claxedo.com",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))

    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.claxedo.com")
    await expect(res.text()).resolves.toBe("cloud-ok")
  })

  test("maps cloud HTTP upstream failures to a fail-closed response", async () => {
    const harness = await roomHarness({
      fetch: (() => {
        throw new Error("runtime down")
      }) as unknown as typeof fetch,
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "upstream_unavailable",
      },
    })
  })

  test("admits a user-hosted client only after the matching host tunnel is present in the room", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    const offline = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(offline.status).toBe(503)
    await expect(offline.json()).resolves.toMatchObject({
      error: {
        code: "user_hosted_app_offline",
      },
    })

    const host = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    expect(host.status).toBe(101)

    const online = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(online.status).toBe(101)
    expect(harness.room.state()).toMatchObject({
      hostTunnelCount: 1,
      clientCount: 1,
    })
  })

  test("round-trips user-hosted WebSocket frames over the admitted host tunnel", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `claxedo-rat.${await harness.runtimeAccessToken()}`,
        cookie: "private=yes",
      },
    }))
    expect(res.status).toBe(101)
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    const clientSocket = harness.pairs[1]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const open = JSON.parse(String(hostSocket.sent[0])) as {
      channel_id: string
      headers: Record<string, string>
    }

    expect(open).toMatchObject({
      type: "ws.open",
      protocol: TUNNEL_PROTOCOL_VERSION,
      workspace_id: "ws_1",
      path: "/api/claxedo/pty/pty_1/connect",
    })
    expect(open.headers.cookie).toBeUndefined()
    expect(open.headers["sec-websocket-protocol"]).toBeUndefined()
    expect(open.headers.authorization).toStartWith("Bearer ")

    hostSocket.message(JSON.stringify({
      type: "ws.frame",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: open.channel_id,
      binary: false,
      data_base64: btoa("from-host"),
    }))
    await waitForSent(clientSocket, 1)
    expect(clientSocket.sent).toEqual(["from-host"])

    clientSocket.message("from-client")
    await waitForSent(hostSocket, 2)
    await expect(Promise.resolve(JSON.parse(String(hostSocket.sent[1])) as {
      type: string
      binary: boolean
      data_base64: string
    })).resolves.toMatchObject({
      type: "ws.frame",
      binary: false,
      data_base64: btoa("from-client"),
    })
  })

  test("accepts user-hosted sockets with Durable Object hibernation attachments", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted", hibernation: true })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))

    const hostSocket = harness.pairs[0]?.server as FakeSocket
    const clientSocket = harness.pairs[1]?.server as FakeSocket
    expect(hostSocket.accepted).toBe(false)
    expect(clientSocket.accepted).toBe(false)
    expect(harness.hibernatedSockets).toEqual([hostSocket, clientSocket])
    expect(hostSocket.attachment).toMatchObject({
      kind: "host-tunnel",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
    })
    expect(clientSocket.attachment).toMatchObject({
      kind: "user-hosted-client",
      target: {
        workspaceId: "ws_1",
        hostId: "host_1",
        access: "user-hosted",
      },
      path: "/api/claxedo/pty/pty_1/connect",
    })
  })

  test("rebuilds hibernated user-hosted sockets and routes messages after wake", async () => {
    const first = await roomHarness({ resolveTarget: "user-hosted", hibernation: true })
    await first.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await first.hostTunnelToken()}`,
      },
    }))
    await first.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await first.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = first.pairs[0]?.server as FakeSocket
    const clientSocket = first.pairs[1]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const open = JSON.parse(String(hostSocket.sent[0])) as { channel_id: string }
    hostSocket.sent.length = 0

    const second = await roomHarness({
      resolveTarget: "user-hosted",
      hibernation: true,
      hibernatedSockets: first.hibernatedSockets,
    })
    expect(second.room.state()).toMatchObject({
      hostTunnelCount: 1,
      clientCount: 1,
    })

    await second.room.webSocketMessage(clientSocket, "from-client-after-wake")
    await waitForSent(hostSocket, 1)
    expect(JSON.parse(String(hostSocket.sent[0]))).toMatchObject({
      type: "ws.frame",
      channel_id: open.channel_id,
      data_base64: btoa("from-client-after-wake"),
    })

    await second.room.webSocketMessage(hostSocket, JSON.stringify({
      type: "ws.frame",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: open.channel_id,
      binary: false,
      data_base64: btoa("from-host-after-wake"),
    }))
    expect(clientSocket.sent).toEqual(["from-host-after-wake"])
  })

  test("clamps invalid user-hosted WebSocket close codes from the host tunnel", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(101)
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    const clientSocket = harness.pairs[1]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const open = JSON.parse(String(hostSocket.sent[0])) as { channel_id: string }

    hostSocket.message(JSON.stringify({
      type: "ws.close",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: open.channel_id,
      code: 1005,
      reason: "reserved host close",
    }))

    expect(clientSocket.closed).toEqual({
      code: 1011,
      reason: "reserved host close",
    })
  })

  test("closes active user-hosted WebSocket clients when the Runtime Access Token is revoked", async () => {
    let revoked = false
    const harness = await roomHarness({
      resolveTarget: "user-hosted",
      runtimeAccessTokenActiveCheckIntervalMs: 1,
      isRuntimeAccessTokenActive: () => revoked
        ? { active: false, code: "runtime_access_token_revoked", reason: "Runtime Access Token has been revoked" }
        : { active: true },
    })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(101)
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    const clientSocket = harness.pairs[1]?.server as FakeSocket
    await waitForSent(hostSocket, 1)

    revoked = true
    await waitForClosed(clientSocket)
    await waitForSent(hostSocket, 2)

    expect(clientSocket.closed).toEqual({
      code: 1008,
      reason: "Runtime Access Token has been revoked",
    })
    expect(JSON.parse(String(hostSocket.sent[1]))).toMatchObject({
      type: "ws.close",
      protocol: TUNNEL_PROTOCOL_VERSION,
      code: 1008,
      reason: "Runtime Access Token has been revoked",
    })
  })

  test("closes active user-hosted WebSocket clients when the target resolver stops returning the host", async () => {
    let targetActive = true
    const harness = await roomHarness({
      resolveTarget: (claims) => targetActive
        ? {
            workspaceId: claims.workspace_id,
            hostId: claims.host_id,
            baseUrl: "https://runtime.test",
            access: "user-hosted",
            backing: "local-worktree",
          }
        : undefined,
      workspaceTargetActiveCheckIntervalMs: 1,
    })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(101)
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    const clientSocket = harness.pairs[1]?.server as FakeSocket
    await waitForSent(hostSocket, 1)

    targetActive = false
    await waitForClosed(clientSocket)
    await waitForSent(hostSocket, 2)

    expect(clientSocket.closed).toEqual({
      code: 1011,
      reason: "User-hosted workspace is offline",
    })
    expect(JSON.parse(String(hostSocket.sent[1]))).toMatchObject({
      type: "ws.close",
      protocol: TUNNEL_PROTOCOL_VERSION,
      code: 1011,
      reason: "User-hosted workspace is offline",
    })
  })

  test("closes active user-hosted WebSocket clients when directory presence disappears", async () => {
    const harness = await roomHarness({
      resolveTarget: "user-hosted",
      workspaceTargetActiveCheckIntervalMs: 1,
    })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(101)
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    const clientSocket = harness.pairs[1]?.server as FakeSocket
    await waitForSent(hostSocket, 1)

    harness.directory.disconnectHost("host_1")
    await waitForClosed(clientSocket)
    await waitForSent(hostSocket, 2)

    expect(clientSocket.closed).toEqual({
      code: 1011,
      reason: "User-hosted workspace is offline",
    })
    expect(JSON.parse(String(hostSocket.sent[1]))).toMatchObject({
      type: "ws.close",
      protocol: TUNNEL_PROTOCOL_VERSION,
      code: 1011,
      reason: "User-hosted workspace is offline",
    })
  })

  test("rejects user-hosted WebSocket clients after the room channel cap", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted", tunnelChannelCap: 1 })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const first = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const second = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_2/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))

    expect(first.status).toBe(101)
    expect(second.status).toBe(503)
    await expect(second.json()).resolves.toMatchObject({
      error: {
        code: "too_many_channels",
      },
    })
  })

  test("forwards user-hosted HTTP requests over the admitted host tunnel", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    const host = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    expect(host.status).toBe(101)

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health?verbose=1", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        cookie: "private=yes",
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    expect(hostSocket.sent).toHaveLength(1)
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as {
      request_id: string
      type: string
      path: string
      headers: Record<string, string>
    }
    expect(requestMessage).toMatchObject({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      workspace_id: "ws_1",
      method: "GET",
      path: "/api/wr/health?verbose=1",
      end: true,
    })
    expect(requestMessage.headers.cookie).toBeUndefined()
    expect(requestMessage.headers.authorization).toStartWith("Bearer ")

    hostSocket.message(JSON.stringify({
      type: "http.response.start",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      status: 203,
      headers: {
        "content-type": "text/plain",
      },
    }))
    hostSocket.message(JSON.stringify({
      type: "http.response.chunk",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      body_base64: btoa("user-hosted-ok"),
    }))
    hostSocket.message(JSON.stringify({
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
    }))

    const res = await pending
    expect(res.status).toBe(203)
    expect(res.headers.get("content-type")).toBe("text/plain")
    await expect(res.text()).resolves.toBe("user-hosted-ok")
  })

  test("returns user-hosted 204 HTTP responses without opening a body stream", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/session/ses_1/prompt_async", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string; type: string }
    expect(requestMessage.type).toBe("http.request")

    hostSocket.message(JSON.stringify({
      type: "http.response.start",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      status: 204,
      headers: {},
    }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(harness.room.drain.pendingCount()).toBe(1)

    hostSocket.message(JSON.stringify({
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
    }))

    const res = await pending
    expect(res.status).toBe(204)
    expect(res.body).toBeNull()
    await expect(res.text()).resolves.toBe("")
    expect(harness.room.drain.pendingCount()).toBe(0)
  })

  test("streams user-hosted HTTP response chunks before the tunnel response ends", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/stream", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string }
    hostSocket.message(JSON.stringify({
      type: "http.response.start",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      status: 206,
      headers: {
        "content-type": "text/plain",
      },
    }))

    const res = await pending
    expect(res.status).toBe(206)
    expect(harness.room.drain.pendingCount()).toBe(1)
    const body = res.text()
    hostSocket.message(JSON.stringify({
      type: "http.response.chunk",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      body_base64: btoa("part-a"),
    }))
    hostSocket.message(JSON.stringify({
      type: "http.response.chunk",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      body_base64: btoa("-part-b"),
    }))
    hostSocket.message(JSON.stringify({
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
    }))

    await expect(body).resolves.toBe("part-a-part-b")
    expect(harness.room.drain.pendingCount()).toBe(0)
  })

  test("keeps started user-hosted HTTP streams open past the initial response timeout", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted", forwardTimeoutMs: 1 })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/events", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string }
    hostSocket.message(JSON.stringify({
      type: "http.response.start",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    }))

    const res = await pending
    const body = res.text()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(harness.room.drain.pendingCount()).toBe(1)
    hostSocket.message(JSON.stringify({
      type: "http.response.chunk",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      body_base64: btoa("event: ready\n\n"),
    }))
    hostSocket.message(JSON.stringify({
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
    }))

    await expect(body).resolves.toBe("event: ready\n\n")
    expect(harness.room.drain.pendingCount()).toBe(0)
  })

  test("evicts the oldest started stream when the started-stream cap is exceeded", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted", tunnelStartedStreamCap: 1 })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket

    const startStream = async (sentIndex: number) => {
      const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/events", {
        headers: { authorization: `Bearer ${await harness.runtimeAccessToken()}` },
      }))
      await waitForSent(hostSocket, sentIndex + 1)
      const requestMessage = JSON.parse(String(hostSocket.sent[sentIndex])) as { request_id: string }
      hostSocket.message(JSON.stringify({
        type: "http.response.start",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: requestMessage.request_id,
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }))
      return { response: await pending, requestId: requestMessage.request_id }
    }

    const first = await startStream(0)
    expect(harness.room.drain.pendingCount()).toBe(1)

    // Starting a second stream (cap 1) evicts the FIRST — orphaned silent
    // streams must not accumulate until the tunnel starves with 503s.
    const second = await startStream(1)
    expect(harness.room.drain.pendingCount()).toBe(1)
    await expect(first.response.text()).rejects.toThrow("stream_evicted")
    expect(second.response.status).toBe(200)
  })

  test("frees the pending slot and aborts the host upstream when the client cancels a streaming response", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/events", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string }
    hostSocket.message(JSON.stringify({
      type: "http.response.start",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    }))

    const res = await pending
    expect(harness.room.drain.pendingCount()).toBe(1)

    // Browser dropped the SSE (tab closed / reconnect): the pending slot must
    // free immediately and the host must receive the terminal closed frame —
    // otherwise leaked slots starve the tunnel cap (`too_many_pending_requests`).
    await res.body!.cancel()

    expect(harness.room.drain.pendingCount()).toBe(0)
    const flows = hostSocket.sent
      .map((item) => JSON.parse(String(item)) as { type: string; request_id?: string; paused?: boolean; reason?: string })
      .filter((item) => item.type === "http.response.flow")
    expect(flows).toEqual([
      expect.objectContaining({ request_id: requestMessage.request_id, paused: false, reason: "closed" }),
    ])
  })

  test("fails and cleans up user-hosted HTTP streams when the downstream consumer stays slow", async () => {
    const harness = await roomHarness({
      resolveTarget: "user-hosted",
      slowConsumerHighWaterMarkBytes: 3,
      slowConsumerTimeoutMs: 5,
    })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/slow-consumer", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string }
    hostSocket.message(JSON.stringify({
      type: "http.response.start",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      status: 200,
      headers: {
        "content-type": "text/plain",
      },
    }))

    const res = await pending
    hostSocket.message(JSON.stringify({
      type: "http.response.chunk",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      body_base64: btoa("abcd"),
    }))
    hostSocket.message(JSON.stringify({
      type: "http.response.chunk",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      body_base64: btoa("efgh"),
    }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    await expect(res.text()).rejects.toThrow("slow_consumer_timeout")
    expect(hostSocket.sent.map((item) => JSON.parse(String(item))).filter((item) => item.type === "http.response.flow")).toEqual([
      expect.objectContaining({ paused: true, reason: "slow_consumer" }),
      expect.objectContaining({ paused: false, reason: "closed" }),
    ])
    expect(harness.room.drain.pendingCount()).toBe(0)
  })

  test("pauses and resumes host HTTP streaming when downstream backpressure drains", async () => {
    const harness = await roomHarness({
      resolveTarget: "user-hosted",
      slowConsumerHighWaterMarkBytes: 3,
      slowConsumerTimeoutMs: 5_000,
    })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/file/raw?path=large.bin", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string }
    hostSocket.message(JSON.stringify({
      type: "http.response.start",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
      },
    }))

    const res = await pending
    const reader = res.body!.getReader()
    hostSocket.message(JSON.stringify({
      type: "http.response.chunk",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      body_base64: btoa("abcd"),
    }))
    hostSocket.message(JSON.stringify({
      type: "http.response.chunk",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      body_base64: btoa("efgh"),
    }))

    await waitForSent(hostSocket, 2)
    expect(hostSocket.sent.map((item) => JSON.parse(String(item))).filter((item) => item.type === "http.response.flow")).toEqual([
      expect.objectContaining({ paused: true, reason: "slow_consumer" }),
    ])

    const first = await reader.read()
    expect(first.done).toBe(false)
    await waitForSent(hostSocket, 3)
    expect(hostSocket.sent.map((item) => JSON.parse(String(item))).filter((item) => item.type === "http.response.flow")).toEqual([
      expect.objectContaining({ paused: true, reason: "slow_consumer" }),
      expect.objectContaining({ paused: false, reason: "drained" }),
    ])

    hostSocket.message(JSON.stringify({
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
    }))
    const second = await reader.read()
    const done = await reader.read()
    expect(new TextDecoder().decode(first.value) + new TextDecoder().decode(second.value)).toBe("abcdefgh")
    expect(done.done).toBe(true)
  })

  test("drain pending count and waitForDrain track in-flight tunnel HTTP requests", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/slow", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    expect(harness.room.drain.pendingCount()).toBe(1)
    await expect(harness.room.drain.waitForDrain(1)).resolves.toEqual({ drained: false, remaining: 1 })

    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string }
    hostSocket.message(JSON.stringify({
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
    }))

    await expect(pending.then((res) => res.status)).resolves.toBe(200)
    await expect(harness.room.drain.waitForDrain(100)).resolves.toEqual({ drained: true, remaining: 0 })
  })

  test("rejects user-hosted HTTP requests after the pending request cap", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted", tunnelPendingHttpCap: 1 })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const first = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/slow", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)

    const second = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/second", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))

    expect(second.status).toBe(503)
    await expect(second.json()).resolves.toMatchObject({
      error: {
        code: "too_many_pending_requests",
      },
    })
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string }
    hostSocket.message(JSON.stringify({
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
    }))
    await expect(first.then((res) => res.status)).resolves.toBe(200)
  })

  test("rejects user-hosted HTTP request bodies over the room body cap", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted", tunnelRequestBodyMaxBytes: 3 })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/upload", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
      body: "too-large",
    }))

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "request_body_too_large",
      },
    })
    expect((harness.pairs[0]?.server as FakeSocket).sent).toHaveLength(0)
  })

  test("rejects user-hosted HTTP responses over the room body cap", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted", tunnelResponseBodyMaxBytes: 3 })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/download", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    expect(harness.room.drain.pendingCount()).toBe(1)
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string }
    hostSocket.message(JSON.stringify({
      type: "http.response.start",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      status: 200,
      headers: {
        "content-type": "text/plain",
      },
    }))
    hostSocket.message(JSON.stringify({
      type: "http.response.chunk",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      body_base64: btoa("too-large"),
    }))

    const res = await pending
    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toThrow("User-hosted response body exceeds the relay limit")
    expect(harness.room.drain.pendingCount()).toBe(0)
  })

  test("maps user-hosted tunnel errors to fail-closed HTTP responses", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string }
    hostSocket.message(JSON.stringify({
      type: "error",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      code: "host_failed",
      message: "host failed",
    }))

    await expect(pending.then(async (res) => ({ status: res.status, body: await res.json() }))).resolves.toMatchObject({
      status: 503,
      body: {
        error: {
          code: "user_hosted_tunnel_unavailable",
        },
      },
    })
  })

  test("rejects host tunnel routes that are not upgrade requests", async () => {
    const harness = await roomHarness()
    const res = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    expect(res.status).toBe(426)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "websocket_upgrade_required",
      },
    })
  })

  test("keeps host presence alive past the directory TTL while tunnel pings flow", async () => {
    let clock = 1_000_000_000_000
    const harness = await roomHarness({ resolveTarget: "user-hosted", now: () => clock })
    const host = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    expect(host.status).toBe(101)
    const hostSocket = harness.pairs[0]?.server as FakeSocket

    for (let i = 0; i < 4; i++) {
      clock += 15_000
      hostSocket.message(JSON.stringify({
        type: "ping",
        protocol: TUNNEL_PROTOCOL_VERSION,
        id: `ping_${i}`,
        sent_at: clock,
      }))
    }

    expect(harness.directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" })).toBeTruthy()

    const pending = harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    await waitForSent(hostSocket, 5)
    const requestMessage = JSON.parse(String(hostSocket.sent[4])) as { request_id: string }
    hostSocket.message(JSON.stringify({
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
    }))
    await expect(pending.then((res) => res.status)).resolves.toBe(200)
  })

  test("expires host presence when tunnel pings stop", async () => {
    let clock = 1_000_000_000_000
    const harness = await roomHarness({ resolveTarget: "user-hosted", now: () => clock })
    const host = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    expect(host.status).toBe(101)

    clock += 46_000

    expect(harness.directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" })).toBeUndefined()
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "user_hosted_app_offline",
      },
    })
  })

  test("refreshes host presence on any real host frame, not just pings, on the hibernation path", async () => {
    let clock = 1_000_000_000_000
    const harness = await roomHarness({ resolveTarget: "user-hosted", hibernation: true, now: () => clock })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    const hostSocket = harness.hibernatedSockets[0]!
    const realFrame = () => harness.room.webSocketMessage(hostSocket, JSON.stringify({
      // An http response for an unknown request id is a no-op beyond the
      // presence touch — a stand-in for ordinary host->relay traffic.
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "unknown_request",
    }))

    // First frame wakes the DO and triggers the one-time hibernated-socket
    // rebuild (which re-registers presence). Subsequent frames must keep
    // presence fresh on their own — the keepalive ping is auto-responded and
    // never reaches the DO, so real traffic is the only in-session refresh.
    await realFrame()
    clock += 40_000
    await realFrame()
    clock += 40_000
    expect(harness.directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" })).toBeTruthy()
  })

  test("an attached hibernating host socket remains authoritative after directory TTL expiry", async () => {
    let clock = 1_000_000_000_000
    const harness = await roomHarness({ resolveTarget: "user-hosted", hibernation: true, now: () => clock })
    const host = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    expect(host.status).toBe(101)
    clock += 60_000

    const online = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(online.status).toBe(101)
    expect(harness.directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" })).toBeTruthy()
  })

  test("a closed hibernating host socket cannot revive expired directory presence", async () => {
    let clock = 1_000_000_000_000
    const harness = await roomHarness({ resolveTarget: "user-hosted", hibernation: true, now: () => clock })
    const host = await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    expect(host.status).toBe(101)
    const hostSocket = harness.hibernatedSockets[0]!

    hostSocket.close()
    clock += 90_000

    const offline = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(offline.status).toBe(503)
    await expect(offline.json()).resolves.toMatchObject({
      error: {
        code: "user_hosted_app_offline",
      },
    })
  })

  test("echoes the authenticated subprotocol on the cloud client 101 response", async () => {
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
    })
    const token = await harness.runtimeAccessToken()
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `claxedo-rat.${token}, claxedo-extra`,
      },
    }))

    expect(res.status).toBe(101)
    expect(res.headers.get("sec-websocket-protocol")).toBe(`claxedo-rat.${token}`)
  })

  test("echoes the authenticated subprotocol on the user-hosted client 101 response", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    const token = await harness.runtimeAccessToken()
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `claxedo-rat.${token}`,
      },
    }))

    expect(res.status).toBe(101)
    expect(res.headers.get("sec-websocket-protocol")).toBe(`claxedo-rat.${token}`)
  })

  test("passes WebSocket upgrades through untouched when the browser sends an Origin header", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted" })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    const token = await harness.runtimeAccessToken()
    // Browsers ALWAYS send Origin on WS upgrades. The CORS wrapper must skip
    // 101 responses — reconstructing one throws in the Workers runtime and
    // drops the attached webSocket, which turned every browser PTY connection
    // into a 500 while header-less clients worked.
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        origin: "https://claxedo-app-staging.pages.dev",
        "sec-websocket-protocol": `claxedo-rat.${token}`,
      },
    }))

    expect(res.status).toBe(101)
    expect(res.headers.get("sec-websocket-protocol")).toBe(`claxedo-rat.${token}`)
  })

  test("omits the subprotocol header on the 101 when the client does not offer one", async () => {
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))

    expect(res.status).toBe(101)
    expect(res.headers.get("sec-websocket-protocol")).toBeNull()
  })

  test("rejects oversized streamed user-hosted request bodies without buffering them", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted", tunnelRequestBodyMaxBytes: 4096 })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(1024))
      },
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/upload", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
      body,
      duplex: "half",
    } as RequestInit))

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "request_body_too_large",
      },
    })
    expect(pulls).toBeLessThan(10)
    expect((harness.pairs[0]?.server as FakeSocket).sent).toHaveLength(0)
  })

  test("rejects user-hosted request bodies whose content-length exceeds the cap before reading", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted", tunnelRequestBodyMaxBytes: 4096 })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(1024))
      },
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/upload", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        "content-length": "120000000",
      },
      body,
      duplex: "half",
    } as RequestInit))

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "request_body_too_large",
      },
    })
    expect(pulls).toBeLessThanOrEqual(1)
  })

  test("closes live cloud WebSocket clients at token expiry without a revocation hook", async () => {
    let clock = Date.now()
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
      runtimeAccessTokenActiveCheckIntervalMs: 1,
      now: () => clock,
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(101)
    const clientSocket = harness.pairs[0]?.server as FakeSocket

    clock += 31 * 60_000
    await waitForClosed(clientSocket)

    expect(clientSocket.closed).toEqual({
      code: 1008,
      reason: "Runtime Access Token expired",
    })
  })

  test("closes live cloud WebSocket clients at token expiry even when the revocation hook reports active", async () => {
    let clock = Date.now()
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
      runtimeAccessTokenActiveCheckIntervalMs: 1,
      now: () => clock,
      isRuntimeAccessTokenActive: () => ({ active: true }),
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(101)
    const clientSocket = harness.pairs[0]?.server as FakeSocket

    clock += 31 * 60_000
    await waitForClosed(clientSocket)

    expect(clientSocket.closed).toEqual({
      code: 1008,
      reason: "Runtime Access Token expired",
    })
  })

  test("signals the host tunnel to abort when a pending HTTP request times out", async () => {
    const harness = await roomHarness({ resolveTarget: "user-hosted", forwardTimeoutMs: 5 })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))

    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/slow", {
      headers: {
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "user_hosted_tunnel_timeout",
      },
    })

    const hostSocket = harness.pairs[0]?.server as FakeSocket
    await waitForSent(hostSocket, 2)
    const requestMessage = JSON.parse(String(hostSocket.sent[0])) as { request_id: string }
    expect(JSON.parse(String(hostSocket.sent[1]))).toEqual({
      type: "http.response.flow",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestMessage.request_id,
      paused: false,
      reason: "closed",
    })
    expect(harness.room.drain.pendingCount()).toBe(0)
  })

  test("closes the upstream socket and clears the client when the pre-open queue overflows", async () => {
    const upstream = new FakeSocket()
    upstream.readyState = 0
    const harness = await roomHarness({
      connectWebSocket: () => upstream,
      upstreamWebSocketPreOpenQueueMaxFrames: 1,
      // Both bounds must be exceeded to close, so the byte bound has to be tiny
      // here too — otherwise these small frames are admitted (which is the
      // point of the byte bound) and the client is not closed.
      upstreamWebSocketPreOpenQueueMaxBytes: 1,
      createServerSocket: () => new SilentCloseSocket(),
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    expect(res.status).toBe(101)
    const clientSocket = harness.pairs[0]?.server as FakeSocket

    clientSocket.message("frame-1")
    clientSocket.message("frame-2")

    expect(clientSocket.closed).toEqual({
      code: 1011,
      reason: "Upstream WebSocket queue limit exceeded",
    })
    expect(upstream.closed).toEqual({
      code: 1011,
      reason: "Upstream WebSocket queue limit exceeded",
    })
    expect(harness.room.state()).toMatchObject({ clientCount: 0 })
  })

  /**
   * The silent-drop family (W6.1).
   *
   * `socketFrame`/`socketPayload` returned `undefined` for anything that was not
   * a string, ArrayBuffer, or Uint8Array, and every caller treats `undefined` as
   * "nothing to forward" — so an unrecognised frame vanished with no throw and
   * no log. Two shapes hit that path:
   *
   *  - `Blob`, which is what Cloudflare makes the server-side WebSocket default
   *    at `compatibility_date >= 2026-03-17`. The only thing standing between
   *    production and every binary frame disappearing was the pinned date in
   *    wrangler.toml.
   *  - `DataView` (and non-Uint8Array typed arrays), which `socketPayload`
   *    already handled but `socketFrame` did not — a real asymmetry today,
   *    independent of the compatibility date.
   *
   * These assert bytes ARRIVE, so they fail against the pre-fix implementation
   * rather than just exercising the new branch.
   */
  describe("binary frame shapes that used to be dropped silently", () => {
    const bytes = new Uint8Array([0, 1, 0x7f, 0x80, 0xfe, 0xff])

    async function userHostedChannel() {
      const harness = await roomHarness({ resolveTarget: "user-hosted" })
      await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${await harness.hostTunnelToken()}`,
        },
      }))
      const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        },
      }))
      expect(res.status).toBe(101)
      const hostSocket = harness.pairs[0]?.server as FakeSocket
      const clientSocket = harness.pairs[1]?.server as FakeSocket
      await waitForSent(hostSocket, 1)
      const open = JSON.parse(String(hostSocket.sent[0])) as { channel_id: string }
      hostSocket.sent.length = 0
      return { harness, hostSocket, clientSocket, channelId: open.channel_id }
    }

    test("forwards a Blob client frame to the host tunnel as binary", async () => {
      const { hostSocket, clientSocket } = await userHostedChannel()

      clientSocket.message(new Blob([bytes]))
      await waitForSent(hostSocket, 1)

      expect(JSON.parse(String(hostSocket.sent[0]))).toMatchObject({
        type: "ws.frame",
        binary: true,
        data_base64: btoa(String.fromCharCode(...bytes)),
      })
    })

    test("forwards a DataView client frame to the host tunnel as binary", async () => {
      const { hostSocket, clientSocket } = await userHostedChannel()

      clientSocket.message(new DataView(bytes.buffer.slice(0)))
      await waitForSent(hostSocket, 1)

      expect(JSON.parse(String(hostSocket.sent[0]))).toMatchObject({
        type: "ws.frame",
        binary: true,
        data_base64: btoa(String.fromCharCode(...bytes)),
      })
    })

    test("forwards a typed-array view respecting its byte offset", async () => {
      const { hostSocket, clientSocket } = await userHostedChannel()
      // A view over the MIDDLE of a larger buffer: forwarding the whole
      // underlying buffer instead of the view's window is the classic bug here.
      const backing = new Uint8Array([0xaa, 0xbb, ...bytes, 0xcc])
      clientSocket.message(new DataView(backing.buffer, 2, bytes.byteLength))
      await waitForSent(hostSocket, 1)

      expect(JSON.parse(String(hostSocket.sent[0]))).toMatchObject({
        binary: true,
        data_base64: btoa(String.fromCharCode(...bytes)),
      })
    })

    test("forwards a Blob frame across the cloud upstream socket", async () => {
      const upstream = new FakeSocket()
      const harness = await roomHarness({ connectWebSocket: () => upstream })
      const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        },
      }))
      expect(res.status).toBe(101)
      const clientSocket = harness.pairs[0]?.server as FakeSocket

      clientSocket.message(new Blob([bytes]))
      await waitForSent(upstream, 1)
      expect(new Uint8Array(upstream.sent[0] as ArrayBuffer)).toEqual(bytes)

      // ...and back down from the upstream to the browser.
      upstream.message(new Blob([bytes]))
      await waitForSent(clientSocket, 1)
      expect(new Uint8Array(clientSocket.sent[0] as ArrayBuffer)).toEqual(bytes)
    })

    test("preserves frame order when Blob and synchronous frames interleave", async () => {
      // The ordering hazard the async Blob path introduces: `await
      // blob.arrayBuffer()` yields, so a string frame arriving immediately after
      // a Blob frame would overtake it and silently scramble an ordered stream.
      const upstream = new FakeSocket()
      const harness = await roomHarness({ connectWebSocket: () => upstream })
      await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        },
      }))
      const clientSocket = harness.pairs[0]?.server as FakeSocket

      clientSocket.message(new Blob([new Uint8Array([1])]))
      clientSocket.message("two")
      clientSocket.message(new Blob([new Uint8Array([3])]))
      clientSocket.message("four")
      await waitForSent(upstream, 4)

      expect(upstream.sent.map((item) => typeof item === "string" ? item : [...new Uint8Array(item as ArrayBuffer)].join()))
        .toEqual(["1", "two", "3", "four"])
    })

    test("routes a Blob frame after a hibernation wake", async () => {
      // The hibernation path goes through `webSocketMessage`, not an event
      // listener, so it needs its own coverage — and it is the path where the
      // per-frame check is the only auth enforcement.
      const harness = await roomHarness({ resolveTarget: "user-hosted", hibernation: true })
      await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${await harness.hostTunnelToken()}`,
        },
      }))
      await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${await harness.runtimeAccessToken()}`,
        },
      }))
      const hostSocket = harness.pairs[0]?.server as FakeSocket
      const clientSocket = harness.pairs[1]?.server as FakeSocket
      await waitForSent(hostSocket, 1)
      const open = JSON.parse(String(hostSocket.sent[0])) as { channel_id: string }
      hostSocket.sent.length = 0

      await harness.room.webSocketMessage(
        clientSocket,
        new Blob([bytes]) as unknown as ArrayBuffer,
      )
      await waitForSent(hostSocket, 1)

      expect(JSON.parse(String(hostSocket.sent[0]))).toMatchObject({
        type: "ws.frame",
        channel_id: open.channel_id,
        binary: true,
        data_base64: btoa(String.fromCharCode(...bytes)),
      })
    })
  })
})

/**
 * W6.2 / W6b.2 — failure semantics on established connections.
 *
 * Each test here asserts an explicit CLIENT EXPERIENCE (a close code, a status,
 * a settled promise) rather than an internal state transition, because the
 * defect class being fixed is precisely "the client is left with no signal".
 */
describe("workspace relay failure semantics", () => {
  async function userHostedChannel(input: Parameters<typeof roomHarness>[0] = {}) {
    const harness = await roomHarness({ resolveTarget: "user-hosted", ...input })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.hostTunnelToken()}`,
      },
    }))
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${await harness.runtimeAccessToken()}`,
      },
    }))
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    const clientSocket = harness.pairs[1]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const open = JSON.parse(String(hostSocket.sent[0])) as { channel_id: string }
    hostSocket.sent.length = 0
    return { harness, hostSocket, clientSocket, channelId: open.channel_id, upgradeStatus: res.status }
  }

  test("closes the client 1013 and tells the host when a host->client frame cannot be delivered", async () => {
    // The unchecked send at the ws.frame handler. A browser socket that rejects
    // sends used to be kept in `tunnel.channels` forever, with the host happily
    // producing frames into it.
    class RejectingSocket extends FakeSocket {
      send(): void {
        throw new Error("socket is gone")
      }
    }
    let created = 0
    const { hostSocket, clientSocket, channelId } = await userHostedChannel({
      // Only the CLIENT socket (the second pair) rejects sends; the host tunnel
      // must stay usable so the ws.close notification can be observed.
      createServerSocket: () => (created++ === 1 ? new RejectingSocket() : new FakeSocket()),
    })

    hostSocket.message(JSON.stringify({
      type: "ws.frame",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: channelId,
      binary: false,
      data_base64: btoa("undeliverable"),
    }))
    await waitForClosed(clientSocket)

    expect(clientSocket.closed).toEqual({
      code: 1013,
      reason: "Client WebSocket delivery failed",
    })
    // The host is told to stop producing for this channel.
    await waitForSent(hostSocket, 1)
    expect(JSON.parse(String(hostSocket.sent[0]))).toMatchObject({
      type: "ws.close",
      channel_id: channelId,
      code: 1013,
    })
  })

  test("closes 1011 with a log instead of silently rejecting when a frame handler throws", async () => {
    // `webSocketMessage` awaited the handlers bare: a throw rejected the DO's
    // message promise with no close and no log, and the client waited forever.
    // Admit must succeed first — the same hook gates admission — so it only
    // starts throwing once the channel is established.
    let established = false
    const harness = await roomHarness({
      resolveTarget: "user-hosted",
      hibernation: true,
      isRuntimeAccessTokenActive: () => {
        if (!established) return { active: true as const }
        throw new Error("revocation backend exploded")
      },
    })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: { upgrade: "websocket", authorization: `Bearer ${await harness.hostTunnelToken()}` },
    }))
    await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: { upgrade: "websocket", authorization: `Bearer ${await harness.runtimeAccessToken()}` },
    }))
    const clientSocket = harness.pairs[1]?.server as FakeSocket
    established = true

    // Must RESOLVE, not reject: an escaping throw is the bug.
    await harness.room.webSocketMessage(clientSocket, "frame-that-throws")

    expect(clientSocket.closed).toEqual({
      code: 1011,
      reason: "Workspace relay failed to process a frame",
    })
  })

  test("fails the upgrade when the host cannot be told the channel opened", async () => {
    // A ws.open that never reaches the host leaves the browser holding an
    // established socket nothing will ever answer. Better a retryable 503.
    class RejectingSocket extends FakeSocket {
      send(): void {
        throw new Error("tunnel is gone")
      }
    }
    const harness = await roomHarness({
      resolveTarget: "user-hosted",
      createServerSocket: () => new RejectingSocket(),
    })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: { upgrade: "websocket", authorization: `Bearer ${await harness.hostTunnelToken()}` },
    }))
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: { upgrade: "websocket", authorization: `Bearer ${await harness.runtimeAccessToken()}` },
    }))

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "user_hosted_app_offline" },
    })
    // The half-open channel must not be left behind.
    expect(harness.room.state()).toMatchObject({ clientCount: 0 })
  })

  test("graces an established connection through a resolver outage instead of closing it", async () => {
    // A revocation resolver 5xx arrives as `active: false` with
    // code relay_revocation_resolver_unavailable — NOT as a throw. Treating that
    // as authoritative closed every live session on one blip.
    let calls = 0
    // Admission uses the same hook, so the outage begins only after the socket is
    // established — the claim under test is about ESTABLISHED connections.
    let established = false
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
      runtimeAccessTokenActiveCheckIntervalMs: 5,
      resolverOutageGraceAttempts: 3,
      isRuntimeAccessTokenActive: () => {
        if (!established) return { active: true as const }
        calls += 1
        return {
          active: false as const,
          code: "relay_revocation_resolver_unavailable",
          reason: "revocation resolver returned 503",
        }
      },
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: { upgrade: "websocket", authorization: `Bearer ${await harness.runtimeAccessToken()}` },
    }))
    expect(res.status).toBe(101)
    established = true
    const clientSocket = harness.pairs[0]?.server as FakeSocket

    // After the FIRST failure the connection must still be open.
    while (calls < 1) await new Promise((r) => setTimeout(r, 2))
    expect(clientSocket.closed).toBeUndefined()

    // ...and it closes only once the outage is sustained past the grace bound.
    await waitForClosed(clientSocket)
    expect(clientSocket.closed?.code).toBe(1008)
    expect(clientSocket.closed?.reason).toContain("unavailable")
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test("closes immediately on an explicit revocation, with no grace", async () => {
    // The fail-closed half of the same policy: grace must not delay a REAL
    // revocation by even one interval.
    let calls = 0
    let established = false
    const harness = await roomHarness({
      connectWebSocket: () => new FakeSocket(),
      runtimeAccessTokenActiveCheckIntervalMs: 5,
      resolverOutageGraceAttempts: 3,
      isRuntimeAccessTokenActive: () => {
        if (!established) return { active: true as const }
        calls += 1
        return { active: false as const, code: "relay_token_revoked", reason: "Runtime Access Token was revoked" }
      },
    })
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: { upgrade: "websocket", authorization: `Bearer ${await harness.runtimeAccessToken()}` },
    }))
    expect(res.status).toBe(101)
    established = true
    const clientSocket = harness.pairs[0]?.server as FakeSocket

    await waitForClosed(clientSocket)
    expect(clientSocket.closed).toEqual({
      code: 1008,
      reason: "Runtime Access Token was revoked",
    })
    // One conclusive answer is enough — this is what proves grace is scoped to
    // unreachability rather than applied to every negative answer.
    expect(calls).toBe(1)
  })
})

/**
 * W6b.2 — revocation under hibernation.
 *
 * On the hibernating path `admitUserHostedClient` installs NO watchers, because
 * `setInterval` does not survive DO eviction. That left the per-frame cached
 * check as the only enforcement, which never fires for an IDLE connection — so a
 * revoked token could hold a hibernated socket open indefinitely. DO alarms DO
 * survive hibernation, so they carry the periodic re-check.
 *
 * The per-frame check is retained; these tests assert the alarm is ADDITIVE.
 */
describe("workspace relay hibernated revocation alarm", () => {
  /**
   * Models the DO alarm slot the way workerd actually behaves. The load-bearing
   * detail, verified on real workerd via miniflare: the runtime CLEARS the alarm
   * before invoking `alarm()`, so `getAlarm()` inside the handler returns null.
   * A fake that kept reporting the fired alarm as pending would make the sweep
   * look like it fails to re-arm.
   */
  function fakeAlarms() {
    const scheduled: number[] = []
    let current: number | null = null
    return {
      scheduled,
      current: () => current,
      /** What the runtime does immediately before calling `alarm()`. */
      fire: () => {
        current = null
      },
      alarms: {
        getAlarm: () => current,
        setAlarm: (at: number) => {
          current = at
          scheduled.push(at)
        },
        deleteAlarm: () => {
          current = null
        },
      },
    }
  }

  async function hibernatedClient(input: {
    isRuntimeAccessTokenActive?: NonNullable<Parameters<typeof roomHarness>[0]>["isRuntimeAccessTokenActive"]
    now?: () => number
  } = {}) {
    const alarmState = fakeAlarms()
    const harness = await roomHarness({
      resolveTarget: "user-hosted",
      hibernation: true,
      hibernatedRevocationCheckIntervalMs: 30_000,
      alarms: alarmState.alarms,
      ...(input.isRuntimeAccessTokenActive ? { isRuntimeAccessTokenActive: input.isRuntimeAccessTokenActive } : {}),
      ...(input.now ? { now: input.now } : {}),
    })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: { upgrade: "websocket", authorization: `Bearer ${await harness.hostTunnelToken()}` },
    }))
    const res = await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: { upgrade: "websocket", authorization: `Bearer ${await harness.runtimeAccessToken()}` },
    }))
    expect(res.status).toBe(101)
    const hostSocket = harness.pairs[0]?.server as FakeSocket
    const clientSocket = harness.pairs[1]?.server as FakeSocket
    await waitForSent(hostSocket, 1)
    const open = JSON.parse(String(hostSocket.sent[0])) as { channel_id: string }
    hostSocket.sent.length = 0
    return { harness, alarmState, hostSocket, clientSocket, channelId: open.channel_id }
  }

  test("schedules an alarm when a hibernated client connects", async () => {
    // Without this the sweep never runs at all, so it is the precondition for
    // every other assertion here.
    const { alarmState } = await hibernatedClient()
    // Allow the fire-and-forget schedule to settle.
    await new Promise((r) => setTimeout(r, 5))

    expect(alarmState.scheduled.length).toBeGreaterThanOrEqual(1)
  })

  test("closes an IDLE hibernated connection whose token was revoked", async () => {
    // THE W6b.2 positive control: no frames are ever sent on this socket, so the
    // per-frame cached check cannot fire. Only the alarm can close it.
    let established = false
    const { harness, clientSocket, hostSocket, channelId } = await hibernatedClient({
      isRuntimeAccessTokenActive: () => established
        ? { active: false as const, code: "relay_token_revoked", reason: "Runtime Access Token was revoked" }
        : { active: true as const },
    })
    established = true
    expect(clientSocket.closed).toBeUndefined()

    // The runtime firing the alarm after hibernation.
    await harness.room.alarm()

    expect(clientSocket.closed).toEqual({
      code: 1008,
      reason: "Runtime Access Token was revoked",
    })
    expect(harness.room.state()).toMatchObject({ clientCount: 0 })
    // The host is told to stop serving the channel too.
    await waitForSent(hostSocket, 1)
    expect(JSON.parse(String(hostSocket.sent[0]))).toMatchObject({
      type: "ws.close",
      channel_id: channelId,
      code: 1008,
    })
  })

  test("closes an idle hibernated connection whose token merely expired", async () => {
    // Expiry needs no resolver at all — it is decided from the token's own `exp`,
    // which is what bounds worst-case revocation latency.
    let clock = Date.now()
    const { harness, clientSocket } = await hibernatedClient({ now: () => clock })
    expect(clientSocket.closed).toBeUndefined()

    // Past any plausible RAT lifetime.
    clock += 24 * 60 * 60 * 1000
    await harness.room.alarm()

    expect(clientSocket.closed).toEqual({
      code: 1008,
      reason: "Runtime Access Token expired",
    })
  })

  test("leaves an idle hibernated connection open through a resolver outage", async () => {
    // Same fail-open-briefly policy as the watchers: an outage must not
    // disconnect idle users fleet-wide.
    let established = false
    const { harness, clientSocket } = await hibernatedClient({
      isRuntimeAccessTokenActive: () => established
        ? {
            active: false as const,
            code: "relay_revocation_resolver_unavailable",
            reason: "revocation resolver returned 503",
          }
        : { active: true as const },
    })
    established = true

    await harness.room.alarm()

    expect(clientSocket.closed).toBeUndefined()
    expect(harness.room.state()).toMatchObject({ clientCount: 1 })
  })

  test("leaves a still-valid idle connection open and re-arms the alarm", async () => {
    const { harness, clientSocket, alarmState } = await hibernatedClient()
    await new Promise((r) => setTimeout(r, 5))
    const before = alarmState.scheduled.length

    alarmState.fire()
    await harness.room.alarm()

    expect(clientSocket.closed).toBeUndefined()
    // Re-armed, otherwise revocation enforcement stops dead after one sweep.
    expect(alarmState.scheduled.length).toBeGreaterThan(before)
    expect(alarmState.current()).not.toBeNull()
  })

  test("does not clobber an earlier alarm already pending in the shared slot", async () => {
    // A Durable Object has exactly ONE alarm slot, shared with any other user of
    // it. The room must only ever move the alarm EARLIER — pushing it out would
    // silently cancel someone else's wake.
    //
    // The pre-existing alarm has to be in place BEFORE the room ever schedules,
    // otherwise the room's own (later) alarm is what is being overwritten and the
    // assertion passes for the wrong reason.
    const alarmState = fakeAlarms()
    const sooner = Date.now() + 50
    alarmState.alarms.setAlarm(sooner)
    const countAfterManualSet = alarmState.scheduled.length

    const harness = await roomHarness({
      resolveTarget: "user-hosted",
      hibernation: true,
      hibernatedRevocationCheckIntervalMs: 30_000,
      alarms: alarmState.alarms,
    })
    await harness.room.fetch(new Request("https://relay.test/host-tunnels/host_1?workspaceId=ws_1", {
      headers: { upgrade: "websocket", authorization: `Bearer ${await harness.hostTunnelToken()}` },
    }))
    await harness.room.fetch(new Request("https://relay.test/workspaces/ws_1/api/claxedo/pty/pty_1/connect", {
      headers: { upgrade: "websocket", authorization: `Bearer ${await harness.runtimeAccessToken()}` },
    }))
    await new Promise((r) => setTimeout(r, 5))

    // 50 ms from now is sooner than the room's 30 s interval, so it stands.
    expect(alarmState.current()).toBe(sooner)
    expect(alarmState.scheduled.length).toBe(countAfterManualSet)
  })
})

/**
 * W6b.3 — per-workspace Durable Object placement.
 *
 * A DO's location is fixed at FIRST CREATION and never migrates, so the hint
 * chosen on the very first request is permanent for that workspace's whole life.
 * One deployment-wide constant therefore means every non-APAC user crosses an
 * ocean twice per frame forever. These assert the hint AT THE `idFromName` CALL
 * SITE, which is the only place the decision has any effect.
 */
describe("workspace relay Durable Object location hint", () => {
  async function routeWith(input: {
    headers?: Record<string, string>
    search?: string
    cf?: { country?: string }
    env?: Record<string, unknown>
  }) {
    const { namespace, routed } = fakeNamespace()
    const gateway = createWorkspaceRelayDurableObjectGateway({ namespace })
    const request = new Request(`https://relay.test/workspaces/ws_1/api/wr/health${input.search ?? ""}`, {
      ...(input.headers ? { headers: input.headers } : {}),
    })
    if (input.cf) Object.defineProperty(request, "cf", { value: input.cf })
    const res = await gateway.fetch(request, input.env ?? {})
    return { res, routed, hint: routed[0]?.options?.locationHint }
  }

  test("derives the hint from the workspace region header", async () => {
    const { res, hint } = await routeWith({
      headers: { "x-claxedo-workspace-region": "us-east" },
    })

    expect(hint).toBe("enam")
    // Echoed so a client (and a bench) can see which region it actually got.
    expect(res.headers.get("x-claxedo-relay-location-hint")).toBe("enam")
  })

  test("derives the hint from a region query parameter", async () => {
    // The control plane composes relay URLs; a query param is the cheaper seam
    // when a header cannot be added (WebSocket upgrades from a browser).
    expect((await routeWith({ search: "?region=eu-west" })).hint).toBe("weur")
    expect((await routeWith({ search: "?homeRegion=ap-south" })).hint).toBe("apac")
  })

  test("accepts a literal Cloudflare hint as a region", async () => {
    expect((await routeWith({ search: "?region=weur" })).hint).toBe("weur")
    expect((await routeWith({ search: "?region=WNAM" })).hint).toBe("wnam")
  })

  test("falls back to the requesting user's Cloudflare country when no region is known", async () => {
    expect((await routeWith({ cf: { country: "DE" } })).hint).toBe("weur")
    expect((await routeWith({ cf: { country: "BR" } })).hint).toBe("sam")
    expect((await routeWith({ cf: { country: "IN" } })).hint).toBe("apac")
    expect((await routeWith({ cf: { country: "AU" } })).hint).toBe("oc")
  })

  test("prefers the workspace region over the requesting user's country", async () => {
    // The workspace's own region is the authoritative signal: whoever connects
    // FIRST must not permanently pin the DO next to themselves.
    const { hint } = await routeWith({
      headers: { "x-claxedo-workspace-region": "eu-west" },
      cf: { country: "US" },
    })

    expect(hint).toBe("weur")
  })

  test("falls back to the configured deployment hint for an unknown region", async () => {
    // Cloudflare REJECTS an unknown hint and a rejected get() fails the request,
    // so an unrecognised value must never be passed through.
    expect((await routeWith({
      search: "?region=mars-central-1",
      env: { CLAXEDO_RELAY_LOCATION_HINT: "wnam" },
    })).hint).toBe("wnam")

    expect((await routeWith({ search: "?region=mars-central-1" })).hint).toBe(DEFAULT_RELAY_LOCATION_HINT)
  })

  test("keeps today's behavior when nothing declares a region", async () => {
    // The strangler requirement: an unannotated request must be byte-identical to
    // the pre-change behavior, so this cannot regress existing workspaces.
    expect((await routeWith({})).hint).toBe(DEFAULT_RELAY_LOCATION_HINT)
    expect((await routeWith({ env: { CLAXEDO_RELAY_LOCATION_HINT: "enam" } })).hint).toBe("enam")
  })

  test("only ever emits a hint Cloudflare recognises", async () => {
    // Whatever the inputs, the value handed to `get()` must be in Cloudflare's
    // fixed set — an invalid one fails the request rather than degrading latency.
    const regions = [
      "apac-south", "apac-east", "us-east", "us-west", "eu-west",
      "eu-central", "eu-east", "ap-south", "sa-east", "af-south",
      "me-central", "oceania", "totally-made-up", "", "../../etc/passwd",
    ]
    for (const region of regions) {
      const { hint } = await routeWith({ search: `?region=${encodeURIComponent(region)}` })
      expect(
        (RELAY_LOCATION_HINTS as readonly string[]).includes(hint ?? ""),
        `region "${region}" produced "${hint}", which Cloudflare would reject`,
      ).toBe(true)
    }
  })
})
