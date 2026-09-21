import { describe, expect, test } from "bun:test"
import { generateKeyPair } from "jose"
import { createWorkspaceRelayDirectory, mintHostTunnelToken, mintRuntimeAccessToken, verifyRelayHostToken, type WorkspaceRelayDirectory } from "@claxedo/workspace-relay"
import { createWorkspaceRelayBun } from "@claxedo/workspace-relay/bun"
import { startWorkspaceRelayHostTunnel, type WorkspaceRelayHostTunnelEvent } from "./workspace-relay-host-tunnel"
import { TUNNEL_PROTOCOL_VERSION } from "@claxedo/workspace-relay-protocol"
import { fetchUrl } from "./test-support/fetch-double"

type DirectoryObserver = {
  waitForPresence(): Promise<NonNullable<ReturnType<WorkspaceRelayDirectory["activeHost"]>>>
  waitForNoPresence(): Promise<void>
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

async function waitForSent(socket: FakeWebSocket, type: string) {
  const deadline = Date.now() + 1_000
  for (;;) {
    const message = socket.sent.find((item) => JSON.parse(item).type === type)
    if (message) return JSON.parse(message) as { type: string }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

// Generic in the frame shape so a caller can name the fields it asserts on
// (`body_base64`, ...) without re-casting through `unknown`.
async function waitForSentTypeCount<TFrame extends { type: string } = { type: string }>(
  socket: FakeWebSocket,
  type: string,
  count: number,
): Promise<TFrame[]> {
  const deadline = Date.now() + 1_000
  for (;;) {
    const messages = socket.sent.map((item) => JSON.parse(item) as TFrame).filter((item) => item.type === type)
    if (messages.length >= count) return messages
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} ${type} message(s)`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

type FakeTimer = { fn: () => void; delayMs: number; cleared: boolean; fired: boolean }

function fakeTimers() {
  const timers: FakeTimer[] = []
  return {
    timers,
    setTimeout: (fn: () => void, delayMs?: number) => {
      timers.push({ fn, delayMs: delayMs ?? 0, cleared: false, fired: false })
      return timers.length as unknown as ReturnType<typeof globalThis.setTimeout>
    },
    clearTimeout: ((handle?: number | string | NodeJS.Timeout) => {
      const timer = timers[Number(handle) - 1]
      if (timer) timer.cleared = true
    }) as typeof globalThis.clearTimeout,
    fireNext() {
      const timer = timers.find((item) => !item.cleared && !item.fired)
      if (!timer) throw new Error("No pending fake timer")
      timer.fired = true
      timer.fn()
    },
    fired: () => timers.filter((item) => item.fired).map((item) => item.delayMs),
  }
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

class FakeWebSocket {
  // Annotated, or it infers the literal `0` and every later transition fails.
  readyState: number = WebSocket.CONNECTING
  sent: string[] = []
  closeCode: number | undefined
  closeReason = ""
  binaryType: BinaryType = "blob"
  onopen?: () => void
  onmessage?: (event: MessageEvent) => void
  onclose?: (event: CloseEvent) => void
  onerror?: () => void

  constructor(
    readonly url: string,
    readonly options: { headers?: Record<string, string> },
  ) {}

  open() {
    this.readyState = WebSocket.OPEN
    this.onopen?.()
  }

  receive(data: string) {
    this.onmessage?.({ data } as MessageEvent)
  }

  // Node's `ws` emits 'error' on transport failure (a relay 500 on the
  // upgrade, a reset socket) with no close of its own guaranteed to follow.
  error() {
    this.onerror?.()
  }

  send(data: string) {
    this.sent.push(data)
  }

  close(code = 1000, reason = "") {
    this.closeCode = code
    this.closeReason = reason
    this.readyState = WebSocket.CLOSED
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

function observeDirectory(directory: WorkspaceRelayDirectory): DirectoryObserver {
  const waiters = new Set<() => void>()
  const notify = () => {
    for (const waiter of waiters) waiter()
  }
  const registerHostTunnel = directory.registerHostTunnel.bind(directory)
  const disconnectHost = directory.disconnectHost.bind(directory)
  directory.registerHostTunnel = (input) => {
    const presence = registerHostTunnel(input)
    notify()
    return presence
  }
  directory.disconnectHost = (hostId) => {
    disconnectHost(hostId)
    notify()
  }
  const waitFor = <T>(label: string, fn: () => T | undefined) => {
    const current = fn()
    if (current) return Promise.resolve(current)
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(label))
      }, 5_000)
      const check = () => {
        const next = fn()
        if (!next) return
        clearTimeout(timeout)
        waiters.delete(check)
        resolve(next)
      }
      waiters.add(check)
    })
  }
  return {
    waitForPresence: () => waitFor(
      "Host tunnel presence was not registered",
      () => directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" }),
    ),
    waitForNoPresence: () => waitFor(
      "Host tunnel presence stayed registered",
      () => !directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" }) || undefined,
    ).then(() => undefined),
  }
}

async function harness() {
  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  const directory = createWorkspaceRelayDirectory()
  const relayHandler = createWorkspaceRelayBun({
    runtimeAccessKey: runtime.publicKey,
    relayHostSigningKey: relayHost.privateKey,
    relayHostAlgorithm: "EdDSA",
    directory,
    resolveTarget: (claims) => ({
      workspaceId: claims.workspace_id,
      hostId: claims.host_id,
      baseUrl: "http://host-tunnel.invalid",
      backing: "local-worktree",
    }),
  })
  const startRelay = (port = 0) => Bun.serve({
    port,
    fetch: relayHandler.fetch,
    websocket: relayHandler.websocket,
  })
  const relay = startRelay()
  const observer = observeDirectory(directory)
  const token = await mintRuntimeAccessToken({
    principalKind: "user",
    actorId: "user_1",
    actorKind: "human",
    orgId: "org_1",
    workspaceId: "ws_1",
    hostId: "host_1",
    role: "editor",
  }, runtime.privateKey, "EdDSA")
  const hostTunnelToken = await mintHostTunnelToken({
    subject: "user_1",
    hostId: "host_1",
    workspaceIds: ["ws_1"],
  }, runtime.privateKey, "EdDSA")
  return {
    directory,
    observer,
    relay,
    startRelay,
    relayHost,
    hostTunnelToken,
    runtimeAccessToken: token,
  }
}

describe("workspace relay host tunnel client", () => {
  test("updates workspace registration on the existing socket", async () => {
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    sockets[0].open()

    await tunnel.updateRegistration({ workspaceIds: ["ws_1", "ws_2"], token: "htt_2" })

    expect(sockets).toHaveLength(1)
    expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({
      type: "host.registration.update",
      protocol: TUNNEL_PROTOCOL_VERSION,
      workspace_ids: ["ws_1", "ws_2"],
      token: "htt_2",
    })
    tunnel.close()
  })

  test("uses workspace-aware targets and refuses requests outside the allowed backing surface", async () => {
    const sockets: FakeWebSocket[] = []
    const requests: string[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1", "ws_2"],
      localBaseUrl: "http://runtime.invalid",
      resolveLocalUrl: ({ workspaceId, path }) => path.startsWith("/api/wr/")
        ? new URL(`/workspaces/${workspaceId}${path}`, "http://runtime.invalid")
        : undefined,
      request: async (target) => {
        requests.push(fetchUrl(target))
        return new Response("ok")
      },
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    socket.receive(JSON.stringify({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "allowed",
      workspace_id: "ws_2",
      method: "GET",
      path: "/api/wr/health",
      headers: {},
      end: true,
    }))
    socket.receive(JSON.stringify({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "central",
      workspace_id: "ws_2",
      method: "GET",
      path: "/api/claxedo/credentials",
      headers: {},
      end: true,
    }))
    await flush()

    expect(requests).toEqual(["http://runtime.invalid/workspaces/ws_2/api/wr/health"])
    expect(socket.sent.map((item) => JSON.parse(item)).find((item) => item.request_id === "central")).toMatchObject({
      type: "http.response.start",
      status: 403,
    })
    tunnel.close()
  })

  /**
   * A relayed frame carries `path` as a STRING, so dot segments arrive intact
   * where an HTTP hop would have resolved them long before. Every target
   * below is that string pasted behind something that binds it — a base URL
   * already scoped to one workspace, or a `/workspaces/:id` prefix a host
   * builds — and a surviving `..` climbs straight back out of that binding
   * onto the host's own root, where the workspace is whatever a
   * caller-controlled selector says rather than the one this frame was
   * admitted for.
   */
  test("carries __proto__ and constructor header names onto the wire as ordinary data", async () => {
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      request: async () => {
        const headers = new Headers()
        headers.set("__proto__", "spoofed")
        headers.set("constructor", "spoofed")
        return new Response("ok", { headers })
      },
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    socket.receive(JSON.stringify({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      workspace_id: "ws_1",
      method: "GET",
      path: "/api/wr/health",
      headers: {},
      end: true,
    }))

    const [start] = await waitForSentTypeCount<{ type: string; headers: Record<string, string> }>(socket, "http.response.start", 1)
    // Assigned onto `{}`, `__proto__` would hit the prototype setter and the
    // header would vanish; the wire map must keep it as an own property.
    expect(Object.hasOwn(start.headers, "__proto__")).toBe(true)
    expect(start.headers["__proto__"]).toBe("spoofed")
    expect(start.headers["constructor"]).toBe("spoofed")
    tunnel.close()
  })

  test("resolves dot segments before binding the scoped base, on HTTP and on WebSocket alike", async () => {
    const sockets: FakeWebSocket[] = []
    const requests: string[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      // What a control-plane host hands this client for one workspace: a base
      // that is itself the workspace binding.
      localBaseUrl: "http://runtime.invalid/workspaces/ws_1",
      request: async (target) => {
        requests.push(fetchUrl(target))
        return new Response("ok")
      },
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    for (const [requestId, path] of [
      ["dots", "/../../session?directory=ws_other"],
      ["encoded", "/%2e%2e/%2e%2e/api/wr/health"],
      ["backslash", "/a/..\\..\\session"],
      // An authority smuggled into the path is not a target either: only the
      // path and query survive, so the host still dials its own base.
      ["authority", "//runtime.evil/api/wr/health"],
    ]) {
      socket.receive(JSON.stringify({
        type: "http.request",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: requestId,
        workspace_id: "ws_1",
        method: "GET",
        path,
        headers: {},
        end: true,
      }))
    }
    await flush()

    expect(requests).toEqual([
      "http://runtime.invalid/workspaces/ws_1/session?directory=ws_other",
      "http://runtime.invalid/workspaces/ws_1/api/wr/health",
      "http://runtime.invalid/workspaces/ws_1/session",
      "http://runtime.invalid/workspaces/ws_1/api/wr/health",
    ])

    socket.receive(JSON.stringify({
      type: "ws.open",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "channel_1",
      workspace_id: "ws_1",
      path: "/../../api/wr/pty/pty_1/connect?cursor=0",
      headers: {},
    }))

    expect(sockets[1].url).toBe("ws://runtime.invalid/workspaces/ws_1/api/wr/pty/pty_1/connect?cursor=0")
    tunnel.close()
  })

  /**
   * A host that resolves its own target decides policy on the path and then
   * binds it, and those two must read the same string. Handing it the frame's
   * raw one made a route check pass on the harmless resolved form while the
   * URL it built escaped — so the path is resolved HERE, once, before any
   * host sees it.
   */
  test("hands a host's own resolver a path it has already resolved", async () => {
    const sockets: FakeWebSocket[] = []
    const seen: string[] = []
    const requests: string[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      resolveLocalUrl: ({ workspaceId, path }) => {
        seen.push(path)
        return path.startsWith("/api/wr/")
          ? new URL(`/workspaces/${workspaceId}${path}`, "http://runtime.invalid")
          : undefined
      },
      request: async (target) => {
        requests.push(fetchUrl(target))
        return new Response("ok")
      },
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    socket.receive(JSON.stringify({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "climbing",
      workspace_id: "ws_1",
      method: "GET",
      path: "/../../api/wr/health?probe=1",
      headers: {},
      end: true,
    }))
    await flush()

    expect(seen).toEqual(["/api/wr/health?probe=1"])
    expect(requests).toEqual(["http://runtime.invalid/workspaces/ws_1/api/wr/health?probe=1"])
    tunnel.close()
  })

  /**
   * Resolving a path is also the only thing that can REFUSE one: a malformed
   * authority (`//[`, `http://[`, `//[::1`) is not a URL, and a frame
   * carrying one names no route on this machine. It is refused exactly like a
   * route the host declines — the relay is owed the same terminal frame
   * either way — rather than becoming a thrown TypeError whose text would
   * travel back to the caller as a failure of this machine.
   */
  const MALFORMED_PATHS = ["//[", "http://[", "//[::1", "//%5B"]

  test("refuses a malformed path on HTTP and keeps serving the next request", async () => {
    const sockets: FakeWebSocket[] = []
    const requests: string[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid/workspaces/ws_1",
      request: async (target) => {
        requests.push(fetchUrl(target))
        return new Response("ok")
      },
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    for (const [index, path] of MALFORMED_PATHS.entries()) {
      socket.receive(JSON.stringify({
        type: "http.request",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: `malformed_${index}`,
        workspace_id: "ws_1",
        method: "GET",
        path,
        headers: {},
        end: true,
      }))
    }
    // A legitimate frame after them: a refusal must cost the tunnel nothing.
    socket.receive(JSON.stringify({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "legitimate",
      workspace_id: "ws_1",
      method: "GET",
      path: "/api/wr/file/content?path=a%20b&probe=1",
      headers: {},
      end: true,
    }))
    await flush()

    const frames = socket.sent.map((item) => JSON.parse(item) as { type: string; request_id?: string; status?: number })
    for (const [index] of MALFORMED_PATHS.entries()) {
      const answered = frames.filter((frame) => frame.request_id === `malformed_${index}`)
      expect(answered.map((frame) => frame.type), MALFORMED_PATHS[index])
        .toEqual(["http.response.start", "http.response.end"])
      expect(answered[0].status, MALFORMED_PATHS[index]).toBe(403)
    }
    // Nothing was dialled for them, and the legitimate one still was.
    expect(requests).toEqual(["http://runtime.invalid/workspaces/ws_1/api/wr/file/content?path=a%20b&probe=1"])
    tunnel.close()
  })

  test("refuses a malformed path on a WebSocket open without opening a channel", async () => {
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid/workspaces/ws_1",
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    for (const [index, path] of MALFORMED_PATHS.entries()) {
      // `onmessage` has no try of its own, so a throw here would leave the
      // host process with an unhandled exception and the relay with a channel
      // it is never told about.
      socket.receive(JSON.stringify({
        type: "ws.open",
        protocol: TUNNEL_PROTOCOL_VERSION,
        channel_id: `channel_malformed_${index}`,
        workspace_id: "ws_1",
        path,
        headers: {},
      }))
    }

    const refusals = socket.sent
      .map((item) => JSON.parse(item) as { type: string; channel_id?: string; code?: number; reason?: string })
      .filter((frame) => frame.type === "ws.close")
    expect(refusals.map((frame) => frame.channel_id))
      .toEqual(MALFORMED_PATHS.map((_, index) => `channel_malformed_${index}`))
    // The refusal a declined route already gets, verbatim: `sendWsClose`
    // clamps the 1008 the deny path passes down to the 1000 an application
    // may send, and the reason is the one this client has for any path it
    // will not carry.
    expect(refusals.map((frame) => frame.code)).toEqual(MALFORMED_PATHS.map(() => 1000))
    expect(refusals.map((frame) => frame.reason))
      .toEqual(MALFORMED_PATHS.map(() => "Workspace route is not remotely accessible"))
    // Only this tunnel's own socket exists: no upstream was dialled, and no
    // channel is left half-registered for a frame that never opened one.
    expect(sockets).toHaveLength(1)

    socket.receive(JSON.stringify({
      type: "ws.open",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "channel_ok",
      workspace_id: "ws_1",
      path: "/api/wr/pty/pty_1/connect?cursor=0",
      headers: {},
    }))

    expect(sockets[1].url).toBe("ws://runtime.invalid/workspaces/ws_1/api/wr/pty/pty_1/connect?cursor=0")
    tunnel.close()
  })

  test("ignores malformed JSON and unknown tunnel frames without breaking the tunnel", () => {
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()

    expect(() => socket.receive("{not-json")).not.toThrow()
    expect(() => socket.receive(JSON.stringify({ type: "future.frame", protocol: TUNNEL_PROTOCOL_VERSION }))).not.toThrow()

    socket.receive(JSON.stringify({
      type: "ping",
      protocol: TUNNEL_PROTOCOL_VERSION,
      id: "ping_1",
      sent_at: 1,
    }))

    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "pong",
      protocol: TUNNEL_PROTOCOL_VERSION,
      id: "ping_1",
    })
    tunnel.close()
  })

  test("watchdog reconnects when the relay goes silent on a half-open socket", async () => {
    const sockets: FakeWebSocket[] = []
    const events: WorkspaceRelayHostTunnelEvent[] = []
    // 100ms ping interval → ~300ms watchdog silence window. The old 5ms/15ms
    // pairing was tighter than CI's scheduler: a single overshooting
    // setTimeout(5) during the live-pong phase exceeded the window, the
    // watchdog fired on a genuinely-live socket, and the "no teardown"
    // assertion counted the extra reconnect (Expected 2, Received 3).
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      pingIntervalMs: 100,
      reconnectIntervalMs: 1,
      onEvent: (event) => events.push(event),
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    sockets[0].open()

    // No inbound traffic at all (half-open socket): after 3 ping intervals the
    // watchdog must tear the socket down and reconnect with a fresh socket.
    const deadline = Date.now() + 10_000
    while (sockets.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(sockets.length).toBeGreaterThanOrEqual(2)
    expect(events.some((event) => event.type === "reconnecting")).toBe(true)

    // A LIVE socket (pongs flowing back) must NOT be torn down. Feed pongs at
    // a cadence (10ms nominal) far inside the 300ms watchdog window so only a
    // pathological >290ms scheduler stall could break this — and even CI's
    // worst observed stalls are an order of magnitude smaller.
    const live = sockets.at(-1)!
    live.open()
    const liveCount = sockets.length
    for (let i = 0; i < 10; i += 1) {
      live.receive(JSON.stringify({ type: "pong", protocol: TUNNEL_PROTOCOL_VERSION, id: `p${i}`, sent_at: Date.now() }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(sockets.length).toBe(liveCount)
    tunnel.close()
  })

  test("uses protocol ping/pong control frames without changing the v1 application heartbeat", async () => {
    const sockets: Array<FakeWebSocket & { pings: number }> = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      pingIntervalMs: 5,
      webSocket: class extends FakeWebSocket {
        pings = 0
        private readonly pongListeners = new Set<() => void>()

        on(event: "pong", listener: () => void) {
          if (event === "pong") this.pongListeners.add(listener)
        }

        ping() {
          this.pings += 1
          this.pongListeners.forEach((listener) => listener())
        }

        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    sockets[0].open()
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(sockets).toHaveLength(1)
    expect(sockets[0].pings).toBeGreaterThan(0)
    expect(sockets[0].sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "ping")).toEqual([])
    tunnel.close()
  })

  test("clamps unsafe WebSocket close codes from relay frames", () => {
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    socket.receive(JSON.stringify({
      type: "ws.open",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "channel_1",
      workspace_id: "ws_1",
      path: "/api/ws",
      headers: {},
    }))
    const upstream = sockets[1]

    socket.receive(JSON.stringify({
      type: "ws.close",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "channel_1",
      code: 2000,
      reason: "unsafe",
    }))

    expect(upstream.closeCode).toBe(1000)
    expect(upstream.closeReason).toBe("unsafe")
    tunnel.close()
  })

  test("aborts in-flight HTTP forwarding when the tunnel closes", async () => {
    const sockets: FakeWebSocket[] = []
    let signal: AbortSignal | undefined
    let streamCanceled = false
    let resolveAborted!: () => void
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve
    })
    const request: NonNullable<Parameters<typeof startWorkspaceRelayHostTunnel>[0]["request"]> = async (_url, init) => {
      signal = init?.signal as AbortSignal
      signal.addEventListener("abort", resolveAborted, { once: true })
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([65]))
        },
        cancel() {
          streamCanceled = true
        },
      }))
    }
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      request,
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()

    socket.receive(JSON.stringify({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      workspace_id: "ws_1",
      method: "GET",
      path: "/stream",
      headers: {},
      end: true,
    }))

    await waitForSent(socket, "http.response.chunk")
    expect(signal?.aborted).toBe(false)
    tunnel.close()
    await aborted
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(signal?.aborted).toBe(true)
    expect(streamCanceled).toBe(true)
    expect(socket.sent.some((item) => JSON.parse(item).type === "http.response.end")).toBe(false)
  })

  test("pauses host HTTP response streaming until relay flow-control resumes", async () => {
    const sockets: FakeWebSocket[] = []
    let releaseSecond!: () => void
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const request: NonNullable<Parameters<typeof startWorkspaceRelayHostTunnel>[0]["request"]> = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"))
      },
      async pull(controller) {
        await second
        controller.enqueue(new TextEncoder().encode("second"))
        controller.close()
      },
    }))
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      request,
      webSocket: class extends FakeWebSocket {
        paused = false

        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }

        send(data: string) {
          super.send(data)
          const message = JSON.parse(data) as { type: string; request_id?: string }
          if (this.paused || message.type !== "http.response.chunk" || !message.request_id) return
          this.paused = true
          this.receive(JSON.stringify({
            type: "http.response.flow",
            protocol: TUNNEL_PROTOCOL_VERSION,
            request_id: message.request_id,
            paused: true,
            reason: "slow_consumer",
          }))
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()

    socket.receive(JSON.stringify({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      workspace_id: "ws_1",
      method: "GET",
      path: "/stream",
      headers: {},
      end: true,
    }))

    const firstChunks = await waitForSentTypeCount<{ type: string; body_base64: string }>(socket, "http.response.chunk", 1)
    releaseSecond()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(socket.sent.map((item) => JSON.parse(item) as { type: string }).filter((item) => item.type === "http.response.chunk")).toHaveLength(1)

    socket.receive(JSON.stringify({
      type: "http.response.flow",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      paused: false,
      reason: "drained",
    }))
    const chunks = await waitForSentTypeCount<{ type: string; body_base64: string }>(socket, "http.response.chunk", 2)
    await waitForSent(socket, "http.response.end")

    expect(chunks.map((chunk) => Buffer.from(chunk.body_base64, "base64").toString("utf8"))).toEqual(["first", "second"])
    expect(firstChunks).toHaveLength(1)
    tunnel.close()
  })

  test("keeps a burst of small frames that arrives before the upstream WebSocket opens", async () => {
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    socket.receive(JSON.stringify({
      type: "ws.open",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "channel_1",
      workspace_id: "ws_1",
      path: "/api/ws",
      headers: {},
    }))
    const upstream = sockets[1]

    // 200 keystroke-sized frames while the upstream is still CONNECTING; a
    // frame-count bound alone closed the channel at 65 and delivered nothing.
    const frames = Array.from({ length: 200 }, (_, index) => `key-${index}`)
    for (const frame of frames) {
      socket.receive(JSON.stringify({
        type: "ws.frame",
        protocol: TUNNEL_PROTOCOL_VERSION,
        channel_id: "channel_1",
        binary: false,
        data_base64: Buffer.from(frame).toString("base64"),
      }))
    }

    expect(socket.sent.map((item) => JSON.parse(item) as { type: string }).filter((item) => item.type === "ws.close")).toEqual([])
    upstream.open()
    expect(upstream.sent).toEqual(frames)
    tunnel.close()
  })

  test("closes upstream WebSocket channels when the pre-open queue exceeds its byte bound", async () => {
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      // Both bounds must be crossed to close, so a test that means to exercise
      // the close path has to make the queued BYTES the binding constraint.
      wsPreOpenQueueMaxFrames: 1,
      wsPreOpenQueueMaxBytes: 8,
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    socket.receive(JSON.stringify({
      type: "ws.open",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "channel_1",
      workspace_id: "ws_1",
      path: "/api/ws",
      headers: {},
    }))
    const upstream = sockets[1]

    socket.receive(JSON.stringify({
      type: "ws.frame",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "channel_1",
      binary: false,
      data_base64: "Zmlyc3Q=",
    }))
    socket.receive(JSON.stringify({
      type: "ws.frame",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "channel_1",
      binary: false,
      data_base64: "c2Vjb25k",
    }))

    const close = await waitForSent(socket, "ws.close")
    // The relay-facing ws.close FRAME keeps the protocol code (1013); the
    // local WebSocket.close() call is clamped to 1000 — WHATWG close() only
    // permits 1000/3000-4999 and undici throws InvalidAccessError otherwise
    // (an uncaught throw that killed the host process in production).
    expect(upstream.closeCode).toBe(1000)
    expect(close).toMatchObject({
      type: "ws.close",
      channel_id: "channel_1",
      code: 1000,
      reason: "Host upstream WebSocket pre-open queue limit exceeded",
    })
    tunnel.close()
  })

  test("survives an error on the tunnel socket and reconnects instead of crashing", async () => {
    const sockets: FakeWebSocket[] = []
    const events: WorkspaceRelayHostTunnelEvent[] = []
    const timers = fakeTimers()
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      reconnectIntervalMs: 10,
      reconnectJitterRatio: 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onEvent: (event) => events.push(event),
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })

    // A transient relay 500 on the upgrade: `ws` emits 'error' and, with no
    // listener attached, Node treats it as fatal — the whole host process died
    // and the backoff path below never ran.
    expect(() => sockets[0].error()).not.toThrow()
    timers.fireNext()
    await flush()

    expect(sockets).toHaveLength(2)
    expect(events).toEqual([
      { type: "connecting", attempt: 1 },
      { type: "reconnecting", attempt: 2, delayMs: 10, reason: "closed" },
      { type: "connecting", attempt: 2 },
    ])
    tunnel.close()
  })

  test("schedules one reconnect when a tunnel socket error is followed by a close", async () => {
    const sockets: FakeWebSocket[] = []
    const events: WorkspaceRelayHostTunnelEvent[] = []
    const timers = fakeTimers()
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      reconnectIntervalMs: 10,
      reconnectJitterRatio: 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onEvent: (event) => events.push(event),
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })

    sockets[0].open()
    // `ws` emits 'error' then 'close' for the same failure. Two reconnects for
    // one disconnect would halve the backoff and double the connect load.
    sockets[0].error()
    sockets[0].close(1006)

    expect(events.filter((event) => event.type === "reconnecting")).toEqual([
      { type: "reconnecting", attempt: 2, delayMs: 10, reason: "closed" },
    ])
    tunnel.close()
  })

  test("closes upstream WebSocket channels that do not open before the watchdog fires", async () => {
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      wsOpenTimeoutMs: 1,
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    socket.receive(JSON.stringify({
      type: "ws.open",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "channel_1",
      workspace_id: "ws_1",
      path: "/api/ws",
      headers: {},
    }))
    const upstream = sockets[1]

    const close = await waitForSent(socket, "ws.close")

    expect(upstream.closeCode).toBe(1000)
    expect(close).toMatchObject({
      type: "ws.close",
      channel_id: "channel_1",
      code: 1000,
      reason: "Host upstream WebSocket open timeout",
    })
    tunnel.close()
  })

  test("closes open upstream WebSocket channels when the host tunnel closes", () => {
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()
    socket.receive(JSON.stringify({
      type: "ws.open",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "channel_1",
      workspace_id: "ws_1",
      path: "/api/ws",
      headers: {},
    }))
    const upstream = sockets[1]
    upstream.open()

    tunnel.close()

    expect(upstream.closeCode).toBe(1000)
    expect(upstream.readyState).toBe(WebSocket.CLOSED)
  })

  test("reconnects with exponential backoff and jitter, then resets after open", () => {
    const sockets: FakeWebSocket[] = []
    const timers = fakeTimers()
    const originalRandom = Math.random
    Math.random = () => 1
    try {
      const tunnel = startWorkspaceRelayHostTunnel({
        relayUrl: "http://relay.invalid",
        hostId: "host_1",
        workspaceIds: ["ws_1"],
        localBaseUrl: "http://runtime.invalid",
        reconnectIntervalMs: 10,
        reconnectMaxIntervalMs: 100,
        reconnectJitterRatio: 0.5,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        webSocket: class extends FakeWebSocket {
          constructor(url: string, options: { headers?: Record<string, string> }) {
            super(url, options)
            sockets.push(this)
          }
        } as never,
      })

      sockets[0].close()
      timers.fireNext()
      sockets[1].close()
      timers.fireNext()
      sockets[2].open()
      sockets[2].close()
      timers.fireNext()

      expect(timers.fired()).toEqual([15, 30, 15])
      tunnel.close()
    } finally {
      Math.random = originalRandom
    }
  })

  test("refreshes host tunnel bearer tokens before each relay connection", async () => {
    const sockets: FakeWebSocket[] = []
    let tokens = 0
    const timers = fakeTimers()
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      headers: {
        Authorization: "Bearer stale",
        "x-host-kind": "machine",
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      tokenProvider: async () => `token_${++tokens}`,
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })

    await flush()
    expect(sockets[0].options.headers).toEqual({
      authorization: "Bearer token_1",
      "x-host-kind": "machine",
    })

    sockets[0].open()
    sockets[0].close()
    timers.fireNext()
    await flush()

    expect(sockets[1].options.headers).toEqual({
      authorization: "Bearer token_2",
      "x-host-kind": "machine",
    })
    tunnel.close()
  })

  test("retries with backoff when the host tunnel token provider fails", async () => {
    const sockets: FakeWebSocket[] = []
    const events: WorkspaceRelayHostTunnelEvent[] = []
    let attempts = 0
    const timers = fakeTimers()
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      reconnectIntervalMs: 10,
      reconnectJitterRatio: 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onEvent: (event) => events.push(event),
      tokenProvider: async () => {
        attempts++
        if (attempts === 1) throw new Error("mint failed")
        return "fresh"
      },
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })

    await flush()
    expect(sockets).toHaveLength(0)
    timers.fireNext()
    await flush()

    expect(timers.fired()).toEqual([10])
    expect(sockets).toHaveLength(1)
    expect(sockets[0].options.headers).toEqual({
      authorization: "Bearer fresh",
    })
    sockets[0].open()
    expect(events).toEqual([
      { type: "connecting", attempt: 1 },
      { type: "auth-failed", attempt: 1, error: "mint failed" },
      { type: "reconnecting", attempt: 2, delayMs: 10, reason: "auth-failed" },
      { type: "connecting", attempt: 2 },
      { type: "open" },
    ])
    tunnel.close()
  })

  test("stops retrying after the host tunnel reconnect attempt cap is reached", async () => {
    const sockets: FakeWebSocket[] = []
    const events: WorkspaceRelayHostTunnelEvent[] = []
    const timers = fakeTimers()
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      maxReconnectAttempts: 1,
      reconnectIntervalMs: 10,
      reconnectJitterRatio: 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onEvent: (event) => events.push(event),
      tokenProvider: async () => {
        throw new Error("mint failed")
      },
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })

    await flush()
    timers.fireNext()
    await flush()

    expect(sockets).toHaveLength(0)
    expect(events).toEqual([
      { type: "connecting", attempt: 1 },
      { type: "auth-failed", attempt: 1, error: "mint failed" },
      { type: "reconnecting", attempt: 2, delayMs: 10, reason: "auth-failed" },
      { type: "connecting", attempt: 2 },
      { type: "auth-failed", attempt: 2, error: "mint failed" },
      { type: "closed", reason: "max-attempts" },
    ])
    tunnel.close()
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1)
  })

  test("routes synchronously throwing token providers into the auth-failed backoff path", async () => {
    const events: WorkspaceRelayHostTunnelEvent[] = []
    const timers = fakeTimers()
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      reconnectIntervalMs: 10,
      reconnectJitterRatio: 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onEvent: (event) => events.push(event),
      tokenProvider: (() => {
        throw new Error("sync mint failed")
      }) as unknown as () => Promise<string>,
      webSocket: FakeWebSocket as never,
    })

    await flush()
    // The reconnect timer invokes connect() directly; a synchronous throw here
    // must not escape as an uncaught exception.
    expect(() => timers.fireNext()).not.toThrow()
    await flush()

    expect(events).toEqual([
      { type: "connecting", attempt: 1 },
      { type: "auth-failed", attempt: 1, error: "sync mint failed" },
      { type: "reconnecting", attempt: 2, delayMs: 10, reason: "auth-failed" },
      { type: "connecting", attempt: 2 },
      { type: "auth-failed", attempt: 2, error: "sync mint failed" },
      { type: "reconnecting", attempt: 3, delayMs: 20, reason: "auth-failed" },
    ])
    tunnel.close()
  })

  test("times out token providers that never settle and falls back to backoff", async () => {
    const events: WorkspaceRelayHostTunnelEvent[] = []
    const sockets: FakeWebSocket[] = []
    const timers = fakeTimers()
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      wsOpenTimeoutMs: 25,
      reconnectIntervalMs: 10,
      reconnectJitterRatio: 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onEvent: (event) => events.push(event),
      tokenProvider: () => new Promise<string>(() => {}),
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })

    await flush()
    expect(sockets).toHaveLength(0)
    // First pending timer is the mint timeout (reuses wsOpenTimeoutMs).
    timers.fireNext()
    await flush()

    expect(sockets).toHaveLength(0)
    expect(events).toEqual([
      { type: "connecting", attempt: 1 },
      { type: "auth-failed", attempt: 1, error: "Host tunnel token mint timed out after 25ms" },
      { type: "reconnecting", attempt: 2, delayMs: 10, reason: "auth-failed" },
    ])
    tunnel.close()
  })

  test("treats relay auth-rejection close codes as auth-failed before backing off", async () => {
    const sockets: FakeWebSocket[] = []
    const events: WorkspaceRelayHostTunnelEvent[] = []
    const timers = fakeTimers()
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      reconnectIntervalMs: 10,
      reconnectJitterRatio: 0,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onEvent: (event) => events.push(event),
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })

    sockets[0].open()
    // 1008 (policy violation) is the relay's token-rejection close code.
    sockets[0].close(1008, "Runtime Access Token expired")
    timers.fireNext()
    sockets[1].open()
    // Routine closes still reconnect with reason "closed".
    sockets[1].close(1006)

    expect(events).toEqual([
      { type: "connecting", attempt: 1 },
      { type: "open" },
      { type: "auth-failed", attempt: 1, error: "Runtime Access Token expired" },
      { type: "reconnecting", attempt: 2, delayMs: 10, reason: "auth-failed" },
      { type: "connecting", attempt: 2 },
      { type: "open" },
      { type: "reconnecting", attempt: 2, delayMs: 10, reason: "closed" },
    ])
    tunnel.close()
  })

  test("ignores http.response.flow frames for unknown or finished request ids", async () => {
    const sockets: FakeWebSocket[] = []
    const request: NonNullable<Parameters<typeof startWorkspaceRelayHostTunnel>[0]["request"]> = async () => new Response("flow-ok")
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      request,
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()

    const pauseFrame = JSON.stringify({
      type: "http.response.flow",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      paused: true,
      reason: "slow_consumer",
    })
    const httpRequest = JSON.stringify({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      workspace_id: "ws_1",
      method: "GET",
      path: "/flow",
      headers: {},
      end: true,
    })

    // A pause for a request id that has not started must be ignored — it
    // would otherwise pre-create an entry that stalls the next request.
    socket.receive(pauseFrame)
    socket.receive(httpRequest)
    await waitForSent(socket, "http.response.end")

    // A pause arriving after http.response.end must not leak an entry that
    // blocks a future request reusing the same id.
    socket.receive(pauseFrame)
    socket.sent.length = 0
    socket.receive(httpRequest)
    await waitForSent(socket, "http.response.end")

    tunnel.close()
  })

  test("treats http.response.flow reason \"closed\" as a terminal abort for the in-flight request", async () => {
    const sockets: FakeWebSocket[] = []
    let cancelled = false
    const request: NonNullable<Parameters<typeof startWorkspaceRelayHostTunnel>[0]["request"]> = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"))
      },
      // Never produce another chunk — the relay kills the response while the
      // host is still mid-stream.
      pull: () => new Promise<never>(() => {}),
      cancel() {
        cancelled = true
      },
    }))
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      request,
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    const socket = sockets[0]
    socket.open()

    socket.receive(JSON.stringify({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      workspace_id: "ws_1",
      method: "GET",
      path: "/stream",
      headers: {},
      end: true,
    }))
    await waitForSentTypeCount(socket, "http.response.chunk", 1)

    // The relay's pending-timeout/slow-consumer kill: paused:false is NOT a
    // resume here — reason:"closed" means the response is gone.
    socket.receive(JSON.stringify({
      type: "http.response.flow",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      paused: false,
      reason: "closed",
    }))

    const deadline = Date.now() + 1_000
    // Re-read through a call: `cancelled` is set by the abort handler on
    // another task, which a bare variable in the condition cannot express.
    const stillRunning = () => !cancelled
    while (stillRunning()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the upstream reader to be aborted")
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    const types = socket.sent.map((item) => (JSON.parse(item) as { type: string }).type)
    expect(types.filter((type) => type === "http.response.chunk")).toHaveLength(1)
    expect(types).not.toContain("http.response.end")
    expect(types).not.toContain("error")
    tunnel.close()
  })

  test("forwards tunnelled HTTP requests to the local Workspace Host Service", async () => {
    const relay = await harness()
    const hostAuthorizations: string[] = []
    const hostWorkspaces: string[] = []
    const host = Bun.serve({
      port: 0,
      fetch(request) {
        hostAuthorizations.push(request.headers.get("authorization") ?? "")
        hostWorkspaces.push(request.headers.get("x-workspace-id") ?? "")
        return new Response("host-ok", {
          status: 203,
          headers: {
            "content-type": "text/plain",
          },
        })
      },
    })
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: String(relay.relay.url),
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: String(host.url),
      headers: {
        authorization: `Bearer ${relay.hostTunnelToken}`,
      },
      pingIntervalMs: 1_000,
    })

    try {
      await relay.observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.relay.url), {
        headers: {
          authorization: `Bearer ${relay.runtimeAccessToken}`,
        },
      })

      expect(res.status).toBe(203)
      await expect(res.text()).resolves.toBe("host-ok")
      await expect(verifyRelayHostToken(hostAuthorizations[0].replace(/^Bearer\s+/i, ""), relay.relayHost.publicKey, {
        workspaceId: "ws_1",
        hostId: "host_1",
      })).resolves.toMatchObject({
        backing: "local-worktree",
      })
      expect(hostWorkspaces[0]).toBe("ws_1")
    } finally {
      tunnel.close()
      await host.stop(true)
      await relay.relay.stop(true)
    }
  })

  test("streams large tunnelled responses through the host tunnel before the host finishes", async () => {
    const relay = await harness()
    const firstChunk = new Uint8Array(64 * 1024).fill(65)
    const secondChunk = new Uint8Array(64 * 1024).fill(66)
    let restReleased = false
    let releaseRest!: () => void
    const rest = new Promise<void>((resolve) => {
      releaseRest = () => {
        restReleased = true
        resolve()
      }
    })
    const host = Bun.serve({
      port: 0,
      fetch() {
        return new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(firstChunk)
            await rest
            controller.enqueue(secondChunk)
            controller.close()
          },
        }), {
          headers: {
            "content-type": "application/octet-stream",
          },
        })
      },
    })
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: String(relay.relay.url),
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: String(host.url),
      headers: {
        authorization: `Bearer ${relay.hostTunnelToken}`,
      },
      pingIntervalMs: 1_000,
    })

    try {
      await relay.observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/file/raw?path=large.bin", relay.relay.url), {
        headers: {
          authorization: `Bearer ${relay.runtimeAccessToken}`,
        },
      })

      expect(res.status).toBe(200)
      expect(res.body).toBeTruthy()
      const reader = res.body!.getReader()
      const first = await reader.read()

      expect(first.done).toBe(false)
      expect(first.value!.length).toBeGreaterThan(0)
      expect(restReleased).toBe(false)
      releaseRest()

      const chunks = [first.value!]
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        chunks.push(chunk.value)
      }

      expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.concat([
        Buffer.from(firstChunk),
        Buffer.from(secondChunk),
      ]))
    } finally {
      releaseRest()
      tunnel.close()
      await host.stop(true)
      await relay.relay.stop(true)
    }
  })

  test("forwards tunnelled WebSocket channels to the local Workspace Host Service", async () => {
    const relay = await harness()
    const hostWorkspaces: string[] = []
    const host = Bun.serve<{ ok: true }>({
      port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname !== "/api/ws") return new Response("not found", { status: 404 })
        hostWorkspaces.push(request.headers.get("x-workspace-id") ?? "")
        if (server.upgrade(request, { data: { ok: true } })) return undefined as unknown as Response
        return new Response("upgrade failed", { status: 400 })
      },
      websocket: {
        message(ws, message) {
          ws.send(`host:${typeof message === "string" ? message : Buffer.from(message).toString()}`)
        },
      },
    })
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: String(relay.relay.url),
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: String(host.url),
      headers: {
        authorization: `Bearer ${relay.hostTunnelToken}`,
      },
      pingIntervalMs: 1_000,
    })
    let client: WebSocket | undefined

    try {
      await relay.observer.waitForPresence()
      // Bun's `WebSocket` constructor accepts an extended
      // `(url, { headers, protocols })` shape — use it to send the
      // origin header the relay's `requireAllowedOrigin` enforces on
      // WebSocket upgrades. Without this, bun WS clients send no
      // origin header and the relay returns 403, surfacing as a
      // generic "WebSocket failed to open" on the client side.
      client = new (WebSocket as unknown as {
        new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
      })(
        new URL("/workspaces/ws_1/api/ws", relay.relay.url).toString().replace(/^http/, "ws"),
        {
          headers: { origin: "http://localhost:3000" },
          protocols: [`claxedo-rat.${relay.runtimeAccessToken}`],
        },
      )
      await waitForOpen(client)
      const message = waitForMessage(client)
      client.send("ping")

      await expect(message).resolves.toBe("host:ping")
      expect(hostWorkspaces[0]).toBe("ws_1")
    } finally {
      client?.close()
      tunnel.close()
      await host.stop(true)
      await relay.relay.stop(true)
    }
  })

  test("closing the host tunnel makes machine-placed workspaces unavailable remotely", async () => {
    const relay = await harness()
    const host = Bun.serve({
      port: 0,
      fetch() {
        return new Response("host-ok")
      },
    })
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: String(relay.relay.url),
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: String(host.url),
      headers: {
        authorization: `Bearer ${relay.hostTunnelToken}`,
      },
      pingIntervalMs: 1_000,
    })

    try {
      await relay.observer.waitForPresence()
      tunnel.close()
      await relay.observer.waitForNoPresence()

      const res = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.relay.url), {
        headers: {
          authorization: `Bearer ${relay.runtimeAccessToken}`,
        },
      })

      expect(res.status).toBe(503)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "host_tunnel_offline",
          message: "The machine serving this workspace is offline",
        },
      })
    } finally {
      tunnel.close()
      await host.stop(true)
      await relay.relay.stop(true)
    }
  })

  test("reconnects the host tunnel after Workspace Relay restarts", async () => {
    const relay = await harness()
    const host = Bun.serve({
      port: 0,
      fetch() {
        return new Response("host-ok", {
          headers: {
            "content-type": "text/plain",
          },
        })
      },
    })
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: String(relay.relay.url),
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: String(host.url),
      headers: {
        authorization: `Bearer ${relay.hostTunnelToken}`,
      },
      pingIntervalMs: 1_000,
      reconnectIntervalMs: 10,
    })

    try {
      await relay.observer.waitForPresence()
      const port = Number(new URL(String(relay.relay.url)).port)
      await relay.relay.stop(true)
      await relay.observer.waitForNoPresence()
      relay.relay = relay.startRelay(port)

      await relay.observer.waitForPresence()
      const res = await fetch(new URL("/workspaces/ws_1/api/wr/health", relay.relay.url), {
        headers: {
          authorization: `Bearer ${relay.runtimeAccessToken}`,
        },
      })

      expect(res.status).toBe(200)
      await expect(res.text()).resolves.toBe("host-ok")
    } finally {
      tunnel.close()
      await host.stop(true)
      await relay.relay.stop(true)
    }
  })
})

