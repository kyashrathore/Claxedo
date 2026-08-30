import { describe, expect, test } from "bun:test"
import { generateKeyPair } from "jose"
import { mintHostTunnelToken, mintRuntimeAccessToken, verifyRelayHostToken } from "./auth"
import { createWorkspaceRelayDirectory, type WorkspaceRelayDirectory } from "./directory"
import {
  __slowConsumerInternalsForTest,
  createWorkspaceRelayBun,
  relayBufferedBytes,
  relayOverBackpressureLimit,
  WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS,
  type WorkspaceRelayBunOptions,
} from "./bun"
import { TUNNEL_PROTOCOL_VERSION, type TunnelPong } from "@claxedo/workspace-relay-protocol"

type DirectoryObserver = {
  waitForPresence(): Promise<NonNullable<ReturnType<WorkspaceRelayDirectory["activeHost"]>>>
  waitForFreshPong(connectedAt: number): Promise<NonNullable<ReturnType<WorkspaceRelayDirectory["activeHost"]>>>
  waitForOffline(): Promise<void>
}

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("WebSocket failed to open"))
  })
}

function waitForMessage(ws: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    ws.onmessage = (event) => resolve(String(event.data))
    ws.onerror = () => reject(new Error("WebSocket failed while waiting for message"))
  })
}

function waitForRawMessage(ws: WebSocket) {
  return new Promise<MessageEvent["data"]>((resolve, reject) => {
    ws.onmessage = (event) => resolve(event.data)
    ws.onerror = () => reject(new Error("WebSocket failed while waiting for message"))
  })
}

function waitForClose(ws: WebSocket) {
  return new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (event) => resolve({ code: event.code, reason: event.reason })
  })
}

function observeDirectory(directory: WorkspaceRelayDirectory): DirectoryObserver {
  const waiters = new Set<() => void>()
  const notify = () => {
    for (const waiter of waiters) waiter()
  }
  const registerHostTunnel = directory.registerHostTunnel.bind(directory)
  const recordPong = directory.recordPong.bind(directory)
  const disconnectHost = directory.disconnectHost.bind(directory)
  directory.registerHostTunnel = (input) => {
    const presence = registerHostTunnel(input)
    notify()
    return presence
  }
  directory.recordPong = (hostId) => {
    const presence = recordPong(hostId)
    notify()
    return presence
  }
  directory.disconnectHost = (hostId) => {
    disconnectHost(hostId)
    notify()
  }
  const active = () => directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" })
  const waitFor = <T>(label: string, fn: () => T | undefined) => {
    const current = fn()
    if (current) return Promise.resolve(current)
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const next = fn()
        if (!next) return
        clearTimeout(timeout)
        waiters.delete(check)
        resolve(next)
      }
      const timeout = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(label))
      }, 5_000)
      waiters.add(check)
    })
  }
  return {
    waitForPresence: () => waitFor("Host tunnel presence was not registered", active),
    waitForFreshPong: (connectedAt) => waitFor(
      "Host tunnel pong was not recorded",
      () => {
        const presence = active()
        return presence && presence.lastPongAt > connectedAt ? presence : undefined
      },
    ),
    waitForOffline: () => waitFor(
      "Host tunnel presence was not removed",
      () => !active() || undefined,
    ).then(() => undefined),
  }
}

async function readExactBytes(reader: ReadableStreamDefaultReader<Uint8Array>, byteLength: number) {
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < byteLength) {
    const next = await reader.read()
    if (next.done) throw new Error(`Stream ended after ${size} bytes, expected ${byteLength}`)
    chunks.push(next.value)
    size += next.value.byteLength
  }
  if (size !== byteLength) throw new Error(`Stream returned ${size} bytes, expected ${byteLength}`)
  const result = new Uint8Array(byteLength)
  chunks.reduce((offset, chunk) => {
    result.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  return result
}

function hostTunnelSocket(url: string, token: string) {
  return new (WebSocket as unknown as {
    new(url: string, options: { headers: Record<string, string> }): WebSocket
  })(url, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })
}

