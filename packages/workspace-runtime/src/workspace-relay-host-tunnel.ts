import {
  isTunnelMessage,
  makeTunnelPing,
  makeTunnelPong,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelHeaderMap,
  type TunnelHttpRequest,
  type TunnelHttpResponseFlow,
  type TunnelMessage,
  type TunnelWsClose,
  type TunnelWsFrame,
  type TunnelWsOpen,
} from "@claxedo/workspace-relay-protocol"
import NodeWebSocket from "ws"

export type WorkspaceRelayHostTunnelOptions = {
  relayUrl: string
  hostId: string
  workspaceIds: string[]
  localBaseUrl: string
  /**
   * Home region of the workspaces this tunnel serves, forwarded to the relay so
   * it can place the workspace's Durable Object near its users.
   *
   * Worth threading even though it looks cosmetic: the relay fixes a DO's
   * location at FIRST CREATION and never migrates it, so this value is permanent
   * for the workspace. Omitted when unset — the relay then falls back to its
   * configured deployment-wide hint, which is what an older runtime produces.
   */
  region?: string
  resolveLocalUrl?: (input: { workspaceId: string; path: string }) => URL | undefined
  headers?: Record<string, string>
  tokenProvider?: () => Promise<string>
  onEvent?: (event: WorkspaceRelayHostTunnelEvent) => void
  maxReconnectAttempts?: number
  webSocket?: typeof WebSocket
  /**
   * Only ever called `(target, init)`, so it is typed to that shape rather than
   * `typeof fetch`, whose statics (`preconnect`) a caller supplying a plain
   * function has no reason to provide. The global `fetch` still satisfies it.
   */
  request?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  pingIntervalMs?: number
  reconnectIntervalMs?: number
  reconnectMaxIntervalMs?: number
  reconnectJitterRatio?: number
  wsOpenTimeoutMs?: number
  wsPreOpenQueueMaxFrames?: number
  wsPreOpenQueueMaxBytes?: number
  /**
   * Only ever called `(fn, delayMs)`, so it is typed to that shape rather than
   * `typeof globalThis.setTimeout`, whose overloads (string handler, extra
   * args) no fake timer implements. The global still satisfies it.
   */
  setTimeout?: (fn: () => void, delayMs?: number) => ReturnType<typeof globalThis.setTimeout>
  clearTimeout?: typeof globalThis.clearTimeout
}

export type WorkspaceRelayHostTunnel = {
  close(): void
  updateRegistration(input: { workspaceIds: string[]; token: string }): Promise<void>
}

// `attempt` is the 1-based total connection attempt: the initial connect is 1,
// the first reconnect is 2. `reconnecting` reports the attempt it schedules.
export type WorkspaceRelayHostTunnelEvent =
  | { type: "connecting"; attempt: number }
  | { type: "open" }
  | { type: "reconnecting"; attempt: number; delayMs: number; reason: "closed" | "auth-failed" }
  | { type: "auth-failed"; attempt: number; error: string }
  | { type: "closed"; reason: "client" | "max-attempts" }

type TunnelChannel = {
  upstream: WebSocket
  queue: Array<string | Uint8Array<ArrayBuffer>>
  /** Running byte size of `queue`; reset when it is flushed upstream. */
  queuedBytes: number
  openTimer: ReturnType<typeof setTimeout>
  closing: boolean
}

type HttpFlowControl = {
  paused: boolean
  waiters: Set<() => void>
  abort: () => void
}

const DEFAULT_WS_OPEN_TIMEOUT_MS = 10_000
// Frames the relay may forward while this host's upstream socket is still
// connecting. Both bounds must be crossed to close, so this is the secondary
// one — it caps the per-entry bookkeeping the byte bound cannot see, and is
// deliberately far above any interactive burst.
const DEFAULT_WS_PRE_OPEN_QUEUE_MAX_FRAMES = 8_192
// Bytes are the resource this queue actually consumes, so they are the real
// bound. Mirrors `UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_BYTES_DEFAULT` on the relay
// side (workspace-relay/src/cloudflare.ts) on purpose: the two legs queue the
// same stream during the same connect window, and a host that admitted less
// than the relay would just move the same startup failure one hop inward.
//
// Overflow CLOSES the channel rather than dropping frames, deliberately: this
// queue carries an ordered byte stream (terminal input, PTY data), so shedding
// entries would hand the far end a corrupted stream with no error anywhere.
// The tunnel protocol has no acknowledgement, so there is no backpressure
// signal to send instead — a clean, named close is the honest failure.
const DEFAULT_WS_PRE_OPEN_QUEUE_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_RECONNECT_INTERVAL_MS = 1_000
const DEFAULT_RECONNECT_MAX_INTERVAL_MS = 30_000
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2
// Close codes the relay uses to reject credentials in-band: 1008 (policy
// violation) is what `watchRuntimeAccessToken` sends when a token expires or
// is revoked mid-connection (see workspace-relay/src/cloudflare.ts). Pre-open
// rejections surface as HTTP 401/403 before the upgrade and cannot carry a
// close code.
const AUTH_REJECTED_CLOSE_CODES = new Set([1008])

