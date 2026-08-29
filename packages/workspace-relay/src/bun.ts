import {
  makeTunnelPing,
  makeTunnelPong,
  TUNNEL_PROTOCOL_VERSION,
  validateTunnelMessage,
  type TunnelHeaderMap,
  type TunnelHostRegistrationUpdate,
  type TunnelHttpResponseChunk,
  type TunnelHttpResponseEnd,
  type TunnelHttpResponseStart,
  type TunnelPing,
  type TunnelWsClose,
  type TunnelWsFrame,
} from "@claxedo/workspace-relay-protocol"
import {
  authorizeWorkspaceRelayRequest,
  createWorkspaceRelay,
  createWorkspaceRelayTrace,
  workspaceRelayForwardHeaders,
  workspaceRelayForwardRequestInit,
  workspaceRelayTargetUrl,
  workspaceRelayTimingResponse,
  type WorkspaceRelayAuthorizeTrace,
  type WorkspaceRelayOptions,
} from "./server"
import { WorkspaceRelayAuthError, verifyHostTunnelToken, type RuntimeAccessTokenClaims } from "./auth"
import { createOriginMatcher, DEFAULT_RELAY_APP_ORIGINS } from "./cors-origins"
import { bearerToken } from "./http"

/**
 * Bun expresses HTTP idle timeout in seconds. Runtime SSE heartbeats arrive
 * every 30 seconds, so this exceeds that interval while still bounding idle
 * unauthenticated and incomplete HTTP connections.
 */
export const WORKSPACE_RELAY_IDLE_TIMEOUT_SECONDS = 45

type RelayClientWebSocketData = {
  kind: "client"
  claims: RuntimeAccessTokenClaims
  upstreamUrl: string
  headers: Record<string, string>
  queue: Array<{ payload: string | Buffer<ArrayBuffer>; queuedAt: number }>
  /** Running byte size of `queue`; reset when the queue is flushed upstream. */
  queuedBytes?: number
  upstream?: WebSocket
  upstreamOpenTimer?: ReturnType<typeof setTimeout>
  trace?: RelayClientWebSocketTrace
  accessCheckTimer?: ReturnType<typeof setInterval>
  expiryTimer?: ReturnType<typeof setTimeout>
}

type RelayClientWebSocketTrace = {
  acceptedAt: number
  upstreamStartedAt?: number
  upstreamOpenMs?: number
  queuedFrames: number
  maxQueuedDelayMs: number
  emitted: boolean
}

type RelayHostTunnelWebSocketData = {
  kind: "host-tunnel"
  hostId: string
  workspaceIds: string[]
  pending: Map<string, PendingTunnelHttpResponse>
  channels: Map<string, Bun.ServerWebSocket<RelayUserHostedClientWebSocketData>>
  heartbeat?: ReturnType<typeof setInterval>
  missedPongs: number
  // T11: per-WS buffer for fragmented WebSocket frames that arrive as partial
  // JSON. Bounded at TUNNEL_MESSAGE_BUFFER_CAP_BYTES; oversize triggers 1009.
  messageBuffer: string
}

type RelayUserHostedClientWebSocketData = {
  kind: "user-hosted-client"
  claims: RuntimeAccessTokenClaims
  hostId: string
  workspaceId: string
  channelId: string
  path: string
  relayHostToken: string
  accessCheckTimer?: ReturnType<typeof setInterval>
  expiryTimer?: ReturnType<typeof setTimeout>
}

type RelayWebSocketData =
  | RelayClientWebSocketData
  | RelayHostTunnelWebSocketData
  | RelayUserHostedClientWebSocketData

type UpstreamWebSocketConstructor = {
  new(url: string, options: Bun.WebSocketOptions): WebSocket
}

type PendingTunnelHttpResponse = {
  controller: ReadableStreamDefaultController<Uint8Array>
  stream: ReadableStream<Uint8Array>
  resolve: (response: Response) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  // T12: backpressure tracking for slow downstream consumers.
  // Chunks that arrive while controller.desiredSize <= 0 are buffered here
  // and drained back into the controller from pull() once the consumer reads.
  pendingChunks: Uint8Array[]
  // Bytes currently held in pendingChunks (overflow buffer only — does not
  // include bytes already enqueued in the controller's internal queue).
  bytesQueued: number
  // Slow-consumer watchdog. Started when the first chunk overflows, cleared
  // whenever pendingChunks fully drains.
  slowConsumerTimeout?: ReturnType<typeof setTimeout>
  responseStarted: boolean
}

export type WorkspaceRelayHostTunnelOptions = {
  authorizeHostTunnel?: (
    request: Request,
    input: {
      hostId: string
      workspaceIds: string[]
    },
  ) => boolean | Promise<boolean>
  hostTunnelPingIntervalMs?: number
  hostTunnelMaxMissedPongs?: number
  // T19: debounce window used to coalesce host-tunnel connected/disconnected
  // audit emissions per host_id. Default 250ms. A flapping reconnect within
  // this window whose intended state matches lastWritten is suppressed.
  hostTunnelStateDebounceMs?: number
}

export type WorkspaceRelayBackpressureOptions = {
  // T12: high-water mark used by the per-pending ByteLengthQueuingStrategy.
  // When the controller's queued bytes meet or exceed this value, new chunks
  // are diverted into the per-pending overflow buffer until the consumer
  // catches up. Default 8 MiB.
  slowConsumerHighWaterMarkBytes?: number
  // T12: how long the per-pending overflow buffer can stay non-empty before
  // the request is failed with 503 slow_consumer_timeout. Default 30 s.
  slowConsumerTimeoutMs?: number
  tunnelRequestBodyMaxBytes?: number
  tunnelHttpResponseTimeoutMs?: number
  directHttpTimeoutMs?: number
  directHttpConcurrency?: number
  upstreamWebSocketOpenTimeoutMs?: number
  upstreamWebSocketPreOpenQueueMaxFrames?: number
  upstreamWebSocketPreOpenQueueMaxBytes?: number
  upstreamWebSocket?: UpstreamWebSocketConstructor
  webSocketBufferedAmountMaxBytes?: number
}

export type WorkspaceRelayBunOptions = WorkspaceRelayHostTunnelOptions & WorkspaceRelayBackpressureOptions
  & {
    /** How often established user WebSockets are re-checked for revocation. Defaults to 30s. */
    runtimeAccessTokenActiveCheckIntervalMs?: number
    /** Clock injection used to calculate the local token-expiry deadline. */
    now?: () => number
  }

export type WorkspaceRelayBunTelemetry = {
  getFragmentationStats(): FragmentationStats
  resetFragmentationStats(): void
  getSlowConsumerStats(): SlowConsumerStats
  resetSlowConsumerStats(): void
}

/**
 * T9: drain controller exposed by `createWorkspaceRelayBun`.
 *
 * On SIGTERM the operator (see `installShutdownDrainHandler` in main.ts)
 * flips `setDraining(true)`; from that point onward the relay
 *   - returns 503 from `/health` so Fly removes the instance from routing
 *   - rejects new HTTP requests with 503 (`relay_draining`) before doing auth
 *   - rejects new host-tunnel WebSocket upgrades with 503
 *   - closes active host tunnels with 1012 so host clients reconnect promptly
 *
 * `pendingCount()` reports the total number of in-flight tunnel HTTP
 * responses across every connected host tunnel — this is what the operator
 * polls via `waitForDrain(timeoutMs)` before hard-closing remaining sockets.
 */
export type WorkspaceRelayBunDrainController = {
  isDraining(): boolean
  setDraining(value: boolean): void
  pendingCount(): number
  waitForDrain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }>
}

