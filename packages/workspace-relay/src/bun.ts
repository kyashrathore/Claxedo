import {
  makeTunnelPing,
  makeTunnelPong,
  TUNNEL_PROTOCOL_VERSION,
  validateTunnelMessage,
  type TunnelHeaderMap,
  type TunnelMessage,
  type TunnelWsFrame,
} from "@claxedo/workspace-relay-protocol"
import {
  RELAY_ALLOWED_REQUEST_HEADERS,
  RUNTIME_ACCESS_TOKEN_ACTIVE_CHECK_INTERVAL_MS_DEFAULT,
  authorizeWorkspaceRelayRequest,
  checkHostTunnelGeneration,
  hostTunnelIncumbentOutranks,
  createWorkspaceRelay,
  createWorkspaceRelayTrace,
  workspaceRelayForwardHeaders,
  workspaceRelayForwardRequestInit,
  workspaceRelayTargetUrl,
  workspaceRelayTimingResponse,
  type WorkspaceRelayAuthorizeTrace,
  type WorkspaceRelayOptions,
} from "./server"
import {
  WorkspaceRelayAuthError,
  validateHostTunnelTokenClaims,
  verifyHostTunnelToken,
  type HostTunnelTokenClaims,
  type RuntimeAccessTokenClaims,
} from "./auth"
import { createOriginMatcher, DEFAULT_RELAY_APP_ORIGINS } from "./cors-origins"
import { bearerToken } from "./http"
import { isHostTunnelTarget } from "./host-tunnel-forwarding"
import { resolveUpstreamWebSocket, type UpstreamWebSocketConstructor } from "./upstream-websocket"

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
  /** Fence pair from the last verified Host Tunnel Token (connect or registration update); absent for tokens without one. */
  enrollmentId?: string
  generation?: number
  pending: Map<string, PendingTunnelHttpResponse>
  /**
   * Pending entries whose response started as `text/event-stream`. They stay
   * in `pending` (chunks, end and cancel all still route through it) but hold
   * a slot in this separate budget instead of the pending-request cap, so a
   * healthy set of long-lived streams cannot starve ordinary requests.
   */
  activeStreams: number
  channels: Map<string, RelayHostTunnelClientWebSocket>
  heartbeat?: ReturnType<typeof setInterval>
  missedPongs: number
  generationCheckTimer?: ReturnType<typeof setInterval>
  generationCheckFailures: number
  // Reassembly buffer for WebSocket frames that arrive as partial JSON.
  // Bounded at TUNNEL_MESSAGE_BUFFER_CAP_BYTES; oversize closes with 1009.
  messageBuffer: string
}