describe("workspace relay Bun adapter", () => {
  test("forwards generic WebSocket frames with a Relay Host Token", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const hostAuthorizations: string[] = []
    const host = Bun.serve<{ ok: true }>({
      port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname !== "/api/ws") {
          return new Response("not found", { status: 404 })
        }
        hostAuthorizations.push(request.headers.get("authorization") ?? "")
        if (server.upgrade(request, { data: { ok: true } })) {
          return undefined as unknown as Response
        }
        return new Response("upgrade failed", { status: 400 })
      },
      websocket: {
        message(ws, message) {
          ws.send(`host:${message}`)
        },
      },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"),
      { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
    )

    try {
      await waitForOpen(ws)
      const message = waitForMessage(ws)
      ws.send("ping")

      await expect(message).resolves.toBe("host:ping")
      expect(hostAuthorizations[0]?.startsWith("Bearer ")).toBe(true)
      await expect(verifyRelayHostToken(hostAuthorizations[0]!.replace(/^Bearer\s+/i, ""), relayHost.publicKey, {
        workspaceId: "ws_1",
        hostId: "host_1",
      })).resolves.toMatchObject({
        role: "editor",
        access: "cloud",
        backing: "cloud-vm",
      })
    } finally {
      ws.close()
      relay.stop(true)
      host.stop(true)
    }
  })

  test("round-trips binary cloud WebSocket frames without changing bytes", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const host = Bun.serve<{ ok: true }>({
      port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname !== "/api/ws") {
          return new Response("not found", { status: 404 })
        }
        if (server.upgrade(request, { data: { ok: true } })) {
          return undefined as unknown as Response
        }
        return new Response("upgrade failed", { status: 400 })
      },
      websocket: {
        message(ws, message) {
          ws.send(message)
        },
      },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"),
      { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
    )

    try {
      await waitForOpen(ws)
      const incoming = waitForRawMessage(ws)
      ws.send(new Uint8Array([0, 1, 127, 255]))
      const data = await incoming
      expect(Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data as Uint8Array)).toEqual(Buffer.from([0, 1, 127, 255]))
    } finally {
      ws.close()
      relay.stop(true)
      host.stop(true)
    }
  })

  test("closes cloud WebSocket clients when the upstream open watchdog fires", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    class HangingUpstreamWebSocket {
      readyState: number = WebSocket.CONNECTING
      binaryType: BinaryType = "arraybuffer"
      bufferedAmount = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      send() {}
      close(code = 1000, reason = "") {
        this.readyState = WebSocket.CLOSED
        this.onclose?.({ code, reason } as CloseEvent)
      }
    }
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://cloud.example.test",
        access: "cloud",
        backing: "cloud-vm",
      }),
    }, {
      upstreamWebSocket: HangingUpstreamWebSocket as unknown as WorkspaceRelayBunOptions["upstreamWebSocket"],
      upstreamWebSocketOpenTimeoutMs: 20,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"),
      { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
    )

    try {
      await waitForOpen(ws)
      await expect(waitForClose(ws)).resolves.toMatchObject({
        reason: "Upstream WebSocket open timed out",
      })
    } finally {
      ws.close()
      relay.stop(true)
    }
  })

  test("bounds the cloud WebSocket pre-open queue", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    class HangingUpstreamWebSocket {
      readyState: number = WebSocket.CONNECTING
      binaryType: BinaryType = "arraybuffer"
      bufferedAmount = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      send() {}
      close(code = 1000, reason = "") {
        this.readyState = WebSocket.CLOSED
        this.onclose?.({ code, reason } as CloseEvent)
      }
    }
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://cloud.example.test",
        access: "cloud",
        backing: "cloud-vm",
      }),
    }, {
      upstreamWebSocket: HangingUpstreamWebSocket as unknown as WorkspaceRelayBunOptions["upstreamWebSocket"],
      upstreamWebSocketOpenTimeoutMs: 5_000,
      upstreamWebSocketPreOpenQueueMaxFrames: 1,
      // Both bounds must be exceeded to close, so the byte bound has to be tiny
      // here too — otherwise these small frames are admitted (which is the
      // point of the byte bound) and the socket survives to the open timeout.
      upstreamWebSocketPreOpenQueueMaxBytes: 1,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"),
      { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
    )

    try {
      await waitForOpen(ws)
      const closed = waitForClose(ws)
      ws.send("first")
      ws.send("second")
      await expect(closed).resolves.toMatchObject({
        reason: "Upstream WebSocket queue limit exceeded",
      })
    } finally {
      ws.close()
      relay.stop(true)
    }
  })

  test("emits opt-in cloud WebSocket upstream timing trace", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    class SlowOpenUpstreamWebSocket {
      static instances: SlowOpenUpstreamWebSocket[] = []
      readyState: number = WebSocket.CONNECTING
      binaryType: BinaryType = "arraybuffer"
      bufferedAmount = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      sent: Array<string | Buffer<ArrayBuffer>> = []
      constructor() {
        SlowOpenUpstreamWebSocket.instances.push(this)
        setTimeout(() => {
          this.readyState = WebSocket.OPEN
          this.onopen?.({} as Event)
          setTimeout(() => {
            this.onmessage?.({
              data: JSON.stringify({ type: "ready" }),
            } as MessageEvent)
          }, 0)
        }, 20)
      }
      send(message: string | Buffer<ArrayBuffer>) {
        this.sent.push(message)
      }
      close(code = 1000, reason = "") {
        this.readyState = WebSocket.CLOSED
        this.onclose?.({ code, reason } as CloseEvent)
      }
    }
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://cloud.example.test",
        access: "cloud",
        backing: "cloud-vm",
      }),
    }, {
      upstreamWebSocket: SlowOpenUpstreamWebSocket as unknown as WorkspaceRelayBunOptions["upstreamWebSocket"],
      upstreamWebSocketOpenTimeoutMs: 5_000,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"),
      {
        headers: {
          origin: "http://localhost:3000",
          "x-claxedo-relay-ws-trace": "1",
        },
        protocols: [`claxedo-rat.${token}`],
      },
    )

    try {
      await waitForOpen(ws)
      const messages = new Promise<string[]>((resolve, reject) => {
        const received: string[] = []
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for trace and ready")), 1_000)
        ws.onmessage = (event) => {
          received.push(String(event.data))
          if (received.length < 2) return
          clearTimeout(timeout)
          resolve(received)
        }
      })
      ws.send("queued-before-upstream")
      const received = await messages
      const trace = JSON.parse(received[0]!) as {
        type?: string
        wsUpstreamOpenMs?: number
        queuedFrames?: number
        maxQueuedDelayMs?: number
      }
      expect(trace.type).toBe("relay.trace")
      expect(trace.wsUpstreamOpenMs).toBeGreaterThanOrEqual(0)
      expect(trace.queuedFrames).toBe(1)
      expect(trace.maxQueuedDelayMs).toBeGreaterThanOrEqual(0)
      expect(JSON.parse(received[1]!) as { type?: string }).toMatchObject({ type: "ready" })
      expect(SlowOpenUpstreamWebSocket.instances[0]?.sent).toEqual(["queued-before-upstream"])
    } finally {
      ws.close()
      relay.stop(true)
    }
  })

  test("clamps invalid cloud upstream close codes before closing the client", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    class InvalidCloseUpstreamWebSocket {
      readyState: number = WebSocket.CONNECTING
      binaryType: BinaryType = "arraybuffer"
      bufferedAmount = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      constructor() {
        setTimeout(() => {
          this.readyState = WebSocket.OPEN
          this.onopen?.({} as Event)
          this.readyState = WebSocket.CLOSED
          this.onclose?.({ code: 1005, reason: "reserved close" } as CloseEvent)
        }, 0)
      }
      send() {}
      close(code = 1000, reason = "") {
        this.readyState = WebSocket.CLOSED
        this.onclose?.({ code, reason } as CloseEvent)
      }
    }
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://cloud.example.test",
        access: "cloud",
        backing: "cloud-vm",
      }),
    }, {
      upstreamWebSocket: InvalidCloseUpstreamWebSocket as unknown as WorkspaceRelayBunOptions["upstreamWebSocket"],
      upstreamWebSocketOpenTimeoutMs: 5_000,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"),
      { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
    )

    try {
      await waitForOpen(ws)
      await expect(waitForClose(ws)).resolves.toMatchObject({
        code: 1011,
        reason: "reserved close",
      })
    } finally {
      ws.close()
      relay.stop(true)
    }
  })

  test("adds a reason when cloud upstream closes abnormally without one", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    class AbnormalCloseUpstreamWebSocket {
      readyState: number = WebSocket.CONNECTING
      binaryType: BinaryType = "arraybuffer"
      bufferedAmount = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      constructor() {
        setTimeout(() => {
          this.readyState = WebSocket.OPEN
          this.onopen?.({} as Event)
          this.readyState = WebSocket.CLOSED
          this.onclose?.({ code: 1006, reason: "" } as CloseEvent)
        }, 0)
      }
      send() {}
      close(code = 1000, reason = "") {
        this.readyState = WebSocket.CLOSED
        this.onclose?.({ code, reason } as CloseEvent)
      }
    }
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://cloud.example.test",
        access: "cloud",
        backing: "cloud-vm",
      }),
    }, {
      upstreamWebSocket: AbnormalCloseUpstreamWebSocket as unknown as WorkspaceRelayBunOptions["upstreamWebSocket"],
      upstreamWebSocketOpenTimeoutMs: 5_000,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"),
      { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
    )

    try {
      await waitForOpen(ws)
      await expect(waitForClose(ws)).resolves.toMatchObject({
        code: 1011,
        reason: "Upstream WebSocket closed abnormally",
      })
    } finally {
      ws.close()
      relay.stop(true)
    }
  })

  test("proxies cloud HTTP with relay-owned CORS headers", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const host = Bun.serve({
      port: 0,
      fetch() {
        return new Response("cloud-ok", {
          headers: {
            "access-control-allow-origin": "http://localhost:4482",
            "content-type": "text/plain",
            "server-timing": "runtime-handler;dur=1.23",
          },
        })
      },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      const preflight = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.url), {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:4482",
        },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:4482")
      expect(preflight.headers.get("access-control-allow-headers")).toContain("X-OpenCode-Directory")
      expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Claxedo-Runner")
      expect(preflight.headers.get("access-control-allow-headers")).toContain("Last-Event-ID")
      expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Fetch-Bypass-Throttle")

      const res = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.url), {
        headers: {
          authorization: `Bearer ${token}`,
          origin: "http://localhost:4482",
        },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:4482")
      expect(res.headers.get("access-control-allow-origin")?.split(",")).toEqual(["http://localhost:4482"])
      const timing = res.headers.get("server-timing") ?? ""
      expect(timing).toContain("runtime-handler;dur=1.23")
      for (const phase of ["rat-verify", "rat-active", "target-resolve", "rht-mint", "upstream-fetch", "relay-total"]) {
        expect(timing).toContain(`${phase};dur=`)
      }
      await expect(res.text()).resolves.toBe("cloud-ok")
    } finally {
      relay.stop(true)
      host.stop(true)
    }
  })

  test("reuses cached Relay Host Tokens on Bun HTTP while preserving revocation checks", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const authorizations: string[] = []
    let revocationCalls = 0
    const host = Bun.serve({
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get("authorization") ?? "")
        return new Response("cloud-ok")
      },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      relayHostTokenCacheTtlMs: 30_000,
      isRuntimeAccessTokenActive: async () => {
        revocationCalls += 1
        return { active: true }
      },
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      const first = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      const second = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      await expect(first.text()).resolves.toBe("cloud-ok")
      await expect(second.text()).resolves.toBe("cloud-ok")
      expect(revocationCalls).toBe(2)
      expect(authorizations).toHaveLength(2)
      expect(authorizations[0]).toBe(authorizations[1])
      expect(first.headers.get("server-timing") ?? "").toContain("rht-mint;dur=")
      expect(second.headers.get("server-timing") ?? "").toContain("rht-cache;dur=")
    } finally {
      relay.stop(true)
      host.stop(true)
    }
  })

  test("maps cloud HTTP upstream timeout to 504", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const host = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {})
      },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    }, {
      directHttpTimeoutMs: 50,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      const res = await fetch(new URL("/workspaces/ws_1/api/slow", relay.url), {
        headers: {
          authorization: `Bearer ${token}`,
          origin: "http://localhost:4482",
        },
      })
      expect(res.status).toBe(504)
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:4482")
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "upstream_timeout",
          message: "Workspace upstream timed out",
        },
      })
    } finally {
      relay.stop(true)
      host.stop(true)
    }
  })

  test("limits concurrent cloud HTTP upstream fetches when configured", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    let active = 0
    let maxActive = 0
    const host = Bun.serve({
      port: 0,
      async fetch() {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 40))
        active--
        return new Response("cloud-ok")
      },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    }, {
      directHttpConcurrency: 1,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      const headers = { authorization: `Bearer ${token}` }
      const [first, second] = await Promise.all([
        fetch(new URL("/workspaces/ws_1/api/wr/health?i=1", relay.url), { headers }),
        fetch(new URL("/workspaces/ws_1/api/wr/health?i=2", relay.url), { headers }),
      ])

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(maxActive).toBe(1)
      expect(first.headers.get("server-timing") ?? "").toContain("direct-http-queue;dur=")
      expect(second.headers.get("server-timing") ?? "").toContain("direct-http-queue;dur=")
    } finally {
      relay.stop(true)
      host.stop(true)
    }
  })

  test("registers user-hosted tunnel presence and responds to heartbeat pings", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory({ ttlMs: 10_000 })
    const observer = observeDirectory(directory)
    const auditEvents: unknown[] = []
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: async () => undefined,
      audit: (event) => {
        auditEvents.push(event)
      },
    }, {
      // T19: disable debounce so connected audit fires immediately for this assertion.
      hostTunnelStateDebounceMs: 0,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintHostTunnelToken({
      subject: "user_1",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
    }, runtime.privateKey, "EdDSA")
    const ws = hostTunnelSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
      token,
    )

    try {
      await waitForOpen(ws)
      await expect(observer.waitForPresence()).resolves.toMatchObject({
        hostId: "host_1",
        workspaceIds: ["ws_1"],
      })
      const pong = waitForMessage(ws)
      ws.send(JSON.stringify({
        type: "ping",
        protocol: TUNNEL_PROTOCOL_VERSION,
        id: "ping_1",
        sent_at: 1,
      }))

      await expect(pong.then((message) => JSON.parse(message) as TunnelPong)).resolves.toMatchObject({
        type: "pong",
        protocol: TUNNEL_PROTOCOL_VERSION,
        id: "ping_1",
        sent_at: 1,
      })
      // Wait one macrotask so the debounce-flush microtask runs.
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(auditEvents).toContainEqual({
        action: "host_tunnel.connected",
        result: "allow",
        hostId: "host_1",
        workspaceId: "ws_1",
        method: "WEBSOCKET",
        path: "/host-tunnels/host_1",
      })
    } finally {
      ws.close()
      relay.stop(true)
    }
  })

  test("updates a host registration on the existing WebSocket after re-authorizing the workspace set", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory({ ttlMs: 10_000 })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: async () => undefined,
    })
    const relay = Bun.serve({ port: 0, fetch: relayHandler.fetch, websocket: relayHandler.websocket })
    const initialToken = await mintHostTunnelToken({
      subject: "user_1",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
    }, runtime.privateKey, "EdDSA")
    const updateToken = await mintHostTunnelToken({
      subject: "user_1",
      hostId: "host_1",
      workspaceIds: ["ws_1", "ws_2"],
    }, runtime.privateKey, "EdDSA")
    const ws = hostTunnelSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
      initialToken,
    )

    try {
      await waitForOpen(ws)
      ws.send(JSON.stringify({
        type: "host.registration.update",
        protocol: TUNNEL_PROTOCOL_VERSION,
        workspace_ids: ["ws_1", "ws_2"],
        token: updateToken,
      }))
      const deadline = Date.now() + 1_000
      while (!directory.activeHost({ hostId: "host_1", workspaceId: "ws_2" }) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      expect(directory.activeHost({ hostId: "host_1", workspaceId: "ws_2" })).toMatchObject({
        hostId: "host_1",
        workspaceIds: ["ws_1", "ws_2"],
      })
      expect(ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      ws.close()
      relay.stop(true)
    }
  })

  test("sends relay heartbeat pings and records host tunnel pongs", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory({ ttlMs: 10_000 })
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: async () => undefined,
    }, {
      authorizeHostTunnel: () => true,
      hostTunnelPingIntervalMs: 1,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const ws = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )

    try {
      await waitForOpen(ws)
      const presence = await observer.waitForPresence()
      const ping = await waitForMessage(ws).then((message) => JSON.parse(message) as {
        type: string
        id: string
        sent_at: number
      })
      expect(ping.type).toBe("ping")
      ws.send(JSON.stringify({
        type: "pong",
        protocol: TUNNEL_PROTOCOL_VERSION,
        id: ping.id,
        sent_at: ping.sent_at,
        received_at: Date.now(),
      }))

      await expect(observer.waitForFreshPong(presence.connectedAt)).resolves.toMatchObject({
        hostId: "host_1",
      })
    } finally {
      ws.close()
      relay.stop(true)
    }
  })

  test("closes zombie host tunnels after missed relay pongs", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory({ ttlMs: 10_000 })
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: async () => undefined,
    }, {
      authorizeHostTunnel: () => true,
      hostTunnelPingIntervalMs: 10,
      hostTunnelMaxMissedPongs: 1,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const ws = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )

    try {
      await waitForOpen(ws)
      await observer.waitForPresence()
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.onclose = (event) => resolve({ code: event.code, reason: event.reason })
      })
      await expect(closed).resolves.toMatchObject({
        reason: "Host tunnel heartbeat timed out",
      })
      await expect(observer.waitForOffline()).resolves.toBeUndefined()
    } finally {
      ws.close()
      relay.stop(true)
    }
  })

  test("forwards user-hosted HTTP requests over the registered tunnel", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string
        request_id: string
        path: string
        headers: Record<string, string>
      }
      if (message.type !== "http.request") return
      expect(message.path).toBe("/api/wr/health?verbose=1")
      expect(message.headers.authorization?.startsWith("Bearer ")).toBe(true)
      expect(message.headers["x-workspace-id"]).toBe("ws_1")
      host.send(JSON.stringify({
        type: "http.response.start",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        status: 202,
        headers: {
          "content-type": "text/plain",
        },
      }))
      host.send(JSON.stringify({
        type: "http.response.chunk",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        body_base64: Buffer.from("tunnel-ok").toString("base64"),
      }))
      host.send(JSON.stringify({
        type: "http.response.end",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
      }))
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/wr/health?verbose=1", relay.url), {
        headers: {
          authorization: `Bearer ${token}`,
        },
      })

      expect(res.status).toBe(202)
      await expect(res.text()).resolves.toBe("tunnel-ok")
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("rejects user-hosted HTTP request bodies over the configured cap", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
      tunnelRequestBodyMaxBytes: 8,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    let forwarded = false
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string }
      if (message.type === "http.request") forwarded = true
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/upload", relay.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          origin: "http://localhost:4482",
        },
        body: "this body is too large",
      })

      expect(res.status).toBe(413)
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:4482")
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "request_body_too_large",
          message: "Tunnel request body exceeds the relay limit",
        },
      })
      expect(forwarded).toBe(false)
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("returns user-hosted offline after the host tunnel closes", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      host.close()
      await observer.waitForOffline()

      const res = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.url), {
        headers: {
          authorization: `Bearer ${token}`,
        },
      })

      expect(res.status).toBe(503)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "user_hosted_app_offline",
          message: "User-hosted workspace is offline",
        },
      })
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("streams user-hosted large HTTP responses before the tunnel response ends", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    const firstChunk = Buffer.alloc(64 * 1024, "a")
    const secondChunk = Buffer.alloc(64 * 1024, "b")
    let requestId = ""
    let resolveRequest!: () => void
    const requestSeen = new Promise<void>((resolve) => {
      resolveRequest = resolve
    })
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string
        request_id: string
        path: string
      }
      if (message.type !== "http.request") return
      expect(message.path).toBe("/file/content?path=large.bin")
      requestId = message.request_id
      host.send(JSON.stringify({
        type: "http.response.start",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: requestId,
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
        },
      }))
      host.send(JSON.stringify({
        type: "http.response.chunk",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: requestId,
        body_base64: firstChunk.toString("base64"),
      }))
      resolveRequest()
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/file/content?path=large.bin", relay.url), {
        headers: {
          authorization: `Bearer ${token}`,
        },
      })
      await requestSeen
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("application/octet-stream")

      const reader = res.body!.getReader()
      await expect(readExactBytes(reader, firstChunk.byteLength)).resolves.toEqual(new Uint8Array(firstChunk))

      host.send(JSON.stringify({
        type: "http.response.chunk",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: requestId,
        body_base64: secondChunk.toString("base64"),
      }))
      host.send(JSON.stringify({
        type: "http.response.end",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: requestId,
      }))
      await expect(readExactBytes(reader, secondChunk.byteLength)).resolves.toEqual(new Uint8Array(secondChunk))
      await expect(reader.read()).resolves.toMatchObject({ done: true })
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("fails pending user-hosted HTTP when the tunnel sends an error frame", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; request_id: string }
      if (message.type !== "http.request") return
      host.send(JSON.stringify({
        type: "error",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        code: "host_tunnel_http_failed",
        message: "local runtime failed",
      }))
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/fails", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })

      expect(res.status).toBe(502)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "host_tunnel_http_failed",
          message: "local runtime failed",
        },
      })
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("times out a started tunnel HTTP stream and cleans the pending entry", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
      tunnelHttpResponseTimeoutMs: 50,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    let requestCount = 0
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; request_id: string }
      if (message.type !== "http.request") return
      requestCount += 1
      if (requestCount === 1) {
        host.send(JSON.stringify({
          type: "http.response.start",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: message.request_id,
          status: 200,
          headers: { "content-type": "text/plain" },
        }))
        return
      }
      host.send(JSON.stringify({
        type: "http.response.start",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        status: 204,
        headers: {},
      }))
      host.send(JSON.stringify({
        type: "http.response.end",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
      }))
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/never-ends", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      await expect(Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("reader did not close after tunnel timeout")), 2_000)),
      ])).resolves.toMatchObject({ done: true })

      const after = await fetch(new URL("/workspaces/ws_1/api/after-timeout", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(after.status).toBe(204)
      expect(requestCount).toBe(2)
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("keeps user-hosted SSE streams open past the tunnel response timeout", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
      // Wide enough that http.response.start reliably lands INSIDE the window
      // even on a starved 2-core CI runner — a start that misses the window
      // times out a never-started request and the fetch below hangs forever.
      // The SSE chunk is delayed past the window (below), which is the
      // behavior under test: an already-started SSE stream must survive it.
      tunnelHttpResponseTimeoutMs: 2_000,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    let requestCount = 0
    let delayedChunk: ReturnType<typeof setTimeout> | undefined
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; request_id: string }
      if (message.type !== "http.request") return
      requestCount += 1
      host.send(JSON.stringify({
        type: "http.response.start",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }))
      delayedChunk = setTimeout(() => {
        host.send(JSON.stringify({
          type: "http.response.chunk",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: message.request_id,
          body_base64: Buffer.from("data: still-open\n\n").toString("base64"),
        }))
        host.send(JSON.stringify({
          type: "http.response.end",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: message.request_id,
        }))
      }, 2_600)
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/events", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const reader = res.body!.getReader()
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE chunk did not arrive")), 10_000)),
      ])
      expect(chunk.done).toBe(false)
      expect(new TextDecoder().decode(chunk.value)).toBe("data: still-open\n\n")
      expect(requestCount).toBe(1)
    } finally {
      if (delayedChunk) clearTimeout(delayedChunk)
      host.close()
      relay.stop(true)
    }
  })

  test("keeps direct-cloud SSE streams open past Bun's default idle timeout", async () => {
    expect(WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(30)
    expect(WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(60)
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const encoder = new TextEncoder()
    let delayedChunk: ReturnType<typeof setTimeout> | undefined
    const host = Bun.serve({
      port: 0,
      idleTimeout: 20,
      fetch() {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(": connected\n\n"))
            delayedChunk = setTimeout(() => {
              controller.enqueue(encoder.encode("data: still-open\n\n"))
              controller.close()
            }, 11_000)
          },
          cancel() {
            if (delayedChunk) clearTimeout(delayedChunk)
          },
        }), {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        })
      },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    })
    const relay = Bun.serve({
      port: 0,
      idleTimeout: WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      const res = await fetch(new URL("/workspaces/ws_1/api/wr/events", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const reader = res.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n")
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE chunk did not arrive")), 15_000)),
      ])
      expect(chunk.done).toBe(false)
      expect(new TextDecoder().decode(chunk.value)).toBe("data: still-open\n\n")
    } finally {
      if (delayedChunk) clearTimeout(delayedChunk)
      relay.stop(true)
      host.stop(true)
    }
  }, 20_000)

  test("multiplexes user-hosted WebSocket frames over the registered tunnel", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    let channelId = ""
    let resolveOpen!: (message: Record<string, unknown>) => void
    let resolveFrame!: (message: Record<string, unknown>) => void
    const opened = new Promise<Record<string, unknown>>((resolve) => {
      resolveOpen = resolve
    })
    const framed = new Promise<Record<string, unknown>>((resolve) => {
      resolveFrame = resolve
    })
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      if (message.type === "ws.open") {
        channelId = String(message.channel_id)
        resolveOpen(message)
        host.send(JSON.stringify({
          type: "ws.frame",
          protocol: TUNNEL_PROTOCOL_VERSION,
          channel_id: channelId,
          binary: false,
          data_base64: Buffer.from("from-host").toString("base64"),
        }))
      }
      if (message.type === "ws.frame") resolveFrame(message)
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const client = new (WebSocket as unknown as {
        new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
      })(
        new URL("/workspaces/ws_1/api/claxedo/pty/pty_1/connect", relay.url).toString().replace(/^http/, "ws"),
        { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
      )
      try {
        await waitForOpen(client)
        const clientMessage = waitForMessage(client)

        await expect(opened).resolves.toMatchObject({
          type: "ws.open",
          workspace_id: "ws_1",
          path: "/api/claxedo/pty/pty_1/connect",
        })
        await expect(clientMessage).resolves.toBe("from-host")
        client.send("from-client")
        await expect(framed.then((message) => Buffer.from(String(message.data_base64), "base64").toString("utf8")))
          .resolves.toBe("from-client")
      } finally {
        client.close()
      }
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("closes an idle user-hosted channel and notifies its host after token revocation", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    let active = true
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      isRuntimeAccessTokenActive: () => active
        ? { active: true as const }
        : { active: false as const, code: "runtime_access_token_revoked", reason: "Runtime Access Token has been revoked" },
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
      runtimeAccessTokenActiveCheckIntervalMs: 5,
    })
    const relay = Bun.serve({ port: 0, fetch: relayHandler.fetch, websocket: relayHandler.websocket })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    const hostClose = new Promise<Record<string, unknown>>((resolve) => {
      host.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>
        if (message.type === "ws.close") resolve(message)
      }
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const client = new (WebSocket as unknown as {
        new(url: string, options: { headers: Record<string, string>; protocols: string[] }): WebSocket
      })(new URL("/workspaces/ws_1/api/claxedo/pty/pty_1/connect", relay.url).toString().replace(/^http/, "ws"), {
        headers: { origin: "http://localhost:3000" },
        protocols: [`claxedo-rat.${token}`],
      })
      try {
        await waitForOpen(client)
        const closed = waitForClose(client)
        active = false
        await expect(closed).resolves.toEqual({ code: 1008, reason: "Runtime Access Token has been revoked" })
        await expect(hostClose).resolves.toMatchObject({ type: "ws.close", code: 1008 })
      } finally {
        client.close()
      }
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("round-trips binary user-hosted WebSocket frames through the tunnel", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    let channelId = ""
    const clientFrame = new Promise<Record<string, unknown>>((resolve) => {
      host.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>
        if (message.type === "ws.open") {
          channelId = String(message.channel_id)
          host.send(JSON.stringify({
            type: "ws.frame",
            protocol: TUNNEL_PROTOCOL_VERSION,
            channel_id: channelId,
            binary: true,
            data_base64: Buffer.from([9, 8, 7, 6]).toString("base64"),
          }))
        }
        if (message.type === "ws.frame") resolve(message)
      }
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const client = new (WebSocket as unknown as {
        new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
      })(
        new URL("/workspaces/ws_1/api/claxedo/pty/pty_binary/connect", relay.url).toString().replace(/^http/, "ws"),
        { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
      )
      try {
        await waitForOpen(client)
        const hostBytes = waitForRawMessage(client)
        const data = await hostBytes
        expect(Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data as Uint8Array)).toEqual(Buffer.from([9, 8, 7, 6]))

        client.send(new Uint8Array([1, 3, 3, 7]))
        await expect(clientFrame.then((message) => ({
          binary: message.binary,
          bytes: Buffer.from(String(message.data_base64), "base64"),
        }))).resolves.toEqual({
          binary: true,
          bytes: Buffer.from([1, 3, 3, 7]),
        })
      } finally {
        client.close()
      }
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("clamps invalid host-tunnel ws.close codes before closing user clients", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      if (message.type !== "ws.open") return
      host.send(JSON.stringify({
        type: "ws.close",
        protocol: TUNNEL_PROTOCOL_VERSION,
        channel_id: String(message.channel_id),
        code: 1005,
        reason: "reserved host close",
      }))
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const client = new (WebSocket as unknown as {
        new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
      })(
        new URL("/workspaces/ws_1/api/claxedo/pty/pty_close/connect", relay.url).toString().replace(/^http/, "ws"),
        { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
      )
      try {
        await waitForOpen(client)
        await expect(waitForClose(client)).resolves.toMatchObject({
          code: 1011,
          reason: "reserved host close",
        })
      } finally {
        client.close()
      }
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("denies host tunnel registration when the adapter authorizer rejects it", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory: createWorkspaceRelayDirectory(),
      resolveTarget: async () => undefined,
    }, {
      authorizeHostTunnel: () => false,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })

    try {
      const res = await fetch(new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url), {
        headers: {
          upgrade: "websocket",
        },
      })

      expect(res.status).toBe(403)
      await expect(res.text()).resolves.toBe("Host tunnel registration denied")
    } finally {
      relay.stop(true)
    }
  })

  test("denies host tunnel registration without a signed Host Tunnel Token", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory: createWorkspaceRelayDirectory(),
      resolveTarget: async () => undefined,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })

    try {
      const res = await fetch(new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url), {
        headers: {
          upgrade: "websocket",
        },
      })

      expect(res.status).toBe(403)
      await expect(res.text()).resolves.toBe("Host tunnel registration denied")
    } finally {
      relay.stop(true)
    }
  })

  test("rejects new in-flight tunnel HTTP requests when pending cap is reached", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    const seenRequestIds: string[] = []
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string
        request_id: string
      }
      if (message.type === "http.request") {
        seenRequestIds.push(message.request_id)
      }
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()

      const inflight: Promise<Response>[] = []
      // Saturate the pending map (cap is 32). Don't send responses from the host yet.
      for (let i = 0; i < 32; i++) {
        inflight.push(fetch(new URL(`/workspaces/ws_1/api/wr/slow?i=${i}`, relay.url), {
          headers: { authorization: `Bearer ${token}` },
        }))
      }
      // Wait until the host has seen all 32 requests so they're all in `pending`.
      const deadline = Date.now() + 4_000
      while (seenRequestIds.length < 32 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(seenRequestIds.length).toBe(32)

      // 33rd request should be rejected with 429.
      const rejected = await fetch(new URL("/workspaces/ws_1/api/wr/slow?i=33", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(rejected.status).toBe(429)
      const body = await rejected.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe("too_many_in_flight")

      // Complete one request → make room. Drain all 32 since we don't know which fetch
      // promise corresponds to seenRequestIds[0].
      for (const id of seenRequestIds) {
        host.send(JSON.stringify({
          type: "http.response.start",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: id,
          status: 200,
          headers: { "content-type": "text/plain" },
        }))
        host.send(JSON.stringify({
          type: "http.response.end",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: id,
        }))
      }
      await Promise.all(inflight)

      // Now a new request should succeed (no longer 429).
      let nextHandled = false
      host.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string
          request_id: string
        }
        if (message.type === "http.request" && !nextHandled) {
          nextHandled = true
          host.send(JSON.stringify({
            type: "http.response.start",
            protocol: TUNNEL_PROTOCOL_VERSION,
            request_id: message.request_id,
            status: 200,
            headers: { "content-type": "text/plain" },
          }))
          host.send(JSON.stringify({
            type: "http.response.end",
            protocol: TUNNEL_PROTOCOL_VERSION,
            request_id: message.request_id,
          }))
        }
      }
      const accepted = await fetch(new URL("/workspaces/ws_1/api/wr/after?i=34", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(accepted.status).toBe(200)
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("rejects new WS channel opens when channels cap is reached", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()

      // Open 16 WS channels.
      const clients: WebSocket[] = []
      for (let i = 0; i < 16; i++) {
        const c = new (WebSocket as unknown as {
          new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
        })(
          new URL(`/workspaces/ws_1/api/claxedo/pty/pty_${i}/connect`, relay.url).toString().replace(/^http/, "ws"),
          { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
        )
        await waitForOpen(c)
        clients.push(c)
      }

      // Wait for the host to see all 16 ws.open messages — channels are added on relay-side open.
      // Brief settle to let the close-cap effect propagate to channels Map.
      await new Promise((r) => setTimeout(r, 50))

      // 17th attempt should be rejected with HTTP 503 + body code too_many_channels.
      const res = await fetch(new URL("/workspaces/ws_1/api/claxedo/pty/pty_17/connect", relay.url), {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          upgrade: "websocket",
          connection: "upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          origin: "http://localhost:3000",
        },
      })
      expect(res.status).toBe(503)
      const body = await res.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe("too_many_channels")

      for (const c of clients) c.close()
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("configures Bun.serve websocket maxPayloadLength to 16 MB", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: async () => undefined,
    })
    const ws = relayHandler.websocket as Bun.WebSocketHandler<unknown> & { maxPayloadLength?: number }
    expect(ws.maxPayloadLength).toBe(16 * 1024 * 1024)
  })

  test("keeps one active host tunnel per host_id and ignores stale close events", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })

    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const first = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    let firstSawRequest = false
    first.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string }
      if (message.type === "http.request") firstSawRequest = true
    }
    let secondRequestId = ""
    let second: WebSocket | undefined

    try {
      await waitForOpen(first)
      await observer.waitForPresence()
      second = new WebSocket(
        new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
      )
      second.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; request_id: string }
        if (message.type !== "http.request") return
        secondRequestId = message.request_id
        second!.send(JSON.stringify({
          type: "http.response.start",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: message.request_id,
          status: 200,
          headers: { "content-type": "text/plain" },
        }))
        second!.send(JSON.stringify({
          type: "http.response.chunk",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: message.request_id,
          body_base64: Buffer.from("from-second").toString("base64"),
        }))
        second!.send(JSON.stringify({
          type: "http.response.end",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: message.request_id,
        }))
      }
      await waitForOpen(second!)
      await observer.waitForPresence()

      first.close()
      await new Promise((resolve) => setTimeout(resolve, 100))
      await expect(observer.waitForPresence()).resolves.toMatchObject({ hostId: "host_1" })

      const res = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.url), {
        headers: {
          authorization: `Bearer ${token}`,
          origin: "http://localhost:4482",
        },
      })
      expect(res.status).toBe(200)
      await expect(res.text()).resolves.toBe("from-second")
      expect(firstSawRequest).toBe(false)
      expect(secondRequestId).toBeTruthy()
    } finally {
      first.close()
      second?.close()
      relay.stop(true)
    }
  })

  test("rejects user→relay WS upgrades with a disallowed Origin", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://upstream.invalid",
        access: "cloud",
        backing: "cloud-vm",
      }),
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      const res = await fetch(new URL("/workspaces/ws_1/api/ws", relay.url), {
        headers: {
          upgrade: "websocket",
          connection: "upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": `claxedo-rat.${token}`,
          origin: "https://evil.example.com",
        },
      })
      expect(res.status).toBe(403)
      const body = await res.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe("origin_not_allowed")
    } finally {
      relay.stop(true)
    }
  })

  test("honors configured allowedOrigins for user WebSocket upgrades", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const host = Bun.serve<{ ok: true }>({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: { ok: true } })) return
        return new Response("upgrade failed", { status: 400 })
      },
      websocket: { message() {} },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      allowedOrigins: ["https://selfhost.example.com"],
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    })
    const relay = Bun.serve({ port: 0, fetch: relayHandler.fetch, websocket: relayHandler.websocket })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const custom = new (WebSocket as unknown as {
      new(url: string, options: { headers: Record<string, string>; protocols: string[] }): WebSocket
    })(new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"), {
      headers: { origin: "https://selfhost.example.com" },
      protocols: [`claxedo-rat.${token}`],
    })

    try {
      await waitForOpen(custom)
      const product = await fetch(new URL("/workspaces/ws_1/api/ws", relay.url), {
        headers: {
          upgrade: "websocket",
          connection: "upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": `claxedo-rat.${token}`,
          origin: "https://app.claxedo.com",
        },
      })
      expect(product.status).toBe(403)
      await expect(product.json()).resolves.toMatchObject({ error: { code: "origin_not_allowed" } })
    } finally {
      custom.close()
      relay.stop(true)
      host.stop(true)
    }
  })

  test("closes an idle Bun WebSocket after its Runtime Access Token is revoked", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const host = Bun.serve<{ ok: true }>({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: { ok: true } })) return
        return new Response("upgrade failed", { status: 400 })
      },
      websocket: { message() {} },
    })
    let active = true
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      isRuntimeAccessTokenActive: () => active
        ? { active: true as const }
        : { active: false as const, code: "runtime_access_token_revoked", reason: "Runtime Access Token has been revoked" },
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    }, { runtimeAccessTokenActiveCheckIntervalMs: 5 })
    const relay = Bun.serve({ port: 0, fetch: relayHandler.fetch, websocket: relayHandler.websocket })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const client = new (WebSocket as unknown as {
      new(url: string, options: { headers: Record<string, string>; protocols: string[] }): WebSocket
    })(new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"), {
      headers: { origin: "http://localhost:3000" },
      protocols: [`claxedo-rat.${token}`],
    })

    try {
      await waitForOpen(client)
      const closed = waitForClose(client)
      active = false
      await expect(closed).resolves.toEqual({ code: 1008, reason: "Runtime Access Token has been revoked" })
    } finally {
      client.close()
      relay.stop(true)
      host.stop(true)
    }
  })

  test("caps an idle Bun WebSocket lifetime at Runtime Access Token expiry", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const host = Bun.serve<{ ok: true }>({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: { ok: true } })) return
        return new Response("upgrade failed", { status: 400 })
      },
      websocket: { message() {} },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    }, { now: () => Date.now() + 31 * 60_000 })
    const relay = Bun.serve({ port: 0, fetch: relayHandler.fetch, websocket: relayHandler.websocket })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const client = new (WebSocket as unknown as {
      new(url: string, options: { headers: Record<string, string>; protocols: string[] }): WebSocket
    })(new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"), {
      headers: { origin: "http://localhost:3000" },
      protocols: [`claxedo-rat.${token}`],
    })

    try {
      const closed = waitForClose(client)
      await waitForOpen(client)
      await expect(closed).resolves.toEqual({ code: 1008, reason: "Runtime Access Token expired" })
    } finally {
      client.close()
      relay.stop(true)
      host.stop(true)
    }
  })

  test("rejects user→relay WS upgrades with a missing Origin header", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://upstream.invalid",
        access: "cloud",
        backing: "cloud-vm",
      }),
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      const res = await fetch(new URL("/workspaces/ws_1/api/ws", relay.url), {
        headers: {
          upgrade: "websocket",
          connection: "upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": `claxedo-rat.${token}`,
        },
      })
      expect(res.status).toBe(403)
      const body = await res.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe("origin_not_allowed")
    } finally {
      relay.stop(true)
    }
  })

  test("allows user→relay WS upgrades from localhost origin (cloud-vm)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const host = Bun.serve<{ ok: true }>({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: { ok: true } })) {
          return undefined as unknown as Response
        }
        return new Response("upgrade failed", { status: 400 })
      },
      websocket: {
        message(ws, message) {
          ws.send(`host:${message}`)
        },
      },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"),
      { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
    )

    try {
      await waitForOpen(ws)
      const message = waitForMessage(ws)
      ws.send("ping-localhost")
      await expect(message).resolves.toBe("host:ping-localhost")
    } finally {
      ws.close()
      relay.stop(true)
      host.stop(true)
    }
  })

  test("allows user→relay WS upgrades from *.claxedo.com origin (cloud-vm)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const host = Bun.serve<{ ok: true }>({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: { ok: true } })) {
          return undefined as unknown as Response
        }
        return new Response("upgrade failed", { status: 400 })
      },
      websocket: {
        message(ws, message) {
          ws.send(`host:${message}`)
        },
      },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"),
      { headers: { origin: "https://app.claxedo.com" }, protocols: [`claxedo-rat.${token}`] },
    )

    try {
      await waitForOpen(ws)
      const message = waitForMessage(ws)
      ws.send("ping-opencode")
      await expect(message).resolves.toBe("host:ping-opencode")
    } finally {
      ws.close()
      relay.stop(true)
      host.stop(true)
    }
  })

  test("rejects user-hosted user→relay WS upgrades with a disallowed Origin", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()

      const res = await fetch(new URL("/workspaces/ws_1/api/claxedo/pty/pty_1/connect", relay.url), {
        headers: {
          authorization: `Bearer ${token}`,
          upgrade: "websocket",
          connection: "upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          origin: "https://evil.example.com",
        },
      })
      expect(res.status).toBe(403)
      const body = await res.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe("origin_not_allowed")
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("does NOT enforce Origin allowlist on host-tunnel WS upgrades", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: async () => undefined,
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    // Host-tunnel WS upgrade with a non-allowlisted origin must still succeed —
    // host apps may have any origin (or none) and are protected by the HTT, not CORS.
    const ws = new (WebSocket as unknown as {
      new(url: string, options: { headers: Record<string, string> }): WebSocket
    })(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
      { headers: { origin: "https://evil.example.com" } },
    )

    try {
      await waitForOpen(ws)
      await expect(observer.waitForPresence()).resolves.toMatchObject({
        hostId: "host_1",
      })
    } finally {
      ws.close()
      relay.stop(true)
    }
  })

  test("limits host-tunnel reconnects per host_id to 5 within 60 seconds", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory: createWorkspaceRelayDirectory(),
      resolveTarget: async () => undefined,
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })

    try {
      // 5 connect→disconnect cycles
      for (let i = 0; i < 5; i++) {
        const ws = new WebSocket(
          new URL(`/host-tunnels/bob?workspaceId=ws_${i}`, relay.url).toString().replace(/^http/, "ws"),
        )
        await waitForOpen(ws)
        ws.close()
        await new Promise<void>((resolve) => {
          ws.onclose = () => resolve()
          // safety
          setTimeout(resolve, 200)
        })
      }
      // Brief settle.
      await new Promise((r) => setTimeout(r, 50))

      const res = await fetch(new URL("/host-tunnels/bob?workspaceId=ws_x", relay.url), {
        headers: {
          upgrade: "websocket",
        },
      })
      expect(res.status).toBe(429)
      const body = await res.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe("too_many_host_tunnel_reconnects")
    } finally {
      relay.stop(true)
    }
  })

  test("processes a complete tunnel JSON message normally (T11 fragmentation baseline)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string
        request_id: string
      }
      if (message.type !== "http.request") return
      host.send(JSON.stringify({
        type: "http.response.start",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        status: 200,
        headers: { "content-type": "text/plain" },
      }))
      host.send(JSON.stringify({
        type: "http.response.chunk",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        body_base64: Buffer.from("ok-complete").toString("base64"),
      }))
      host.send(JSON.stringify({
        type: "http.response.end",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
      }))
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      await expect(res.text()).resolves.toBe("ok-complete")
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("closes host tunnel with protocol error when tunnel message version mismatches", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: async () => undefined,
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const closed = waitForClose(host)

      host.send(JSON.stringify({
        type: "pong",
        protocol: TUNNEL_PROTOCOL_VERSION + 1,
        id: "pong_1",
        sent_at: 1,
        received_at: 2,
      }))

      const event = await Promise.race([
        closed,
        new Promise<{ code: number; reason: string }>((_, reject) =>
          setTimeout(() => reject(new Error("host tunnel did not close after protocol mismatch")), 5_000),
        ),
      ])
      expect(event).toEqual({
        code: 1002,
        reason: `Tunnel protocol mismatch: expected ${TUNNEL_PROTOCOL_VERSION}`,
      })
    } finally {
      try { host.close() } catch {}
      relay.stop(true)
    }
  })

  test("reassembles a fragmented tunnel JSON message split into two halves (T11)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string
        request_id: string
      }
      if (message.type !== "http.request") return
      // Build a single complete response message and split it in half.
      const startMessage = JSON.stringify({
        type: "http.response.start",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        status: 201,
        headers: { "content-type": "text/plain" },
      })
      const half = Math.floor(startMessage.length / 2)
      host.send(startMessage.slice(0, half))
      host.send(startMessage.slice(half))
      host.send(JSON.stringify({
        type: "http.response.chunk",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        body_base64: Buffer.from("frag-2").toString("base64"),
      }))
      host.send(JSON.stringify({
        type: "http.response.end",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
      }))
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(201)
      await expect(res.text()).resolves.toBe("frag-2")
      // We expect at least one "fragments buffered" event from the partial first half.
      expect(relayHandler.telemetry.getFragmentationStats().fragmentsBuffered).toBeGreaterThanOrEqual(1)
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("reassembles a tunnel JSON message split into three parts (T11)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    host.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string
        request_id: string
      }
      if (message.type !== "http.request") return
      const startMessage = JSON.stringify({
        type: "http.response.start",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        status: 203,
        headers: { "content-type": "text/plain" },
      })
      const third = Math.floor(startMessage.length / 3)
      host.send(startMessage.slice(0, third))
      host.send(startMessage.slice(third, third * 2))
      host.send(startMessage.slice(third * 2))
      host.send(JSON.stringify({
        type: "http.response.chunk",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        body_base64: Buffer.from("three-part").toString("base64"),
      }))
      host.send(JSON.stringify({
        type: "http.response.end",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
      }))
    }
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(203)
      await expect(res.text()).resolves.toBe("three-part")
      // Two fragments buffered (first slice + middle slice both fail to parse).
      expect(relayHandler.telemetry.getFragmentationStats().fragmentsBuffered).toBeGreaterThanOrEqual(2)
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("closes WS with code 1009 when buffered fragments exceed 4 MB cap (T11)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: async () => undefined,
    }, {
      authorizeHostTunnel: () => true,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )

    try {
      await waitForOpen(host)
      await observer.waitForPresence()

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        host.onclose = (event) => resolve({ code: event.code, reason: event.reason })
      })

      // Send fragments that never form valid JSON. Each is just under the 1 MB
      // WS payload cap (T3 enforces 16 MB max, so 1 MB is comfortably under).
      // 5 chunks × 1 MB = 5 MB total which should trip the 4 MB buffer cap.
      const chunk = "{".repeat(1024 * 1024)
      for (let i = 0; i < 5; i++) {
        if (host.readyState !== WebSocket.OPEN) break
        host.send(chunk)
        // Yield so the server processes each frame before the next send.
        await new Promise((r) => setTimeout(r, 10))
      }

      const event = await Promise.race([
        closed,
        new Promise<{ code: number; reason: string }>((_, reject) =>
          setTimeout(() => reject(new Error("WS did not close after oversized fragmented input")), 5000),
        ),
      ])
      expect(event.code).toBe(1009)
      expect(relayHandler.telemetry.getFragmentationStats().oversizedClosed).toBeGreaterThanOrEqual(1)
    } finally {
      try { host.close() } catch {}
      relay.stop(true)
    }
  })

  test("fragmentation counter is exposed and increments per buffered fragment (T11)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: async () => undefined,
    }, {
      authorizeHostTunnel: () => true,
    })
    const before = relayHandler.telemetry.getFragmentationStats()
    expect(before.fragmentsBuffered).toBe(0)
    expect(before.oversizedClosed).toBe(0)
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )

    try {
      await waitForOpen(host)
      await observer.waitForPresence()

      // Send a single partial JSON fragment. It must fail to parse so the
      // server buffers it and increments the counter.
      host.send('{"type":"pi')
      // Wait for the server to process.
      await new Promise((r) => setTimeout(r, 50))
      expect(relayHandler.telemetry.getFragmentationStats().fragmentsBuffered).toBeGreaterThanOrEqual(1)

      // Sending more partial data continues to increment.
      host.send('ng","protoco')
      await new Promise((r) => setTimeout(r, 50))
      expect(relayHandler.telemetry.getFragmentationStats().fragmentsBuffered).toBeGreaterThanOrEqual(2)

      // Finally complete the message; counter should not increment further.
      const before = relayHandler.telemetry.getFragmentationStats().fragmentsBuffered
      host.send(`l":${TUNNEL_PROTOCOL_VERSION},"id":"x","sent_at":1}`)
      await new Promise((r) => setTimeout(r, 50))
      expect(relayHandler.telemetry.getFragmentationStats().fragmentsBuffered).toBe(before)
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  // T12: Slow-consumer backpressure on tunnel HTTP responses.
  test("normal flow under HWM streams all chunks without backpressure (T12)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
      // Keep defaults for HWM (8 MB) and slow-consumer timeout (30 s);
      // total payload is well under the HWM in this test.
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    // Send 8 chunks of 512 KB each = 4 MB total, comfortably under the 8 MB HWM.
    const chunkSize = 512 * 1024
    const chunkCount = 8
    const totalBytes = chunkSize * chunkCount
    let requestId = ""
    const requestSeen = new Promise<void>((resolve) => {
      host.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; request_id: string }
        if (message.type !== "http.request") return
        requestId = message.request_id
        host.send(JSON.stringify({
          type: "http.response.start",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: requestId,
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }))
        for (let i = 0; i < chunkCount; i++) {
          const buf = Buffer.alloc(chunkSize, String.fromCharCode(0x61 + i))
          host.send(JSON.stringify({
            type: "http.response.chunk",
            protocol: TUNNEL_PROTOCOL_VERSION,
            request_id: requestId,
            body_base64: buf.toString("base64"),
          }))
        }
        host.send(JSON.stringify({
          type: "http.response.end",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: requestId,
        }))
        resolve()
      }
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/wr/file", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      await requestSeen
      expect(res.status).toBe(200)
      const body = new Uint8Array(await res.arrayBuffer())
      expect(body.byteLength).toBe(totalBytes)
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  test("slow consumer triggers backpressure pause and drains on read (T12)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
      // Lower the HWM so the test doesn't have to push 8 MB across the WS.
      slowConsumerHighWaterMarkBytes: 256 * 1024,
      // Keep the slow-consumer timeout long so the test only verifies pause/resume.
      slowConsumerTimeoutMs: 5_000,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    const chunkSize = 64 * 1024
    const chunkCount = 8 // 512 KB total; HWM is 256 KB.
    let requestId = ""
    const allChunksSent = new Promise<void>((resolve) => {
      host.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; request_id: string }
        if (message.type !== "http.request") return
        requestId = message.request_id
        host.send(JSON.stringify({
          type: "http.response.start",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: requestId,
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }))
        for (let i = 0; i < chunkCount; i++) {
          const buf = Buffer.alloc(chunkSize, String.fromCharCode(0x61 + i))
          host.send(JSON.stringify({
            type: "http.response.chunk",
            protocol: TUNNEL_PROTOCOL_VERSION,
            request_id: requestId,
            body_base64: buf.toString("base64"),
          }))
        }
        host.send(JSON.stringify({
          type: "http.response.end",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: requestId,
        }))
        resolve()
      }
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/wr/file", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      await allChunksSent
      expect(res.status).toBe(200)
      // Don't read immediately. Give the relay a beat to process the chunks
      // and apply backpressure (overflow into pendingChunks).
      await new Promise((r) => setTimeout(r, 200))
      // Now drain at the consumer's pace; all bytes must arrive intact.
      const body = new Uint8Array(await res.arrayBuffer())
      expect(body.byteLength).toBe(chunkSize * chunkCount)
      // Sanity: per-chunk fill bytes preserve order across pause/resume.
      for (let i = 0; i < chunkCount; i++) {
        const fill = 0x61 + i
        const offset = i * chunkSize
        expect(body[offset]).toBe(fill)
        expect(body[offset + chunkSize - 1]).toBe(fill)
      }
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  // T29: re-enabled with a counter assertion. The original test tried to
  // assert reader-side errors after http.response.start; Bun's
  // `controller.error()` doesn't reliably surface as a thrown read in this
  // configuration. We now drive the slow-consumer code path at the unit
  // level (a controlled ReadableStream consumer that never reads) and
  // assert on an isolated counter that the timer body increments.
  // Going through real fetch + host-tunnel chunks doesn't reliably trip the
  // HWM on localhost — Bun's HTTP server pulls between every WS message,
  // keeping desiredSize at HWM no matter how many chunks we push.
  test("slow consumer beyond timeout fails with 503 slow_consumer_timeout (T12)", async () => {
    const slowConsumerStats = __slowConsumerInternalsForTest.createSlowConsumerStats()
    let controller: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c },
    }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }))
    const pendingMap = new Map<string, unknown>()
    const requestId = "req_t12"
    let resolved503 = false
    const responsePromise = new Promise<Response>((resolve) => {
      pendingMap.set(requestId, {
        controller: controller!,
        stream,
        resolve: (res: Response) => {
          if (res.status === 503) resolved503 = true
          resolve(res)
        },
        reject: () => {},
        timeout: setTimeout(() => {}, 60_000),
        pendingChunks: [] as Uint8Array[],
        bytesQueued: 0,
        responseStarted: false,
      })
    })
    void responsePromise
    const fakeWs = { data: { pending: pendingMap } } as unknown as Parameters<
      typeof __slowConsumerInternalsForTest.enqueueChunkWithBackpressure
    >[0]["ws"]
    const entry = pendingMap.get(requestId) as Parameters<
      typeof __slowConsumerInternalsForTest.enqueueChunkWithBackpressure
    >[0]["entry"]
    try {
      // First chunk overflows HWM; second chunk arms the slow-consumer
      // watchdog (overflowEvents++).
      __slowConsumerInternalsForTest.enqueueChunkWithBackpressure({
        ws: fakeWs,
        requestId,
        entry,
        chunk: new Uint8Array(96 * 1024),
        slowConsumerTimeoutMs: 150,
        slowConsumerStats,
      })
      __slowConsumerInternalsForTest.enqueueChunkWithBackpressure({
        ws: fakeWs,
        requestId,
        entry,
        chunk: new Uint8Array(32 * 1024),
        slowConsumerTimeoutMs: 150,
        slowConsumerStats,
      })
      // Wait past the slow-consumer timeout (150 ms); 400 ms slack matches
      // the original test's wait window.
      await new Promise((resolve) => setTimeout(resolve, 400))
      // T29: assert via isolated counter rather than reader-side error.
      expect(slowConsumerStats.timerFired).toBeGreaterThanOrEqual(1)
      expect(slowConsumerStats.droppedRequests).toBeGreaterThanOrEqual(1)
      // Because responseStarted is false, the timer body resolves the
      // pending promise with a 503 slow_consumer_timeout response.
      expect(resolved503).toBe(true)
    } finally {
      clearTimeout((entry as { timeout: ReturnType<typeof setTimeout> }).timeout)
    }
  })

  test("pending entry is cleaned up after slow-consumer timeout (T12)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
      slowConsumerHighWaterMarkBytes: 64 * 1024,
      slowConsumerTimeoutMs: 150,
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    let requestId = ""
    const requestSeen = new Promise<void>((resolve) => {
      host.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; request_id: string }
        if (message.type !== "http.request") return
        requestId = message.request_id
        host.send(JSON.stringify({
          type: "http.response.start",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: requestId,
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }))
        for (let i = 0; i < 4; i++) {
          const buf = Buffer.alloc(32 * 1024, "z")
          host.send(JSON.stringify({
            type: "http.response.chunk",
            protocol: TUNNEL_PROTOCOL_VERSION,
            request_id: requestId,
            body_base64: buf.toString("base64"),
          }))
        }
        resolve()
      }
    })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/wr/slow2", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      await requestSeen
      // Wait passively for the slow-consumer timeout to fire — actively
      // reading would clear the timer. We care about pending-entry cleanup,
      // so just drop the response body and let the timer fire.
      await new Promise((resolve) => setTimeout(resolve, 400))
      try {
        await res.body!.cancel()
      } catch {
        // body may already be errored — fine
      }
      // After the timeout fires, the relay should have removed the pending
      // entry. Issue another request while the tunnel is still alive — it
      // should be accepted (no leftover pending slot consumed).
      let nextHandled = false
      host.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; request_id: string }
        if (message.type === "http.request" && !nextHandled) {
          nextHandled = true
          host.send(JSON.stringify({
            type: "http.response.start",
            protocol: TUNNEL_PROTOCOL_VERSION,
            request_id: message.request_id,
            status: 204,
            headers: {},
          }))
          host.send(JSON.stringify({
            type: "http.response.end",
            protocol: TUNNEL_PROTOCOL_VERSION,
            request_id: message.request_id,
          }))
        }
      }
      const after = await fetch(new URL("/workspaces/ws_1/api/wr/after", relay.url), {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(after.status).toBe(204)
    } finally {
      host.close()
      relay.stop(true)
    }
  })

  // T29: per-handler slow-consumer telemetry mirrors T11's fragmentation
  // telemetry and gives the backpressure path an observable production signal.
  test("slow-consumer telemetry starts zeroed after handler creation (T29)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const handler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: async () => undefined,
    })
    const stats = handler.telemetry.getSlowConsumerStats()
    expect(stats.overflowEvents).toBe(0)
    expect(stats.timerFired).toBe(0)
    expect(stats.droppedRequests).toBe(0)
    handler.telemetry.resetSlowConsumerStats()
    expect(handler.telemetry.getSlowConsumerStats()).toEqual({
      overflowEvents: 0,
      timerFired: 0,
      droppedRequests: 0,
    })
  })

  // T29: drive enqueueChunkWithBackpressure directly with a controlled
  // ReadableStream consumer that never reads. Going through real fetch +
  // host-tunnel chunks doesn't reliably trip the HWM on localhost — Bun's
  // HTTP server pulls between every WS message, keeping desiredSize at HWM.
  // The unit-level path exercises the same code under deterministic
  // conditions.
  test("slow-consumer counter increments on overflow + timer fire (T29)", async () => {
    const slowConsumerStats = __slowConsumerInternalsForTest.createSlowConsumerStats()
    const before = slowConsumerStats
    expect(before.overflowEvents).toBe(0)
    expect(before.timerFired).toBe(0)
    expect(before.droppedRequests).toBe(0)

    // Build a pending entry whose ReadableStream is never read — desiredSize
    // immediately drops past 0 once we enqueue past HWM (64 KB).
    let controller: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c },
    }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }))
    const pendingMap = new Map<string, unknown>()
    const requestId = "req_t29"
    const responsePromise = new Promise<Response>((resolve) => {
      pendingMap.set(requestId, {
        controller: controller!,
        stream,
        resolve,
        reject: () => {},
        timeout: setTimeout(() => {}, 60_000),
        pendingChunks: [] as Uint8Array[],
        bytesQueued: 0,
        responseStarted: false,
      })
    })
    void responsePromise
    const fakeWs = { data: { pending: pendingMap } } as unknown as Parameters<
      typeof __slowConsumerInternalsForTest.enqueueChunkWithBackpressure
    >[0]["ws"]
    const entry = pendingMap.get(requestId) as Parameters<
      typeof __slowConsumerInternalsForTest.enqueueChunkWithBackpressure
    >[0]["entry"]
    try {
      // First chunk: HWM = 64KB; chunk = 96KB → enqueues, desiredSize goes
      // negative immediately (consumer never reads, so no pull).
      __slowConsumerInternalsForTest.enqueueChunkWithBackpressure({
        ws: fakeWs,
        requestId,
        entry,
        chunk: new Uint8Array(96 * 1024),
        slowConsumerTimeoutMs: 100,
        slowConsumerStats,
      })
      // Second chunk: desiredSize is now <= 0 → overflow → arms watchdog →
      // overflowEvents++.
      __slowConsumerInternalsForTest.enqueueChunkWithBackpressure({
        ws: fakeWs,
        requestId,
        entry,
        chunk: new Uint8Array(32 * 1024),
        slowConsumerTimeoutMs: 100,
        slowConsumerStats,
      })
      expect(slowConsumerStats.overflowEvents).toBe(1)
      expect(slowConsumerStats.timerFired).toBe(0)
      expect(slowConsumerStats.droppedRequests).toBe(0)
      // Wait past the 100 ms watchdog.
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(slowConsumerStats.timerFired).toBe(1)
      expect(slowConsumerStats.droppedRequests).toBe(1)
      // Pending entry should have been deleted by the timer body.
      expect(pendingMap.has(requestId)).toBe(false)
    } finally {
      clearTimeout((entry as { timeout: ReturnType<typeof setTimeout> }).timeout)
    }
  })

  describe("drain controller (T9)", () => {
    test("isDraining() is false initially; setDraining(true) flips it", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const handler = createWorkspaceRelayBun({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "http://example.test",
          access: "cloud",
          backing: "cloud-vm",
        }),
      })
      expect(handler.drain.isDraining()).toBe(false)
      handler.drain.setDraining(true)
      expect(handler.drain.isDraining()).toBe(true)
      handler.drain.setDraining(false)
      expect(handler.drain.isDraining()).toBe(false)
    })

    test("waitForDrain resolves immediately when no pending requests", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const handler = createWorkspaceRelayBun({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "http://example.test",
          access: "cloud",
          backing: "cloud-vm",
        }),
      })
      const start = Date.now()
      const result = await handler.drain.waitForDrain(1000)
      const elapsed = Date.now() - start
      expect(result.drained).toBe(true)
      expect(result.remaining).toBe(0)
      expect(elapsed).toBeLessThan(500)
    })

    test("pendingCount() reports 0 when no host tunnels are connected", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const handler = createWorkspaceRelayBun({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "http://example.test",
          access: "cloud",
          backing: "cloud-vm",
        }),
      })
      expect(handler.drain.pendingCount()).toBe(0)
    })

    test("waitForDrain times out and returns drained=false when pending stays > 0", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const directory = createWorkspaceRelayDirectory({ sweepIntervalMs: 0 })
      const httpToken = await mintHostTunnelToken({
        subject: "user_1",
        hostId: "host_1",
        workspaceIds: ["ws_1"],
      }, runtime.privateKey, "EdDSA")
      const ratToken = await mintRuntimeAccessToken({
        subject: "user_1",
        orgId: "org_1",
        workspaceId: "ws_1",
        hostId: "host_1",
        role: "editor",
      }, runtime.privateKey, "EdDSA")
      const handler = createWorkspaceRelayBun({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        directory,
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "http://unused.test",
          access: "user-hosted",
          backing: "local-worktree",
        }),
      })
      const relay = Bun.serve({
        port: 0,
        fetch: handler.fetch,
        websocket: handler.websocket,
      })
      const tunnel = hostTunnelSocket(
        new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
        httpToken,
      )
      // Track the in-flight fetch so we can attach catch + await before the
      // tunnel closes. Bun otherwise logs "GET ... failed" (and treats it as
      // an unhandled rejection in test mode) when the underlying socket dies
      // mid-request.
      let inflight: Promise<unknown> | undefined
      try {
        await waitForOpen(tunnel)
        // Wait for directory presence so the first HTTP can find the tunnel.
        const observer = observeDirectory(directory)
        await observer.waitForPresence()
        // Issue a request that the host will never respond to so it stays pending.
        inflight = fetch(new URL("/workspaces/ws_1/api/never", relay.url), {
          headers: {
            authorization: `Bearer ${ratToken}`,
          },
        }).then(
          () => undefined,
          () => undefined,
        )
        // Spin until pendingCount > 0.
        const deadline = Date.now() + 2000
        while (handler.drain.pendingCount() === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(handler.drain.pendingCount()).toBeGreaterThan(0)
        // waitForDrain with short timeout should report drained=false.
        const start = Date.now()
        const result = await handler.drain.waitForDrain(100)
        const elapsed = Date.now() - start
        expect(result.drained).toBe(false)
        expect(result.remaining).toBeGreaterThan(0)
        expect(elapsed).toBeGreaterThanOrEqual(90)
        expect(elapsed).toBeLessThan(2000)
      } finally {
        try {
          tunnel.close()
        } catch {
          // ignore
        }
        relay.stop(true)
        if (inflight) await inflight
        directory.dispose()
      }
    })

    test("new HTTP requests are rejected with 503 once draining starts", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const host = Bun.serve({
        port: 0,
        fetch() {
          return new Response("ok")
        },
      })
      const handler = createWorkspaceRelayBun({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: String(host.url).replace(/\/$/, ""),
          access: "cloud",
          backing: "cloud-vm",
        }),
      })
      const relay = Bun.serve({
        port: 0,
        fetch: handler.fetch,
        websocket: handler.websocket,
      })
      const ratToken = await mintRuntimeAccessToken({
        subject: "user_1",
        orgId: "org_1",
        workspaceId: "ws_1",
        hostId: "host_1",
        role: "editor",
      }, runtime.privateKey, "EdDSA")
      try {
        const before = await fetch(new URL("/workspaces/ws_1/api/anything", relay.url), {
          headers: { authorization: `Bearer ${ratToken}` },
        })
        expect(before.status).toBe(200)

        handler.drain.setDraining(true)

        const after = await fetch(new URL("/workspaces/ws_1/api/anything", relay.url), {
          headers: { authorization: `Bearer ${ratToken}` },
        })
        expect(after.status).toBe(503)
        const body = (await after.json()) as { error?: { code?: string } }
        expect(body.error?.code).toBe("relay_draining")

        const health = await fetch(new URL("/health", relay.url))
        expect(health.status).toBe(503)
      } finally {
        relay.stop(true)
        host.stop(true)
      }
    })

    test("root health reports draining state", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const handler = createWorkspaceRelayBun({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "http://127.0.0.1:1",
          access: "cloud",
          backing: "cloud-vm",
        }),
      })
      const relay = Bun.serve({
        port: 0,
        fetch: handler.fetch,
        websocket: handler.websocket,
      })
      try {
        const before = await fetch(new URL("/health", relay.url))
        expect(before.status).toBe(200)
        expect(await before.json()).toEqual({ ok: true, service: "workspace-relay" })

        handler.drain.setDraining(true)

        const after = await fetch(new URL("/health", relay.url))
        expect(after.status).toBe(503)
        expect(await after.json()).toEqual({ ok: false, service: "workspace-relay", draining: true })
      } finally {
        relay.stop(true)
      }
    })

    test("existing host tunnels are closed with restart policy once draining starts", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const directory = createWorkspaceRelayDirectory({ sweepIntervalMs: 0 })
      const observer = observeDirectory(directory)
      const handler = createWorkspaceRelayBun({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        directory,
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "http://unused.test",
          access: "user-hosted",
          backing: "local-worktree",
        }),
      })
      const relay = Bun.serve({
        port: 0,
        fetch: handler.fetch,
        websocket: handler.websocket,
      })
      const httpToken = await mintHostTunnelToken({
        subject: "user_1",
        hostId: "host_1",
        workspaceIds: ["ws_1"],
      }, runtime.privateKey, "EdDSA")
      const tunnel = hostTunnelSocket(
        new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
        httpToken,
      )
      try {
        await waitForOpen(tunnel)
        await observer.waitForPresence()
        const closed = waitForClose(tunnel)

        handler.drain.setDraining(true)

        await expect(closed).resolves.toMatchObject({
          code: 1012,
          reason: "Workspace relay is draining",
        })
        await observer.waitForOffline()
      } finally {
        try {
          tunnel.close()
        } catch {
          // ignore
        }
        relay.stop(true)
        directory.dispose()
      }
    })

    test("existing cloud WebSocket clients are closed with restart policy once draining starts", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      class OpenUpstreamWebSocket {
        readyState: number = WebSocket.CONNECTING
        binaryType: BinaryType = "arraybuffer"
        bufferedAmount = 0
        onopen: ((event: Event) => void) | null = null
        onmessage: ((event: MessageEvent) => void) | null = null
        onclose: ((event: CloseEvent) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        constructor() {
          setTimeout(() => {
            this.readyState = WebSocket.OPEN
            this.onopen?.({} as Event)
          }, 0)
        }
        send() {}
        close(code = 1000, reason = "") {
          this.readyState = WebSocket.CLOSED
          this.onclose?.({ code, reason } as CloseEvent)
        }
      }
      const handler = createWorkspaceRelayBun({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "http://cloud.example.test",
          access: "cloud",
          backing: "cloud-vm",
        }),
      }, {
        upstreamWebSocket: OpenUpstreamWebSocket as unknown as WorkspaceRelayBunOptions["upstreamWebSocket"],
      })
      const relay = Bun.serve({
        port: 0,
        fetch: handler.fetch,
        websocket: handler.websocket,
      })
      const ratToken = await mintRuntimeAccessToken({
        subject: "user_1",
        orgId: "org_1",
        workspaceId: "ws_1",
        hostId: "host_1",
        role: "editor",
      }, runtime.privateKey, "EdDSA")
      const ws = new (WebSocket as unknown as {
        new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
      })(
        new URL("/workspaces/ws_1/api/ws", relay.url).toString().replace(/^http/, "ws"),
        { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${ratToken}`] },
      )
      try {
        await waitForOpen(ws)
        const closed = waitForClose(ws)

        handler.drain.setDraining(true)

        await expect(closed).resolves.toMatchObject({
          code: 1012,
          reason: "Workspace relay is draining",
        })
      } finally {
        try {
          ws.close()
        } catch {
          // ignore
        }
        relay.stop(true)
      }
    })

    test("new host-tunnel registrations are rejected once draining starts", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const directory = createWorkspaceRelayDirectory({ sweepIntervalMs: 0 })
      const handler = createWorkspaceRelayBun({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        directory,
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "http://unused.test",
          access: "user-hosted",
          backing: "local-worktree",
        }),
      })
      const relay = Bun.serve({
        port: 0,
        fetch: handler.fetch,
        websocket: handler.websocket,
      })
      const httpToken = await mintHostTunnelToken({
        subject: "user_1",
        hostId: "host_2",
        workspaceIds: ["ws_2"],
      }, runtime.privateKey, "EdDSA")
      try {
        handler.drain.setDraining(true)
        const tunnel = hostTunnelSocket(
          new URL("/host-tunnels/host_2?workspaceId=ws_2", relay.url).toString().replace(/^http/, "ws"),
          httpToken,
        )
        // The upgrade should fail because we returned a 503 before upgrading.
        const closed = new Promise<{ code: number; reason: string } | "open">((resolve) => {
          tunnel.onopen = () => resolve("open")
          tunnel.onerror = () => resolve({ code: 0, reason: "error" })
          tunnel.onclose = (event) => resolve({ code: event.code, reason: event.reason })
        })
        const result = await closed
        expect(result).not.toBe("open")
        try {
          tunnel.close()
        } catch {
          // ignore
        }
      } finally {
        relay.stop(true)
        directory.dispose()
      }
    })
  })

  describe("host-tunnel state debounce (T19)", () => {
    type ConnectionAuditEvent = {
      action: "host_tunnel.connected" | "host_tunnel.disconnected"
      hostId: string
    }
    function setupRelay(
      runtime: CryptoKeyPair,
      relayHost: CryptoKeyPair,
      auditEvents: ConnectionAuditEvent[],
      debounceMs: number,
    ) {
      const directory = createWorkspaceRelayDirectory({ ttlMs: 10_000 })
      const relayHandler = createWorkspaceRelayBun({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        directory,
        resolveTarget: async () => undefined,
        audit: (event) => {
          if (
            event.action === "host_tunnel.connected" ||
            event.action === "host_tunnel.disconnected"
          ) {
            auditEvents.push({ action: event.action, hostId: event.hostId ?? "" })
          }
        },
      }, {
        authorizeHostTunnel: () => true,
        hostTunnelStateDebounceMs: debounceMs,
      })
      const relay = Bun.serve({
        port: 0,
        fetch: relayHandler.fetch,
        websocket: relayHandler.websocket,
      })
      return { relay, directory }
    }
    function openTunnel(relayUrl: string, hostId: string) {
      return new WebSocket(
        new URL(`/host-tunnels/${hostId}?workspaceId=ws_1`, relayUrl).toString().replace(/^http/, "ws"),
      )
    }
    function closeAndWait(ws: WebSocket) {
      return new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve()
        ws.onclose = () => resolve()
        try { ws.close() } catch { /* ignore */ }
        setTimeout(resolve, 200)
      })
    }
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    test("single connect emits exactly one connected audit event", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const events: ConnectionAuditEvent[] = []
      const { relay, directory } = setupRelay(runtime, relayHost, events, 50)
      try {
        const ws = openTunnel(relay.url.toString(), "host_a")
        await waitForOpen(ws)
        // Wait past the debounce flush window.
        await wait(100)
        const connectedEvents = events.filter((e) => e.action === "host_tunnel.connected" && e.hostId === "host_a")
        expect(connectedEvents.length).toBe(1)
        await closeAndWait(ws)
      } finally {
        relay.stop(true)
        directory.dispose()
      }
    })

    test("connect + immediate disconnect within debounce window emits zero net events", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const events: ConnectionAuditEvent[] = []
      const { relay, directory } = setupRelay(runtime, relayHost, events, 250)
      try {
        const ws = openTunnel(relay.url.toString(), "host_b")
        await waitForOpen(ws)
        // Close immediately — both events should coalesce since intended state
        // returns to disconnected (== lastWritten "disconnected" baseline) before
        // the timer fires.
        await closeAndWait(ws)
        // Wait past the debounce flush window.
        await wait(400)
        const hostBEvents = events.filter((e) => e.hostId === "host_b")
        expect(hostBEvents.length).toBe(0)
      } finally {
        relay.stop(true)
        directory.dispose()
      }
    })

    test("connect + disconnect + reconnect within debounce window suppresses flap (only connect emitted)", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const events: ConnectionAuditEvent[] = []
      const { relay, directory } = setupRelay(runtime, relayHost, events, 250)
      try {
        const ws1 = openTunnel(relay.url.toString(), "host_c")
        await waitForOpen(ws1)
        await closeAndWait(ws1)
        // Reconnect quickly — flap should be suppressed; final intended state is "connected".
        const ws2 = openTunnel(relay.url.toString(), "host_c")
        await waitForOpen(ws2)
        // Wait past the debounce flush window.
        await wait(400)
        const hostCEvents = events.filter((e) => e.hostId === "host_c")
        expect(hostCEvents.map((e) => e.action)).toEqual(["host_tunnel.connected"])
        await closeAndWait(ws2)
      } finally {
        relay.stop(true)
        directory.dispose()
      }
    })

    test("connect + slow disconnect (>debounce) emits both events", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const events: ConnectionAuditEvent[] = []
      const { relay, directory } = setupRelay(runtime, relayHost, events, 50)
      try {
        const ws = openTunnel(relay.url.toString(), "host_d")
        await waitForOpen(ws)
        // Wait past the debounce flush so the connected event is emitted.
        await wait(150)
        await closeAndWait(ws)
        // Wait past the debounce flush again.
        await wait(150)
        const hostDActions = events.filter((e) => e.hostId === "host_d").map((e) => e.action)
        expect(hostDActions).toEqual(["host_tunnel.connected", "host_tunnel.disconnected"])
      } finally {
        relay.stop(true)
        directory.dispose()
      }
    })

    test("two different host_ids debounced independently", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const events: ConnectionAuditEvent[] = []
      const { relay, directory } = setupRelay(runtime, relayHost, events, 250)
      try {
        // host_e: flap → suppressed
        const ws1 = openTunnel(relay.url.toString(), "host_e")
        await waitForOpen(ws1)
        await closeAndWait(ws1)
        // host_f: stable connect → should emit one connected event
        const ws2 = openTunnel(relay.url.toString(), "host_f")
        await waitForOpen(ws2)
        // Wait past debounce window.
        await wait(400)
        const hostEEvents = events.filter((e) => e.hostId === "host_e")
        const hostFEvents = events.filter((e) => e.hostId === "host_f")
        expect(hostEEvents.length).toBe(0)
        expect(hostFEvents.map((e) => e.action)).toEqual(["host_tunnel.connected"])
        await closeAndWait(ws2)
      } finally {
        relay.stop(true)
        directory.dispose()
      }
    })
  })
})

describe("WebSocket send backpressure guard", () => {
  // The decision behind the two guards at `bun.ts:1455` (client channel) and
  // `:1478` (host tunnel). Both call this with the same limit, so asserting it
  // once covers both directions; what differs between them is only which socket
  // is closed, which the code-shape test in
  // `relay-workerd-backpressure.test.ts` pins.
  //
  // These are the tests that were missing when the guard was written: it read a
  // `bufferedAmount` property that Bun does not have, and nothing ever asserted
  // that it fired, so it sat dead through a whole cloud investigation that cited
  // it as prior art.
  const LIMIT = 8 * 1024 * 1024

  test("closes when the socket reports a depth over the limit", () => {
    // Bun's real shape: a method, not a property.
    expect(relayOverBackpressureLimit({ getBufferedAmount: () => LIMIT + 1 }, LIMIT)).toBe(true)
    expect(relayOverBackpressureLimit({ getBufferedAmount: () => 99 * 1024 * 1024 }, LIMIT)).toBe(true)
  })

  test("passes at or below the limit", () => {
    // Boundary is exclusive: exactly at the limit is not yet a breach, matching
    // the `>` the guards use.
    expect(relayOverBackpressureLimit({ getBufferedAmount: () => LIMIT }, LIMIT)).toBe(false)
    expect(relayOverBackpressureLimit({ getBufferedAmount: () => 0 }, LIMIT)).toBe(false)
    expect(relayOverBackpressureLimit({ getBufferedAmount: () => LIMIT - 1 }, LIMIT)).toBe(false)
  })

  test("FAILS OPEN on a socket that cannot report its buffer depth", () => {
    // The rule that matters most: a socket which cannot report must never be
    // closed. Hand-rolled doubles all over this suite are exactly this shape,
    // and so is every workerd socket — where this guard is unportable for this
    // very reason.
    expect(relayOverBackpressureLimit({}, LIMIT)).toBe(false)
    expect(relayOverBackpressureLimit({ send() {} }, LIMIT)).toBe(false)
    expect(relayOverBackpressureLimit({ bufferedAmount: undefined }, LIMIT)).toBe(false)
    // Non-numeric or non-finite answers are "cannot report", not "breached".
    expect(relayOverBackpressureLimit({ getBufferedAmount: () => Number.NaN }, LIMIT)).toBe(false)
    expect(relayOverBackpressureLimit({ getBufferedAmount: () => "lots" }, LIMIT)).toBe(false)
    expect(relayOverBackpressureLimit({ bufferedAmount: Number.NaN }, LIMIT)).toBe(false)
    // Infinity IS a finite-check failure, so it fails open too — deliberate: a
    // socket answering Infinity is malfunctioning, not merely saturated.
    expect(relayOverBackpressureLimit({ getBufferedAmount: () => Number.POSITIVE_INFINITY }, LIMIT)).toBe(false)
  })

  test("honours a browser-shaped bufferedAmount property when that is all there is", () => {
    // Keeps the guard working against a `ws`-style or browser socket, and keeps
    // existing doubles that mimic one meaningful rather than silently unguarded.
    expect(relayOverBackpressureLimit({ bufferedAmount: LIMIT + 1 }, LIMIT)).toBe(true)
    expect(relayOverBackpressureLimit({ bufferedAmount: 0 }, LIMIT)).toBe(false)
  })

  test("prefers the method over the property when a socket carries both", () => {
    // The method is the authoritative source on Bun. A stale or shimmed property
    // must not be able to mask a real breach, or resurrect the original bug in a
    // subtler form.
    expect(relayBufferedBytes({ getBufferedAmount: () => LIMIT + 1, bufferedAmount: 0 })).toBe(LIMIT + 1)
    expect(relayOverBackpressureLimit({ getBufferedAmount: () => LIMIT + 1, bufferedAmount: 0 }, LIMIT)).toBe(true)
  })

  test("reads a real Bun.ServerWebSocket over the limit", () => {
    // Not a double: an actual server socket with ~32 MiB queued at a peer that
    // never reads. This is the assertion that would have caught the dead guard,
    // because it is the only one that touches Bun's real accessor shape.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Bun socket never opened")), 10_000)
      const server = Bun.serve({
        port: 0,
        fetch(request, self) {
          if (self.upgrade(request)) return undefined
          return new Response("expected an upgrade", { status: 400 })
        },
        websocket: {
          open(socket) {
            try {
              const frame = "x".repeat(64 * 1024)
              for (let index = 0; index < 500; index++) socket.send(frame)
              expect(relayBufferedBytes(socket)).toBeGreaterThan(LIMIT)
              expect(relayOverBackpressureLimit(socket, LIMIT)).toBe(true)
              // And the same real socket reads as healthy against a limit above
              // its depth, so the assertion above is about depth and not merely
              // "any real socket trips this".
              expect(relayOverBackpressureLimit(socket, 512 * 1024 * 1024)).toBe(false)
              resolve()
            } catch (err) {
              reject(err)
            } finally {
              clearTimeout(timer)
              server.stop(true)
            }
          },
          message() {},
        },
      })
      const client = new WebSocket(`ws://localhost:${server.port}`)
      client.onerror = () => {
        clearTimeout(timer)
        server.stop(true)
        reject(new Error("Bun client socket errored"))
      }
    })
  }, 30_000)
})