function normalized(input: string) {
  return input.replace(/\/+$/, "")
}

function tunnelUrl(input: WorkspaceRelayHostTunnelOptions) {
  const url = new URL(`/host-tunnels/${encodeURIComponent(input.hostId)}`, `${normalized(input.relayUrl)}/`)
  for (const workspaceId of input.workspaceIds) {
    url.searchParams.append("workspaceId", workspaceId)
  }
  // Only set when non-blank. An older relay ignores the param (it reads only
  // `workspaceId`/`workspace_id` here), and a relay that does read it treats
  // absence as "use the configured default" — so both deployment directions stay
  // compatible, but an empty value would be a third case for no reason.
  const region = input.region?.trim()
  if (region) url.searchParams.set("region", region)
  return url.toString().replace(/^http/, "ws")
}

function targetUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\/+/, ""), `${normalized(baseUrl)}/`)
}

function localTarget(input: WorkspaceRelayHostTunnelOptions, workspaceId: string, path: string) {
  return input.resolveLocalUrl?.({ workspaceId, path }) ?? (input.resolveLocalUrl ? undefined : targetUrl(input.localBaseUrl, path))
}

function headers(input: TunnelHeaderMap) {
  const result = new Headers()
  for (const [key, value] of Object.entries(input)) {
    result.set(key, value)
  }
  return result
}

function headerMap(input: Headers) {
  const result: TunnelHeaderMap = {}
  input.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function decoded(input: string) {
  return Buffer.from(input, "base64")
}

function encoded(input: ArrayBuffer | ArrayBufferView) {
  if (input instanceof ArrayBuffer) return Buffer.from(input).toString("base64")
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("base64")
}

/** Byte size of a frame awaiting the upstream socket, for the pre-open bound. */
function preOpenFrameBytes(input: string | Uint8Array<ArrayBuffer>) {
  if (typeof input === "string") return Buffer.byteLength(input)
  return input.byteLength
}

function encodedFrame(input: MessageEvent["data"]) {
  if (typeof input === "string") {
    return {
      binary: false,
      data_base64: Buffer.from(input).toString("base64"),
    }
  }
  if (input instanceof ArrayBuffer) {
    return {
      binary: true,
      data_base64: encoded(input),
    }
  }
  if (ArrayBuffer.isView(input)) {
    return {
      binary: true,
      data_base64: Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("base64"),
    }
  }
}

function send(ws: WebSocket, message: TunnelMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

function safeCloseCode(code: unknown) {
  // WHATWG WebSocket.close() only permits 1000 or 3000–4999 from the
  // APPLICATION — protocol codes like 1011/1013 (valid on RECEIVED close
  // frames) make undici throw InvalidAccessError, and from an event handler
  // that uncaught throw kills the whole host process. Clamp everything else
  // to 1000.
  if (typeof code !== "number" || !Number.isInteger(code)) return 1000
  if (code === 1000) return code
  if (code >= 3000 && code <= 4999) return code
  return 1000
}

function safeCloseReason(reason: unknown) {
  if (typeof reason !== "string") return ""
  let result = ""
  for (const char of reason) {
    if (Buffer.byteLength(result + char) > 123) return result
    result += char
  }
  return result
}

function errorMessage(input: unknown) {
  return input instanceof Error ? input.message : String(input)
}

function closeSocket(ws: WebSocket, code?: number, reason?: string) {
  try {
    ws.close(safeCloseCode(code), safeCloseReason(reason))
  } catch {
    // A close() that throws (already-closing socket, exotic runtime
    // validation) must never take down the host process.
  }
}

function reconnectDelay(input: WorkspaceRelayHostTunnelOptions, attempt: number) {
  const base = Math.max(1, input.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS)
  const max = Math.max(base, input.reconnectMaxIntervalMs ?? DEFAULT_RECONNECT_MAX_INTERVAL_MS)
  const jitterRatio = Math.max(0, input.reconnectJitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO)
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1))
  return Math.min(max, Math.round(exponential + exponential * jitterRatio * Math.random()))
}