// Per-tunnel resource caps.
const TUNNEL_PENDING_HTTP_CAP = 32
const TUNNEL_CHANNEL_CAP = 16
const HOST_TUNNEL_REGISTRATION_RECONNECT_CAP = 5
const HOST_TUNNEL_REGISTRATION_RECONNECT_WINDOW_MS = 60_000
const WS_MAX_PAYLOAD_LENGTH_BYTES = 16 * 1024 * 1024
const TUNNEL_REQUEST_BODY_MAX_BYTES_DEFAULT = 16 * 1024 * 1024
const TUNNEL_HTTP_RESPONSE_TIMEOUT_MS_DEFAULT = 30_000
const DIRECT_HTTP_TIMEOUT_MS_DEFAULT = 30_000
const UPSTREAM_WS_OPEN_TIMEOUT_MS_DEFAULT = 10_000
// Frames a client may send while the upstream WebSocket is still connecting.
//
// Overflow CLOSES the socket rather than dropping frames, and that is
// deliberate: this queue carries an ordered byte stream (terminal input, PTY
// data), so shedding entries from it would hand the far end a corrupted stream
// with no error anywhere — strictly worse than a clean, diagnosable close.
//
// The count is low because it is sized for the interactive case: a human types,
// waits for output, types again, and never has 64 unacknowledged frames in
// flight during the few milliseconds before upstream connects. A client that
// pipelines without waiting (bulk paste, file transfer, a load generator) can
// exceed it — see `UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_BYTES_DEFAULT`, which is the
// bound that should govern such traffic.
const UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_FRAMES_DEFAULT = 64
// Bytes are the resource this queue actually consumes, and 64 tiny frames is
// not a memory problem. Admitting on EITHER bound lets a legitimate burst of
// small frames through while still capping real memory, so the close above is
// reserved for traffic that is genuinely too large to hold.
const UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_BYTES_DEFAULT = 8 * 1024 * 1024
const WS_BUFFERED_AMOUNT_MAX_BYTES_DEFAULT = 8 * 1024 * 1024

/**
 * Bytes queued in a socket's send buffer, or `undefined` if it cannot report.
 *
 * Bun spells this `getBufferedAmount()` — a method, not the browser's
 * `bufferedAmount` property. The two guards below used to read the property
 * behind a non-null assertion, which typechecked and then evaluated
 * `undefined > 8388608` forever: neither had ever closed a connection. Measured
 * in `relay-workerd-backpressure.test.ts` at 16.8 MB queued, twice the limit,
 * guard silent.
 *
 * FAILS OPEN on a socket that cannot report, deliberately. Test doubles and any
 * exotic socket must not be closed for lacking the accessor — an unguarded
 * healthy connection beats a guard that kills healthy connections. Note this is
 * also why the same guard is NOT portable to `cloudflare.ts`: workerd's
 * WebSocket exposes no buffer depth in any form, so there it would fail open
 * unconditionally. Bounding the Cloudflare path needs a protocol-level
 * credit/ack window instead.
 */
export const relayBufferedBytes = (socket: unknown) => {
  const method = (socket as { getBufferedAmount?: () => number }).getBufferedAmount
  if (typeof method === "function") {
    const measured = method.call(socket)
    if (typeof measured === "number" && Number.isFinite(measured)) return measured
    return undefined
  }
  // Browser-shaped sockets (and doubles that mimic one) carry the property.
  const property = (socket as { bufferedAmount?: unknown }).bufferedAmount
  return typeof property === "number" && Number.isFinite(property) ? property : undefined
}

/**
 * True only when the socket reports a depth over the limit. Unknown ⇒ false.
 *
 * Exported for `bun.test.ts`. Forcing a real over-limit buffer through the
 * server's own sockets is not achievable locally — a loopback peer drains far
 * faster than a test can outrun it, which is precisely why the dead guard went
 * unnoticed for so long — so the decision itself is asserted directly.
 */
export const relayOverBackpressureLimit = (socket: unknown, limitBytes: number) => {
  const queued = relayBufferedBytes(socket)
  return queued !== undefined && queued > limitBytes
}
const HOST_TUNNEL_MAX_MISSED_PONGS_DEFAULT = 2
// T11: bound the per-WS reassembly buffer for fragmented JSON frames.
const TUNNEL_MESSAGE_BUFFER_CAP_BYTES = 4 * 1024 * 1024
// T12: defaults for per-request slow-consumer backpressure on tunnel HTTP
// responses. Overridable via WorkspaceRelayBunOptions for tests.
const SLOW_CONSUMER_HIGH_WATER_MARK_BYTES_DEFAULT = 8 * 1024 * 1024
const SLOW_CONSUMER_TIMEOUT_MS_DEFAULT = 30_000
// T19: default debounce window for host-tunnel connected/disconnected audit
// emissions. Coalesces flapping reconnects per host_id.
const HOST_TUNNEL_STATE_DEBOUNCE_MS_DEFAULT = 250

export type FragmentationStats = {
  fragmentsBuffered: number
  oversizedClosed: number
}

export type SlowConsumerStats = {
  overflowEvents: number
  timerFired: number
  droppedRequests: number
}

function createFragmentationStats(): FragmentationStats {
  return {
    fragmentsBuffered: 0,
    oversizedClosed: 0,
  }
}

function createSlowConsumerStats(): SlowConsumerStats {
  return {
    overflowEvents: 0,
    timerFired: 0,
    droppedRequests: 0,
  }
}

function readFragmentationStats(stats: FragmentationStats) {
  return {
    fragmentsBuffered: stats.fragmentsBuffered,
    oversizedClosed: stats.oversizedClosed,
  }
}

function resetFragmentationStats(stats: FragmentationStats) {
  stats.fragmentsBuffered = 0
  stats.oversizedClosed = 0
}

function readSlowConsumerStats(stats: SlowConsumerStats) {
  return { ...stats }
}

function resetSlowConsumerStats(stats: SlowConsumerStats) {
  stats.overflowEvents = 0
  stats.timerFired = 0
  stats.droppedRequests = 0
}

type DirectHttpLimiter = {
  acquire(): Promise<() => void>
}

function createDirectHttpLimiter(limit: number | undefined): DirectHttpLimiter | undefined {
  if (!Number.isInteger(limit) || !limit || limit <= 0) return undefined
  const max = limit
  let active = 0
  const queue: Array<() => void> = []

  function drain() {
    if (active >= max) return
    const next = queue.shift()
    if (!next) return
    active++
    next()
  }

  return {
    async acquire() {
      if (active < max) {
        active++
      } else {
        await new Promise<void>((resolve) => queue.push(resolve))
      }
      let released = false
      return () => {
        if (released) return
        released = true
        active = Math.max(0, active - 1)
        drain()
      }
    },
  }
}


type HostTunnelRegistrationTracker = {
  recent: number[]
}

function jsonError(code: string, message: string, status: number) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function corsJsonError(request: Request, code: string, message: string, status: number) {
  const headers = relayCorsHeaders(request)
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers })
}

/** Byte size of a frame awaiting the upstream socket, for the pre-open bound. */
function preOpenFrameBytes(message: string | Buffer<ArrayBuffer>) {
  return typeof message === "string" ? Buffer.byteLength(message) : message.byteLength
}

function safeCloseCode(input: number | undefined, fallback = 1011) {
  if (!Number.isInteger(input)) return fallback
  const code = input as number
  if (code === 1000) return code
  if (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code
  if (code >= 3000 && code <= 4999) return code
  return fallback
}

function closeWebSocket(ws: Pick<WebSocket, "close">, code: number | undefined, reason?: string, fallback = 1011) {
  try {
    ws.close(safeCloseCode(code, fallback), reason)
  } catch {
    try {
      ws.close(fallback, reason)
    } catch {
      // ignore close failures at the boundary
    }
  }
}

function upstreamCloseReason(event: Pick<CloseEvent, "code" | "reason">) {
  if (event.reason.trim()) return event.reason
  if (event.code === 1000) return ""
  if (event.code === 1005 || event.code === 1006) return "Upstream WebSocket closed abnormally"
  return `Upstream WebSocket closed unexpectedly with code ${event.code}`
}

function workspaceIdFromPath(pathname: string) {
  return /^\/workspaces\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
}

function hostIdFromTunnelPath(pathname: string) {
  return /^\/host-tunnels\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
}

function websocketRequest(request: Request) {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket"
}

function roundedMs(input: number) {
  return Math.round(input * 100) / 100
}

function relayWebSocketTraceEnabled(request: Request) {
  return request.headers.get("x-claxedo-relay-ws-trace") === "1"
}

function sendRelayWebSocketTrace(ws: Bun.ServerWebSocket<RelayClientWebSocketData>) {
  const trace = ws.data.trace
  if (!trace || trace.emitted) return
  trace.emitted = true
  ws.send(JSON.stringify({
    type: "relay.trace",
    wsUpstreamOpenMs: trace.upstreamOpenMs === undefined ? undefined : roundedMs(trace.upstreamOpenMs),
    queuedFrames: trace.queuedFrames,
    maxQueuedDelayMs: roundedMs(trace.maxQueuedDelayMs),
  }))
}

function relayWebSocketPayload(input: MessageEvent["data"]): string | ArrayBuffer | Uint8Array | undefined {
  if (typeof input === "string") return input
  if (input instanceof ArrayBuffer) return input
  if (ArrayBuffer.isView(input)) {
    const copy = new Uint8Array(input.byteLength)
    copy.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength))
    return copy
  }
}