describe("WebSocket send backpressure guard wiring (end-to-end)", () => {
  // The tests above assert the DECISION. These assert the WIRING: that a breach
  // at each of the two call sites closes the right socket with the right code
  // and reason, through a real relay, real host tunnel, and real client.
  //
  // HOW the breach is forced, and its one honest limitation. A loopback peer
  // drains faster than a test can outrun it: a real 8 MiB backlog is not
  // reachable locally, and even at a limit of 0 the buffer is back to 0 bytes by
  // the time the next frame handler runs (measured — that variant timed out).
  // So these tests set the limit NEGATIVE, which makes any socket that can
  // report its depth (0 > -1) a breach.
  //
  // That exercises the real call site, the real close, and the real code/reason
  // on a real socket; what it does NOT prove is that a genuine 8 MiB backlog is
  // detected, because no local harness can produce one. The threshold arithmetic
  // is covered by the unit tests above; the "healthy traffic at the real 8 MiB
  // default is untouched" test below is the other half of the vise.
  async function userHostedRelay(webSocketBufferedAmountMaxBytes: number) {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory()
    const observer = observeDirectory(directory)
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://user-hosted.invalid",
        access: "user-hosted",
        backing: "local-worktree",
      }),
    }, {
      authorizeHostTunnel: () => true,
      webSocketBufferedAmountMaxBytes,
    })
    const relay = Bun.serve({ port: 0, fetch: relayHandler.fetch, websocket: relayHandler.websocket })
    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    return { relay, token, observer, directory }
  }

  function openClient(relayUrl: URL | string, token: string) {
    return new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      new URL("/workspaces/ws_1/api/claxedo/pty/pty_1/connect", relayUrl).toString().replace(/^http/, "ws"),
      { headers: { origin: "http://localhost:3000" }, protocols: [`claxedo-rat.${token}`] },
    )
  }

  test("a saturated client channel is closed 1011 with the named reason", async () => {
    // Host→client direction, `bun.ts:1455`. The host pushes a frame at a client
    // whose buffer is over limit; the CHANNEL dies, and the tunnel survives.
    const { relay, token, observer, directory } = await userHostedRelay(-1)
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const client = openClient(relay.url, token)
      const clientClosed = waitForClose(client)
      let channelId = ""
      host.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>
        if (message.type === "ws.open") {
          channelId = String(message.channel_id)
          for (let index = 0; index < 2; index++) {
            host.send(JSON.stringify({
              type: "ws.frame",
              protocol: TUNNEL_PROTOCOL_VERSION,
              channel_id: channelId,
              binary: false,
              data_base64: Buffer.from("x".repeat(64 * 1024)).toString("base64"),
            }))
          }
        }
      }
      await waitForOpen(client)
      const closed = await Promise.race([
        clientClosed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("client was never closed")), 5_000)),
      ])
      expect(closed.code).toBe(1011)
      expect(closed.reason).toBe("Client WebSocket backpressure limit exceeded")
      // The tunnel itself must NOT be collateral of one bad channel.
      expect(host.readyState).toBe(WebSocket.OPEN)
    } finally {
      host.close()
      relay.stop(true)
      directory.dispose()
    }
  }, 30_000)

  test("a saturated host tunnel closes the client 1011 with the named reason", async () => {
    // Client→host direction, `bun.ts:1478`. The client sends while the tunnel's
    // buffer is over limit. Bun closes the CLIENT here (not the tunnel), which
    // is the semantic this test pins — it is the shape the CF port would have
    // had to match, and it keeps one noisy client from killing every channel.
    const { relay, token, observer, directory } = await userHostedRelay(-1)
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const client = openClient(relay.url, token)
      await waitForOpen(client)
      const clientClosed = waitForClose(client)
      for (let index = 0; index < 2; index++) client.send("x".repeat(64 * 1024))
      const closed = await Promise.race([
        clientClosed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("client was never closed")), 5_000)),
      ])
      expect(closed.code).toBe(1011)
      expect(closed.reason).toBe("Host tunnel backpressure limit exceeded")
    } finally {
      host.close()
      relay.stop(true)
      directory.dispose()
    }
  }, 30_000)

  test("healthy traffic at the 8 MiB default is untouched", async () => {
    // The control for both tests above: identical topology and payloads, real
    // default limit. If the guard were over-eager, this is what would break —
    // and this is the assertion that makes the two forced-breach tests meaningful
    // rather than merely "closing sockets is possible".
    const { relay, token, observer, directory } = await userHostedRelay(8 * 1024 * 1024)
    const host = new WebSocket(
      new URL("/host-tunnels/host_1?workspaceId=ws_1", relay.url).toString().replace(/^http/, "ws"),
    )
    try {
      await waitForOpen(host)
      await observer.waitForPresence()
      const client = openClient(relay.url, token)
      const relayed: string[] = []
      let channelId = ""
      host.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>
        if (message.type === "ws.open") channelId = String(message.channel_id)
        if (message.type === "ws.frame") {
          relayed.push(Buffer.from(String(message.data_base64), "base64").toString("utf8"))
        }
      }
      await waitForOpen(client)
      for (let index = 0; index < 2; index++) client.send("x".repeat(64 * 1024))
      // Give the frames a chance to relay, then confirm nothing was closed.
      const deadline = Date.now() + 5_000
      while (relayed.length < 2 && Date.now() < deadline) await Bun.sleep(25)
      expect(relayed.length).toBe(2)
      expect(client.readyState).toBe(WebSocket.OPEN)
      expect(host.readyState).toBe(WebSocket.OPEN)
      expect(channelId).not.toBe("")
    } finally {
      host.close()
      relay.stop(true)
      directory.dispose()
    }
  }, 30_000)
})