function tunnelHeaders(input: WorkspaceRelayHostTunnelOptions, token: string) {
  const result = { ...(input.headers ?? {}) }
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === "authorization") delete result[key]
  }
  result.authorization = `Bearer ${token}`
  return result
}

function sendWsClose(tunnel: WebSocket, channelId: string, code: unknown, reason: unknown) {
  send(tunnel, {
    type: "ws.close",
    protocol: TUNNEL_PROTOCOL_VERSION,
    channel_id: channelId,
    code: safeCloseCode(code),
    reason: safeCloseReason(reason),
  })
}

function closeChannel(
  tunnel: WebSocket,
  channels: Map<string, TunnelChannel>,
  channelId: string,
  channel: TunnelChannel,
  code: number,
  reason: string,
) {
  if (channel.closing) return
  channel.closing = true
  clearTimeout(channel.openTimer)
  channels.delete(channelId)
  closeSocket(channel.upstream, code, reason)
  sendWsClose(tunnel, channelId, code, reason)
}

function parseTunnelMessage(data: MessageEvent["data"]) {
  if (typeof data !== "string") return
  try {
    const parsed = JSON.parse(data) as unknown
    if (isTunnelMessage(parsed)) return parsed
  } catch {}
}

async function waitForHttpFlow(flowControls: Map<string, HttpFlowControl>, requestId: string, signal: AbortSignal) {
  const flow = flowControls.get(requestId)
  if (!flow?.paused) return
  await new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done)
      flow.waiters.delete(done)
      resolve()
    }
    flow.waiters.add(done)
    signal.addEventListener("abort", done, { once: true })
  })
}

function applyHttpFlow(flowControls: Map<string, HttpFlowControl>, message: TunnelHttpResponseFlow) {
  // Flow entries are registered when the http.request starts and removed when
  // forwarding finishes — frames for unknown/finished request ids are ignored
  // so a late pause cannot leak an entry that only socket teardown clears.
  const current = flowControls.get(message.request_id)
  if (!current) return
  // The relay sends `paused:false, reason:"closed"` when it kills an in-flight
  // response (pending-timeout/slow-consumer): that is a terminal abort, not a
  // resume — abort the upstream reader instead of streaming into a dead pipe.
  if (!message.paused && message.reason === "closed") {
    current.abort()
    return
  }
  current.paused = message.paused
  if (message.paused) return
  for (const waiter of current.waiters) waiter()
  current.waiters.clear()
}

function releaseHttpFlows(flowControls: Map<string, HttpFlowControl>) {
  for (const flow of flowControls.values()) {
    flow.paused = false
    for (const waiter of flow.waiters) waiter()
    flow.waiters.clear()
  }
  flowControls.clear()
}

async function forwardHttp(
  ws: WebSocket,
  input: WorkspaceRelayHostTunnelOptions,
  message: TunnelHttpRequest,
  signal: AbortSignal,
  flowControls: Map<string, HttpFlowControl>,
) {
  try {
    const target = localTarget(input, message.workspace_id, message.path)
    if (!target) {
      send(ws, {
        type: "http.response.start",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
        status: 403,
        headers: { "content-type": "application/json" },
      })
      send(ws, {
        type: "http.response.end",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: message.request_id,
      })
      return
    }
    const res = await (input.request ?? fetch)(target, {
      method: message.method,
      headers: headers(message.headers),
      body: message.body_base64 ? decoded(message.body_base64) : undefined,
      redirect: "manual",
      signal,
    })
    if (signal.aborted) return
    send(ws, {
      type: "http.response.start",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: message.request_id,
      status: res.status,
      headers: headerMap(res.headers),
    })
    if (res.body) {
      const reader = res.body.getReader()
      const cancel = () => {
        void reader.cancel().catch(() => {})
      }
      signal.addEventListener("abort", cancel, { once: true })
      try {
        for (;;) {
          await waitForHttpFlow(flowControls, message.request_id, signal)
          if (signal.aborted) return
          const chunk = await reader.read()
          if (signal.aborted) return
          if (chunk.done) break
          send(ws, {
            type: "http.response.chunk",
            protocol: TUNNEL_PROTOCOL_VERSION,
            request_id: message.request_id,
            body_base64: encoded(chunk.value),
          })
        }
      } finally {
        signal.removeEventListener("abort", cancel)
      }
    }
    if (signal.aborted) return
    send(ws, {
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: message.request_id,
    })
  } catch (err) {
    if (signal.aborted) return
    send(ws, {
      type: "error",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: message.request_id,
      code: "host_tunnel_http_failed",
      message: err instanceof Error ? err.message : String(err),
    })
  } finally {
    flowControls.delete(message.request_id)
  }
}