function headersRecord(headers: Headers) {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function headers(input: TunnelHeaderMap) {
  const result = new Headers()
  for (const [key, value] of Object.entries(input)) {
    result.set(key, value)
  }
  return result
}

function isEventStream(input: TunnelHeaderMap) {
  return Object.entries(input).some(([key, value]) =>
    key.toLowerCase() === "content-type" && value.toLowerCase().includes("text/event-stream")
  )
}

// Same default policy the HTTP path and the Cloudflare adapter apply
// (./cors-origins). The Bun adapter compiles an options-specific matcher for
// WebSocket admission while these module-level helpers retain the product
// default for call sites without an options bag.
const defaultRelayOriginMatcher = createOriginMatcher(DEFAULT_RELAY_APP_ORIGINS)

function allowedCorsOrigin(origin: string | null, matcher = defaultRelayOriginMatcher) {
  if (!origin) return
  if (matcher(origin)) return origin
}

function requireAllowedOrigin(request: Request, matcher = defaultRelayOriginMatcher) {
  const origin = request.headers.get("origin")
  if (allowedCorsOrigin(origin, matcher)) return null
  return jsonError(
    "origin_not_allowed",
    "Origin is not in the allowlist",
    403,
  )
}

function relayCorsHeaders(request: Request, input = new Headers()) {
  const result = new Headers(input)
  result.delete("access-control-allow-origin")
  result.delete("access-control-allow-credentials")
  result.delete("access-control-allow-headers")
  result.delete("access-control-allow-methods")
  result.delete("access-control-expose-headers")
  result.delete("access-control-max-age")
  const origin = allowedCorsOrigin(request.headers.get("origin"))
  if (origin) {
    result.set("access-control-allow-origin", origin)
    result.set("access-control-allow-headers", "Accept, Authorization, Content-Type, Last-Event-ID, X-Fetch-Bypass-Throttle, X-Daytona-Skip-Preview-Warning, X-Workspace-Id, X-OpenCode-Directory, X-Claxedo-Runner, X-Claxedo-Model, X-Claxedo-Draft-Id, X-Claxedo-Binary")
    result.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
  }
  return result
}

function encoded(input: ArrayBuffer) {
  return Buffer.from(input).toString("base64")
}

function decoded(input: string) {
  return new Uint8Array(Buffer.from(input, "base64"))
}

function encodedFrame(message: string | Buffer<ArrayBuffer>) {
  if (typeof message === "string") {
    return {
      binary: false,
      data_base64: Buffer.from(message).toString("base64"),
    }
  }
  return {
    binary: true,
    data_base64: Buffer.from(message).toString("base64"),
  }
}

function decodedFrame(frame: TunnelWsFrame) {
  const body = Buffer.from(frame.data_base64, "base64")
  return frame.binary ? new Uint8Array(body) : body.toString("utf8")
}

function tunnelMessage(
  ws: Bun.ServerWebSocket<RelayHostTunnelWebSocketData>,
  input: string | Buffer<ArrayBuffer>,
  stats: FragmentationStats,
) {
  if (typeof input !== "string") return
  // T11: defensive parse with per-WS reassembly. Some intermediate proxies
  // fragment WS frames; concat with any prior partial and retry.
  const combined = ws.data.messageBuffer.length > 0
    ? ws.data.messageBuffer + input
    : input
  let parsed: unknown
  try {
    parsed = JSON.parse(combined)
  } catch {
    // Partial JSON. Retain the accumulated buffer (subject to the size cap)
    // and wait for the next frame to complete the message.
    if (combined.length > TUNNEL_MESSAGE_BUFFER_CAP_BYTES) {
      stats.oversizedClosed += 1
      ws.data.messageBuffer = ""
      ws.close(1009, "Tunnel message buffer exceeded 4 MB")
      return
    }
    stats.fragmentsBuffered += 1
    ws.data.messageBuffer = combined
    return
  }
  // Successful parse — clear any retained buffer.
  ws.data.messageBuffer = ""
  const validated = validateTunnelMessage(parsed)
  if (validated.ok) return validated.message
  if (validated.reason === "protocol_mismatch") {
    ws.close(1002, `Tunnel protocol mismatch: expected ${validated.expected_protocol}`)
  }
  return
}

function sendTunnelPing(ws: Bun.ServerWebSocket<RelayHostTunnelWebSocketData>) {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.data.missedPongs += 1
  ws.send(JSON.stringify(makeTunnelPing()))
}

function clearPendingTimers(entry: PendingTunnelHttpResponse) {
  clearTimeout(entry.timeout)
  if (entry.slowConsumerTimeout) {
    clearTimeout(entry.slowConsumerTimeout)
    entry.slowConsumerTimeout = undefined
  }
}

function failPendingHttpResponse(input: {
  entry: PendingTunnelHttpResponse
  response?: Response
  error: Error
}) {
  clearPendingTimers(input.entry)
  input.entry.pendingChunks.length = 0
  input.entry.bytesQueued = 0
  try {
    input.entry.controller.error(input.error)
  } catch {
    // already closed or errored
  }
  if (!input.entry.responseStarted) {
    if (input.response) {
      input.entry.resolve(input.response)
      return
    }
    input.entry.reject(input.error)
  }
}

function cleanupHostTunnelSocket(input: {
  ws: Bun.ServerWebSocket<RelayHostTunnelWebSocketData>
  hostTunnels: Map<string, Bun.ServerWebSocket<RelayHostTunnelWebSocketData>>
  hostTunnelStateDebounce: Map<string, HostTunnelStateEntry>
  options: WorkspaceRelayOptions
  bunOptions: WorkspaceRelayBunOptions
  request?: Request
  disconnectDirectory: boolean
  closeChannels: boolean
}) {
  if (input.ws.data.heartbeat) {
    clearInterval(input.ws.data.heartbeat)
    input.ws.data.heartbeat = undefined
  }
  for (const pending of input.ws.data.pending.values()) {
    failPendingHttpResponse({
      entry: pending,
      response: input.request
        ? corsJsonError(input.request, "user_hosted_app_offline", "User-hosted workspace is offline", 503)
        : jsonError("user_hosted_app_offline", "User-hosted workspace is offline", 503),
      error: new Error("User-hosted tunnel disconnected"),
    })
  }
  input.ws.data.pending.clear()
  for (const channel of input.ws.data.channels.values()) {
    if (input.closeChannels) closeWebSocket(channel, 1011, "User-hosted tunnel disconnected")
  }
  input.ws.data.channels.clear()
  if (!input.disconnectDirectory) return
  if (input.hostTunnels.get(input.ws.data.hostId) === input.ws) {
    input.hostTunnels.delete(input.ws.data.hostId)
    input.options.directory?.disconnectHost(input.ws.data.hostId)
    scheduleHostTunnelStateChange(input.hostTunnelStateDebounce, input.options, {
      hostId: input.ws.data.hostId,
      workspaceId: input.ws.data.workspaceIds[0],
      path: `/host-tunnels/${input.ws.data.hostId}`,
      state: "disconnected",
      debounceMs: input.bunOptions.hostTunnelStateDebounceMs ?? HOST_TUNNEL_STATE_DEBOUNCE_MS_DEFAULT,
    })
  }
}

async function audit(
  options: WorkspaceRelayOptions,
  input: {
    action: "host_tunnel.connected" | "host_tunnel.disconnected"
    hostId: string
    workspaceId?: string
    path: string
  },
) {
  await options.audit?.({
    action: input.action,
    result: "allow",
    hostId: input.hostId,
    workspaceId: input.workspaceId,
    method: "WEBSOCKET",
    path: input.path,
  })
}

// T19: per-host_id debounce of host_tunnel.connected / host_tunnel.disconnected
// audit emissions. Coalesces flapping (close + immediate reopen) within the
// debounce window so a wifi flicker that disconnects and reconnects under
// 250ms produces zero net audit events instead of a connect/disconnect/connect
// burst. The latest pending state is compared against `lastWritten` when the
// flush timer fires; if they match, no event is emitted.
type HostTunnelStateEntry = {
  intendedState: "connected" | "disconnected"
  lastWritten: "connected" | "disconnected"
  flushTimer: ReturnType<typeof setTimeout> | undefined
  // Snapshot of the audit metadata captured when intendedState last changed.
  // Used so the eventual flushed event reports the right workspaceId/path
  // without keeping a reference to a now-closed websocket.
  pending: {
    workspaceId?: string
    path: string
  }
}
function scheduleHostTunnelStateChange(
  state: Map<string, HostTunnelStateEntry>,
  options: WorkspaceRelayOptions,
  input: {
    hostId: string
    workspaceId?: string
    path: string
    state: "connected" | "disconnected"
    debounceMs: number
  },
) {
  const existing = state.get(input.hostId)
  const entry: HostTunnelStateEntry = existing ?? {
    intendedState: "disconnected",
    lastWritten: "disconnected",
    flushTimer: undefined,
    pending: { workspaceId: input.workspaceId, path: input.path },
  }
  entry.intendedState = input.state
  entry.pending = { workspaceId: input.workspaceId, path: input.path }
  if (entry.flushTimer) clearTimeout(entry.flushTimer)
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = undefined
    if (entry.intendedState === entry.lastWritten) {
      // No-op: state returned to lastWritten before the flush fired.
      // Drop the entry if it has settled to "disconnected" (the implicit
      // baseline for unseen hosts) so the map doesn't grow unbounded.
      if (entry.intendedState === "disconnected") {
        state.delete(input.hostId)
      }
      return
    }
    entry.lastWritten = entry.intendedState
    void audit(options, {
      action:
        entry.intendedState === "connected"
          ? "host_tunnel.connected"
          : "host_tunnel.disconnected",
      hostId: input.hostId,
      workspaceId: entry.pending.workspaceId,
      path: entry.pending.path,
    })
  }, input.debounceMs)
  state.set(input.hostId, entry)
}