type RelayHostTunnelClientWebSocketData = {
  kind: "host-tunnel-client"
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
  | RelayHostTunnelClientWebSocketData

/** The socket type Bun hands every handler: one type carrying the data union. */
type RelayWebSocket = Bun.ServerWebSocket<RelayWebSocketData>
type RelayClientWebSocket = Bun.ServerWebSocket<RelayClientWebSocketData>
type RelayHostTunnelWebSocket = Bun.ServerWebSocket<RelayHostTunnelWebSocketData>
type RelayHostTunnelClientWebSocket = Bun.ServerWebSocket<RelayHostTunnelClientWebSocketData>

/*
 * `RelayWebSocketData` is a discriminated union, but `Bun.ServerWebSocket<T>`
 * wraps it: testing `ws.data.kind` narrows `ws.data` and leaves `ws` at the
 * union-typed socket, so every per-kind helper used to be reached through a
 * cast. These three predicates are the one place that turns the runtime
 * discriminant into the socket type those helpers require.
 */
const isRelayClientSocket = (ws: RelayWebSocket): ws is RelayClientWebSocket => ws.data.kind === "client"
const isHostTunnelSocket = (ws: RelayWebSocket): ws is RelayHostTunnelWebSocket => ws.data.kind === "host-tunnel"
const isHostTunnelClientSocket = (ws: RelayWebSocket): ws is RelayHostTunnelClientWebSocket =>
  ws.data.kind === "host-tunnel-client"

type PendingTunnelHttpResponse = {
  controller: ReadableStreamDefaultController<Uint8Array>
  stream: ReadableStream<Uint8Array>
  resolve: (response: Response) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
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
  /**
   * Set when `http.response.start` declares `text/event-stream`: the entry
   * then holds a slot in `ws.data.activeStreams` rather than the
   * pending-request budget, released only by `deletePendingHttpResponse`.
   */
  eventStream: boolean
  /**
   * The relay's own CORS headers for this request, applied to whatever the
   * tunnelled host answers with. The browser talks to the RELAY, so the
   * relay's allowlist is the one that decides what it may read — the host
   * behind the tunnel runs its own, unrelated policy, and passing its headers
   * through made a relay's configured app origin readable only when the host
   * happened to allow it too.
   */
  corsHeaders: (upstream: Headers) => Headers
}

/**
 * What an `authorizeHostTunnel` policy returns. A grant must carry the Host
 * Tunnel Token claims the policy verified — there is no claimless "yes":
 * `validateHostTunnelTokenClaims` re-checks issuer, audience, host/workspace
 * binding, and clock bounds before admission, so a permissive policy cannot
 * register a host or workspace its own claims do not assert.
 */
export type HostTunnelAuthorizationResult =
  | { authorized: false }
  | { authorized: true; claims: Record<string, unknown> }

export type WorkspaceRelayHostTunnelOptions = {
  /**
   * Composition seam replacing Host Tunnel Token verification. The result's
   * claims are validated against the requested host and workspace set
   * outside this policy; a tunnel admitted through it can carry a serving
   * generation and is fenced like a token-admitted one.
   */
  authorizeHostTunnel?: (
    request: Request,
    input: {
      hostId: string
      workspaceIds: string[]
    },
  ) => HostTunnelAuthorizationResult | Promise<HostTunnelAuthorizationResult>
  hostTunnelPingIntervalMs?: number
  hostTunnelMaxMissedPongs?: number
  /**
   * How often an established host tunnel's generation is re-checked against
   * `resolveHostGeneration`. Defaults to 30s; 0 disables the check. Because
   * the lookup may answer from its cache, a superseded tunnel closes within
   * this interval plus the lookup's cache TTL.
   */
  hostGenerationCheckIntervalMs?: number
  /**
   * Consecutive unavailable lookups an established tunnel survives before it
   * is closed 1012 for the host to reconnect. Defaults to 3.
   */
  hostGenerationOutageGraceAttempts?: number
  // Debounce window used to coalesce host-tunnel connected/disconnected
  // audit emissions per tunnel identity. Default 250ms. A flapping reconnect within
  // this window whose intended state matches lastWritten is suppressed.
  hostTunnelStateDebounceMs?: number
}

export type WorkspaceRelayBackpressureOptions = {
  // High-water mark used by the per-pending ByteLengthQueuingStrategy.
  // When the controller's queued bytes meet or exceed this value, new chunks
  // are diverted into the per-pending overflow buffer until the consumer
  // catches up. Default 8 MiB.
  slowConsumerHighWaterMarkBytes?: number
  // How long the per-pending overflow buffer can stay non-empty before
  // the request is failed with 503 slow_consumer_timeout. Default 30 s.
  slowConsumerTimeoutMs?: number
  // How many bytes the per-pending overflow buffer may hold before the request
  // is failed with 503 slow_consumer_overflow. Default 16 MiB.
  slowConsumerMaxBufferedBytes?: number
  tunnelRequestBodyMaxBytes?: number
  directHttpRequestBodyMaxBytes?: number
  tunnelHttpResponseTimeoutMs?: number
  directHttpTimeoutMs?: number
  directHttpConcurrency?: number
  /**
   * Waiters allowed in the direct-HTTP concurrency queue before new requests
   * are refused 429. Each waiter pins its Request while it waits, so the
   * queue is what turns `directHttpConcurrency` into a memory bound rather
   * than only a latency one. Default 64; unused when no concurrency limit is
   * configured.
   */
  directHttpQueueMax?: number
  /**
   * In-flight non-stream tunnel HTTP requests admitted per host tunnel.
   * Default 32. A response that starts as `text/event-stream` leaves this
   * budget for `tunnelActiveStreamMax`.
   */
  tunnelPendingRequestMax?: number
  /**
   * Concurrent started `text/event-stream` responses per host tunnel.
   * Default 64. Streams past the cap are refused 503/429 `too_many_streams`.
   */
  tunnelActiveStreamMax?: number
  /**
   * Pending-request slots a request declaring `Accept: text/event-stream`
   * may not consume. A burst of stream opens sits in the pending budget only
   * until `http.response.start` reclassifies it; the reserve keeps that
   * window from crowding out ordinary health/management requests. Default 4.
   */
  tunnelControlRequestReserve?: number
  upstreamWebSocketOpenTimeoutMs?: number
  upstreamWebSocketPreOpenQueueMaxFrames?: number
  upstreamWebSocketPreOpenQueueMaxBytes?: number
  upstreamWebSocket?: UpstreamWebSocketConstructor
  webSocketBufferedAmountMaxBytes?: number
}

export type WorkspaceRelayBunOptions = WorkspaceRelayHostTunnelOptions & WorkspaceRelayBackpressureOptions
  & {
    /**
     * How often established user WebSockets are re-checked for revocation.
     * Defaults to 30s; 0 disables the re-check. Because the check may answer
     * from the revocation lookup's cache, a revoked token closes the socket
     * within this interval plus the lookup's cache TTL — see
     * `runtimeAccessTokenRevocationDelayMs` in `./server`. A resolver outage
     * does not extend the socket past the token's `exp`, which the watcher
     * enforces locally.
     */
    runtimeAccessTokenActiveCheckIntervalMs?: number
    /** Clock injection used to calculate the local token-expiry deadline. */
    now?: () => number
  }

/**
 * Declared as function-valued properties, not methods, because every member is
 * a closure over the adapter's counters and is routinely handed around
 * detached (`metricsSources.fragmentation ?? telemetry.getFragmentationStats`).
 * None of them reads `this`, and the same shape is used by
 * `WorkspaceRelayMetricsSources` in `./server`.
 */
export type WorkspaceRelayBunTelemetry = {
  getFragmentationStats: () => FragmentationStats
  resetFragmentationStats: () => void
  getSlowConsumerStats: () => SlowConsumerStats
  resetSlowConsumerStats: () => void
}

/**
 * Drain controller exposed by `createWorkspaceRelayBun`.
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
 *
 * Function-valued properties rather than methods, for the same reason as
 * `WorkspaceRelayBunTelemetry`: `isDraining` and `pendingCount` are passed
 * detached into `createWorkspaceRelay`, and none of them reads `this`.
 */
export type WorkspaceRelayBunDrainController = {
  isDraining: () => boolean
  setDraining: (value: boolean) => void
  pendingCount: () => number
  waitForDrain: (timeoutMs: number) => Promise<{ drained: boolean; remaining: number }>
}

// Per-tunnel resource caps.
const TUNNEL_PENDING_HTTP_CAP = 32
// Started text/event-stream responses hold their own budget instead of the
// pending-request cap: an SSE response is expected to stay open indefinitely,
// so counting it against a budget sized for request/response turnaround lets
// a handful of healthy streams starve every other request on the tunnel.
const TUNNEL_ACTIVE_STREAM_CAP = 64
// Pending-request slots an `Accept: text/event-stream` request may not hold
// while it waits for http.response.start to move it into the stream budget,
// so a burst of stream opens cannot crowd out ordinary requests. A pending
// entry counts against this reserve only until its response starts.
const TUNNEL_CONTROL_REQUEST_RESERVE = 4
const TUNNEL_CHANNEL_CAP = 16
const HOST_TUNNEL_REGISTRATION_RECONNECT_CAP = 5
const HOST_TUNNEL_REGISTRATION_RECONNECT_WINDOW_MS = 60_000
const WS_MAX_PAYLOAD_LENGTH_BYTES = 16 * 1024 * 1024
const TUNNEL_REQUEST_BODY_MAX_BYTES_DEFAULT = 16 * 1024 * 1024
const DIRECT_HTTP_REQUEST_BODY_MAX_BYTES_DEFAULT = 16 * 1024 * 1024
const TUNNEL_HTTP_RESPONSE_TIMEOUT_MS_DEFAULT = 30_000
const DIRECT_HTTP_TIMEOUT_MS_DEFAULT = 30_000
const DIRECT_HTTP_QUEUE_MAX_DEFAULT = 64
const UPSTREAM_WS_OPEN_TIMEOUT_MS_DEFAULT = 10_000
// The two bounds a client's pre-open frames are held against, each enforced on
// its own: the queue costs both an array entry per frame and the payload bytes,
// and neither bounds the other. 8 MiB of one-byte frames is eight million
// entries; one frame at `WS_MAX_PAYLOAD_LENGTH_BYTES` is 16 MiB under any frame
// count. Requiring both to be exceeded left roughly a gigabyte reachable per
// socket.
//
// Overflow CLOSES the socket rather than dropping frames, and that is
// deliberate: this queue carries an ordered byte stream (terminal input, PTY
// data), so shedding entries from it would hand the far end a corrupted stream
// with no error anywhere — strictly worse than a clean, diagnosable close.
//
// The window this queue covers is one upstream connect, bounded above by
// `UPSTREAM_WS_OPEN_TIMEOUT_MS_DEFAULT` and normally milliseconds. A client that
// pipelines more than 64 frames into it without waiting for any output is not
// the interactive case these defaults serve and is closed; a deployment that
// carries such traffic raises the bound explicitly.
const UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_FRAMES_DEFAULT = 64
const UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_BYTES_DEFAULT = 8 * 1024 * 1024
const WS_BUFFERED_AMOUNT_MAX_BYTES_DEFAULT = 8 * 1024 * 1024

/**
 * Bytes queued in a socket's send buffer, or `undefined` if it cannot report.
 *
 * Bun spells this `getBufferedAmount()` — a method, not the browser's
 * `bufferedAmount` property. Reading the property on a Bun socket yields
 * `undefined`, and `undefined > limit` is always false, so a guard built on it
 * never fires.
 *
 * Fails open on a socket that cannot report, deliberately: an unguarded healthy
 * connection beats a guard that kills healthy connections. This is also why the
 * guard is not portable to `cloudflare.ts` — workerd's WebSocket exposes no
 * buffer depth, so bounding that path needs a protocol-level credit/ack window.
 */
export const relayBufferedBytes = (socket: unknown): number | undefined => {
  if (typeof socket !== "object" || socket === null) return undefined
  if ("getBufferedAmount" in socket && typeof socket.getBufferedAmount === "function") {
    const measured: unknown = socket.getBufferedAmount()
    return typeof measured === "number" && Number.isFinite(measured) ? measured : undefined
  }
  // Browser-shaped sockets (and doubles that mimic one) carry the property.
  if (!("bufferedAmount" in socket)) return undefined
  const property: unknown = socket.bufferedAmount
  return typeof property === "number" && Number.isFinite(property) ? property : undefined
}

/**
 * True only when the socket reports a depth over the limit. Unknown ⇒ false.
 *
 * Exported for `bun.test.ts`: a loopback peer drains faster than a test can
 * fill it, so the decision is asserted directly.
 */
export const relayOverBackpressureLimit = (socket: unknown, limitBytes: number) => {
  const queued = relayBufferedBytes(socket)
  return queued !== undefined && queued > limitBytes
}
const HOST_TUNNEL_MAX_MISSED_PONGS_DEFAULT = 2
const HOST_GENERATION_CHECK_INTERVAL_MS_DEFAULT = 30_000
const HOST_GENERATION_OUTAGE_GRACE_ATTEMPTS_DEFAULT = 3
// Cap on the per-WS reassembly buffer for fragmented JSON frames.
const TUNNEL_MESSAGE_BUFFER_CAP_BYTES = 4 * 1024 * 1024
// Per-request slow-consumer backpressure defaults for tunnel HTTP responses;
// overridable via WorkspaceRelayBunOptions.
const SLOW_CONSUMER_HIGH_WATER_MARK_BYTES_DEFAULT = 8 * 1024 * 1024
const SLOW_CONSUMER_TIMEOUT_MS_DEFAULT = 30_000
// The high-water mark decides only when a chunk is diverted into the overflow
// buffer; this bounds what that buffer may then hold, so one in-flight tunnel
// response costs at most the two combined. Without it the buffer grew for the
// whole slow-consumer window at whatever rate the host could push, and it grew
// with no consumer at all when a host sent `http.response.chunk` before
// `http.response.start` — nothing reads the stream until that start resolves it.
//
// Sized to the largest frame the socket can deliver so an empty buffer always
// admits one whole chunk: a lower cap would refuse a single oversized chunk the
// consumer was about to read, turning a momentary lag into a failed response.
const SLOW_CONSUMER_MAX_BUFFERED_BYTES_DEFAULT = WS_MAX_PAYLOAD_LENGTH_BYTES
// Default debounce window for host-tunnel connected/disconnected audit emissions.
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
  /**
   * Resolves a release function once a concurrency slot is held, or
   * `undefined` when the wait queue is already full or `signal` aborted while
   * waiting. The queue is bounded because a waiter pins its whole Request —
   * unbounded queueing would let memory grow past the very limit the slots
   * exist to enforce.
   */
  acquire(signal?: AbortSignal): Promise<(() => void) | undefined>
}