function openChannel(
  tunnel: WebSocket,
  input: WorkspaceRelayHostTunnelOptions,
  channels: Map<string, TunnelChannel>,
  message: TunnelWsOpen,
) {
  const target = localTarget(input, message.workspace_id, message.path)
  if (!target) {
    sendWsClose(tunnel, message.channel_id, 1008, "Workspace route is not remotely accessible")
    return
  }
  const WebSocketCtor = input.webSocket ?? WebSocket
  const upstream = new (WebSocketCtor as unknown as {
    new(url: string, options: { headers?: Record<string, string> }): WebSocket
  })(target.toString().replace(/^http/, "ws"), {
    headers: message.headers,
  })
  const channel: TunnelChannel = {
    upstream,
    queue: [],
    queuedBytes: 0,
    openTimer: setTimeout(() => {
      closeChannel(tunnel, channels, message.channel_id, channel, 1013, "Host upstream WebSocket open timeout")
    }, input.wsOpenTimeoutMs ?? DEFAULT_WS_OPEN_TIMEOUT_MS),
    closing: false,
  }
  channels.set(message.channel_id, channel)
  upstream.binaryType = "arraybuffer"
  upstream.onopen = () => {
    if (channel.closing) return
    clearTimeout(channel.openTimer)
    channel.queuedBytes = 0
    for (const frame of channel.queue.splice(0)) upstream.send(frame)
  }
  upstream.onmessage = (event) => {
    const frame = encodedFrame(event.data)
    if (!frame) return
    send(tunnel, {
      type: "ws.frame",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: message.channel_id,
      ...frame,
    })
  }
  upstream.onclose = (event) => {
    if (channel.closing) return
    channel.closing = true
    clearTimeout(channel.openTimer)
    channels.delete(message.channel_id)
    sendWsClose(tunnel, message.channel_id, event.code, event.reason)
  }
  upstream.onerror = () => {
    closeChannel(tunnel, channels, message.channel_id, channel, 1011, "Host upstream WebSocket failed")
  }
}

function forwardFrame(
  tunnel: WebSocket,
  input: WorkspaceRelayHostTunnelOptions,
  channels: Map<string, TunnelChannel>,
  message: TunnelWsFrame,
) {
  const channel = channels.get(message.channel_id)
  if (!channel) return
  const payload = message.binary
    ? new Uint8Array(decoded(message.data_base64))
    : decoded(message.data_base64).toString("utf8")
  if (channel.upstream.readyState === WebSocket.OPEN) {
    channel.upstream.send(payload)
    return
  }
  if (channel.upstream.readyState !== WebSocket.CONNECTING) {
    channels.delete(message.channel_id)
    return
  }
  // Admit on EITHER bound — see the constants. A burst of small frames during
  // the few milliseconds before upstream opens costs almost nothing to hold,
  // and closing on frame count alone loses the whole channel to a startup race
  // a client cannot avoid: a single client that pipelines 65 keystroke-sized
  // frames faster than the upstream socket opens got 0 of them delivered.
  const frameBytes = preOpenFrameBytes(payload)
  if (
    channel.queue.length >= (input.wsPreOpenQueueMaxFrames ?? DEFAULT_WS_PRE_OPEN_QUEUE_MAX_FRAMES)
    && channel.queuedBytes + frameBytes > (input.wsPreOpenQueueMaxBytes ?? DEFAULT_WS_PRE_OPEN_QUEUE_MAX_BYTES)
  ) {
    closeChannel(tunnel, channels, message.channel_id, channel, 1013, "Host upstream WebSocket pre-open queue limit exceeded")
    return
  }
  channel.queuedBytes += frameBytes
  channel.queue.push(payload)
}