// T12: drain as much of the overflow buffer as the controller will accept.
// Decrements bytesQueued (which counts ONLY overflow-buffer bytes, not
// bytes already inside the controller's internal queue). Clears the
// slow-consumer watchdog once the overflow buffer is empty.
function drainPendingChunks(entry: PendingTunnelHttpResponse) {
  while (entry.pendingChunks.length > 0) {
    const desired = entry.controller.desiredSize
    if (desired !== null && desired <= 0) break
    const next = entry.pendingChunks.shift()!
    entry.bytesQueued -= next.byteLength
    try {
      entry.controller.enqueue(next)
    } catch {
      // Controller has been closed/errored; stop draining.
      entry.pendingChunks.length = 0
      entry.bytesQueued = 0
      break
    }
  }
  if (entry.pendingChunks.length === 0 && entry.slowConsumerTimeout) {
    clearTimeout(entry.slowConsumerTimeout)
    entry.slowConsumerTimeout = undefined
  }
}

// T12: route a freshly-received chunk either into the controller (consumer
// keeping up) or into the overflow buffer (consumer slow). Starts the
// slow-consumer watchdog the first time a chunk overflows.
function enqueueChunkWithBackpressure(input: {
  ws: Bun.ServerWebSocket<RelayHostTunnelWebSocketData>
  requestId: string
  entry: PendingTunnelHttpResponse
  chunk: Uint8Array
  slowConsumerTimeoutMs: number
  slowConsumerStats: SlowConsumerStats
}) {
  const { entry, chunk } = input
  const desired = entry.controller.desiredSize
  const overflowing = desired !== null && desired <= 0
  if (overflowing || entry.pendingChunks.length > 0) {
    entry.pendingChunks.push(chunk)
    entry.bytesQueued += chunk.byteLength
    if (!entry.slowConsumerTimeout) {
      // T29: first overflow for this request — count it before arming the
      // watchdog so the metric reflects "how often did we hit the HWM".
      input.slowConsumerStats.overflowEvents += 1
      entry.slowConsumerTimeout = setTimeout(() => {
        // T29: count actual timer fires (vs. timers cleared by drain).
        input.slowConsumerStats.timerFired += 1
        const error = new Error("slow_consumer_timeout: downstream consumer did not drain in time")
        try {
          entry.controller.error(error)
        } catch {
          // ignore — already closed/errored
        }
        clearTimeout(entry.timeout)
        entry.pendingChunks.length = 0
        entry.bytesQueued = 0
        if (!entry.responseStarted) {
          entry.resolve(jsonError("slow_consumer_timeout", "Downstream consumer did not drain in time", 503))
        }
        input.ws.data.pending.delete(input.requestId)
        // T29: count after cleanup so droppedRequests reflects requests we
        // actually freed (not double-counted on re-entry).
        input.slowConsumerStats.droppedRequests += 1
      }, input.slowConsumerTimeoutMs)
    }
    return
  }
  try {
    entry.controller.enqueue(chunk)
  } catch {
    // ignore — controller already closed/errored
  }
}

// T29: testing-only export. Allows unit tests to drive the slow-consumer
// counter from a controlled ReadableStream consumer without depending on
// Bun's HTTP server pulling rate (localhost is too fast to reliably trip
// the HWM via real fetch+host-tunnel chunks).
export const __slowConsumerInternalsForTest = {
  enqueueChunkWithBackpressure,
  createSlowConsumerStats,
}

async function tunnelHttpRequest(input: {
  ws: Bun.ServerWebSocket<RelayHostTunnelWebSocketData>
  request: Request
  workspaceId: string
  path: string
  relayHostToken: string
  slowConsumerHighWaterMarkBytes: number
  slowConsumerTimeoutMs: number
  slowConsumerStats: SlowConsumerStats
  requestBodyMaxBytes: number
  responseTimeoutMs: number
}) {
  if (input.ws.readyState !== WebSocket.OPEN) {
    return new Response("User-hosted workspace is offline", { status: 503 })
  }
  if (input.ws.data.pending.size >= TUNNEL_PENDING_HTTP_CAP) {
    return jsonError(
      "too_many_in_flight",
      "User-hosted tunnel has too many in-flight HTTP requests",
      429,
    )
  }
  const requestId = crypto.randomUUID()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  // T12: ByteLengthQueuingStrategy makes controller.desiredSize reflect
  // remaining byte capacity. When it goes <= 0, downstream is at/over HWM
  // and we divert further chunks into the per-pending overflow buffer.
  // pull() is invoked by Web Streams when the consumer reads and the queue
  // drops below HWM — that's our cue to drain the overflow buffer.
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next
    },
    pull() {
      const entry = input.ws.data.pending.get(requestId)
      if (!entry) return
      drainPendingChunks(entry)
    },
    cancel() {
      // Downstream consumer (browser) went away — free the pending slot and
      // tell the host to abort the upstream request. Without this a
      // long-lived (SSE) response whose client disconnected leaks its
      // pending slot until the tunnel cap starves all future requests.
      const entry = input.ws.data.pending.get(requestId)
      if (!entry) return
      input.ws.data.pending.delete(requestId)
      clearPendingTimers(entry)
      entry.pendingChunks.length = 0
      entry.bytesQueued = 0
      if (input.ws.readyState === WebSocket.OPEN) {
        input.ws.send(JSON.stringify({
          type: "http.response.flow",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: requestId,
          paused: false,
          reason: "closed",
        }))
      }
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: input.slowConsumerHighWaterMarkBytes }))
  const pending = new Promise<Response>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const entry = input.ws.data.pending.get(requestId)
      if (!entry) return
      input.ws.data.pending.delete(requestId)
      if (entry.responseStarted) {
        clearPendingTimers(entry)
        entry.pendingChunks.length = 0
        entry.bytesQueued = 0
        try {
          entry.controller.close()
        } catch {
          // already closed or errored
        }
        return
      }
      const error = new Error("User-hosted tunnel response timed out")
      failPendingHttpResponse({
        entry,
        response: corsJsonError(input.request, "user_hosted_tunnel_timeout", "User-hosted tunnel response timed out", 504),
        error,
      })
    }, input.responseTimeoutMs)
    input.ws.data.pending.set(requestId, {
      controller: controller!,
      stream,
      resolve,
      reject,
      timeout,
      pendingChunks: [],
      bytesQueued: 0,
      responseStarted: false,
    })
  })
  const body = input.request.method === "GET" || input.request.method === "HEAD"
    ? undefined
    : await readBoundedBody(input.request, input.requestBodyMaxBytes)
  if (body && "response" in body) {
    const entry = input.ws.data.pending.get(requestId)
    if (entry) clearPendingTimers(entry)
    input.ws.data.pending.delete(requestId)
    return body.response
  }
  input.ws.send(JSON.stringify({
    type: "http.request",
    protocol: TUNNEL_PROTOCOL_VERSION,
    request_id: requestId,
    workspace_id: input.workspaceId,
    method: input.request.method,
    path: input.path,
    headers: headersRecord(workspaceRelayForwardHeaders(
      input.request.headers,
      input.relayHostToken,
      input.workspaceId,
      // T26: user-hosted tunnel — strip Cookie to avoid leaking browser
      // cookies to the host process running on the user's laptop.
      { userHosted: true },
    )),
    ...(body?.bodyBase64 ? { body_base64: body.bodyBase64 } : {}),
    end: true,
  }))
  return await pending
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<{ bodyBase64: string } | { response: Response } | undefined> {
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        // ignore cancel failures
      }
      return {
        response: corsJsonError(request, "request_body_too_large", "Tunnel request body exceeds the relay limit", 413),
      }
    }
    chunks.push(next.value)
  }
  const body = new Uint8Array(total)
  chunks.reduce((offset, chunk) => {
    body.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  return { bodyBase64: encoded(body.buffer) }
}

async function directHttpRequest(input: {
  request: Request
  targetUrl: string
  relayHostToken: string
  workspaceId: string
  upstreamHeaders?: Record<string, string>
  timeoutMs: number
  limiter?: DirectHttpLimiter
  trace?: WorkspaceRelayAuthorizeTrace
}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const span = <T>(name: string, run: () => Promise<T>) => input.trace ? input.trace.span(name, run) : run()
  try {
    const init = workspaceRelayForwardRequestInit(
      input.request,
      input.relayHostToken,
      input.workspaceId,
      {
        // T26: cloud-vm direct path. Cookies pass through (default) — workspace
        // dashboards in the VM may legitimately need session cookies.
        userHosted: false,
        upstreamHeaders: input.upstreamHeaders,
        signal: controller.signal,
      },
    )
    if (input.request.method !== "GET" && input.request.method !== "HEAD" && input.request.body) {
      init.body = await input.request.arrayBuffer()
    }
    const limiter = input.limiter
    const release = limiter ? await span("direct-http-queue", () => limiter.acquire()) : undefined
    try {
      const upstream = await span("upstream-fetch", async () => await fetch(input.targetUrl, init))
      const headers = relayCorsHeaders(input.request, upstream.headers)
      const contentType = upstream.headers.get("content-type") ?? ""
      const streamResponse =
        contentType.includes("text/event-stream") ||
        contentType.includes("application/octet-stream")
      if (streamResponse) {
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        })
      }
      const body = await upstream.arrayBuffer()
      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      })
    } finally {
      release?.()
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError"
    return corsJsonError(
      input.request,
      aborted ? "upstream_timeout" : "upstream_unavailable",
      aborted ? "Workspace upstream timed out" : "Workspace upstream is unavailable",
      aborted ? 504 : 503,
    )
  } finally {
    clearTimeout(timer)
  }
}