/**
 * W6b.3 — the region hint the relay needs to place a workspace's Durable Object.
 *
 * The relay derives its DO location hint from a region on the very first request
 * (`relayRequestRegion` in workspace-relay/src/cloudflare.ts) and that placement
 * is PERMANENT — a DO's location is fixed at creation and never migrates. The
 * relay reads the param; this is the side that sends it.
 *
 * Both compatibility directions matter, because relay and runtime deploy
 * independently:
 *  - an OLD relay receiving `?region=` ignores it (it only ever reads
 *    `workspaceId`/`workspace_id` from the tunnel query), so sending is safe;
 *  - an OLD runtime omits it, and the relay falls back to its configured
 *    deployment hint, so absence is safe.
 * The `region` option is therefore optional and omitted entirely when unset,
 * rather than sent as an empty string.
 */
describe("workspace relay host tunnel region hint", () => {
  function tunnelWith(region?: string) {
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      localBaseUrl: "http://runtime.invalid",
      ...(region !== undefined ? { region } : {}),
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    return { tunnel, url: new URL(sockets[0].url.replace(/^ws/, "http")) }
  }

  test("carries the workspace region as a query param", async () => {
    const { tunnel, url } = tunnelWith("eu-west")

    expect(url.searchParams.get("region")).toBe("eu-west")
    // The existing contract must be untouched.
    expect(url.pathname).toBe("/host-tunnels/host_1")
    expect(url.searchParams.getAll("workspaceId")).toEqual(["ws_1"])
    tunnel.close()
  })

  test("omits the param entirely when no region is configured", async () => {
    // Backwards direction: an unset region must not produce `?region=`, so a
    // relay never sees an empty value it would have to special-case.
    const { tunnel, url } = tunnelWith()

    expect(url.searchParams.has("region")).toBe(false)
    expect(url.searchParams.getAll("workspaceId")).toEqual(["ws_1"])
    tunnel.close()
  })

  test("omits the param for a blank or whitespace region", async () => {
    for (const region of ["", "   "]) {
      const { tunnel, url } = tunnelWith(region)
      expect(url.searchParams.has("region"), `region ${JSON.stringify(region)}`).toBe(false)
      tunnel.close()
    }
  })

  test("encodes a region safely into the query", async () => {
    const { tunnel, url } = tunnelWith("eu west/&x")

    expect(url.searchParams.get("region")).toBe("eu west/&x")
    // Must not have leaked into the path or spawned extra params.
    expect(url.pathname).toBe("/host-tunnels/host_1")
    expect([...url.searchParams.keys()].toSorted()).toEqual(["region", "workspaceId"])
    tunnel.close()
  })
})