function createDirectHttpLimiter(limit: number | undefined, queueMax: number | undefined): DirectHttpLimiter | undefined {
  if (!Number.isInteger(limit) || !limit || limit <= 0) return undefined
  const max = limit
  const queuedMax = Number.isInteger(queueMax) && queueMax! > 0 ? queueMax! : DIRECT_HTTP_QUEUE_MAX_DEFAULT
  let active = 0
  const queue: Array<{
    resolve: (release: (() => void) | undefined) => void
    onAbort: () => void
    signal?: AbortSignal
  }> = []

  function makeRelease() {
    let released = false
    return () => {
      if (released) return
      released = true
      active = Math.max(0, active - 1)
      drain()
    }
  }

  function drain() {
    while (active < max) {
      const next = queue.shift()
      if (!next) return
      active++
      next.signal?.removeEventListener("abort", next.onAbort)
      next.resolve(makeRelease())
    }
  }

  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.resolve(undefined)
      if (active < max && queue.length === 0) {
        active++
        return Promise.resolve(makeRelease())
      }
      if (queue.length >= queuedMax) return Promise.resolve(undefined)
      return new Promise((resolve) => {
        const waiter = {
          resolve,
          signal,
          onAbort: () => {
            const index = queue.indexOf(waiter)
            if (index === -1) return
            queue.splice(index, 1)
            resolve(undefined)
          },
        }
        queue.push(waiter)
        signal?.addEventListener("abort", waiter.onAbort, { once: true })
      })
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

function corsJsonError(
  request: Request,
  originAllowed: RelayOriginMatcher,
  code: string,
  message: string,
  status: number,
) {
  const headers = relayCorsHeaders(request, originAllowed)
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers })
}

/** Byte size of a frame awaiting the upstream socket, for the pre-open bound. */
function preOpenFrameBytes(message: string | Buffer<ArrayBuffer>) {
  return typeof message === "string" ? Buffer.byteLength(message) : message.byteLength
}

function safeCloseCode(input: number | undefined, fallback = 1011) {
  if (input === undefined || !Number.isInteger(input)) return fallback
  const code = input
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

/**
 * A host tunnel is identified by (host, workspace), never by host alone: one
 * host opens one socket per workspace it serves, and the routing map and audit
 * debounce are keyed by this so a second workspace's socket does not replace
 * the first. The reconnect budget stays per host: it bounds abuse by a key
 * holder, and a key holder has one host id however many workspaces it serves.
 */
function tunnelKey(hostId: string, workspaceId: string) {
  return `${hostId}\0${workspaceId}`
}

/** One socket's identity set, for structures that debounce or budget per socket. */
function tunnelIdentity(hostId: string, workspaceIds: string[]) {
  return `${hostId}\0${[...new Set(workspaceIds)].sort().join(",")}`
}

/** Workspaces whose routing entry currently points at this socket. */
function ownedWorkspaceIds(hostTunnels: Map<string, RelayHostTunnelWebSocket>, ws: RelayHostTunnelWebSocket) {
  return ws.data.workspaceIds.filter((workspaceId) => hostTunnels.get(tunnelKey(ws.data.hostId, workspaceId)) === ws)
}

function outranks(incumbent: RelayHostTunnelWebSocket, candidateGeneration: number | undefined) {
  return hostTunnelIncumbentOutranks(incumbent.data.generation, candidateGeneration)
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

function sendRelayWebSocketTrace(ws: RelayClientWebSocket, maxBufferedBytes: number) {
  const trace = ws.data.trace
  if (!trace || trace.emitted) return
  trace.emitted = true
  if (relayOverBackpressureLimit(ws, maxBufferedBytes)) return
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
  return undefined
}

function headersRecord(headers: Headers) {
  // A `__proto__` header name is a legal token: assigned onto `{}` it hits the
  // prototype setter and is silently dropped, so the map gets a null prototype.
  const result: Record<string, string> = Object.create(null)
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

/**
 * Admission-time stream classification. Whether a response streams is known
 * only at `http.response.start`; until then the request occupies the
 * pending-request budget. The `Accept` header (EventSource and fetch-based
 * SSE clients send it) lets a stream-intended request be held to the
 * control-reserve side of that budget for the pre-start window. An
 * undeclared stream is not refused — it just uses an ordinary slot until
 * its response start reclassifies it.
 */
function requestAcceptsEventStream(request: Request) {
  return request.headers.get("accept")?.toLowerCase().includes("text/event-stream") ?? false
}

/**
 * The browser-origin allowlist this relay instance enforces.
 *
 * `createWorkspaceRelayBun` compiles one matcher from the deployment's
 * `allowedOrigins` (falling back to the product default list) and hands it to
 * every path that answers a browser: the WebSocket admission check, the
 * workspace fast path's preflight, and every CORS header it stamps. It is a
 * required parameter rather than a defaulted one so a new call site cannot
 * silently answer from the built-in list while the deployment configured its
 * own: a self-hosted relay's own app origin would then pass the upgrade check
 * but fail every fast-path preflight.
 */
type RelayOriginMatcher = (origin: string) => boolean

// Same default policy the HTTP path and the Cloudflare adapter apply
// (./cors-origins), used when a deployment configures no `allowedOrigins`.
const defaultRelayOriginMatcher = createOriginMatcher(DEFAULT_RELAY_APP_ORIGINS)

function allowedCorsOrigin(origin: string | null, matcher: RelayOriginMatcher): string | undefined {
  if (!origin) return undefined
  return matcher(origin) ? origin : undefined
}

function requireAllowedOrigin(request: Request, matcher: RelayOriginMatcher) {
  const origin = request.headers.get("origin")
  if (allowedCorsOrigin(origin, matcher)) return null
  return jsonError(
    "origin_not_allowed",
    "Origin is not in the allowlist",
    403,
  )
}

function relayCorsHeaders(request: Request, originAllowed: RelayOriginMatcher, input = new Headers()) {
  const result = new Headers(input)
  result.delete("access-control-allow-origin")
  result.delete("access-control-allow-credentials")
  result.delete("access-control-allow-headers")
  result.delete("access-control-allow-methods")
  result.delete("access-control-expose-headers")
  result.delete("access-control-max-age")
  // Every workspace shares this relay's origin: an upstream Set-Cookie would
  // be replayed to other workspaces' requests through the relay.
  result.delete("set-cookie")
  const origin = allowedCorsOrigin(request.headers.get("origin"), originAllowed)
  if (origin) {
    result.set("access-control-allow-origin", origin)
    result.set("access-control-allow-headers", RELAY_ALLOWED_REQUEST_HEADERS)
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
  ws: RelayHostTunnelWebSocket,
  input: string | Buffer<ArrayBuffer>,
  stats: FragmentationStats,
): TunnelMessage | undefined {
  if (typeof input !== "string") return undefined
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
      return undefined
    }
    stats.fragmentsBuffered += 1
    ws.data.messageBuffer = combined
    return undefined
  }
  // Successful parse — clear any retained buffer.
  ws.data.messageBuffer = ""
  const validated = validateTunnelMessage(parsed)
  if (validated.ok) return validated.message
  if (validated.reason === "protocol_mismatch") {
    ws.close(1002, `Tunnel protocol mismatch: expected ${validated.expected_protocol}`)
  }
  return undefined
}

function sendTunnelPing(ws: RelayHostTunnelWebSocket, maxBufferedBytes: number) {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.data.missedPongs += 1
  // 发送缓冲已满说明主机没在消费这条隧道；跳过本帧，让 missedPongs
  // 继续累积 —— 持续打满的隧道会由既有的心跳超时关闭，而不是靠 ping
  // 把缓冲越堆越高。
  if (relayOverBackpressureLimit(ws, maxBufferedBytes)) return
  ws.send(JSON.stringify(makeTunnelPing()))
}

function clearPendingTimers(entry: PendingTunnelHttpResponse) {
  clearTimeout(entry.timeout)
  if (entry.slowConsumerTimeout) {
    clearTimeout(entry.slowConsumerTimeout)
    entry.slowConsumerTimeout = undefined
  }
}

/**
 * Single removal point for `ws.data.pending`: an entry reclassified as an
 * event stream holds a slot in `activeStreams`, and that slot is released
 * only here — every delete path (end, error, timeout, cancel, slow-consumer
 * drop, stream-cap refusal) must pass through it or the budget leaks.
 */
function deletePendingHttpResponse(ws: RelayHostTunnelWebSocket, requestId: string) {
  const entry = ws.data.pending.get(requestId)
  if (entry?.eventStream) ws.data.activeStreams = Math.max(0, ws.data.activeStreams - 1)
  ws.data.pending.delete(requestId)
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
  ws: RelayHostTunnelWebSocket
  hostTunnels: Map<string, RelayHostTunnelWebSocket>
  hostTunnelStateDebounce: Map<string, HostTunnelStateEntry>
  options: WorkspaceRelayOptions
  bunOptions: WorkspaceRelayBunOptions
  originAllowed: RelayOriginMatcher
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
        ? corsJsonError(input.request, input.originAllowed, "host_tunnel_offline", "The machine serving this workspace is offline", 503)
        : jsonError("host_tunnel_offline", "The machine serving this workspace is offline", 503),
      error: new Error("Host tunnel disconnected"),
    })
  }
  input.ws.data.pending.clear()
  input.ws.data.activeStreams = 0
  for (const channel of input.ws.data.channels.values()) {
    if (input.closeChannels) closeWebSocket(channel, 1011, "Host tunnel disconnected")
  }
  input.ws.data.channels.clear()
  if (!input.disconnectDirectory) return
  const owned = ownedWorkspaceIds(input.hostTunnels, input.ws)
  if (owned.length === 0) return
  for (const workspaceId of owned) input.hostTunnels.delete(tunnelKey(input.ws.data.hostId, workspaceId))
  input.options.directory?.disconnectHost(input.ws.data.hostId, owned)
  scheduleHostTunnelStateChange(input.hostTunnelStateDebounce, input.options, {
    hostId: input.ws.data.hostId,
    workspaceIds: input.ws.data.workspaceIds,
    path: `/host-tunnels/${input.ws.data.hostId}`,
    state: "disconnected",
    debounceMs: input.bunOptions.hostTunnelStateDebounceMs ?? HOST_TUNNEL_STATE_DEBOUNCE_MS_DEFAULT,
  })
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