function hostTunnel(
  hostTunnels: Map<string, Bun.ServerWebSocket<RelayHostTunnelWebSocketData>>,
  hostId: string,
) {
  const tunnel = hostTunnels.get(hostId)
  if (tunnel?.readyState === WebSocket.OPEN) return tunnel
  return undefined
}

async function authorizeHostTunnel(
  options: WorkspaceRelayOptions,
  bunOptions: WorkspaceRelayBunOptions,
  request: Request,
  input: {
    hostId: string
    workspaceIds: string[]
  },
) {
  if (bunOptions.authorizeHostTunnel) return await bunOptions.authorizeHostTunnel(request, input)
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) return false
  try {
    await verifyHostTunnelToken(token, options.runtimeAccessKey, input)
    return true
  } catch (err) {
    if (err instanceof WorkspaceRelayAuthError) return false
    throw err
  }
}

const RUNTIME_ACCESS_TOKEN_ACTIVE_CHECK_INTERVAL_MS_DEFAULT = 30_000

type RelayAccessWatchedWebSocketData = RelayClientWebSocketData | RelayUserHostedClientWebSocketData

function clearClientAccessWatchers(data: RelayAccessWatchedWebSocketData) {
  if (data.accessCheckTimer) clearInterval(data.accessCheckTimer)
  if (data.expiryTimer) clearTimeout(data.expiryTimer)
  data.accessCheckTimer = undefined
  data.expiryTimer = undefined
}

/**
 * Keeps authorization of an established Bun WebSocket current. Runtime Access
 * Tokens are admission credentials, but a membership change revokes their jti
 * centrally. Re-checking that jti closes an idle connection within one bounded
 * interval; the local exp timer is the hard upper bound even if the resolver is
 * unavailable.
 */
function watchClientAccess(
  ws: Bun.ServerWebSocket<RelayAccessWatchedWebSocketData>,
  options: WorkspaceRelayOptions,
  bunOptions: WorkspaceRelayBunOptions,
) {
  const now = bunOptions.now ?? Date.now
  const close = (reason: string) => {
    clearClientAccessWatchers(ws.data)
    closeWebSocket(ws, 1008, reason, 1008)
  }
  ws.data.expiryTimer = setTimeout(
    () => close("Runtime Access Token expired"),
    Math.max(0, ws.data.claims.exp * 1000 - now()),
  )
  if (typeof ws.data.expiryTimer.unref === "function") ws.data.expiryTimer.unref()
  const intervalMs = bunOptions.runtimeAccessTokenActiveCheckIntervalMs
    ?? RUNTIME_ACCESS_TOKEN_ACTIVE_CHECK_INTERVAL_MS_DEFAULT
  if (!options.isRuntimeAccessTokenActive || intervalMs <= 0) return
  ws.data.accessCheckTimer = setInterval(() => {
    void Promise.resolve(options.isRuntimeAccessTokenActive!(ws.data.claims))
      .then((active) => {
        if (!active.active) close(active.reason)
      })
      // A resolver outage cannot extend this socket past the local exp timer.
      .catch(() => {})
  }, intervalMs)
  if (typeof ws.data.accessCheckTimer.unref === "function") ws.data.accessCheckTimer.unref()
}