/**
 * Pins current registration behaviour that inventory-driven registration is
 * expected to invert; update these assertions with that change, do not delete
 * them.
 */
describe("host tunnel registration characterization", () => {
  test("reconnect still upgrades with the ORIGINAL workspace set, not the updated one", async () => {
    // `tunnelUrl()` reads `options.workspaceIds`, fixed at construction, while
    // `updateRegistration` only stores a frame to replay after `onopen`, so a
    // removed workspace reappears in relay presence between the reconnect
    // upgrade and the replayed update. Once the accepted set drives the
    // reconnect URL, the first assertion below flips to `["ws_a"]`.
    const sockets: FakeWebSocket[] = []
    const timers = fakeTimers()
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_a", "ws_b"],
      localBaseUrl: "http://runtime.invalid",
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
      setTimeout: timers.setTimeout as never,
      clearTimeout: timers.clearTimeout as never,
    })

    sockets[0].open()
    await tunnel.updateRegistration({ workspaceIds: ["ws_a"], token: "htt_2" })

    // Force a reconnect and let the backoff timer fire.
    sockets[0].close(1006, "relay restart")
    for (const timer of timers.timers) {
      if (!timer.cleared && !timer.fired) {
        timer.fired = true
        timer.fn()
      }
    }

    expect(sockets.length).toBeGreaterThan(1)
    const reconnectUrl = new URL(sockets.at(-1)!.url.replace(/^ws/, "http"))
    expect(reconnectUrl.searchParams.getAll("workspaceId")).toEqual(["ws_a", "ws_b"])

    // The replayed update frame carries the correct set, so the window is transient.
    sockets.at(-1)!.open()
    const replayed = await waitForSent(sockets.at(-1)!, "host.registration.update")
    expect((replayed as unknown as { workspace_ids: string[] }).workspace_ids).toEqual(["ws_a"])

    tunnel.close()
  })

  test("an empty workspace set is currently rejected", async () => {
    // A machine with zero local workspaces is a valid enrollment, but the
    // transport has no representation for it: a caller must keep the tunnel
    // closed until the first workspace appears rather than send an empty set.
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_a"],
      localBaseUrl: "http://runtime.invalid",
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    sockets[0].open()

    await expect(tunnel.updateRegistration({ workspaceIds: [], token: "htt_2" })).rejects.toThrow(
      /At least one workspace is required/,
    )

    tunnel.close()
  })

  test("deduplicates a repeated workspace id in one registration", async () => {
    // The transport normalizes duplicates, so a reconciler submitting a full
    // set does not have to.
    const sockets: FakeWebSocket[] = []
    const tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: "http://relay.invalid",
      hostId: "host_1",
      workspaceIds: ["ws_a"],
      localBaseUrl: "http://runtime.invalid",
      webSocket: class extends FakeWebSocket {
        constructor(url: string, options: { headers?: Record<string, string> }) {
          super(url, options)
          sockets.push(this)
        }
      } as never,
    })
    sockets[0].open()

    await tunnel.updateRegistration({ workspaceIds: ["ws_a", "ws_b", "ws_a"], token: "htt_2" })

    expect(JSON.parse(sockets[0].sent.at(-1)!)).toMatchObject({
      type: "host.registration.update",
      workspace_ids: ["ws_a", "ws_b"],
    })

    tunnel.close()
  })
})