/**
 * A host-tunnel registration the relay refused, recorded the way a client
 * request denial is (`server.ts`'s `deny`): a superseded or revoked
 * generation, a lookup outage, a bad token, or the reconnect cap. Never
 * sampled, so an operator can read a fence decision off the audit log
 * without reproducing the admission.
 */
async function auditHostTunnelDenial(
  options: WorkspaceRelayOptions,
  input: { code: string; hostId: string; workspaceId?: string },
) {
  await options.audit?.({
    action: "host_tunnel.denied",
    result: "deny",
    reason: input.code,
    hostId: input.hostId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    method: "WEBSOCKET",
    path: `/host-tunnels/${input.hostId}`,
  })
}

async function denyHostTunnel(
  options: WorkspaceRelayOptions,
  input: { code: string; message: string; status: number; hostId: string; workspaceId?: string },
) {
  await auditHostTunnelDenial(options, input)
  return jsonError(input.code, input.message, input.status)
}

/**
 * The socket-level form of `denyHostTunnel`, for a fence decision reached
 * after the upgrade: at open, or on a registration update. 1012 is the code
 * the host treats as "reconnect"; every other refusal closes 1008.
 */
async function refuseHostTunnelSocket(
  options: WorkspaceRelayOptions,
  ws: RelayHostTunnelWebSocket,
  input: { code: string; close: 1008 | 1012; reason: string; workspaceId?: string },
) {
  await auditHostTunnelDenial(options, { code: input.code, hostId: ws.data.hostId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) })
  closeWebSocket(ws, input.close, input.reason, input.close)
}