export function createWorkspaceRelayBun(options: WorkspaceRelayOptions, bunOptions: WorkspaceRelayBunOptions = {}) {
  const hostTunnels = new Map<string, Bun.ServerWebSocket<RelayHostTunnelWebSocketData>>()
  const relayClients = new Set<Bun.ServerWebSocket<RelayClientWebSocketData>>()
  const hostTunnelRegistrations = new Map<string, HostTunnelRegistrationTracker>()
  const directHttpLimiter = createDirectHttpLimiter(bunOptions.directHttpConcurrency)
  const hostTunnelStateDebounce = new Map<string, HostTunnelStateEntry>()
  const fragmentationStats = createFragmentationStats()
  const slowConsumerStats = createSlowConsumerStats()
  const relayOriginMatcher = options.allowedOrigins
    ? createOriginMatcher(options.allowedOrigins)
    : defaultRelayOriginMatcher
  const telemetry: WorkspaceRelayBunTelemetry = {
    getFragmentationStats: () => readFragmentationStats(fragmentationStats),
    resetFragmentationStats: () => resetFragmentationStats(fragmentationStats),
    getSlowConsumerStats: () => readSlowConsumerStats(slowConsumerStats),
    resetSlowConsumerStats: () => resetSlowConsumerStats(slowConsumerStats),
  }

  // T9: drain state. The Hono server below is constructed with a closure over
  // this flag so /health and the workspace fast-path see the same value.
  let draining = false
  const drainController: WorkspaceRelayBunDrainController = {
    isDraining: () => draining,
    setDraining: (value) => {
      draining = value
      if (!value) return
      for (const tunnel of hostTunnels.values()) {
        closeWebSocket(tunnel, 1012, "Workspace relay is draining", 1012)
      }
      for (const client of relayClients) {
        closeWebSocket(client, 1012, "Workspace relay is draining", 1012)
      }
    },
    pendingCount: () => {
      let total = 0
      for (const tunnel of hostTunnels.values()) {
        total += tunnel.data.pending.size
      }
      return total
    },
    waitForDrain: async (timeoutMs) => {
      const deadline = Date.now() + Math.max(0, timeoutMs)
      // Poll every 50 ms — small enough to keep the deploy snappy, large
      // enough to avoid burning a CPU on the way out.
      const pollMs = 50
      while (true) {
        const remaining = drainController.pendingCount()
        if (remaining === 0) return { drained: true, remaining: 0 }
        const now = Date.now()
        if (now >= deadline) return { drained: false, remaining }
        const sleep = Math.min(pollMs, Math.max(1, deadline - now))
        await new Promise((resolve) => setTimeout(resolve, sleep))
      }
    },
  }

  // T31: assemble metrics sources here so `/metrics` can surface the bun-only
  // per-relay counters (fragmentation + slow consumer) and the drain
  // controller's pending count without `server.ts` importing back into us.
  // We merge with any explicit `metricsSources` the caller passed (so callers
  // can override individual providers if they want, e.g. in tests).
  const mergedMetricsSources = {
    fragmentation: options.metricsSources?.fragmentation ?? telemetry.getFragmentationStats,
    slowConsumer: options.metricsSources?.slowConsumer ?? telemetry.getSlowConsumerStats,
    drainPending: options.metricsSources?.drainPending ?? drainController.pendingCount,
  }

  // T31: per-request IP capture used to gate `/metrics` to loopback when no
  // metricsToken is configured. Bun's `server.requestIP(request)` is only
  // available on the raw inbound Request — we capture it on entry to fetch()
  // and look it up from the Hono handler via this WeakMap.
  const requestRemoteAddress = new WeakMap<Request, string>()

  const metricsRemoteAddressResolver = options.metricsRemoteAddress
    ?? ((request: Request) => requestRemoteAddress.get(request))

  const app = createWorkspaceRelay({
    ...options,
    isDraining: drainController.isDraining,
    metricsSources: mergedMetricsSources,
    metricsRemoteAddress: metricsRemoteAddressResolver,
  })

  function getRegistrationTracker(hostId: string): HostTunnelRegistrationTracker {
    let tracker = hostTunnelRegistrations.get(hostId)
    if (!tracker) {
      tracker = { recent: [] }
      hostTunnelRegistrations.set(hostId, tracker)
    }
    return tracker
  }

  function pruneReconnects(tracker: HostTunnelRegistrationTracker, now: number) {
    const cutoff = now - HOST_TUNNEL_REGISTRATION_RECONNECT_WINDOW_MS
    while (tracker.recent.length && tracker.recent[0]! < cutoff) {
      tracker.recent.shift()
    }
  }

  return {
    async fetch(request: Request, server: Bun.Server<RelayWebSocketData>) {
      const url = new URL(request.url)
      const workspaceId = workspaceIdFromPath(url.pathname)
      const hostId = hostIdFromTunnelPath(url.pathname)
      // T31: capture the inbound peer IP so the Hono `/metrics` handler can
      // gate on loopback. `server.requestIP` may return null for non-TCP
      // sockets (rare); skip the WeakMap entry in that case so the handler
      // falls back to deny / token-only.
      try {
        const ip = server.requestIP(request)?.address
        if (ip) requestRemoteAddress.set(request, ip)
      } catch {
        // ignore — server.requestIP can throw for already-upgraded sockets;
        // /metrics is HTTP-only so this is harmless.
      }
      if (url.pathname === "/health") {
        return Response.json(
          draining
            ? { ok: false, service: "workspace-relay", draining: true }
            : { ok: true, service: "workspace-relay" },
          { status: draining ? 503 : 200 },
        )
      }
      // T9: once draining starts, refuse new tunnel registrations and new
      // workspace requests. Other unrelated routes are handled by the Hono
      // server (see `app`) which also reads `drainController`.
      if (draining && websocketRequest(request) && hostId) {
        return jsonError(
          "relay_draining",
          "Workspace relay is shutting down; new tunnel registrations are not accepted",
          503,
        )
      }
      if (draining && workspaceId) {
        const headers = relayCorsHeaders(request)
        const body = JSON.stringify({
          error: {
            code: "relay_draining",
            message: "Workspace relay is shutting down; try another instance",
          },
        })
        headers.set("content-type", "application/json")
        return new Response(body, { status: 503, headers })
      }
      if (websocketRequest(request) && hostId) {
        const workspaceIds = url.searchParams.getAll("workspaceId")
        if (!workspaceIds.length || !options.directory) {
          return new Response("Host tunnel registration is unavailable", { status: 503 })
        }
        if (!await authorizeHostTunnel(options, bunOptions, request, { hostId, workspaceIds })) {
          return new Response("Host tunnel registration denied", { status: 403 })
        }
        const tracker = getRegistrationTracker(hostId)
        const now = Date.now()
        pruneReconnects(tracker, now)
        if (tracker.recent.length >= HOST_TUNNEL_REGISTRATION_RECONNECT_CAP) {
          return jsonError(
            "too_many_host_tunnel_reconnects",
            "Too many host-tunnel reconnects for this host within the last 60 seconds",
            429,
          )
        }
        // The Host Tunnel Token (HTT) authenticates only this registration
        // upgrade; the long-lived host-tunnel WebSocket survives past HTT TTL
        // by design. Same "validate establishment, not stream lifetime"
        // semantics as RHT — see `auth.ts` mintRelayHostToken.
        if (server.upgrade(request, {
          data: {
            kind: "host-tunnel",
            hostId,
            workspaceIds,
            pending: new Map(),
            channels: new Map(),
            missedPongs: 0,
            messageBuffer: "",
          },
        })) {
          tracker.recent.push(now)
          return
        }
        return new Response("WebSocket upgrade failed", { status: 400 })
      }
      if (!workspaceId) return app.request(request)
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: relayCorsHeaders(request),
        })
      }
      if (!websocketRequest(request)) {
        const trace = createWorkspaceRelayTrace()
        const response = await trace.span("relay-total", async () => {
          const relay = await authorizeWorkspaceRelayRequest(options, request, workspaceId, trace)
          if (!relay.ok) return relay.response
          if (relay.request.target.access === "user-hosted") {
            const tunnel = hostTunnel(hostTunnels, relay.request.target.hostId)
            return tunnel
              ? await trace.span("tunnel-http", async () => await tunnelHttpRequest({
                ws: tunnel,
                request,
                workspaceId: relay.request.target.workspaceId,
                path: `${relay.request.path}${url.search}`,
                relayHostToken: relay.request.relayHostToken,
                slowConsumerHighWaterMarkBytes: bunOptions.slowConsumerHighWaterMarkBytes ?? SLOW_CONSUMER_HIGH_WATER_MARK_BYTES_DEFAULT,
                slowConsumerTimeoutMs: bunOptions.slowConsumerTimeoutMs ?? SLOW_CONSUMER_TIMEOUT_MS_DEFAULT,
                slowConsumerStats,
                requestBodyMaxBytes: bunOptions.tunnelRequestBodyMaxBytes ?? TUNNEL_REQUEST_BODY_MAX_BYTES_DEFAULT,
                responseTimeoutMs: bunOptions.tunnelHttpResponseTimeoutMs ?? TUNNEL_HTTP_RESPONSE_TIMEOUT_MS_DEFAULT,
              }))
              : new Response("User-hosted workspace is offline", { status: 503 })
          }
          return await directHttpRequest({
            request,
            targetUrl: workspaceRelayTargetUrl(
              relay.request.target,
              relay.request.path,
              url.search,
            ).toString(),
            relayHostToken: relay.request.relayHostToken,
            workspaceId: relay.request.target.workspaceId,
            upstreamHeaders: relay.request.target.upstreamHeaders,
            timeoutMs: bunOptions.directHttpTimeoutMs ?? DIRECT_HTTP_TIMEOUT_MS_DEFAULT,
            limiter: directHttpLimiter,
            trace,
          })
        })
        return workspaceRelayTimingResponse(response, trace)
      }
      const relay = await authorizeWorkspaceRelayRequest(options, request, workspaceId)
      if (!relay.ok) return relay.response
      const originDenied = requireAllowedOrigin(request, relayOriginMatcher)
      if (originDenied) return originDenied
      if (relay.request.target.access === "user-hosted") {
        const tunnel = hostTunnel(hostTunnels, relay.request.target.hostId)
        if (!tunnel) {
          return new Response("User-hosted workspace is offline", { status: 503 })
        }
        if (tunnel.data.channels.size >= TUNNEL_CHANNEL_CAP) {
          return jsonError(
            "too_many_channels",
            "User-hosted tunnel has too many active WebSocket channels",
            503,
          )
        }
        // RHT validates only the connection establishment for this WS upgrade.
        // The long-lived user-hosted-client channel (multiplexed over the host
        // tunnel) survives past RHT TTL by design. See
        // `packages/workspace-relay/src/auth.ts` mintRelayHostToken for the
        // full lifetime semantics.
        if (server.upgrade(request, {
          data: {
            kind: "user-hosted-client",
            claims: relay.request.claims,
            hostId: relay.request.target.hostId,
            workspaceId: relay.request.target.workspaceId,
            channelId: crypto.randomUUID(),
            path: `${relay.request.path}${url.search}`,
            relayHostToken: relay.request.relayHostToken,
          },
        })) {
          return
        }
        return new Response("WebSocket upgrade failed", { status: 400 })
      }
      // RHT validates only the connection establishment for this WS upgrade.
      // The long-lived cloud-VM relayed socket (PTY, SSE, agent event streams)
      // survives past RHT TTL by design. See
      // `packages/workspace-relay/src/auth.ts` mintRelayHostToken for the full
      // lifetime semantics.
      if (server.upgrade(request, {
        data: {
          kind: "client",
          claims: relay.request.claims,
          upstreamUrl: workspaceRelayTargetUrl(
            relay.request.target,
            relay.request.path,
            url.search,
          ).toString().replace(/^http/, "ws"),
          headers: headersRecord(workspaceRelayForwardHeaders(
            new Headers(),
            relay.request.relayHostToken,
            relay.request.target.workspaceId,
            // T26: cloud-vm WS upgrade. Cookies pass through (default).
            { userHosted: false, upstreamHeaders: relay.request.target.upstreamHeaders },
          )),
          queue: [],
          ...(relayWebSocketTraceEnabled(request)
            ? {
                trace: {
                  acceptedAt: performance.now(),
                  queuedFrames: 0,
                  maxQueuedDelayMs: 0,
                  emitted: false,
                },
              }
            : {}),
        },
      })) {
        return
      }
      return new Response("WebSocket upgrade failed", { status: 400 })
    },
    websocket: {
      maxPayloadLength: WS_MAX_PAYLOAD_LENGTH_BYTES,
      message(ws: Bun.ServerWebSocket<RelayWebSocketData>, message: string | Buffer<ArrayBuffer>) {
        if (ws.data.kind === "host-tunnel") {
          const parsed = tunnelMessage(
            ws as Bun.ServerWebSocket<RelayHostTunnelWebSocketData>,
            message,
            fragmentationStats,
          )
          if (parsed?.type === "ping") {
            options.directory?.recordPong(ws.data.hostId)
            ws.send(JSON.stringify(makeTunnelPong(parsed as TunnelPing)))
          }
          if (parsed?.type === "pong") {
            ws.data.missedPongs = 0
            options.directory?.recordPong(ws.data.hostId)
          }
          if (parsed?.type === "host.registration.update") {
            const update = parsed as TunnelHostRegistrationUpdate
            const workspaceIds = [...new Set(update.workspace_ids)]
            const hostSocket = ws as Bun.ServerWebSocket<RelayHostTunnelWebSocketData>
            const hostId = hostSocket.data.hostId
            const authorizationRequest = new Request(
              `http://relay.local/host-tunnels/${encodeURIComponent(hostId)}`,
              { headers: { authorization: `Bearer ${update.token}` } },
            )
            void authorizeHostTunnel(options, bunOptions, authorizationRequest, {
              hostId,
              workspaceIds,
            }).then((authorized) => {
              if (!authorized) {
                closeWebSocket(hostSocket, 1008, "Host tunnel registration update denied", 1008)
                return
              }
              if (hostTunnels.get(hostId) !== hostSocket || hostSocket.readyState !== WebSocket.OPEN) return
              hostSocket.data.workspaceIds = workspaceIds
              options.directory?.registerHostTunnel({ hostId, workspaceIds })
            }).catch(() => closeWebSocket(hostSocket, 1008, "Host tunnel registration update denied", 1008))
            return
          }
          if (parsed?.type === "error") {
            if (parsed.request_id) {
              const pending = ws.data.pending.get(parsed.request_id)
              if (pending) {
                ws.data.pending.delete(parsed.request_id)
                failPendingHttpResponse({
                  entry: pending,
                  response: jsonError(parsed.code, parsed.message, 502),
                  error: new Error(parsed.message),
                })
              }
            }
          }
          if (parsed?.type === "http.response.start") {
            const pending = ws.data.pending.get(parsed.request_id)
            if (pending) {
              const response = parsed as TunnelHttpResponseStart
              pending.responseStarted = true
              if (isEventStream(response.headers)) clearTimeout(pending.timeout)
              pending.resolve(new Response(pending.stream, {
                status: response.status,
                headers: headers(response.headers),
              }))
            }
          }
          if (parsed?.type === "http.response.chunk") {
            const entry = ws.data.pending.get(parsed.request_id)
            if (entry) {
              enqueueChunkWithBackpressure({
                ws: ws as Bun.ServerWebSocket<RelayHostTunnelWebSocketData>,
                requestId: parsed.request_id,
                entry,
                chunk: decoded((parsed as TunnelHttpResponseChunk).body_base64),
                slowConsumerTimeoutMs: bunOptions.slowConsumerTimeoutMs ?? SLOW_CONSUMER_TIMEOUT_MS_DEFAULT,
                slowConsumerStats,
              })
            }
          }
          if (parsed?.type === "http.response.end") {
            const pending = ws.data.pending.get((parsed as TunnelHttpResponseEnd).request_id)
            if (pending) {
              clearTimeout(pending.timeout)
              if (pending.slowConsumerTimeout) {
                clearTimeout(pending.slowConsumerTimeout)
                pending.slowConsumerTimeout = undefined
              }
              // Drain any remaining overflow before closing so the consumer
              // sees the full body.
              drainPendingChunks(pending)
              if (pending.pendingChunks.length > 0) {
                // Still couldn't drain — push remaining bytes so the queue
                // grows past HWM rather than truncate. Web Streams allows
                // enqueueing past HWM; backpressure is advisory.
                for (const chunk of pending.pendingChunks) {
                  try {
                    pending.controller.enqueue(chunk)
                  } catch {
                    break
                  }
                }
                pending.pendingChunks.length = 0
                pending.bytesQueued = 0
              }
              try {
                pending.controller.close()
              } catch {
                // already closed/errored
              }
              ws.data.pending.delete((parsed as TunnelHttpResponseEnd).request_id)
            }
          }
          if (parsed?.type === "ws.frame") {
            const frame = parsed as TunnelWsFrame
            const channel = ws.data.channels.get(frame.channel_id)
            if (!channel || channel.readyState !== WebSocket.OPEN) {
              ws.data.channels.delete(frame.channel_id)
              return
            }
            if (relayOverBackpressureLimit(channel, bunOptions.webSocketBufferedAmountMaxBytes ?? WS_BUFFERED_AMOUNT_MAX_BYTES_DEFAULT)) {
              ws.data.channels.delete(frame.channel_id)
              closeWebSocket(channel, 1011, "Client WebSocket backpressure limit exceeded")
              return
            }
            channel.send(decodedFrame(frame))
          }
          if (parsed?.type === "ws.close") {
            const close = parsed as TunnelWsClose
            const channel = ws.data.channels.get(close.channel_id)
            if (channel) {
              ws.data.channels.delete(close.channel_id)
              closeWebSocket(channel, close.code, close.reason)
            }
          }
          return
        }
        if (ws.data.kind === "user-hosted-client") {
          const tunnel = hostTunnel(hostTunnels, ws.data.hostId)
          if (!tunnel) {
            ws.close(1011, "User-hosted tunnel disconnected")
            return
          }
          if (relayOverBackpressureLimit(tunnel, bunOptions.webSocketBufferedAmountMaxBytes ?? WS_BUFFERED_AMOUNT_MAX_BYTES_DEFAULT)) {
            closeWebSocket(ws, 1011, "Host tunnel backpressure limit exceeded")
            return
          }
          tunnel.send(JSON.stringify({
            type: "ws.frame",
            protocol: TUNNEL_PROTOCOL_VERSION,
            channel_id: ws.data.channelId,
            ...encodedFrame(message),
          }))
          return
        }
        if (ws.data.upstream?.readyState === WebSocket.OPEN) {
          ws.data.upstream.send(message)
          return
        }
        // Admit on EITHER bound: a burst of small frames during the few
        // milliseconds before upstream connects is normal client behaviour and
        // costs almost nothing to hold, so the frame count alone must not end
        // the session. Only genuinely large buffered traffic closes.
        const queuedBytes = ws.data.queuedBytes ?? 0
        const frameBytes = preOpenFrameBytes(message)
        if (
          ws.data.queue.length >= (bunOptions.upstreamWebSocketPreOpenQueueMaxFrames ?? UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_FRAMES_DEFAULT)
          && queuedBytes + frameBytes > (bunOptions.upstreamWebSocketPreOpenQueueMaxBytes ?? UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_BYTES_DEFAULT)
        ) {
          closeWebSocket(ws, 1011, "Upstream WebSocket queue limit exceeded")
          return
        }
        ws.data.queuedBytes = queuedBytes + frameBytes
        ws.data.queue.push({ payload: message, queuedAt: performance.now() })
      },
      open(ws: Bun.ServerWebSocket<RelayWebSocketData>) {
        if (ws.data.kind === "host-tunnel") {
          const previous = hostTunnels.get(ws.data.hostId)
          if (previous && previous !== ws) {
            cleanupHostTunnelSocket({
              ws: previous,
              hostTunnels,
              hostTunnelStateDebounce,
              options,
              bunOptions,
              disconnectDirectory: false,
              closeChannels: true,
            })
            closeWebSocket(previous, 1012, "Host tunnel replaced by a newer connection", 1012)
          }
          hostTunnels.set(ws.data.hostId, ws as Bun.ServerWebSocket<RelayHostTunnelWebSocketData>)
          options.directory?.registerHostTunnel({
            hostId: ws.data.hostId,
            workspaceIds: ws.data.workspaceIds,
          })
          ws.data.heartbeat = setInterval(() => {
            const hostWs = ws as Bun.ServerWebSocket<RelayHostTunnelWebSocketData>
            if (hostWs.data.missedPongs > (bunOptions.hostTunnelMaxMissedPongs ?? HOST_TUNNEL_MAX_MISSED_PONGS_DEFAULT)) {
              closeWebSocket(ws, 1001, "Host tunnel heartbeat timed out", 1001)
              return
            }
            sendTunnelPing(hostWs)
          }, bunOptions.hostTunnelPingIntervalMs ?? 15_000)
          scheduleHostTunnelStateChange(hostTunnelStateDebounce, options, {
            hostId: ws.data.hostId,
            workspaceId: ws.data.workspaceIds[0],
            path: `/host-tunnels/${ws.data.hostId}`,
            state: "connected",
            debounceMs: bunOptions.hostTunnelStateDebounceMs ?? HOST_TUNNEL_STATE_DEBOUNCE_MS_DEFAULT,
          })
          return
        }
        if (ws.data.kind === "user-hosted-client") {
          watchClientAccess(ws as Bun.ServerWebSocket<RelayUserHostedClientWebSocketData>, options, bunOptions)
          const tunnel = hostTunnel(hostTunnels, ws.data.hostId)
          if (!tunnel) {
            ws.close(1011, "User-hosted tunnel disconnected")
            return
          }
          tunnel.data.channels.set(ws.data.channelId, ws as Bun.ServerWebSocket<RelayUserHostedClientWebSocketData>)
          if (tunnel.readyState !== WebSocket.OPEN) {
            closeWebSocket(ws, 1011, "User-hosted tunnel disconnected")
            return
          }
          tunnel.send(JSON.stringify({
            type: "ws.open",
            protocol: TUNNEL_PROTOCOL_VERSION,
            channel_id: ws.data.channelId,
            workspace_id: ws.data.workspaceId,
            path: ws.data.path,
            headers: headersRecord(workspaceRelayForwardHeaders(
              new Headers(),
              ws.data.relayHostToken,
              ws.data.workspaceId,
              // T26: user-hosted tunnel WS upgrade — strip Cookie. Headers are
              // empty here today, but pass the flag for consistency in case
              // upstream client headers are forwarded in the future.
              { userHosted: true },
            )),
          }))
          return
        }
        relayClients.add(ws as Bun.ServerWebSocket<RelayClientWebSocketData>)
        watchClientAccess(ws as Bun.ServerWebSocket<RelayClientWebSocketData>, options, bunOptions)
        const data = ws.data
        const UpstreamWebSocket = bunOptions.upstreamWebSocket ?? (WebSocket as unknown as UpstreamWebSocketConstructor)
        if (data.trace) data.trace.upstreamStartedAt = performance.now()
        const upstream = new UpstreamWebSocket(data.upstreamUrl, {
          headers: data.headers,
        })
        upstream.binaryType = "arraybuffer"
        data.upstream = upstream
        data.upstreamOpenTimer = setTimeout(() => {
          if (upstream.readyState === WebSocket.OPEN) return
          closeWebSocket(upstream, 1001, "Upstream WebSocket open timed out", 1001)
          closeWebSocket(ws, 1011, "Upstream WebSocket open timed out")
        }, bunOptions.upstreamWebSocketOpenTimeoutMs ?? UPSTREAM_WS_OPEN_TIMEOUT_MS_DEFAULT)
        upstream.onopen = () => {
          const openedAt = performance.now()
          if (data.upstreamOpenTimer) {
            clearTimeout(data.upstreamOpenTimer)
            data.upstreamOpenTimer = undefined
          }
          if (data.trace) {
            data.trace.upstreamOpenMs = openedAt - (data.trace.upstreamStartedAt ?? data.trace.acceptedAt)
            data.trace.queuedFrames = data.queue.length
            data.trace.maxQueuedDelayMs = data.queue.reduce(
              (max, item) => Math.max(max, openedAt - item.queuedAt),
              0,
            )
            sendRelayWebSocketTrace(ws as Bun.ServerWebSocket<RelayClientWebSocketData>)
          }
          for (const item of data.queue.splice(0)) upstream.send(item.payload)
          data.queuedBytes = 0
        }
        upstream.onmessage = (event) => {
          const payload = relayWebSocketPayload(event.data)
          if (payload !== undefined) ws.send(payload)
        }
        upstream.onclose = (event) => {
          if (data.upstreamOpenTimer) {
            clearTimeout(data.upstreamOpenTimer)
            data.upstreamOpenTimer = undefined
          }
          closeWebSocket(ws, event.code, upstreamCloseReason(event))
        }
        upstream.onerror = () => {
          if (data.upstreamOpenTimer) {
            clearTimeout(data.upstreamOpenTimer)
            data.upstreamOpenTimer = undefined
          }
          closeWebSocket(ws, 1011, "Upstream WebSocket connection failed")
        }
      },
      close(ws: Bun.ServerWebSocket<RelayWebSocketData>, code: number, reason: string) {
        if (ws.data.kind === "host-tunnel") {
          cleanupHostTunnelSocket({
            ws: ws as Bun.ServerWebSocket<RelayHostTunnelWebSocketData>,
            hostTunnels,
            hostTunnelStateDebounce,
            options,
            bunOptions,
            disconnectDirectory: true,
            closeChannels: true,
          })
          const tracker = hostTunnelRegistrations.get(ws.data.hostId)
          if (tracker) {
            pruneReconnects(tracker, Date.now())
            if (tracker.recent.length === 0) hostTunnelRegistrations.delete(ws.data.hostId)
          }
          return
        }
        if (ws.data.kind === "user-hosted-client") {
          clearClientAccessWatchers(ws.data)
          const tunnel = hostTunnel(hostTunnels, ws.data.hostId)
          tunnel?.data.channels.delete(ws.data.channelId)
          if (tunnel?.readyState === WebSocket.OPEN) {
            tunnel.send(JSON.stringify({
              type: "ws.close",
              protocol: TUNNEL_PROTOCOL_VERSION,
              channel_id: ws.data.channelId,
              code: safeCloseCode(code, 1000),
              reason,
            }))
          }
          return
        }
        relayClients.delete(ws as Bun.ServerWebSocket<RelayClientWebSocketData>)
        clearClientAccessWatchers(ws.data)
        if (ws.data.upstreamOpenTimer) clearTimeout(ws.data.upstreamOpenTimer)
        if (ws.data.upstream) closeWebSocket(ws.data.upstream, code, reason, 1000)
      },
    } satisfies Bun.WebSocketHandler<RelayWebSocketData>,
    drain: drainController,
    telemetry,
  }
}