export function startWorkspaceRelayHostTunnel(options: WorkspaceRelayHostTunnelOptions): WorkspaceRelayHostTunnel {
  const WebSocketCtor = options.webSocket ?? NodeWebSocket as unknown as typeof WebSocket
  const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout
  const clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout
  const channels = new Map<string, TunnelChannel>()
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let ws: WebSocket | undefined
  let closed = false
  let closedEventSent = false
  let reconnectAttempt = 0
  const httpControllers = new Set<AbortController>()
  const httpFlowControls = new Map<string, HttpFlowControl>()
  let registrationUpdate: { workspaceIds: string[]; token: string } | undefined

  const emit = (event: WorkspaceRelayHostTunnelEvent) => {
    options.onEvent?.(event)
  }

  const emitClosed = (reason: "client" | "max-attempts") => {
    if (closedEventSent) return
    closedEventSent = true
    emit({ type: "closed", reason })
  }

  const scheduleReconnect = (reason: "closed" | "auth-failed") => {
    if (closed) return
    const attempt = reconnectAttempt + 1
    if (options.maxReconnectAttempts !== undefined && attempt > options.maxReconnectAttempts) {
      closed = true
      cleanupSocket()
      ws?.close()
      ws = undefined
      emitClosed("max-attempts")
      return
    }
    reconnectAttempt = attempt
    const delayMs = reconnectDelay(options, reconnectAttempt)
    emit({ type: "reconnecting", attempt: reconnectAttempt + 1, delayMs, reason })
    reconnectTimer = setTimeoutFn(connect, delayMs)
  }

  const cleanupSocket = () => {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = undefined
    for (const controller of httpControllers) controller.abort()
    httpControllers.clear()
    releaseHttpFlows(httpFlowControls)
    for (const channel of channels.values()) {
      channel.closing = true
      clearTimeout(channel.openTimer)
      channel.upstream.close()
    }
    channels.clear()
  }

  const openSocket = (headers: Record<string, string> | undefined) => {
    if (closed) return
    const socket = new (WebSocketCtor as unknown as {
      new(url: string, options: { headers?: Record<string, string> }): WebSocket
    })(tunnelUrl(options), {
      headers,
    })
    ws = socket
    // Dead-socket watchdog: sending pings into a half-open TCP socket never
    // errors (frames just buffer), so without verifying that traffic comes
    // BACK the client believes a dead tunnel is healthy forever — the relay
    // marks the host offline while this process logs heartbeats. Any inbound
    // message counts as liveness; if the relay goes silent for 3 ping
    // intervals the socket is force-closed so the reconnect loop takes over.
    let lastInboundAt = Date.now()
    socket.onopen = () => {
      reconnectAttempt = 0
      lastInboundAt = Date.now()
      emit({ type: "open" })
      if (registrationUpdate) {
        send(socket, {
          type: "host.registration.update",
          protocol: TUNNEL_PROTOCOL_VERSION,
          workspace_ids: registrationUpdate.workspaceIds,
          token: registrationUpdate.token,
        })
      }
      const pingIntervalMs = options.pingIntervalMs ?? 15_000
      pingTimer = setInterval(() => {
        if (Date.now() - lastInboundAt > pingIntervalMs * 3) {
          // Half-open socket: relay silent despite our pings. `close()` on a
          // dead TCP connection may stall, so mirror the onclose teardown
          // directly and reconnect.
          if (pingTimer) clearInterval(pingTimer)
          pingTimer = undefined
          cleanupSocket()
          if (ws === socket) ws = undefined
          socket.onclose = null
          try {
            closeSocket(socket, 1001, "Host tunnel watchdog: relay silent")
          } catch {
            // socket already unusable — reconnect regardless
          }
          scheduleReconnect("closed")
          return
        }
        if (socket.readyState !== WebSocket.OPEN) return
        const control = socket as WebSocket & { ping?: () => void }
        if (control.ping) {
          // RFC WebSocket control frames are handled below the Durable Object
          // message API, so they keep the transport alive without waking it.
          control.ping()
          return
        }
        // Injected/browser-style clients without protocol ping support retain
        // the established v1 application heartbeat with unique identity and
        // real timestamps.
        socket.send(JSON.stringify(makeTunnelPing()))
      }, pingIntervalMs)
    }
    ;(socket as WebSocket & { on?: (event: "pong", listener: () => void) => void }).on?.("pong", () => {
      if (ws === socket) lastInboundAt = Date.now()
    })
    socket.onmessage = (event) => {
      if (ws !== socket) return
      lastInboundAt = Date.now()
      const parsed = parseTunnelMessage(event.data)
      if (!parsed) return
      if (parsed.type === "ping") {
        send(socket, makeTunnelPong(parsed))
        return
      }
      if (parsed.type === "http.request") {
        const controller = new AbortController()
        httpControllers.add(controller)
        httpFlowControls.set(parsed.request_id, { paused: false, waiters: new Set(), abort: () => controller.abort() })
        void forwardHttp(socket, options, parsed, controller.signal, httpFlowControls).finally(() => {
          httpControllers.delete(controller)
        })
        return
      }
      if (parsed.type === "http.response.flow") {
        applyHttpFlow(httpFlowControls, parsed)
        return
      }
      if (parsed.type === "ws.open") {
        openChannel(socket, options, channels, parsed)
        return
      }
      if (parsed.type === "ws.frame") {
        forwardFrame(socket, options, channels, parsed)
        return
      }
      if (parsed.type === "ws.close") {
        const close = parsed as TunnelWsClose
        const channel = channels.get(close.channel_id)
        if (channel) closeSocket(channel.upstream, close.code, close.reason)
        channels.delete(close.channel_id)
      }
    }
    // Under Node's `ws` an 'error' with no listener is an unhandled event, and
    // that is FATAL to the host process — a transient relay 500 on the upgrade
    // killed the whole runtime and every channel with it, never reaching the
    // backoff below. `ws` emits 'error' then 'close' for the same failure, but
    // a failed upgrade may produce only the error, so this has to be able to
    // drive the reconnect itself while staying idempotent with onclose.
    socket.onerror = () => {
      if (ws !== socket) return
      cleanupSocket()
      ws = undefined
      socket.onclose = null
      closeSocket(socket, 1001, "Host tunnel socket error")
      scheduleReconnect("closed")
    }
    socket.onclose = (event) => {
      cleanupSocket()
      if (ws === socket) ws = undefined
      if (AUTH_REJECTED_CLOSE_CODES.has(event?.code)) {
        emit({
          type: "auth-failed",
          attempt: reconnectAttempt + 1,
          error: event.reason || `Relay rejected host tunnel credentials (close code ${event.code})`,
        })
        scheduleReconnect("auth-failed")
        return
      }
      scheduleReconnect("closed")
    }
  }

  const connect = () => {
    const attempt = reconnectAttempt + 1
    emit({ type: "connecting", attempt })
    if (!options.tokenProvider) {
      openSocket(options.headers)
      return
    }
    // Promise.resolve().then(...) routes synchronous tokenProvider throws into
    // the auth-failed/backoff path; this runs from the reconnect timer where a
    // sync throw would otherwise be an uncaught exception.
    const mintTimeoutMs = options.wsOpenTimeoutMs ?? DEFAULT_WS_OPEN_TIMEOUT_MS
    let mintTimer: ReturnType<typeof setTimeout> | undefined
    const mintTimeout = new Promise<never>((_, reject) => {
      mintTimer = setTimeoutFn(() => {
        reject(new Error(`Host tunnel token mint timed out after ${mintTimeoutMs}ms`))
      }, mintTimeoutMs)
    })
    void Promise.race([
      Promise.resolve().then(() => options.tokenProvider!()),
      mintTimeout,
    ])
      .then((token) => openSocket(tunnelHeaders(options, token)))
      .catch((err) => {
        emit({ type: "auth-failed", attempt, error: errorMessage(err) })
        scheduleReconnect("auth-failed")
      })
      .finally(() => {
        if (mintTimer !== undefined) clearTimeoutFn(mintTimer)
      })
  }

  connect()

  return {
    async updateRegistration(input) {
      const workspaceIds = [...new Set(input.workspaceIds)]
      if (!workspaceIds.length) throw new Error("At least one workspace is required")
      registrationUpdate = { workspaceIds, token: input.token }
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      send(ws, {
        type: "host.registration.update",
        protocol: TUNNEL_PROTOCOL_VERSION,
        workspace_ids: workspaceIds,
        token: input.token,
      })
    },
    close() {
      closed = true
      if (reconnectTimer) clearTimeoutFn(reconnectTimer)
      cleanupSocket()
      ws?.close()
      ws = undefined
      emitClosed("client")
    },
  }
}