// Per-tunnel-identity debounce of host_tunnel.connected / host_tunnel.disconnected
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
    workspaceIds: string[]
    path: string
    state: "connected" | "disconnected"
    debounceMs: number
  },
) {
  const identity = tunnelIdentity(input.hostId, input.workspaceIds)
  const workspaceId = input.workspaceIds[0]
  const existing = state.get(identity)
  const entry: HostTunnelStateEntry = existing ?? {
    intendedState: "disconnected",
    lastWritten: "disconnected",
    flushTimer: undefined,
    pending: { workspaceId, path: input.path },
  }
  entry.intendedState = input.state
  entry.pending = { workspaceId, path: input.path }
  if (entry.flushTimer) clearTimeout(entry.flushTimer)
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = undefined
    if (entry.intendedState === entry.lastWritten) {
      // No-op: state returned to lastWritten before the flush fired.
      // Drop the entry if it has settled to "disconnected" (the implicit
      // baseline for unseen hosts) so the map doesn't grow unbounded.
      if (entry.intendedState === "disconnected") {
        state.delete(identity)
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
  state.set(identity, entry)
}

// Drain as much of the overflow buffer as the controller will accept.
// Decrements bytesQueued (which counts only overflow-buffer bytes, not
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

// Free a pending tunnel response the consumer never drained. Both slow-consumer
// bounds — the watchdog and the overflow-buffer byte cap — end here, so the
// pending slot, the timers and the buffered bytes are released the same way
// whichever one fired.
function dropSlowConsumer(input: {
  ws: RelayHostTunnelWebSocket
  requestId: string
  entry: PendingTunnelHttpResponse
  slowConsumerStats: SlowConsumerStats
  code: "slow_consumer_timeout" | "slow_consumer_overflow"
  message: string
}) {
  const response = jsonError(input.code, input.message, 503)
  failPendingHttpResponse({
    entry: input.entry,
    response: new Response(response.body, {
      status: response.status,
      headers: input.entry.corsHeaders(response.headers),
    }),
    error: new Error(`${input.code}: ${input.message}`),
  })
  deletePendingHttpResponse(input.ws, input.requestId)
  // Count after cleanup so droppedRequests reflects requests actually freed.
  input.slowConsumerStats.droppedRequests += 1
}

// Route a freshly-received chunk either into the controller (consumer
// keeping up) or into the overflow buffer (consumer slow). Starts the
// slow-consumer watchdog the first time a chunk overflows, and drops the
// request outright once the buffer would pass its byte cap.
function enqueueChunkWithBackpressure(input: {
  ws: RelayHostTunnelWebSocket
  requestId: string
  entry: PendingTunnelHttpResponse
  chunk: Uint8Array
  slowConsumerTimeoutMs: number
  maxBufferedBytes: number
  slowConsumerStats: SlowConsumerStats
}) {
  const { entry, chunk } = input
  const desired = entry.controller.desiredSize
  const overflowing = desired !== null && desired <= 0
  if (overflowing || entry.pendingChunks.length > 0) {
    if (entry.bytesQueued + chunk.byteLength > input.maxBufferedBytes) {
      dropSlowConsumer({
        ws: input.ws,
        requestId: input.requestId,
        entry,
        slowConsumerStats: input.slowConsumerStats,
        code: "slow_consumer_overflow",
        message: "Downstream consumer fell too far behind the tunnelled response",
      })
      return
    }
    entry.pendingChunks.push(chunk)
    entry.bytesQueued += chunk.byteLength
    if (!entry.slowConsumerTimeout) {
      // First overflow for this request: count it before arming the watchdog
      // so the metric reflects how often the HWM was hit.
      input.slowConsumerStats.overflowEvents += 1
      entry.slowConsumerTimeout = setTimeout(() => {
        // Count actual timer fires (not timers cleared by drain).
        input.slowConsumerStats.timerFired += 1
        dropSlowConsumer({
          ws: input.ws,
          requestId: input.requestId,
          entry,
          slowConsumerStats: input.slowConsumerStats,
          code: "slow_consumer_timeout",
          message: "Downstream consumer did not drain in time",
        })
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

// Testing-only export: lets unit tests drive the slow-consumer counter
// directly, since localhost is too fast to trip the HWM through real fetch +
// host-tunnel chunks.
export const __slowConsumerInternalsForTest = {
  enqueueChunkWithBackpressure,
  createSlowConsumerStats,
}

// Testing-only export: a queued waiter's abort is a socket-level event that
// an end-to-end test cannot sequence against a queue fill, so the limiter's
// bookkeeping is asserted directly.
export const __directHttpInternalsForTest = {
  createDirectHttpLimiter,
}

async function tunnelHttpRequest(input: {
  ws: RelayHostTunnelWebSocket
  request: Request
  originAllowed: RelayOriginMatcher
  workspaceId: string
  path: string
  relayHostToken: string
  slowConsumerHighWaterMarkBytes: number
  slowConsumerTimeoutMs: number
  slowConsumerStats: SlowConsumerStats
  requestBodyMaxBytes: number
  responseTimeoutMs: number
  pendingRequestMax: number
  activeStreamMax: number
  controlRequestReserve: number
  socketMaxBufferedBytes: number
}) {
  if (input.ws.readyState !== WebSocket.OPEN) {
    return new Response("The machine serving this workspace is offline", { status: 503 })
  }
  // 非流 pending 占请求预算；已开始的 SSE 改记 activeStreams，不占这里。
  const inFlightRequests = Math.max(0, input.ws.data.pending.size - input.ws.data.activeStreams)
  const wantsStream = requestAcceptsEventStream(input.request)
  const requestLimit = wantsStream
    ? Math.max(0, input.pendingRequestMax - input.controlRequestReserve)
    : input.pendingRequestMax
  if (inFlightRequests >= requestLimit) {
    return jsonError(
      "too_many_in_flight",
      "Host tunnel has too many in-flight HTTP requests",
      429,
    )
  }
  if (wantsStream && input.ws.data.activeStreams >= input.activeStreamMax) {
    return jsonError(
      "too_many_streams",
      "Host tunnel has too many active event streams",
      429,
    )
  }
  if (relayOverBackpressureLimit(input.ws, input.socketMaxBufferedBytes)) {
    return jsonError(
      "host_tunnel_backpressured",
      "Host tunnel socket send buffer is saturated",
      503,
    )
  }
  const requestId = crypto.randomUUID()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  // ByteLengthQueuingStrategy makes controller.desiredSize reflect
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
      deletePendingHttpResponse(input.ws, requestId)
      clearPendingTimers(entry)
      entry.pendingChunks.length = 0
      entry.bytesQueued = 0
      if (input.ws.readyState === WebSocket.OPEN
        && !relayOverBackpressureLimit(input.ws, input.socketMaxBufferedBytes)) {
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
      deletePendingHttpResponse(input.ws, requestId)
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
      const error = new Error("Host tunnel response timed out")
      failPendingHttpResponse({
        entry,
        response: corsJsonError(input.request, input.originAllowed, "host_tunnel_timeout", "Host tunnel response timed out", 504),
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
      eventStream: false,
      corsHeaders: (upstream) => relayCorsHeaders(input.request, input.originAllowed, upstream),
    })
  })
  let body: Awaited<ReturnType<typeof readBoundedBody>>
  try {
    body = input.request.method === "GET" || input.request.method === "HEAD"
      ? undefined
      : await readBoundedBody(input.request, input.requestBodyMaxBytes)
  } catch {
    // A client that vanishes mid-upload fails the read; its pending slot has
    // to go now rather than at the response timeout.
    const entry = input.ws.data.pending.get(requestId)
    if (entry) clearPendingTimers(entry)
    deletePendingHttpResponse(input.ws, requestId)
    return corsJsonError(
      input.request,
      input.originAllowed,
      "request_body_unreadable",
      "Tunnel request body could not be read",
      400,
    )
  }
  if (body && "tooLarge" in body) {
    const entry = input.ws.data.pending.get(requestId)
    if (entry) clearPendingTimers(entry)
    deletePendingHttpResponse(input.ws, requestId)
    return corsJsonError(
      input.request,
      input.originAllowed,
      "request_body_too_large",
      "Tunnel request body exceeds the relay limit",
      413,
    )
  }
  // Body 读取期间隧道可能被打满；发送前再挡一次，避免把请求塞进发不出去
  // 的 socket 后让 pending 空等到超时。
  if (relayOverBackpressureLimit(input.ws, input.socketMaxBufferedBytes)) {
    const entry = input.ws.data.pending.get(requestId)
    if (entry) clearPendingTimers(entry)
    deletePendingHttpResponse(input.ws, requestId)
    return jsonError(
      "host_tunnel_backpressured",
      "Host tunnel socket send buffer is saturated",
      503,
    )
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
      // Host tunnel: strip Cookie so browser cookies never reach the
      // host process on the user's laptop.
      { hostTunnel: true },
    )),
    ...(body && "body" in body && body.body.byteLength > 0
      ? { body_base64: encoded(body.body.buffer) }
      : {}),
    end: true,
  }))
  return await pending
}

/**
 * The request body in full, or `tooLarge` as soon as it passes `maxBytes` —
 * counted while reading and cancelled at the boundary, so an oversized body is
 * refused without ever being held whole. `undefined` means the request carried
 * no body at all, which is not the same as an empty one.
 *
 * The 413 belongs to the caller: the tunnel path and the direct path bound
 * different budgets and name them differently to whoever reads the error.
 */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<{ body: Uint8Array<ArrayBuffer> } | { tooLarge: true } | undefined> {
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
      return { tooLarge: true }
    }
    chunks.push(next.value)
  }
  const body = new Uint8Array(total)
  chunks.reduce((offset, chunk) => {
    body.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  return { body }
}

async function directHttpRequest(input: {
  request: Request
  originAllowed: RelayOriginMatcher
  targetUrl: string
  relayHostToken: string
  workspaceId: string
  upstreamHeaders?: Record<string, string>
  timeoutMs: number
  requestBodyMaxBytes: number
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
        // Cloud-vm direct path: cookies pass through — workspace dashboards in
        // the VM may legitimately need session cookies.
        hostTunnel: false,
        upstreamHeaders: input.upstreamHeaders,
        // Client disconnect cancels the upstream fetch the same way the
        // timeout does — a gone caller must not keep a host request alive.
        signal: AbortSignal.any([controller.signal, input.request.signal]),
      },
    )
    const limiter = input.limiter
    const release = limiter ? await span("direct-http-queue", () => limiter.acquire(input.request.signal)) : undefined
    if (limiter && !release) {
      return corsJsonError(
        input.request,
        input.originAllowed,
        "too_many_in_flight",
        "The relay has too many queued workspace requests",
        429,
      )
    }
    try {
      // The body is buffered inside the concurrency slot, not before it.
      // Reading first let every queued request hold its whole body at once, so
      // the slot budgeted latency and nothing else.
      if (input.request.method !== "GET" && input.request.method !== "HEAD" && input.request.body) {
        const body = await readBoundedBody(input.request, input.requestBodyMaxBytes)
        if (body && "tooLarge" in body) {
          return corsJsonError(
            input.request,
            input.originAllowed,
            "request_body_too_large",
            "Workspace request body exceeds the relay limit",
            413,
          )
        }
        if (body) init.body = body.body
      }
      const upstream = await span("upstream-fetch", async () => await fetch(input.targetUrl, init))
      const headers = relayCorsHeaders(input.request, input.originAllowed, upstream.headers)
      // Every response streams through: buffering an ordinary body in full
      // made one response cost its whole size in relay memory, while a size
      // cap would break legitimate large transfers. Stream backpressure is
      // the bound instead — an unconsumed body cannot accumulate here.
      return new Response(upstream.body, {
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
      input.originAllowed,
      aborted ? "upstream_timeout" : "upstream_unavailable",
      aborted ? "Workspace upstream timed out" : "Workspace upstream is unavailable",
      aborted ? 504 : 503,
    )
  } finally {
    clearTimeout(timer)
  }
}

function hostTunnel(
  hostTunnels: Map<string, RelayHostTunnelWebSocket>,
  hostId: string,
  workspaceId: string,
) {
  const tunnel = hostTunnels.get(tunnelKey(hostId, workspaceId))
  if (tunnel?.readyState === WebSocket.OPEN) return tunnel
  return undefined
}

type HostTunnelAuthorization =
  | { authorized: false }
  | { authorized: true; claims: HostTunnelTokenClaims }

async function authorizeHostTunnel(
  options: WorkspaceRelayOptions,
  bunOptions: WorkspaceRelayBunOptions,
  request: Request,
  input: {
    hostId: string
    workspaceIds: string[]
  },
): Promise<HostTunnelAuthorization> {
  if (bunOptions.authorizeHostTunnel) {
    const result = await bunOptions.authorizeHostTunnel(request, input)
    if (!result.authorized) return { authorized: false }
    try {
      return { authorized: true, claims: validateHostTunnelTokenClaims(result.claims, input) }
    } catch (err) {
      if (err instanceof WorkspaceRelayAuthError) return { authorized: false }
      throw err
    }
  }
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) return { authorized: false }
  try {
    return { authorized: true, claims: await verifyHostTunnelToken(token, options.runtimeAccessKey, input) }
  } catch (err) {
    if (err instanceof WorkspaceRelayAuthError) return { authorized: false }
    throw err
  }
}

function clearHostGenerationWatcher(data: RelayHostTunnelWebSocketData) {
  if (data.generationCheckTimer) clearInterval(data.generationCheckTimer)
  data.generationCheckTimer = undefined
}

/**
 * Re-checks an established host tunnel's serving generation. A conclusive
 * refusal closes 1008 at once; an unreachable lookup is tolerated for a burst
 * of consecutive failures and then closes 1012, which the host treats as a
 * reconnect — its next admission is refused 503 until the lookup answers.
 */
function watchHostGeneration(
  ws: RelayHostTunnelWebSocket,
  options: WorkspaceRelayOptions,
  bunOptions: WorkspaceRelayBunOptions,
) {
  const intervalMs = bunOptions.hostGenerationCheckIntervalMs ?? HOST_GENERATION_CHECK_INTERVAL_MS_DEFAULT
  if (ws.data.generationCheckTimer || !options.resolveHostGeneration || ws.data.generation === undefined || intervalMs <= 0) return
  const graceAttempts = bunOptions.hostGenerationOutageGraceAttempts ?? HOST_GENERATION_OUTAGE_GRACE_ATTEMPTS_DEFAULT
  ws.data.generationCheckTimer = setInterval(() => {
    void checkHostTunnelGeneration(options.resolveHostGeneration, {
      enrollment_id: ws.data.enrollmentId,
      generation: ws.data.generation,
    }).then((decision) => {
      if (decision.ok) {
        ws.data.generationCheckFailures = 0
        return
      }
      if (!decision.retryable) {
        clearHostGenerationWatcher(ws.data)
        closeWebSocket(ws, 1008, decision.reason, 1008)
        return
      }
      ws.data.generationCheckFailures += 1
      if (ws.data.generationCheckFailures < graceAttempts) return
      clearHostGenerationWatcher(ws.data)
      closeWebSocket(ws, 1012, "Host generation check unavailable", 1012)
    })
  }, intervalMs)
  if (typeof ws.data.generationCheckTimer.unref === "function") ws.data.generationCheckTimer.unref()
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

type RelayAccessWatchedWebSocketData = RelayClientWebSocketData | RelayHostTunnelClientWebSocketData

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
  const scheduleExpiry = () => {
    const remaining = ws.data.claims.exp * 1000 - now()
    // Timer delays above the signed 32-bit range can fire immediately. A
    // bounded wake re-reads the clock instead of expiring a still-valid token.
    const delay = Number.isFinite(remaining) ? Math.max(0, Math.min(MAX_TIMER_DELAY_MS, remaining)) : 0
    ws.data.expiryTimer = setTimeout(() => {
      const remaining = ws.data.claims.exp * 1000 - now()
      if (!Number.isFinite(remaining) || remaining <= 0) close("Runtime Access Token expired")
      else scheduleExpiry()
    }, delay)
    if (typeof ws.data.expiryTimer.unref === "function") ws.data.expiryTimer.unref()
  }
  scheduleExpiry()
  const intervalMs = bunOptions.runtimeAccessTokenActiveCheckIntervalMs
    ?? RUNTIME_ACCESS_TOKEN_ACTIVE_CHECK_INTERVAL_MS_DEFAULT
  if (!options.isRuntimeAccessTokenActive || intervalMs <= 0) return
  ws.data.accessCheckTimer = setInterval(() => {
    // `Promise.resolve().then(...)` rather than `Promise.resolve(fn())`: a
    // resolver that throws synchronously must not escape the interval
    // callback as an uncaught timer exception.
    void Promise.resolve()
      .then(() => options.isRuntimeAccessTokenActive!(ws.data.claims))
      .then((active) => {
        if (!active.active) close(active.reason)
      })
      // A resolver outage cannot extend this socket past the local exp timer.
      .catch(() => {})
  }, intervalMs)
  if (typeof ws.data.accessCheckTimer.unref === "function") ws.data.accessCheckTimer.unref()
}

export function createWorkspaceRelayBun(options: WorkspaceRelayOptions, bunOptions: WorkspaceRelayBunOptions = {}) {
  const hostTunnels = new Map<string, RelayHostTunnelWebSocket>()
  const relayClients = new Set<RelayClientWebSocket>()
  const hostTunnelRegistrations = new Map<string, HostTunnelRegistrationTracker>()
  const directHttpLimiter = createDirectHttpLimiter(bunOptions.directHttpConcurrency, bunOptions.directHttpQueueMax)
  // 全 socket 发送路径共用的 buffered-byte 上限：同一阈值、同一
  // relayOverBackpressureLimit 判定，policy（拒绝/关闭/跳过）由各调用点定。
  const socketMaxBufferedBytes = bunOptions.webSocketBufferedAmountMaxBytes ?? WS_BUFFERED_AMOUNT_MAX_BYTES_DEFAULT
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

  // Drain state. The Hono server below is constructed with a closure over
  // this flag so /health and the workspace fast-path see the same value.
  let draining = false
  const drainController: WorkspaceRelayBunDrainController = {
    isDraining: () => draining,
    setDraining: (value) => {
      draining = value
      if (!value) return
      for (const tunnel of new Set(hostTunnels.values())) {
        closeWebSocket(tunnel, 1012, "Workspace relay is draining", 1012)
      }
      for (const client of relayClients) {
        closeWebSocket(client, 1012, "Workspace relay is draining", 1012)
      }
    },
    pendingCount: () => {
      let total = 0
      for (const tunnel of new Set(hostTunnels.values())) {
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

  // Assemble metrics sources here so `/metrics` can surface the bun-only
  // per-relay counters (fragmentation + slow consumer) and the drain
  // controller's pending count without `server.ts` importing back into us.
  // We merge with any explicit `metricsSources` the caller passed (so callers
  // can override individual providers if they want, e.g. in tests).
  const mergedMetricsSources = {
    fragmentation: options.metricsSources?.fragmentation ?? telemetry.getFragmentationStats,
    slowConsumer: options.metricsSources?.slowConsumer ?? telemetry.getSlowConsumerStats,
    drainPending: options.metricsSources?.drainPending ?? drainController.pendingCount,
  }

  // Per-request IP capture used to gate `/metrics` to loopback when no
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

  /**
   * Points every identity in `workspaceIds` at `ws`. An incumbent that loses
   * its last identity is closed as replaced; one that keeps another workspace
   * stays up for it. Returns the first workspace whose incumbent outranks the
   * candidate (`hostTunnelIncumbentOutranks`) with no routing entry touched,
   * so a fenced socket is never displaced by a lower or absent generation
   * even if both sockets were admitted before either opened; `undefined`
   * once every identity points at `ws`.
   */
  function claimTunnelIdentities(ws: RelayHostTunnelWebSocket, workspaceIds: string[]): string | undefined {
    const hostId = ws.data.hostId
    const displaced = new Set<RelayHostTunnelWebSocket>()
    for (const workspaceId of workspaceIds) {
      const previous = hostTunnels.get(tunnelKey(hostId, workspaceId))
      if (!previous || previous === ws) continue
      if (outranks(previous, ws.data.generation)) return workspaceId
      displaced.add(previous)
    }
    for (const workspaceId of workspaceIds) hostTunnels.set(tunnelKey(hostId, workspaceId), ws)
    for (const previous of displaced) {
      if (ownedWorkspaceIds(hostTunnels, previous).length > 0) continue
      cleanupHostTunnelSocket({
        ws: previous,
        hostTunnels,
        hostTunnelStateDebounce,
        options,
        bunOptions,
        originAllowed: relayOriginMatcher,
        disconnectDirectory: false,
        closeChannels: true,
      })
      clearHostGenerationWatcher(previous.data)
      closeWebSocket(previous, 1012, "Host tunnel replaced by a newer connection", 1012)
    }
    return undefined
  }

  /**
   * A registration update is re-admitted the way a connect is, with the
   * socket's own claims as the first incumbent: the update's token must not
   * be outranked by the generation the socket already holds, must pass the
   * control-plane check, and must not be outranked by any incumbent for a
   * workspace it claims. The socket then carries the update's verified claims
   * and, if it became fenced, starts the periodic check. Between the awaits
   * the socket may have lost every identity or closed; the update is then
   * moot and dropped.
   */
  async function applyRegistrationUpdate(hostSocket: RelayHostTunnelWebSocket, workspaceIds: string[], token: string) {
    const hostId = hostSocket.data.hostId
    const authorizationRequest = new Request(
      `http://relay.local/host-tunnels/${encodeURIComponent(hostId)}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    const authorization = await authorizeHostTunnel(options, bunOptions, authorizationRequest, { hostId, workspaceIds })
    if (!authorization.authorized) {
      await refuseHostTunnelSocket(options, hostSocket, {
        code: "host_tunnel_token_invalid",
        close: 1008,
        reason: "Host tunnel registration update denied",
      })
      return
    }
    const claims = authorization.claims
    if (hostTunnelIncumbentOutranks(hostSocket.data.generation, claims.generation)) {
      await refuseHostTunnelSocket(options, hostSocket, {
        code: "host_generation_superseded",
        close: 1008,
        reason: "Host tunnel registration update superseded",
      })
      return
    }
    const generation = await checkHostTunnelGeneration(options.resolveHostGeneration, {
      enrollment_id: claims.enrollment_id,
      generation: claims.generation,
    })
    if (!generation.ok) {
      await refuseHostTunnelSocket(options, hostSocket, {
        code: generation.code,
        close: generation.retryable ? 1012 : 1008,
        reason: generation.retryable ? "Host generation check unavailable" : generation.reason,
      })
      return
    }
    const owned = ownedWorkspaceIds(hostTunnels, hostSocket)
    if (owned.length === 0 || hostSocket.readyState !== WebSocket.OPEN) return
    const released = owned.filter((workspaceId) => !workspaceIds.includes(workspaceId))
    for (const workspaceId of released) hostTunnels.delete(tunnelKey(hostId, workspaceId))
    if (released.length) options.directory?.disconnectHost(hostId, released)
    hostSocket.data.enrollmentId = claims.enrollment_id
    hostSocket.data.generation = claims.generation
    const outranked = claimTunnelIdentities(hostSocket, workspaceIds)
    if (outranked) {
      await refuseHostTunnelSocket(options, hostSocket, {
        code: "host_generation_superseded",
        close: 1008,
        reason: "Host tunnel generation was superseded",
        workspaceId: outranked,
      })
      return
    }
    hostSocket.data.workspaceIds = workspaceIds
    options.directory?.registerHostTunnel({ hostId, workspaceIds })
    watchHostGeneration(hostSocket, options, bunOptions)
  }

  function pruneReconnects(tracker: HostTunnelRegistrationTracker, now: number) {
    const cutoff = now - HOST_TUNNEL_REGISTRATION_RECONNECT_WINDOW_MS
    while (tracker.recent.length && tracker.recent[0] < cutoff) {
      tracker.recent.shift()
    }
  }

  return {
    // A function-valued property rather than a method: `main.ts` hands it
    // straight to `Bun.serve({ fetch: handler.fetch })`, detached from this
    // object, and it closes over the adapter's state rather than reading `this`.
    //
    // `undefined` is Bun's contract for "this request became a WebSocket":
    // `server.upgrade()` has already taken ownership of the socket, so there is
    // no HTTP response left to return.
    fetch: async (request: Request, server: Bun.Server<RelayWebSocketData>): Promise<Response | undefined> => {
      const url = new URL(request.url)
      const workspaceId = workspaceIdFromPath(url.pathname)
      const hostId = hostIdFromTunnelPath(url.pathname)
      // Capture the inbound peer IP so the Hono `/metrics` handler can
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
      // Once draining starts, refuse new tunnel registrations and new
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
        const headers = relayCorsHeaders(request, relayOriginMatcher)
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
        const authorization = await authorizeHostTunnel(options, bunOptions, request, { hostId, workspaceIds })
        if (!authorization.authorized) {
          await denyHostTunnel(options, { code: "host_tunnel_token_invalid", message: "Host tunnel registration denied", status: 403, hostId })
          return new Response("Host tunnel registration denied", { status: 403 })
        }
        const claims = authorization.claims
        const generation = await checkHostTunnelGeneration(options.resolveHostGeneration, {
          enrollment_id: claims.enrollment_id,
          generation: claims.generation,
        })
        if (!generation.ok) {
          return denyHostTunnel(options, {
            code: generation.code,
            message: generation.reason,
            status: generation.retryable ? 503 : 403,
            hostId,
          })
        }
        for (const workspaceId of workspaceIds) {
          const incumbent = hostTunnels.get(tunnelKey(hostId, workspaceId))
          if (incumbent && outranks(incumbent, claims.generation)) {
            return denyHostTunnel(options, {
              code: "host_generation_superseded",
              message: "Host tunnel generation was superseded",
              status: 403,
              hostId,
              workspaceId,
            })
          }
        }
        const tracker = getRegistrationTracker(hostId)
        const now = Date.now()
        pruneReconnects(tracker, now)
        if (tracker.recent.length >= HOST_TUNNEL_REGISTRATION_RECONNECT_CAP) {
          return denyHostTunnel(options, {
            code: "too_many_host_tunnel_reconnects",
            message: "Too many host-tunnel reconnects for this host within the last 60 seconds",
            status: 429,
            hostId,
          })
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
            ...(claims.enrollment_id ? { enrollmentId: claims.enrollment_id } : {}),
            ...(claims.generation !== undefined ? { generation: claims.generation } : {}),
            pending: new Map(),
            activeStreams: 0,
            channels: new Map(),
            missedPongs: 0,
            messageBuffer: "",
            generationCheckFailures: 0,
          },
        })) {
          tracker.recent.push(now)
          return undefined
        }
        return new Response("WebSocket upgrade failed", { status: 400 })
      }
      if (!workspaceId) return app.request(request)
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: relayCorsHeaders(request, relayOriginMatcher),
        })
      }
      if (!websocketRequest(request)) {
        const trace = createWorkspaceRelayTrace()
        const response = await trace.span("relay-total", async () => {
          const relay = await authorizeWorkspaceRelayRequest(options, request, workspaceId, trace)
          if (!relay.ok) return relay.response
          if (isHostTunnelTarget(relay.request.target)) {
            const tunnel = hostTunnel(hostTunnels, relay.request.target.hostId, relay.request.target.workspaceId)
            return tunnel
              ? await trace.span("tunnel-http", async () => await tunnelHttpRequest({
                ws: tunnel,
                request,
                originAllowed: relayOriginMatcher,
                workspaceId: relay.request.target.workspaceId,
                path: `${relay.request.path}${url.search}`,
                relayHostToken: relay.request.relayHostToken,
                slowConsumerHighWaterMarkBytes: bunOptions.slowConsumerHighWaterMarkBytes ?? SLOW_CONSUMER_HIGH_WATER_MARK_BYTES_DEFAULT,
                slowConsumerTimeoutMs: bunOptions.slowConsumerTimeoutMs ?? SLOW_CONSUMER_TIMEOUT_MS_DEFAULT,
                slowConsumerStats,
                requestBodyMaxBytes: bunOptions.tunnelRequestBodyMaxBytes ?? TUNNEL_REQUEST_BODY_MAX_BYTES_DEFAULT,
                responseTimeoutMs: bunOptions.tunnelHttpResponseTimeoutMs ?? TUNNEL_HTTP_RESPONSE_TIMEOUT_MS_DEFAULT,
                pendingRequestMax: bunOptions.tunnelPendingRequestMax ?? TUNNEL_PENDING_HTTP_CAP,
                activeStreamMax: bunOptions.tunnelActiveStreamMax ?? TUNNEL_ACTIVE_STREAM_CAP,
                controlRequestReserve: bunOptions.tunnelControlRequestReserve ?? TUNNEL_CONTROL_REQUEST_RESERVE,
                socketMaxBufferedBytes,
              }))
              : new Response("The machine serving this workspace is offline", { status: 503 })
          }
          return await directHttpRequest({
            request,
            originAllowed: relayOriginMatcher,
            targetUrl: workspaceRelayTargetUrl(
              relay.request.target,
              relay.request.path,
              url.search,
            ).toString(),
            relayHostToken: relay.request.relayHostToken,
            workspaceId: relay.request.target.workspaceId,
            upstreamHeaders: relay.request.target.upstreamHeaders,
            timeoutMs: bunOptions.directHttpTimeoutMs ?? DIRECT_HTTP_TIMEOUT_MS_DEFAULT,
            requestBodyMaxBytes: bunOptions.directHttpRequestBodyMaxBytes ?? DIRECT_HTTP_REQUEST_BODY_MAX_BYTES_DEFAULT,
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
      if (isHostTunnelTarget(relay.request.target)) {
        const tunnel = hostTunnel(hostTunnels, relay.request.target.hostId, relay.request.target.workspaceId)
        if (!tunnel) {
          return new Response("The machine serving this workspace is offline", { status: 503 })
        }
        if (tunnel.data.channels.size >= TUNNEL_CHANNEL_CAP) {
          return jsonError(
            "too_many_channels",
            "Host tunnel has too many active WebSocket channels",
            503,
          )
        }
        // RHT validates only the connection establishment for this WS upgrade.
        // The long-lived host-tunnel-client channel (multiplexed over the host
        // tunnel) survives past RHT TTL by design. See
        // `packages/workspace-relay/src/auth.ts` mintRelayHostToken for the
        // full lifetime semantics.
        if (server.upgrade(request, {
          data: {
            kind: "host-tunnel-client",
            claims: relay.request.claims,
            hostId: relay.request.target.hostId,
            workspaceId: relay.request.target.workspaceId,
            channelId: crypto.randomUUID(),
            path: `${relay.request.path}${url.search}`,
            relayHostToken: relay.request.relayHostToken,
          },
        })) {
          return undefined
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
            // Cloud-vm WS upgrade: cookies pass through.
            { hostTunnel: false, upstreamHeaders: relay.request.target.upstreamHeaders },
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
        return undefined
      }
      return new Response("WebSocket upgrade failed", { status: 400 })
    },
    websocket: {
      maxPayloadLength: WS_MAX_PAYLOAD_LENGTH_BYTES,
      message(ws: RelayWebSocket, message: string | Buffer<ArrayBuffer>) {
        if (isHostTunnelSocket(ws)) {
          const parsed = tunnelMessage(
            ws,
            message,
            fragmentationStats,
          )
          // Frames from a displaced socket keep arriving until the peer
          // handles the close frame; once it owns no identity nothing it says
          // belongs to the live tunnel.
          if (ownedWorkspaceIds(hostTunnels, ws).length === 0) return
          if (parsed?.type === "ping") {
            options.directory?.recordPong(ws.data.hostId, ownedWorkspaceIds(hostTunnels, ws))
            if (!relayOverBackpressureLimit(ws, socketMaxBufferedBytes)) {
              ws.send(JSON.stringify(makeTunnelPong(parsed)))
            }
          }
          if (parsed?.type === "pong") {
            ws.data.missedPongs = 0
            options.directory?.recordPong(ws.data.hostId, ownedWorkspaceIds(hostTunnels, ws))
          }
          if (parsed?.type === "host.registration.update") {
            const hostSocket = ws
            void applyRegistrationUpdate(hostSocket, [...new Set(parsed.workspace_ids)], parsed.token)
              .catch(() => closeWebSocket(hostSocket, 1008, "Host tunnel registration update denied", 1008))
            return
          }
          if (parsed?.type === "error") {
            if (parsed.request_id) {
              const pending = ws.data.pending.get(parsed.request_id)
              if (pending) {
                deletePendingHttpResponse(ws, parsed.request_id)
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
              const response = parsed
              if (isEventStream(response.headers) && !pending.eventStream) {
                const streamMax = bunOptions.tunnelActiveStreamMax ?? TUNNEL_ACTIVE_STREAM_CAP
                if (ws.data.activeStreams >= streamMax) {
                  // 未声明 SSE 的请求在响应开始时才暴露流身份；此时流预算已满，
                  // 只能在这里拒绝。必须抢在 responseStarted 置位之前走
                  // failPendingHttpResponse，它才会把 503 resolve 给客户端；
                  // 同时释放 pending 槽位，并用 paused:false+reason:closed
                  // 让主机中止它那边的上游请求。
                  deletePendingHttpResponse(ws, parsed.request_id)
                  const refused = jsonError(
                    "too_many_streams",
                    "Host tunnel has too many active event streams",
                    503,
                  )
                  failPendingHttpResponse({
                    entry: pending,
                    response: new Response(refused.body, {
                      status: refused.status,
                      headers: pending.corsHeaders(refused.headers),
                    }),
                    error: new Error("Host tunnel has too many active event streams"),
                  })
                  if (!relayOverBackpressureLimit(ws, socketMaxBufferedBytes)) {
                    ws.send(JSON.stringify({
                      type: "http.response.flow",
                      protocol: TUNNEL_PROTOCOL_VERSION,
                      request_id: parsed.request_id,
                      paused: false,
                      reason: "closed",
                    }))
                  }
                  return
                }
                pending.eventStream = true
                ws.data.activeStreams += 1
                clearTimeout(pending.timeout)
              }
              pending.responseStarted = true
              pending.resolve(new Response(pending.stream, {
                status: response.status,
                headers: pending.corsHeaders(headers(response.headers)),
              }))
            }
          }
          if (parsed?.type === "http.response.chunk") {
            const entry = ws.data.pending.get(parsed.request_id)
            if (entry) {
              enqueueChunkWithBackpressure({
                ws: ws,
                requestId: parsed.request_id,
                entry,
                chunk: decoded((parsed).body_base64),
                slowConsumerTimeoutMs: bunOptions.slowConsumerTimeoutMs ?? SLOW_CONSUMER_TIMEOUT_MS_DEFAULT,
                maxBufferedBytes: bunOptions.slowConsumerMaxBufferedBytes ?? SLOW_CONSUMER_MAX_BUFFERED_BYTES_DEFAULT,
                slowConsumerStats,
              })
            }
          }
          if (parsed?.type === "http.response.end") {
            const pending = ws.data.pending.get((parsed).request_id)
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
              deletePendingHttpResponse(ws, (parsed).request_id)
            }
          }
          if (parsed?.type === "ws.frame") {
            const frame = parsed
            const channel = ws.data.channels.get(frame.channel_id)
            if (!channel || channel.readyState !== WebSocket.OPEN) {
              ws.data.channels.delete(frame.channel_id)
              return
            }
            if (relayOverBackpressureLimit(channel, socketMaxBufferedBytes)) {
              ws.data.channels.delete(frame.channel_id)
              closeWebSocket(channel, 1011, "Client WebSocket backpressure limit exceeded")
              return
            }
            channel.send(decodedFrame(frame))
          }
          if (parsed?.type === "ws.close") {
            const close = parsed
            const channel = ws.data.channels.get(close.channel_id)
            if (channel) {
              ws.data.channels.delete(close.channel_id)
              closeWebSocket(channel, close.code, close.reason)
            }
          }
          return
        }
        if (isHostTunnelClientSocket(ws)) {
          const tunnel = hostTunnel(hostTunnels, ws.data.hostId, ws.data.workspaceId)
          if (!tunnel) {
            ws.close(1011, "Host tunnel disconnected")
            return
          }
          if (relayOverBackpressureLimit(tunnel, socketMaxBufferedBytes)) {
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
        if (!isRelayClientSocket(ws)) return
        if (ws.data.upstream?.readyState === WebSocket.OPEN) {
          if (relayOverBackpressureLimit(ws.data.upstream, socketMaxBufferedBytes)) {
            closeWebSocket(ws, 1011, "Upstream WebSocket backpressure limit exceeded")
            return
          }
          ws.data.upstream.send(message)
          return
        }
        const queuedBytes = ws.data.queuedBytes ?? 0
        const frameBytes = preOpenFrameBytes(message)
        if (
          ws.data.queue.length >= (bunOptions.upstreamWebSocketPreOpenQueueMaxFrames ?? UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_FRAMES_DEFAULT)
          || queuedBytes + frameBytes > (bunOptions.upstreamWebSocketPreOpenQueueMaxBytes ?? UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_BYTES_DEFAULT)
        ) {
          closeWebSocket(ws, 1011, "Upstream WebSocket queue limit exceeded")
          return
        }
        ws.data.queuedBytes = queuedBytes + frameBytes
        ws.data.queue.push({ payload: message, queuedAt: performance.now() })
      },
      open(ws: RelayWebSocket) {
        if (isHostTunnelSocket(ws)) {
          const outranked = claimTunnelIdentities(ws, ws.data.workspaceIds)
          if (outranked) {
            void refuseHostTunnelSocket(options, ws, {
              code: "host_generation_superseded",
              close: 1008,
              reason: "Host tunnel generation was superseded",
              workspaceId: outranked,
            })
            return
          }
          options.directory?.registerHostTunnel({
            hostId: ws.data.hostId,
            workspaceIds: ws.data.workspaceIds,
          })
          ws.data.heartbeat = setInterval(() => {
            const hostWs = ws
            if (hostWs.data.missedPongs > (bunOptions.hostTunnelMaxMissedPongs ?? HOST_TUNNEL_MAX_MISSED_PONGS_DEFAULT)) {
              closeWebSocket(ws, 1001, "Host tunnel heartbeat timed out", 1001)
              return
            }
            sendTunnelPing(hostWs, socketMaxBufferedBytes)
          }, bunOptions.hostTunnelPingIntervalMs ?? 15_000)
          watchHostGeneration(ws, options, bunOptions)
          scheduleHostTunnelStateChange(hostTunnelStateDebounce, options, {
            hostId: ws.data.hostId,
            workspaceIds: ws.data.workspaceIds,
            path: `/host-tunnels/${ws.data.hostId}`,
            state: "connected",
            debounceMs: bunOptions.hostTunnelStateDebounceMs ?? HOST_TUNNEL_STATE_DEBOUNCE_MS_DEFAULT,
          })
          return
        }
        if (isHostTunnelClientSocket(ws)) {
          watchClientAccess(ws, options, bunOptions)
          const tunnel = hostTunnel(hostTunnels, ws.data.hostId, ws.data.workspaceId)
          if (!tunnel) {
            ws.close(1011, "Host tunnel disconnected")
            return
          }
          tunnel.data.channels.set(ws.data.channelId, ws)
          if (tunnel.readyState !== WebSocket.OPEN) {
            closeWebSocket(ws, 1011, "Host tunnel disconnected")
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
              // Host tunnel WS upgrade: strip Cookie. Headers are empty
              // here today; the flag keeps the rule uniform.
              { hostTunnel: true },
            )),
          }))
          return
        }
        if (!isRelayClientSocket(ws)) return
        relayClients.add(ws)
        watchClientAccess(ws, options, bunOptions)
        const data = ws.data
        const UpstreamWebSocket = resolveUpstreamWebSocket(bunOptions.upstreamWebSocket)
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
            sendRelayWebSocketTrace(ws, socketMaxBufferedBytes)
          }
          const queued = data.queue.splice(0)
          data.queuedBytes = 0
          for (const item of queued) {
            // 上游 socket 一打开就打满（病态 upstream 或队列刷进慢链路）时，
            // 关闭客户端而不是继续堆——有序字节流丢帧比断开更糟。
            if (relayOverBackpressureLimit(upstream, socketMaxBufferedBytes)) {
              closeWebSocket(ws, 1011, "Upstream WebSocket backpressure limit exceeded")
              return
            }
            upstream.send(item.payload)
          }
        }
        upstream.onmessage = (event) => {
          const payload = relayWebSocketPayload(event.data)
          if (payload === undefined) return
          if (relayOverBackpressureLimit(ws, socketMaxBufferedBytes)) {
            closeWebSocket(ws, 1011, "Client WebSocket backpressure limit exceeded")
            return
          }
          ws.send(payload)
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
      close(ws: RelayWebSocket, code: number, reason: string) {
        if (isHostTunnelSocket(ws)) {
          clearHostGenerationWatcher(ws.data)
          cleanupHostTunnelSocket({
            ws: ws,
            hostTunnels,
            hostTunnelStateDebounce,
            options,
            bunOptions,
            originAllowed: relayOriginMatcher,
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
        if (isHostTunnelClientSocket(ws)) {
          clearClientAccessWatchers(ws.data)
          const tunnel = hostTunnel(hostTunnels, ws.data.hostId, ws.data.workspaceId)
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
        if (!isRelayClientSocket(ws)) return
        relayClients.delete(ws)
        clearClientAccessWatchers(ws.data)
        if (ws.data.upstreamOpenTimer) clearTimeout(ws.data.upstreamOpenTimer)
        if (ws.data.upstream) closeWebSocket(ws.data.upstream, code, reason, 1000)
      },
    } satisfies Bun.WebSocketHandler<RelayWebSocketData>,
    drain: drainController,
    telemetry,
  }
}
