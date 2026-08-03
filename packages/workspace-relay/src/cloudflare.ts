import { WorkspaceRelayAuthError, verifyHostTunnelToken } from "./auth"
import { bearerToken, errorBody } from "./http"
import {
  makeTunnelPong,
  TUNNEL_PROTOCOL_VERSION,
  validateTunnelMessage,
  type TunnelError,
  type TunnelHttpResponseChunk,
  type TunnelHttpResponseEnd,
  type TunnelHttpResponseFlow,
  type TunnelHttpResponseStart,
  type TunnelHostRegistrationUpdate,
  type TunnelPing,
  type TunnelWsClose,
  type TunnelWsFrame,
} from "@claxedo/workspace-relay-protocol"
import {
  authorizeWorkspaceRelayRequest,
  workspaceRelayForwardHeaders,
  workspaceRelayForwardRequestInit,
  workspaceRelayTargetUrl,
  type AuthorizedWorkspaceRelayRequest,
  type RuntimeAccessTokenActiveResult,
  type WorkspaceRelayOptions,
} from "./server"
import { createWorkspaceRelayDirectory } from "./directory"
import { createOriginMatcher, DEFAULT_RELAY_APP_ORIGINS, parseAllowedOrigins } from "./cors-origins"

export type WorkspaceRelayDurableObjectId = unknown

export type WorkspaceRelayDurableObjectStub = {
  fetch: (request: Request) => Promise<Response>
}

export type WorkspaceRelayDurableObjectGetOptions = {
  // Cloudflare Durable Object placement hint, applied when the DO is first
  // created. Keeps the relay's stateful end near users so each browser↔host
  // round-trip doesn't cross continents.
  locationHint?: string
}

export type WorkspaceRelayDurableObjectNamespace = {
  idFromName: (name: string) => WorkspaceRelayDurableObjectId
  get: (
    id: WorkspaceRelayDurableObjectId,
    options?: WorkspaceRelayDurableObjectGetOptions,
  ) => WorkspaceRelayDurableObjectStub
}

// Where new relay DOs are placed when nothing better is known. APAC
// (Singapore/Mumbai) is the closest Cloudflare hint for the India/South-Asia
// user base and is deliberate, not an accident — see wrangler.toml. It is the
// deployment-wide FLOOR; `relayLocationHint()` prefers a per-workspace signal.
// Override via the CLAXEDO_RELAY_LOCATION_HINT env var.
export const DEFAULT_RELAY_LOCATION_HINT = "apac"

/**
 * The complete set of Cloudflare Durable Object location hints.
 *
 * Cloudflare rejects an unknown hint, and a rejected `get()` fails the request —
 * so an unrecognised region must fall back rather than be passed through. This
 * list is the validator for that.
 */
export const RELAY_LOCATION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"] as const

export type RelayLocationHint = typeof RELAY_LOCATION_HINTS[number]

const relayLocationHintSet = new Set<string>(RELAY_LOCATION_HINTS)

/**
 * Maps a workspace home region to a Cloudflare location hint.
 *
 * The FIRST five keys are the product's canonical region vocabulary —
 * `DEFAULT_CLAXEDO_REGIONS` in `claxedo-server/src/platform/runtime/region/index.ts:1`, mirrored
 * as `KNOWN_HOME_REGIONS` in `convex/workspaces.ts` and in the sqlite workspace
 * authority. Those are the values a real workspace's `homeRegion` can hold, and
 * this table must stay in step with that list.
 *
 * The rest are common cloud-provider spellings, accepted so a region that
 * arrives from a provider config maps to something sensible instead of silently
 * falling back to the deployment default. Anything unrecognised returns
 * undefined and the caller falls back — never a guess, because placement is
 * PERMANENT for the workspace.
 */
const RELAY_REGION_TO_LOCATION_HINT: Record<string, RelayLocationHint> = {
  // Canonical Claxedo regions.
  "apac-south": "apac",
  "apac-east": "apac",
  "eu-west": "weur",
  "us-east": "enam",
  "us-west": "wnam",
  // Provider spellings.
  "us-central": "wnam",
  "eu-central": "weur",
  "eu-east": "eeur",
  "ap-south": "apac",
  "ap-southeast": "apac",
  "ap-northeast": "apac",
  "sa-east": "sam",
  "af-south": "afr",
  "me-central": "me",
  "oceania": "oc",
  "au-southeast": "oc",
}

/**
 * Maps a Cloudflare edge country code (`request.cf.country`) to the nearest
 * location hint.
 *
 * Deliberately coarse: this is only consulted when a workspace carries no
 * region, and its job is to beat a deployment-wide constant, not to be a
 * geo-routing table. Continent-level accuracy is enough — the cost of being
 * one region off is latency, while the cost of an invalid hint is a failed
 * request.
 */
function locationHintForCountry(country: string): RelayLocationHint | undefined {
  const code = country.toUpperCase()
  if (["US", "CA", "MX"].includes(code)) return code === "US" || code === "CA" ? "enam" : "wnam"
  if (["BR", "AR", "CL", "CO", "PE", "UY", "PY", "BO", "EC", "VE"].includes(code)) return "sam"
  if (["GB", "IE", "FR", "ES", "PT", "NL", "BE", "DE", "CH", "AT", "IT", "DK", "NO", "SE", "FI", "IS", "LU"].includes(code)) return "weur"
  if (["PL", "CZ", "SK", "HU", "RO", "BG", "GR", "UA", "RS", "HR", "SI", "EE", "LV", "LT", "TR", "RU"].includes(code)) return "eeur"
  if (["IN", "PK", "BD", "LK", "NP", "SG", "MY", "TH", "VN", "PH", "ID", "CN", "HK", "TW", "JP", "KR"].includes(code)) return "apac"
  if (["AU", "NZ", "FJ", "PG"].includes(code)) return "oc"
  if (["ZA", "NG", "KE", "GH", "ET", "TZ", "UG", "EG", "MA", "DZ", "TN"].includes(code)) {
    return ["EG", "MA", "DZ", "TN"].includes(code) ? "me" : "afr"
  }
  if (["AE", "SA", "IL", "QA", "KW", "BH", "OM", "JO", "LB", "IQ", "IR"].includes(code)) return "me"
  return undefined
}

/** A workspace region carried on the request, if the caller supplied one. */
export const RELAY_REGION_HEADER = "x-claxedo-workspace-region"

/**
 * Chooses the location hint for a workspace's Durable Object.
 *
 * This decision is PERMANENT: a DO's location is fixed at first creation and
 * never migrates, so a workspace created with the wrong hint pays the extra
 * ocean crossing on every frame for its entire life. That is why an
 * unrecognised value falls back to the configured default instead of being
 * passed through or guessed at.
 *
 * Precedence, most authoritative first:
 *  1. the workspace's own region (header or `?region=`), which is what the
 *     control plane knows and the only signal tied to the WORKSPACE rather than
 *     to whoever happens to be connecting first;
 *  2. the requesting user's Cloudflare edge country, a decent proxy when the
 *     workspace has no region yet;
 *  3. the deployment-wide configured hint (`CLAXEDO_RELAY_LOCATION_HINT`), then
 *     `DEFAULT_RELAY_LOCATION_HINT`.
 */
export function relayLocationHint(input: {
  configured?: string
  region?: string
  country?: string
}) {
  const configured = clean(input.configured) ?? DEFAULT_RELAY_LOCATION_HINT
  const region = clean(input.region)
  if (region) {
    // A caller may pass a literal CF hint (e.g. "weur") or a workspace region
    // name (e.g. "eu-west"); accept either.
    const direct = relayLocationHintSet.has(region.toLowerCase()) ? region.toLowerCase() as RelayLocationHint : undefined
    const mapped = direct ?? RELAY_REGION_TO_LOCATION_HINT[region.toLowerCase()]
    if (mapped) return mapped
  }
  const country = clean(input.country)
  if (country) {
    const mapped = locationHintForCountry(country)
    if (mapped) return mapped
  }
  return configured
}

/** The workspace region a request declares, if any. */
export function relayRequestRegion(request: Request) {
  const url = new URL(request.url)
  return clean(request.headers.get(RELAY_REGION_HEADER))
    ?? clean(url.searchParams.get("region"))
    ?? clean(url.searchParams.get("homeRegion"))
}

/** The Cloudflare edge country for the request, when running on Cloudflare. */
export function relayRequestCountry(request: Request) {
  const cf = (request as Request & { cf?: { country?: unknown } }).cf
  return typeof cf?.country === "string" ? cf.country : undefined
}

export type WorkspaceRelayDurableObjectEnv = Record<string, unknown>

export type WorkspaceRelayDurableObjectGatewayOptions = {
  bindingName?: string
  namespace?: WorkspaceRelayDurableObjectNamespace
}

export type WorkspaceRelayDurableObjectSocketEvent = {
  data?: unknown
  code?: number
  reason?: string
}

export type WorkspaceRelayDurableObjectSocket = {
  accept?: () => void
  readyState?: number
  binaryType?: string
  send?: (message: string | ArrayBuffer | Uint8Array) => void
  addEventListener?: (type: "open" | "message" | "close" | "error", listener: (event?: WorkspaceRelayDurableObjectSocketEvent) => void) => void
  close?: (code?: number, reason?: string) => void
  serializeAttachment?: (attachment: WorkspaceRelaySocketAttachment) => void
  deserializeAttachment?: () => WorkspaceRelaySocketAttachment | undefined
}

export type WorkspaceRelayDurableObjectSocketPair = {
  client: WorkspaceRelayDurableObjectSocket
  server: WorkspaceRelayDurableObjectSocket
}

export type WorkspaceRelayDurableObjectConnectWebSocket = (
  url: string,
  init: { headers: Record<string, string> },
) => WorkspaceRelayDurableObjectSocket | Promise<WorkspaceRelayDurableObjectSocket>

export type WorkspaceRelayDurableObjectRoomOptions = WorkspaceRelayOptions & {
  createWebSocketPair?: () => WorkspaceRelayDurableObjectSocketPair
  connectWebSocket?: WorkspaceRelayDurableObjectConnectWebSocket
  hibernation?: WorkspaceRelayDurableObjectHibernation
  upstreamWebSocketPreOpenQueueMaxFrames?: number
  upstreamWebSocketPreOpenQueueMaxBytes?: number
  tunnelPendingHttpCap?: number
  tunnelStartedStreamCap?: number
  tunnelChannelCap?: number
  tunnelRequestBodyMaxBytes?: number
  tunnelResponseBodyMaxBytes?: number
  slowConsumerHighWaterMarkBytes?: number
  slowConsumerTimeoutMs?: number
  runtimeAccessTokenActiveCheckIntervalMs?: number
  workspaceTargetActiveCheckIntervalMs?: number
  /**
   * Consecutive resolver-unreachable answers tolerated on an established
   * connection before closing it. Applies ONLY to "could not reach the
   * resolver"; an explicit revoked/inactive answer still closes immediately.
   */
  resolverOutageGraceAttempts?: number
  /**
   * Interval for the alarm-based revocation re-check that covers hibernated
   * connections, where `setInterval` watchers cannot survive. 0 disables it.
   */
  hibernatedRevocationCheckIntervalMs?: number
  /**
   * Durable Object alarm surface, supplied by the Worker (`state.storage`) so the
   * room can schedule the hibernation-safe revocation re-check. Absent on the
   * non-hibernating path and in tests that do not exercise it.
   */
  alarms?: WorkspaceRelayDurableObjectAlarms
  traceSampleRate?: number
  // Operator-configured secret for the x-claxedo-relay-trace force header.
  // Unset (default) means the force header is ignored entirely; otherwise the
  // header value must equal this secret. Never honor a bare client-supplied
  // flag — forced tracing controls log volume and timing-header emission.
  traceForceHeaderSecret?: string
  traceLog?: (event: WorkspaceRelayTraceLogEvent) => void
  now?: () => number
}

export type WorkspaceRelayTraceLogEvent = {
  event: "workspace_relay_request"
  traceId: string
  workspaceId?: string
  routeKind: string
  method: string
  path: string
  status: number
  totalMs: number
  phases: Record<string, number>
}

export type WorkspaceRelayDurableObjectHibernation = {
  acceptWebSocket: (socket: WorkspaceRelayDurableObjectSocket) => void
  getWebSockets: () => WorkspaceRelayDurableObjectSocket[]
}

/**
 * The Durable Object alarm surface, narrowed to what the room needs.
 *
 * Alarms are the only periodic mechanism that survives hibernation — a
 * `setInterval` dies when the DO is evicted, which is exactly why the token and
 * target watchers are not installed on the hibernating path. Backed by
 * `state.storage` in the Worker.
 */
export type WorkspaceRelayDurableObjectAlarms = {
  getAlarm: () => Promise<number | null> | number | null
  setAlarm: (scheduledTime: number) => Promise<void> | void
  deleteAlarm?: () => Promise<void> | void
}

export type WorkspaceRelaySocketAttachment =
  | {
      kind: "host-tunnel"
      hostId: string
      workspaceIds: string[]
      connectedAt: number
    }
  | {
      kind: "user-hosted-client"
      channelId: string
      claims: RuntimeAccessAttachmentClaims
      target: WorkspaceRelayTargetAttachment
      path: string
      connectedAt: number
    }

type RuntimeAccessAttachmentClaims = AuthorizedWorkspaceRelayRequest["claims"]
type WorkspaceRelayTargetAttachment = AuthorizedWorkspaceRelayRequest["target"]

export type WorkspaceRelayDurableObjectDrainController = {
  isDraining(): boolean
  setDraining(value: boolean): void
  pendingCount(): number
  waitForDrain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }>
}

const TUNNEL_PENDING_HTTP_CAP_DEFAULT = 32
// Cap for STARTED streaming responses (SSE etc). A silent stream whose client
// vanished cannot be detected (no write fails, cancel() may never fire), so on
// overflow the OLDEST started stream is evicted — live clients just reconnect.
const TUNNEL_STARTED_STREAM_CAP_DEFAULT = 16
const TUNNEL_CHANNEL_CAP_DEFAULT = 16
const TUNNEL_REQUEST_BODY_MAX_BYTES_DEFAULT = 16 * 1024 * 1024
const TUNNEL_RESPONSE_BODY_MAX_BYTES_DEFAULT = 16 * 1024 * 1024
const SLOW_CONSUMER_HIGH_WATER_MARK_BYTES_DEFAULT = 8 * 1024 * 1024
const SLOW_CONSUMER_TIMEOUT_MS_DEFAULT = 30_000
// Frames a client may send while the upstream WebSocket is still connecting.
//
// Overflow CLOSES the socket rather than dropping frames, deliberately: this
// queue carries an ordered byte stream (terminal input, PTY data), so shedding
// entries would hand the far end a corrupted stream with no error anywhere —
// strictly worse than a clean, diagnosable close. Sized for the interactive
// case, where a human never has 64 unacknowledged frames in flight during the
// few milliseconds before upstream connects.
const UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_FRAMES_DEFAULT = 64
// Bytes are the resource this queue actually consumes, and 64 tiny frames is
// not a memory problem. Admitting on EITHER bound lets a legitimate burst of
// small frames through while still capping real memory, so the close above is
// reserved for traffic genuinely too large to hold.
const UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_BYTES_DEFAULT = 8 * 1024 * 1024
const RUNTIME_ACCESS_TOKEN_ACTIVE_CHECK_INTERVAL_MS_DEFAULT = 30_000
const WORKSPACE_TARGET_ACTIVE_CHECK_INTERVAL_MS_DEFAULT = 30_000
// Consecutive resolver-UNREACHABLE answers tolerated before an established
// connection is closed. 3 × the 30 s watcher interval survives ~90 s of resolver
// downtime; previously a single 5xx closed every live session in the fleet at
// once, with only the resolver client's 10 s cache as accidental grace.
// Deliberately small: this is grace for an outage, not a way to outlive a
// revocation. Worst-case revocation latency is unchanged — still bounded by the
// token's own `exp`, which is checked locally and never graced.
const RESOLVER_OUTAGE_GRACE_ATTEMPTS_DEFAULT = 3
// Interval for the hibernation-safe revocation re-check. DO alarms survive
// hibernation; `setInterval` does not, which is why the watchers below are not
// installed on the hibernating path at all.
const HIBERNATED_REVOCATION_ALARM_INTERVAL_MS_DEFAULT = 30_000
const TRACE_ID_HEADER = "x-claxedo-trace-id"
const TRACE_FORCE_HEADER = "x-claxedo-relay-trace"

type HostTunnelSocket = {
  hostId: string
  workspaceIds: string[]
  connectedAt: number
  socket: WorkspaceRelayDurableObjectSocket
  pending: Map<string, PendingTunnelHttpResponse>
  channels: Map<string, UserHostedClientSocket>
}

type ClientSocket = {
  request: AuthorizedWorkspaceRelayRequest
  socket: WorkspaceRelayDurableObjectSocket
}

type UserHostedClientSocket = ClientSocket & {
  channelId: string
}

type PendingTunnelHttpResponse = {
  chunks: Uint8Array[]
  bytes: number
  headers?: Headers
  status?: number
  // Monotonic order in which the response STARTED streaming — used to evict
  // the oldest (most likely orphaned) stream when the started-stream cap is
  // exceeded. Cloudflare does not reliably invoke ReadableStream.cancel()
  // when the downstream client disappears, so silent SSE streams can leak.
  startedSeq?: number
  stream?: {
    controller: ReadableStreamDefaultController<Uint8Array>
    closed: boolean
    bytesQueued: number
    flowPaused?: boolean
    slowConsumerTimeout?: ReturnType<typeof setTimeout>
  }
  timeout: ReturnType<typeof setTimeout>
  resolve: (response: Response) => void
  reject: (error: Error) => void
}

type RelayTrace = {
  id: string
  sampled: boolean
  startedAt: number
  routeKind: string
  phases: Array<{ name: string; ms: number }>
}

function clean(input: string | undefined | null) {
  const value = input?.trim()
  return value ? value : undefined
}

function clampRate(input: number | undefined) {
  if (input === undefined || !Number.isFinite(input)) return 0
  if (input <= 0) return 0
  if (input >= 1) return 1
  return input
}

function traceRequest(request: Request, routeKind: string, options: WorkspaceRelayDurableObjectRoomOptions): RelayTrace {
  const id = clean(request.headers.get(TRACE_ID_HEADER)) ?? crypto.randomUUID()
  const forceSecret = clean(options.traceForceHeaderSecret)
  const forced = !!forceSecret && request.headers.get(TRACE_FORCE_HEADER) === forceSecret
  const rate = clampRate(options.traceSampleRate)
  return {
    id,
    sampled: forced || (rate > 0 && (options.random ?? Math.random)() < rate),
    startedAt: performance.now(),
    routeKind,
    phases: [],
  }
}

async function traceSpan<T>(trace: RelayTrace | undefined, name: string, fn: () => Promise<T>) {
  const startedAt = performance.now()
  try {
    return await fn()
  } finally {
    trace?.phases.push({ name, ms: performance.now() - startedAt })
  }
}

function tracedRequest(request: Request, trace: RelayTrace) {
  const headers = new Headers(request.headers)
  headers.set(TRACE_ID_HEADER, trace.id)
  // Set-or-strip, never passthrough: the sampled marker must reflect this
  // relay's own sampling decision, not a client-supplied header.
  if (trace.sampled) headers.set("x-claxedo-trace-sampled", "1")
  else headers.delete("x-claxedo-trace-sampled")
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: request.redirect,
    duplex: "half",
  } as RequestInit)
}

function roundedMs(value: number) {
  return Math.round(value * 100) / 100
}

function serverTiming(trace: RelayTrace) {
  return trace.phases
    .map((phase) => `${phase.name};dur=${roundedMs(phase.ms)}`)
    .join(", ")
}

function withTraceHeaders(response: Response, trace: RelayTrace) {
  const headers = new Headers(response.headers)
  headers.set(TRACE_ID_HEADER, trace.id)
  // Phase timings expose internal routing/upstream latency breakdowns, so they
  // are only emitted for sampled traces — never on every production response.
  const timing = trace.sampled ? serverTiming(trace) : ""
  if (timing) {
    const existing = headers.get("server-timing")
    headers.set("server-timing", existing ? `${existing}, ${timing}` : timing)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function logTrace(
  options: WorkspaceRelayDurableObjectRoomOptions,
  request: Request,
  workspaceId: string | undefined,
  trace: RelayTrace,
  response: Response,
) {
  if (!trace.sampled) return
  const url = new URL(request.url)
  const totalMs = performance.now() - trace.startedAt
  const event: WorkspaceRelayTraceLogEvent = {
    event: "workspace_relay_request",
    traceId: trace.id,
    workspaceId,
    routeKind: trace.routeKind,
    method: request.method,
    path: url.pathname,
    status: response.status,
    totalMs: roundedMs(totalMs),
    phases: Object.fromEntries(trace.phases.map((phase) => [phase.name, roundedMs(phase.ms)])),
  }
  if (options.traceLog) {
    options.traceLog(event)
    return
  }
  console.log(JSON.stringify(event))
}

function workspaceIdFromRelayPath(pathname: string) {
  return /^\/workspaces\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
}

function hostIdFromTunnelPath(pathname: string) {
  return /^\/host-tunnels\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
}

function websocketRequest(request: Request) {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket"
}

// Additive experiment instrumentation: when the client sends
// `x-claxedo-relay-ws-trace: 1`, the cloud WS admit path emits a single
// `relay.trace` frame on the client socket carrying wsUpstreamOpenMs /
// queuedFrames / maxQueuedDelayMs. This mirrors the Bun relay's trace
// (bun.ts) so a benchmark harness sees the same vocabulary on both adapters.
// Without the header there is zero behavior change.
function relayWebSocketTraceEnabled(request: Request) {
  return request.headers.get("x-claxedo-relay-ws-trace") === "1"
}

function workspaceIdsFromSearch(url: URL) {
  return [...new Set([
    ...url.searchParams.getAll("workspaceId"),
    ...url.searchParams.getAll("workspace_id"),
  ].map(clean).filter((item): item is string => !!item))]
}

function randomToken() {
  return crypto.randomUUID()
}

function headerRecord(headers: Headers) {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function headersFromRecord(input: Record<string, string>) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(input)) headers.set(key, value)
  return headers
}

/**
 * Chunk size for the `String.fromCharCode.apply` spread below. Every argument
 * becomes a stack slot in the engine's call frame, so a chunk larger than the
 * argument-count limit throws `RangeError: Maximum call stack size exceeded`
 * on a large frame — 0x8000 is the conventional safe ceiling and stays well
 * under every engine's limit (workerd/V8, JSC/Bun, SpiderMonkey).
 */
const BASE64_CHUNK_BYTES = 0x8000

/**
 * Exported for `relay-base64.test.ts`, which proves byte-equality against a
 * per-byte reference across the chunk boundaries. This sits on the path every
 * frame pays, so its equivalence is worth asserting directly rather than
 * inferring from a round-trip.
 */
export function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + BASE64_CHUNK_BYTES) as unknown as number[],
    )
  }
  return btoa(binary)
}

function base64ToBytes(input: string) {
  return Uint8Array.from(atob(input), (char) => char.charCodeAt(0))
}

/** Byte size of a frame awaiting the upstream socket, for the pre-open bound. */
function preOpenFrameBytes(input: string | ArrayBuffer | Uint8Array) {
  if (typeof input === "string") return new TextEncoder().encode(input).byteLength
  return input.byteLength
}

type BlobLike = { arrayBuffer: () => Promise<ArrayBuffer> }

/**
 * Duck-typed instead of `instanceof Blob`, for two reasons: a Blob handed over
 * from another realm fails `instanceof`, and the check must not throw in a
 * runtime that has no global `Blob` at all (the Bun adapter shares this file's
 * type surface). Reached only after the concrete `ArrayBuffer` / view branches,
 * so nothing that is already bytes can land here.
 */
function blobLike(input: unknown) {
  if (!input || typeof input !== "object") return undefined
  return typeof (input as BlobLike).arrayBuffer === "function" ? input as BlobLike : undefined
}

/**
 * Copies a `DataView`/typed-array frame into its own `Uint8Array` rather than
 * aliasing the runtime's buffer. The pre-open queue RETAINS what it is handed,
 * so a view over a buffer the runtime may recycle would corrupt a queued frame.
 * This matches what `socketPayload` always did for views.
 */
function viewBytes(input: ArrayBufferView) {
  return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength))
}

/**
 * Socket `data` → a tunnel `ws.frame` payload.
 *
 * Returns a promise ONLY for `Blob` data, so the production path at the pinned
 * `compatibility_date` (string/ArrayBuffer) stays synchronous and pays no extra
 * microtask per frame. `Blob` is what Cloudflare makes the server-side default
 * at `compatibility_date >= 2026-03-17` (see the comment in wrangler.toml):
 * before this, every binary frame returned `undefined` here and was dropped
 * with no throw and no log.
 */
function socketFrame(input: unknown) {
  if (typeof input === "string") {
    return {
      binary: false,
      data_base64: bytesToBase64(new TextEncoder().encode(input)),
    }
  }
  if (input instanceof ArrayBuffer) {
    return {
      binary: true,
      data_base64: bytesToBase64(new Uint8Array(input)),
    }
  }
  if (input instanceof Uint8Array) {
    return {
      binary: true,
      data_base64: bytesToBase64(input),
    }
  }
  // DataView and the non-Uint8Array typed arrays. `socketPayload` has always
  // handled these and `socketFrame` did not, so a DataView frame dropped here
  // independently of the compatibility date.
  if (ArrayBuffer.isView(input)) {
    return {
      binary: true,
      data_base64: bytesToBase64(viewBytes(input)),
    }
  }
  const blob = blobLike(input)
  if (!blob) return undefined
  return blob.arrayBuffer().then((buffer) => ({
    binary: true,
    data_base64: bytesToBase64(new Uint8Array(buffer)),
  }))
}

/**
 * Socket `data` → something forwardable straight to another socket's `send`.
 * Same `Blob` contract as `socketFrame`: synchronous for everything else.
 */
function socketPayload(input: unknown) {
  if (typeof input === "string") return input
  if (input instanceof ArrayBuffer) return input
  if (input instanceof Uint8Array) return input
  if (ArrayBuffer.isView(input)) return viewBytes(input)
  const blob = blobLike(input)
  if (!blob) return undefined
  return blob.arrayBuffer()
}

/**
 * Wraps a per-socket frame handler so frames are delivered in ARRIVAL order
 * even when some of them resolve asynchronously.
 *
 * `socketPayload` is synchronous for string/ArrayBuffer/view data and only
 * returns a promise for `Blob`. Awaiting that promise inline inside the
 * listener would let the next frame — resolved synchronously — overtake it,
 * silently reordering an ordered byte stream: a terminal would render its
 * output scrambled. So the first pending Blob installs a tail promise and every
 * later frame chains onto it until the chain drains, at which point the
 * synchronous fast path resumes.
 */
function orderedFrameDelivery(deliver: (payload: string | ArrayBuffer | Uint8Array) => void) {
  let tail: Promise<void> | undefined
  return (data: unknown) => {
    const payload = socketPayload(data)
    if (payload === undefined) return
    if (tail === undefined && !(payload instanceof Promise)) {
      deliver(payload)
      return
    }
    const queued = (tail ?? Promise.resolve())
      .then(async () => deliver(await payload))
      // A failed Blob read drops that one frame; it must not poison the chain
      // and stall every frame behind it.
      .catch(() => {})
    tail = queued
    void queued.then(() => {
      if (tail === queued) tail = undefined
    })
  }
}

/**
 * Runs the two frame decoders over one runtime-delivered `event.data` and
 * reports what they produced.
 *
 * Exists so `relay-workerd-binary.test.ts` can assert the decoders against what
 * REAL workerd delivers. The rest of the suite drives hand-rolled socket
 * doubles, which by construction hand us whatever we chose to hand ourselves —
 * so they cannot catch the hazard that binary `event.data` becomes a `Blob` at
 * `compatibility_date >= 2026-03-17`. Test-support surface, not a relay path.
 */
export async function relayFrameDiagnostics(data: unknown) {
  const frame = await socketFrame(data)
  const payload = await socketPayload(data)
  return {
    // `undefined` here is exactly the silent drop: every caller treats it as
    // "nothing to forward" and returns without a throw or a log.
    frameDropped: frame === undefined,
    payloadDropped: payload === undefined,
    ...(frame ? { binary: frame.binary, dataBase64: frame.data_base64 } : {}),
    payloadBase64: payload === undefined
      ? undefined
      : typeof payload === "string"
        ? bytesToBase64(new TextEncoder().encode(payload))
        : bytesToBase64(payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload),
  }
}

function tunnelFrame(input: TunnelWsFrame) {
  const bytes = base64ToBytes(input.data_base64)
  return input.binary ? bytes : new TextDecoder().decode(bytes)
}

function concatBytes(chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function responseMustNotHaveBody(status: number) {
  return status === 204 || status === 205 || status === 304
}

async function readRequestBodyCapped(request: Request, maxBytes: number) {
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return "too_large" as const
    }
    chunks.push(value)
  }
  return concatBytes(chunks)
}

function safeCloseCode(code: number | undefined, fallback = 1011) {
  if (code === undefined) return fallback
  if (code >= 1000 && code <= 4999 && ![1004, 1005, 1006].includes(code)) return code
  return fallback
}

export function workspaceRelayDurableObjectRoomName(workspaceId: string) {
  return `workspace:${workspaceId}`
}

export function workspaceRelayDurableObjectWorkspaceId(request: Request) {
  const url = new URL(request.url)
  const workspaceId = clean(workspaceIdFromRelayPath(url.pathname))
  if (workspaceId) return decodeURIComponent(workspaceId)
  if (!hostIdFromTunnelPath(url.pathname)) return
  return clean(url.searchParams.get("workspaceId")) ?? clean(url.searchParams.get("workspace_id"))
}

function namespaceFromEnv(
  env: WorkspaceRelayDurableObjectEnv,
  options: WorkspaceRelayDurableObjectGatewayOptions,
) {
  if (options.namespace) return options.namespace
  const binding = env[options.bindingName ?? "WORKSPACE_RELAY_ROOM"]
  return binding && typeof binding === "object" ? binding as WorkspaceRelayDurableObjectNamespace : undefined
}

function json(code: string, message: string, status: 400 | 401 | 403 | 404 | 413 | 426 | 503) {
  return Response.json(errorBody(code, message), { status })
}

// Deployment-configured ADDITIVE app origins (CLAXEDO_APP_ORIGINS,
// comma-separated; exact `https://app.example.com` or `https://*.example.com`
// suffix entries). Set once at Worker boot so staged app hosts (e.g.
// Cloudflare Pages) can call the relay without editing shared code per
// deployment.
let configuredAppOriginAllowed: (origin: string) => boolean = () => false

export function setWorkspaceRelayAppOrigins(raw: string | undefined) {
  configuredAppOriginAllowed = raw?.trim()
    ? createOriginMatcher(parseAllowedOrigins(raw) ?? [])
    : () => false
}

// Deployment-configured REPLACEMENT origin allowlist
// (CLAXEDO_RELAY_ALLOWED_ORIGINS). When set, it fully replaces the built-in
// default list (Claxedo/OpenCode app origins plus localhost dev hosts) — a
// self-hosted relay is not forced to keep the product domains in its CORS
// policy. Additive CLAXEDO_APP_ORIGINS entries still apply on top.
const defaultOriginAllowed = createOriginMatcher(DEFAULT_RELAY_APP_ORIGINS)
let baseOriginAllowed = defaultOriginAllowed

export function setWorkspaceRelayAllowedOrigins(raw: string | undefined) {
  const patterns = parseAllowedOrigins(raw)
  baseOriginAllowed = patterns ? createOriginMatcher(patterns) : defaultOriginAllowed
}

function allowedCorsOrigin(origin: string | null) {
  if (!origin) return
  if (baseOriginAllowed(origin)) return origin
  if (configuredAppOriginAllowed(origin)) return origin
}

function corsHeaders(request: Request) {
  const origin = allowedCorsOrigin(request.headers.get("origin"))
  if (!origin) return
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Accept, Authorization, Content-Type, Last-Event-ID, X-Fetch-Bypass-Throttle, X-Daytona-Skip-Preview-Warning, X-Workspace-Id, X-OpenCode-Directory, X-Claxedo-Runner, X-Claxedo-Model, X-Claxedo-Draft-Id, X-Claxedo-Binary",
    "access-control-max-age": "86400",
    vary: "Origin",
  }
}

function corsPreflight(request: Request) {
  const headers = corsHeaders(request)
  return new Response(null, { status: headers ? 204 : 403, ...(headers ? { headers } : {}) })
}

function withCors(request: Request, response: Response) {
  const headers = corsHeaders(request)
  if (!headers) return response
  // A WebSocket upgrade (101) CANNOT be reconstructed: in Workers
  // `new Response(..., { status: 101 })` throws and the attached `webSocket`
  // would be dropped anyway. Browsers always send `Origin` on WS upgrades, so
  // wrapping here turned EVERY browser PTY/WS connection into a 500 while
  // non-browser clients (no Origin header) worked — pass upgrades through
  // untouched (WebSockets are not subject to CORS).
  if (response.status === 101 || (response as { webSocket?: unknown }).webSocket) return response
  const next = new Headers(response.headers)
  for (const [key, value] of Object.entries(headers)) next.set(key, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: next,
  })
}

function defaultWebSocketPair(): WorkspaceRelayDurableObjectSocketPair {
  const pair = new (globalThis as unknown as {
    WebSocketPair?: new () => { 0: WorkspaceRelayDurableObjectSocket; 1: WorkspaceRelayDurableObjectSocket }
  }).WebSocketPair!()
  return {
    client: pair[0],
    server: pair[1],
  }
}

function selectedSubprotocol(request: Request) {
  const offered = request.headers.get("sec-websocket-protocol")
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  if (!offered?.length) return
  return offered.find((item) => item.startsWith("claxedo-rat.")) ?? offered[0]
}

function upgradeResponse(socket: WorkspaceRelayDurableObjectSocket, request: Request) {
  const protocol = selectedSubprotocol(request)
  return new Response(null, {
    status: 101,
    ...(protocol ? { headers: { "sec-websocket-protocol": protocol } } : {}),
    webSocket: socket,
  } as ResponseInit & { webSocket: WorkspaceRelayDurableObjectSocket })
}

async function defaultConnectWebSocket(url: string, init: { headers: Record<string, string> }) {
  const res = await fetch(url, {
    headers: {
      ...init.headers,
      Upgrade: "websocket",
    },
  })
  const socket = (res as Response & { webSocket?: WorkspaceRelayDurableObjectSocket }).webSocket
  if (!socket) throw new Error("Upstream WebSocket upgrade was not accepted")
  socket.accept?.()
  return socket
}

export function createWorkspaceRelayDurableObjectGateway(
  options: WorkspaceRelayDurableObjectGatewayOptions = {},
) {
  return {
    async fetch(request: Request, env: WorkspaceRelayDurableObjectEnv = {}) {
      const gatewayStartedAt = performance.now()
      const gatewayTraceId = clean(request.headers.get(TRACE_ID_HEADER)) ?? crypto.randomUUID()
      const url = new URL(request.url)
      if (request.method === "OPTIONS" && (url.pathname.startsWith("/workspaces/") || url.pathname.startsWith("/host-tunnels/"))) {
        return corsPreflight(request)
      }
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "workspace-relay", mode: "cloudflare-durable-object" })
      }
      // Per-workspace where possible, deployment-wide only as a floor. The DO's
      // location is fixed at FIRST CREATION and never migrates, so this value is
      // permanent for the workspace — see `relayLocationHint`.
      const requestRegion = relayRequestRegion(request)
      const requestCountry = relayRequestCountry(request)
      const locationHint = relayLocationHint({
        ...(typeof env.CLAXEDO_RELAY_LOCATION_HINT === "string" ? { configured: env.CLAXEDO_RELAY_LOCATION_HINT } : {}),
        ...(requestRegion ? { region: requestRegion } : {}),
        ...(requestCountry ? { country: requestCountry } : {}),
      })
      const namespace = namespaceFromEnv(env, options)
      if (!namespace) {
        return json(
          "relay_durable_object_unconfigured",
          "Workspace Relay Durable Object binding is not configured",
          503,
        )
      }
      if (url.pathname.startsWith("/host-tunnels/") && workspaceIdsFromSearch(url).length > 1) {
        return json(
          "host_tunnel_single_workspace_required",
          "Durable Object relay rooms are per-workspace; host tunnels must register exactly one workspaceId per connection",
          400,
        )
      }
      const workspaceId = workspaceRelayDurableObjectWorkspaceId(request)
      if (!workspaceId) {
        return json(
          "relay_workspace_required",
          "Workspace Relay requests must include a workspace id",
          url.pathname.startsWith("/workspaces/") || url.pathname.startsWith("/host-tunnels/") ? 400 : 404,
        )
      }
      const routeFinishedAt = performance.now()
      const response = await namespace.get(namespace.idFromName(workspaceRelayDurableObjectRoomName(workspaceId)), {
        locationHint,
      }).fetch(tracedRequest(request, {
          id: gatewayTraceId,
          sampled: request.headers.get("x-claxedo-trace-sampled") === "1",
          startedAt: gatewayStartedAt,
          routeKind: "gateway",
          phases: [],
        }))
      const fetchFinishedAt = performance.now()
      if (response.status === 101 || (response as { webSocket?: unknown }).webSocket) {
        return url.pathname.startsWith("/workspaces/") ? withCors(request, response) : response
      }
      const headers = new Headers(response.headers)
      headers.set(TRACE_ID_HEADER, headers.get(TRACE_ID_HEADER) ?? gatewayTraceId)
      headers.set("x-claxedo-relay-location-hint", locationHint)
      const gatewayResponseStartedAt = performance.now()
      const tracedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
      const gatewayFinishedAt = performance.now()
      // Only append gateway phase timings when the room decided this trace was
      // sampled (signalled by the room having emitted its own server-timing).
      // The sampling decision lives in the room, cannot be forced by client
      // headers, and keeps timing internals off ordinary production responses.
      const roomTiming = tracedResponse.headers.get("server-timing")
      if (roomTiming) {
        const gatewayTiming = [
          `relay-gateway-route;dur=${roundedMs(routeFinishedAt - gatewayStartedAt)}`,
          `relay-gateway-do-fetch;dur=${roundedMs(fetchFinishedAt - routeFinishedAt)}`,
          `relay-gateway-response;dur=${roundedMs(gatewayFinishedAt - gatewayResponseStartedAt)}`,
          `relay-gateway;dur=${roundedMs(gatewayFinishedAt - gatewayStartedAt)}`,
        ].join(", ")
        tracedResponse.headers.set("server-timing", `${roomTiming}, ${gatewayTiming}`)
      }
      return url.pathname.startsWith("/workspaces/") ? withCors(request, tracedResponse) : tracedResponse
    },
  }
}

export function createWorkspaceRelayDurableObjectRoom(options: WorkspaceRelayDurableObjectRoomOptions) {
  const directory = options.directory ?? createWorkspaceRelayDirectory({ sweepIntervalMs: 0 })
  const relayOptions = { ...options, directory }
  const hostTunnels = new Map<string, HostTunnelSocket>()
  const clients = new Set<ClientSocket>()
  const pairFactory = options.createWebSocketPair ?? defaultWebSocketPair
  const connectWebSocket = options.connectWebSocket ?? defaultConnectWebSocket
  const hibernation = options.hibernation
  let draining = false
  let hibernatedSocketsRebuilt = false

  const socketAttachment = (socket: WorkspaceRelayDurableObjectSocket) => {
    try {
      return socket.deserializeAttachment?.()
    } catch {
      return undefined
    }
  }

  const acceptSocket = (attachment?: WorkspaceRelaySocketAttachment) => {
    const pair = pairFactory()
    if (hibernation && attachment) {
      hibernation.acceptWebSocket(pair.server)
      pair.server.serializeAttachment?.(attachment)
    } else {
      pair.server.accept?.()
    }
    return pair
  }

  const closeSocket = (socket: WorkspaceRelayDurableObjectSocket, code: number, reason: string) => {
    try {
      socket.close?.(code, reason)
    } catch {
      // The socket boundary is best-effort cleanup.
    }
  }

  const sendSocket = (socket: WorkspaceRelayDurableObjectSocket, message: string | ArrayBuffer | Uint8Array) => {
    try {
      socket.send?.(message)
      return true
    } catch {
      return false
    }
  }

  const cleanupTunnelResources = (tunnel: HostTunnelSocket, reason: string) => {
    for (const pending of tunnel.pending.values()) {
      clearTimeout(pending.timeout)
      if (pending.stream?.slowConsumerTimeout) clearTimeout(pending.stream.slowConsumerTimeout)
      const error = new Error(reason)
      if (pending.stream && !pending.stream.closed) {
        pending.stream.closed = true
        pending.stream.controller.error(error)
      } else {
        pending.reject(error)
      }
    }
    tunnel.pending.clear()
    for (const client of tunnel.channels.values()) {
      clients.delete(client)
      closeSocket(client.socket, 1011, reason)
    }
    tunnel.channels.clear()
  }

  /**
   * Rebuilds in-memory presence from the sockets the hibernation runtime still
   * holds, after this isolate woke with empty maps.
   *
   * On the discarded-pending question (W6.2): a rebuilt tunnel starts with an
   * empty `pending` map, and the review predicted an in-flight HTTP request's
   * promise would therefore NEVER settle. Measured, it does settle. The rebuild
   * runs at most once per isolate (`hibernatedSocketsRebuilt`) and always at the
   * TOP of the first entry point, so it cannot run after a pending entry exists;
   * anything in flight was created by this isolate AFTER the rebuild and keeps
   * its own `forwardTimeoutMs` timer.
   *
   * That is an ordering invariant, not a structural guarantee, and nothing was
   * pinning it. Rather than add a durable pending index — which buys nothing,
   * since an isolate cannot settle a promise made in a dead isolate anyway — the
   * rebuild now errors out whatever it would otherwise discard. If a future
   * refactor lets a rebuild happen with live pending work, those callers get a
   * fast 503 instead of a hang.
   */
  const rebuildHibernatedSockets = () => {
    if (!hibernation) return
    hibernatedSocketsRebuilt = true
    for (const tunnel of hostTunnels.values()) {
      if (tunnel.pending.size === 0) continue
      cleanupTunnelResources(tunnel, "Workspace relay restarted while the request was in flight")
    }
    hostTunnels.clear()
    clients.clear()
    const clientRows: Array<{ socket: WorkspaceRelayDurableObjectSocket; attachment: Extract<WorkspaceRelaySocketAttachment, { kind: "user-hosted-client" }> }> = []
    for (const socket of hibernation.getWebSockets()) {
      const attachment = socketAttachment(socket)
      if (!attachment) continue
      if (attachment.kind === "host-tunnel") {
        hostTunnels.set(attachment.hostId, {
          hostId: attachment.hostId,
          workspaceIds: attachment.workspaceIds,
          connectedAt: attachment.connectedAt,
          socket,
          pending: new Map(),
          channels: new Map(),
        })
        directory.registerHostTunnel({
          hostId: attachment.hostId,
          workspaceIds: attachment.workspaceIds,
        })
        continue
      }
      clientRows.push({ socket, attachment })
    }
    for (const row of clientRows) {
      const tunnel = hostTunnels.get(row.attachment.target.hostId)
      if (!tunnel) {
        closeSocket(row.socket, 1011, "User-hosted tunnel unavailable")
        continue
      }
      const client: UserHostedClientSocket = {
        request: {
          claims: row.attachment.claims,
          target: row.attachment.target,
          path: row.attachment.path,
          relayHostToken: "",
        },
        socket: row.socket,
        channelId: row.attachment.channelId,
      }
      clients.add(client)
      tunnel.channels.set(row.attachment.channelId, client)
    }
  }

  const ensureHibernatedSocketsRebuilt = () => {
    if (!hibernation || hibernatedSocketsRebuilt) return
    rebuildHibernatedSockets()
  }

  // Protocol-level ping/pong frames do not enter `webSocketMessage`. Before
  // applying the process-local directory TTL, rebuild presence from the
  // authoritative sockets the hibernation runtime still considers connected.
  const refreshHostPresenceFromSockets = () => {
    if (!hibernation) return
    for (const socket of hibernation.getWebSockets()) {
      const attachment = socketAttachment(socket)
      if (attachment?.kind !== "host-tunnel") continue
      if (!directory.recordPong(attachment.hostId)) {
        directory.registerHostTunnel({ hostId: attachment.hostId, workspaceIds: attachment.workspaceIds })
      }
    }
  }

  const resolverGraceAttempts = options.resolverOutageGraceAttempts ?? RESOLVER_OUTAGE_GRACE_ATTEMPTS_DEFAULT

  /**
   * Distinguishes "the resolver says no" from "I could not reach the resolver".
   *
   * This distinction is the whole basis of the grace policy, and it is NOT the
   * same as catch-vs-then: a 5xx from the revocation resolver never throws. Both
   * `worker.ts` and `main.ts` convert a non-ok HTTP response into an ordinary
   * `{ active: false, code: "relay_revocation_resolver_unavailable" }`. So a
   * resolver outage arrives through the SUCCESS path wearing a denial's clothes,
   * and treating every `active: false` as authoritative is what made a resolver
   * blip indistinguishable from a revocation — one 5xx closed every live
   * session at once.
   *
   * Fail-closed is preserved for real denials; only the unreachable code and a
   * thrown transport error get grace.
   */
  const resolverUnreachable = (code: string | undefined) =>
    code === "relay_revocation_resolver_unavailable"

  const watchRuntimeAccessToken = (
    client: ClientSocket,
    onInactive: (reason: string) => void,
  ) => {
    const intervalMs = options.runtimeAccessTokenActiveCheckIntervalMs ?? RUNTIME_ACCESS_TOKEN_ACTIVE_CHECK_INTERVAL_MS_DEFAULT
    if (intervalMs <= 0) return
    const now = options.now ?? Date.now
    // Reset on any conclusive answer, so grace covers a BURST of failures rather
    // than a slow drip that would eventually add up to a kill.
    let consecutiveUnreachable = 0
    const timer = setInterval(() => {
      // Expiry is decided locally from the token's own `exp` and never gets
      // grace: an expired token is expired whether or not the resolver answers.
      if (client.request.claims.exp * 1000 <= now()) {
        clearInterval(timer)
        onInactive("Runtime Access Token expired")
        return
      }
      if (!options.isRuntimeAccessTokenActive) return
      const tolerate = (reason: string) => {
        consecutiveUnreachable += 1
        if (consecutiveUnreachable < resolverGraceAttempts) return
        clearInterval(timer)
        onInactive(reason)
      }
      void Promise.resolve(options.isRuntimeAccessTokenActive(client.request.claims))
        .then((active) => {
          if (active.active) {
            consecutiveUnreachable = 0
            return
          }
          if (resolverUnreachable(active.code)) {
            tolerate(`Runtime Access Token active check unavailable: ${active.reason}`)
            return
          }
          // A real revocation. Close immediately — fail-closed is the point.
          consecutiveUnreachable = 0
          clearInterval(timer)
          onInactive(active.reason)
        })
        .catch(() => tolerate("Runtime Access Token active check failed"))
    }, intervalMs)
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref?: () => void }).unref!()
    }
    return timer
  }

  const watchUserHostedTarget = (
    client: UserHostedClientSocket,
    onInactive: (reason: string) => void,
  ) => {
    const intervalMs = options.workspaceTargetActiveCheckIntervalMs ?? WORKSPACE_TARGET_ACTIVE_CHECK_INTERVAL_MS_DEFAULT
    if (intervalMs <= 0) return
    const target = client.request.target
    let consecutiveUnreachable = 0
    const timer = setInterval(() => {
      void Promise.resolve(options.resolveTarget(client.request.claims))
        .then((activeTarget) => {
          if (
            activeTarget?.access === "user-hosted"
            && activeTarget.workspaceId === target.workspaceId
            && activeTarget.hostId === target.hostId
            && directory.activeHost({ hostId: target.hostId, workspaceId: target.workspaceId })
          ) {
            consecutiveUnreachable = 0
            return
          }
          // A lookup that RESOLVES to a different or absent target is a
          // conclusive answer — the workspace really did move or stop. No grace.
          consecutiveUnreachable = 0
          clearInterval(timer)
          onInactive("User-hosted workspace is offline")
        })
        // Unlike revocation, the target resolver signals "unreachable" by
        // THROWING (`worker.ts` throws on a non-ok response) while 404/409 return
        // undefined as a real answer. So this catch IS the unreachable case.
        .catch(() => {
          consecutiveUnreachable += 1
          if (consecutiveUnreachable < resolverGraceAttempts) return
          clearInterval(timer)
          onInactive("Workspace relay target active check failed")
        })
    }, intervalMs)
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref?: () => void }).unref!()
    }
    return timer
  }

  const clearSlowConsumerTimer = (pending: PendingTunnelHttpResponse) => {
    if (!pending.stream?.slowConsumerTimeout) return
    clearTimeout(pending.stream.slowConsumerTimeout)
    pending.stream.slowConsumerTimeout = undefined
  }

  const sendHttpResponseFlow = (
    tunnel: HostTunnelSocket,
    requestId: string,
    pending: PendingTunnelHttpResponse,
    paused: boolean,
    reason: TunnelHttpResponseFlow["reason"],
  ) => {
    if (!pending.stream || pending.stream.flowPaused === paused) return
    if (!paused && pending.stream.flowPaused === undefined) {
      pending.stream.flowPaused = false
      return
    }
    pending.stream.flowPaused = paused
    tunnel.socket.send?.(JSON.stringify({
      type: "http.response.flow",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestId,
      paused,
      reason,
    } satisfies TunnelHttpResponseFlow))
  }

  const failSlowConsumer = (
    tunnel: HostTunnelSocket,
    requestId: string,
    pending: PendingTunnelHttpResponse,
  ) => {
    sendHttpResponseFlow(tunnel, requestId, pending, false, "closed")
    tunnel.pending.delete(requestId)
    clearTimeout(pending.timeout)
    clearSlowConsumerTimer(pending)
    pending.chunks.length = 0
    if (!pending.stream || pending.stream.closed) return
    pending.stream.bytesQueued = 0
    pending.stream.closed = true
    pending.stream.controller.error(new Error("slow_consumer_timeout: downstream consumer did not drain in time"))
  }

  const armSlowConsumerTimer = (
    tunnel: HostTunnelSocket,
    requestId: string,
    pending: PendingTunnelHttpResponse,
  ) => {
    if (pending.stream?.slowConsumerTimeout) return
    pending.stream!.slowConsumerTimeout = setTimeout(
      () => failSlowConsumer(tunnel, requestId, pending),
      options.slowConsumerTimeoutMs ?? SLOW_CONSUMER_TIMEOUT_MS_DEFAULT,
    )
  }

  const drainPendingStreamChunks = (
    tunnel: HostTunnelSocket,
    requestId: string,
    pending: PendingTunnelHttpResponse,
  ) => {
    if (!pending.stream || pending.stream.closed) return
    while (pending.chunks.length > 0) {
      const desired = pending.stream.controller.desiredSize
      if (desired !== null && desired <= 0) {
        sendHttpResponseFlow(tunnel, requestId, pending, true, "slow_consumer")
        armSlowConsumerTimer(tunnel, requestId, pending)
        return
      }
      const chunk = pending.chunks.shift()!
      pending.stream.bytesQueued -= chunk.byteLength
      try {
        pending.stream.controller.enqueue(chunk)
      } catch {
        pending.chunks.length = 0
        pending.stream.bytesQueued = 0
        return
      }
    }
    clearSlowConsumerTimer(pending)
    sendHttpResponseFlow(tunnel, requestId, pending, false, "drained")
  }

  const enqueuePendingStreamChunk = (
    tunnel: HostTunnelSocket,
    requestId: string,
    pending: PendingTunnelHttpResponse,
    chunk: Uint8Array,
  ) => {
    if (!pending.stream || pending.stream.closed) {
      pending.chunks.push(chunk)
      return
    }
    const desired = pending.stream.controller.desiredSize
    if ((desired !== null && desired <= 0) || pending.chunks.length > 0) {
      pending.chunks.push(chunk)
      pending.stream.bytesQueued += chunk.byteLength
      sendHttpResponseFlow(tunnel, requestId, pending, true, "slow_consumer")
      armSlowConsumerTimer(tunnel, requestId, pending)
      return
    }
    try {
      pending.stream.controller.enqueue(chunk)
    } catch {
      pending.stream.closed = true
    }
  }

  let startedSeqCounter = 0

  const evictOldestStartedStream = (tunnel: HostTunnelSocket, keepRequestId: string) => {
    const cap = options.tunnelStartedStreamCap ?? TUNNEL_STARTED_STREAM_CAP_DEFAULT
    while (true) {
      const started = [...tunnel.pending.entries()]
        .filter(([id, entry]) => entry.startedSeq !== undefined && id !== keepRequestId)
        .sort((a, b) => (a[1].startedSeq ?? 0) - (b[1].startedSeq ?? 0))
      if (started.length + 1 <= cap) return
      const [oldestId, oldest] = started[0]!
      failPendingTunnelResponse(tunnel, oldestId, oldest, new Error("stream_evicted: tunnel started-stream cap reached"))
    }
  }

  const resolvePendingTunnelStream = (
    tunnel: HostTunnelSocket,
    requestId: string,
    pending: PendingTunnelHttpResponse,
    status: number,
    headers: Headers,
  ) => {
    if (pending.stream) return
    pending.startedSeq = ++startedSeqCounter
    evictOldestStartedStream(tunnel, requestId)
    clearTimeout(pending.timeout)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        pending.stream = { controller, closed: false, bytesQueued: 0 }
        drainPendingStreamChunks(tunnel, requestId, pending)
      },
      pull() {
        drainPendingStreamChunks(tunnel, requestId, pending)
      },
      cancel() {
        // The downstream consumer (browser) went away. Free the pending slot
        // and tell the host to abort the upstream request. Without this, a
        // long-lived (SSE) response whose client disconnected leaks its
        // pending slot until the tunnel cap starves ALL future requests
        // (`too_many_pending_requests`).
        tunnel.pending.delete(requestId)
        clearTimeout(pending.timeout)
        clearSlowConsumerTimer(pending)
        pending.chunks.length = 0
        if (pending.stream) {
          pending.stream.closed = true
          pending.stream.bytesQueued = 0
        }
        tunnel.socket.send?.(JSON.stringify({
          type: "http.response.flow",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: requestId,
          paused: false,
          reason: "closed",
        } satisfies TunnelHttpResponseFlow))
      },
    }, new ByteLengthQueuingStrategy({
      highWaterMark: options.slowConsumerHighWaterMarkBytes ?? SLOW_CONSUMER_HIGH_WATER_MARK_BYTES_DEFAULT,
    }))
    pending.resolve(new Response(stream, {
      status,
      headers,
    }))
  }

  const failPendingTunnelResponse = (
    tunnel: HostTunnelSocket,
    requestId: string,
    pending: PendingTunnelHttpResponse,
    error: Error,
  ) => {
    tunnel.pending.delete(requestId)
    clearTimeout(pending.timeout)
    clearSlowConsumerTimer(pending)
    sendHttpResponseFlow(tunnel, requestId, pending, false, "closed")
    if (pending.stream && !pending.stream.closed) {
      pending.stream.closed = true
      pending.stream.controller.error(error)
      return
    }
    pending.reject(error)
  }

  const pendingCount = () => [...hostTunnels.values()].reduce((sum, tunnel) => sum + tunnel.pending.size, 0)

  const closeActiveSocketsForDrain = () => {
    for (const tunnel of hostTunnels.values()) closeSocket(tunnel.socket, 1012, "Workspace relay is draining")
    for (const client of clients) closeSocket(client.socket, 1012, "Workspace relay is draining")
  }

  const drainController: WorkspaceRelayDurableObjectDrainController = {
    isDraining: () => draining,
    setDraining(value) {
      draining = value
      if (draining) closeActiveSocketsForDrain()
    },
    pendingCount,
    async waitForDrain(timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const remaining = pendingCount()
        if (remaining === 0) return { drained: true, remaining: 0 }
        if (Date.now() >= deadline) return { drained: false, remaining }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }

  const runtimeAccessTokenActive = async (client: ClientSocket) => {
    const now = options.now ?? Date.now
    if (client.request.claims.exp * 1000 <= now()) {
      return { active: false as const, reason: "Runtime Access Token expired" }
    }
    if (!options.isRuntimeAccessTokenActive) return { active: true as const }
    const active = await options.isRuntimeAccessTokenActive(client.request.claims)
    return active.active ? { active: true as const } : { active: false as const, reason: active.reason }
  }

  const userHostedTargetActive = async (client: UserHostedClientSocket) => {
    const target = client.request.target
    const activeTarget = await options.resolveTarget(client.request.claims)
    return !!(
      activeTarget?.access === "user-hosted"
      && activeTarget.workspaceId === target.workspaceId
      && activeTarget.hostId === target.hostId
      && directory.activeHost({ hostId: target.hostId, workspaceId: target.workspaceId })
    )
  }

  /**
   * Tears a user-hosted channel down from the relay's side: forget it, close the
   * browser socket, and tell the host to stop producing for it.
   *
   * That last part is what a bare `closeSocket` misses. A channel the relay has
   * given up on but the host still believes in keeps costing the host work and
   * the tunnel bandwidth, for frames with nowhere to go.
   */
  const dropUserHostedChannel = (
    tunnel: HostTunnelSocket,
    channelId: string,
    client: UserHostedClientSocket,
    code: number,
    reason: string,
  ) => {
    tunnel.channels.delete(channelId)
    clients.delete(client)
    closeSocket(client.socket, code, reason)
    sendSocket(tunnel.socket, JSON.stringify({
      type: "ws.close",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: channelId,
      code,
      reason,
    }))
  }

  /**
   * A frame handler threw. That is a relay-side bug, not a client error, so it
   * gets a log line AND a close. The previous behavior — an unhandled rejection
   * inside the DO's message promise — produced neither, leaving the client
   * connected to a relay that would never answer it again.
   */
  const reportFrameHandlerFailure = (
    socket: WorkspaceRelayDurableObjectSocket,
    err: unknown,
  ) => {
    const reason = err instanceof Error ? err.message : String(err)
    // console.error rather than the audit hook: `audit` is an
    // authorization-decision channel with a fixed action vocabulary, and this is
    // an internal fault. Workers observability captures console output.
    console.error(`[workspace-relay] frame handler failed: ${reason}`)
    closeSocket(socket, 1011, "Workspace relay failed to process a frame")
  }

  const hibernatedRevocationIntervalMs = () =>
    options.hibernatedRevocationCheckIntervalMs ?? HIBERNATED_REVOCATION_ALARM_INTERVAL_MS_DEFAULT

  /**
   * Schedules the next hibernation-safe revocation sweep (W6b.2).
   *
   * MULTIPLEXING: a Durable Object has exactly one alarm slot, shared with
   * anything else that might want it. So this only ever moves the alarm EARLIER
   * — if something has already scheduled a sooner wake, that wake stands and the
   * sweep runs then. It never clears an existing alarm.
   */
  const scheduleHibernatedRevocationCheck = async () => {
    const intervalMs = hibernatedRevocationIntervalMs()
    if (!hibernation || !options.alarms || intervalMs <= 0) return
    // Nothing to watch: do not hold the DO awake on a timer.
    if (clients.size === 0) return
    const now = options.now ?? Date.now
    const at = now() + intervalMs
    try {
      const existing = await options.alarms.getAlarm()
      // Defer to an alarm that is already pending SOONER than ours: that wake
      // will run the sweep anyway, and overwriting it would push out whatever
      // else wanted the slot. Re-arming from inside the handler is safe because
      // workerd clears the alarm before invoking it — verified on real workerd,
      // `getAlarm()` inside `alarm()` returns null — so there is nothing to
      // defer to and the sweep always re-arms itself.
      if (typeof existing === "number" && existing > 0 && existing <= at) return
      await options.alarms.setAlarm(at)
    } catch {
      // Best-effort: the per-frame cached check still enforces revocation for any
      // connection actually sending traffic.
    }
  }

  /**
   * Re-checks revocation for every live client connection and closes the revoked
   * ones. Driven by the DO alarm, so it works under hibernation.
   *
   * Why this exists: on the hibernating path `admitUserHostedClient` installs NO
   * watchers (`hibernation ? undefined : watch…`) because `setInterval` does not
   * survive eviction. That left the per-frame cached check as the only
   * enforcement — adequate for a busy connection, useless for an IDLE one, which
   * could hold a revoked token open indefinitely. Alarms survive hibernation, so
   * this closes that gap.
   *
   * The per-frame check is deliberately RETAINED: it is already a cache hit, and
   * it bounds revocation latency for active traffic far tighter than this
   * interval.
   */
  const runHibernatedRevocationCheck = async () => {
    ensureHibernatedSocketsRebuilt()
    const now = options.now ?? Date.now

    /** Close and forget one client, telling its host tunnel if it has one. */
    const revoke = (client: ClientSocket, reason: string) => {
      const channelId = (client as UserHostedClientSocket).channelId
      for (const tunnel of hostTunnels.values()) {
        if (!channelId || tunnel.channels.get(channelId) !== client) continue
        dropUserHostedChannel(tunnel, channelId, client as UserHostedClientSocket, 1008, reason)
        return
      }
      // A cloud client (no channel) — just close and forget.
      closeSocket(client.socket, 1008, reason)
      clients.delete(client)
    }

    for (const client of [...clients]) {
      // Local and resolver-free, so it is checked first and never graced.
      if (client.request.claims.exp * 1000 <= now()) {
        revoke(client, "Runtime Access Token expired")
        continue
      }
      if (!options.isRuntimeAccessTokenActive) continue
      let active: RuntimeAccessTokenActiveResult
      try {
        active = await options.isRuntimeAccessTokenActive(client.request.claims)
      } catch {
        // Unreachable resolver: do not kill an idle connection over an outage.
        // The next alarm re-checks, and `exp` still bounds the worst case.
        continue
      }
      if (active.active || resolverUnreachable(active.code)) continue
      revoke(client, active.reason)
    }
    // Re-arm while any connection remains, otherwise enforcement stops after one
    // sweep. Safe because workerd clears the alarm before calling the handler.
    await scheduleHibernatedRevocationCheck()
  }

  const activeUserHostedClient = (channelId: string, socket: WorkspaceRelayDurableObjectSocket) => {
    for (const tunnel of hostTunnels.values()) {
      const client = tunnel.channels.get(channelId)
      if (client?.socket === socket) return { tunnel, client }
    }
  }

  const handleUserHostedClientMessage = async (
    channelId: string,
    socket: WorkspaceRelayDurableObjectSocket,
    data: unknown,
  ) => {
    const active = activeUserHostedClient(channelId, socket)
    if (!active) return
    const token = await runtimeAccessTokenActive(active.client)
    if (!token.active) {
      closeSocket(socket, 1008, token.reason)
      return
    }
    if (!await userHostedTargetActive(active.client)) {
      closeSocket(socket, 1011, "User-hosted workspace is offline")
      return
    }
    // `socketFrame` is synchronous except for Blob data, and this handler is
    // already async and already awaited its auth checks above, so awaiting here
    // costs nothing extra on the fast path. Order is preserved because the
    // hibernation `webSocketMessage` entry point awaits this call per frame.
    const frame = await socketFrame(data)
    if (!frame) return
    const sent = sendSocket(active.tunnel.socket, JSON.stringify({
      type: "ws.frame",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: channelId,
      ...frame,
    }))
    if (!sent) closeSocket(socket, 1011, "User-hosted tunnel unavailable")
  }

  const handleTunnelMessage = async (hostId: string, event: { data: unknown }) => {
    const row = parseTunnelMessageData(event.data)
    if (!row.ok) return
    const parsed = validateTunnelMessage(row.value)
    const tunnel = hostTunnels.get(hostId)
    if (!parsed.ok || !tunnel) return
    // ANY inbound frame that actually reached this handler proves the tunnel is
    // alive, so refresh directory presence here rather than only on ping. On the
    // hibernation path protocol-level ping/pong is handled below this message
    // API, so real request/response/ws traffic and the on-wake rebuild are what
    // refresh an active host's process-local presence.
    directory.recordPong(tunnel.hostId)
    if (parsed.message.type === "ping") {
      tunnel.socket.send?.(JSON.stringify(makeTunnelPong(parsed.message as TunnelPing)))
      return
    }
    if (parsed.message.type === "host.registration.update") {
      const update = parsed.message as TunnelHostRegistrationUpdate
      const workspaceIds = [...new Set(update.workspace_ids)]
      try {
        await verifyHostTunnelToken(update.token, options.runtimeAccessKey, { hostId, workspaceIds })
      } catch {
        closeSocket(tunnel.socket, 1008, "Host tunnel registration update denied")
        return
      }
      if (hostTunnels.get(hostId) !== tunnel) return
      tunnel.workspaceIds = workspaceIds
      tunnel.socket.serializeAttachment?.({
        kind: "host-tunnel",
        hostId,
        workspaceIds,
        connectedAt: tunnel.connectedAt,
      })
      directory.registerHostTunnel({ hostId, workspaceIds })
      return
    }
    if (parsed.message.type === "error" && parsed.message.request_id) {
      const pending = tunnel.pending.get(parsed.message.request_id)
      if (!pending) return
      failPendingTunnelResponse(tunnel, parsed.message.request_id, pending, new Error(parsed.message.message))
      return
    }
    if (parsed.message.type === "http.response.start") {
      const message = parsed.message as TunnelHttpResponseStart
      const pending = tunnel.pending.get(message.request_id)
      if (!pending) return
      pending.status = message.status
      pending.headers = headersFromRecord(message.headers)
      if (responseMustNotHaveBody(pending.status)) return
      resolvePendingTunnelStream(tunnel, message.request_id, pending, pending.status, pending.headers)
      return
    }
    if (parsed.message.type === "http.response.chunk") {
      const message = parsed.message as TunnelHttpResponseChunk
      const pending = tunnel.pending.get(message.request_id)
      if (!pending) return
      const chunk = base64ToBytes(message.body_base64)
      if (pending.bytes + chunk.byteLength > (options.tunnelResponseBodyMaxBytes ?? TUNNEL_RESPONSE_BODY_MAX_BYTES_DEFAULT)) {
        failPendingTunnelResponse(tunnel, message.request_id, pending, new Error("User-hosted response body exceeds the relay limit"))
        return
      }
      pending.bytes += chunk.byteLength
      enqueuePendingStreamChunk(tunnel, message.request_id, pending, chunk)
      return
    }
    if (parsed.message.type === "http.response.end") {
      const message = parsed.message as TunnelHttpResponseEnd
      const pending = tunnel.pending.get(message.request_id)
      if (!pending) return
      tunnel.pending.delete(message.request_id)
      clearTimeout(pending.timeout)
      clearSlowConsumerTimer(pending)
      sendHttpResponseFlow(tunnel, message.request_id, pending, false, "closed")
      if (pending.stream) {
        if (!pending.stream.closed) {
          drainPendingStreamChunks(tunnel, message.request_id, pending)
          while (pending.chunks.length > 0) {
            const chunk = pending.chunks.shift()!
            pending.stream.bytesQueued -= chunk.byteLength
            pending.stream.controller.enqueue(chunk)
          }
          pending.stream.closed = true
          pending.stream.controller.close()
        }
        return
      }
      pending.resolve(new Response(responseMustNotHaveBody(pending.status ?? 200) ? null : concatBytes(pending.chunks), {
        status: pending.status ?? 200,
        headers: pending.headers,
      }))
      return
    }
    if (parsed.message.type === "ws.frame") {
      const message = parsed.message as TunnelWsFrame
      const channel = tunnel.channels.get(message.channel_id)
      if (!channel) return
      const token = await runtimeAccessTokenActive(channel)
      if (!token.active) {
        tunnel.channels.delete(message.channel_id)
        clients.delete(channel)
        closeSocket(channel.socket, 1008, token.reason)
        return
      }
      // The host→client direction. The client→host direction in
      // `handleUserHostedClientMessage` has always checked its send result and
      // closed 1011; this one discarded it, so a browser whose socket had gone
      // away stayed in `tunnel.channels` and the host kept producing frames into
      // a dead socket until something else happened to notice.
      if (!sendSocket(channel.socket, tunnelFrame(message))) {
        dropUserHostedChannel(tunnel, message.channel_id, channel, 1013, "Client WebSocket delivery failed")
      }
      return
    }
    if (parsed.message.type === "ws.close") {
      const message = parsed.message as TunnelWsClose
      const channel = tunnel.channels.get(message.channel_id)
      if (!channel) return
      tunnel.channels.delete(message.channel_id)
      clients.delete(channel)
      closeSocket(channel.socket, safeCloseCode(message.code), message.reason ?? "")
      return
    }
    if (parsed.message.type === "error" && parsed.message.channel_id) {
      const message = parsed.message as TunnelError
      const channelId = parsed.message.channel_id
      const channel = tunnel.channels.get(channelId)
      if (!channel) return
      tunnel.channels.delete(channelId)
      clients.delete(channel)
      closeSocket(channel.socket, 1011, message.message)
    }
  }

  const parseTunnelMessageData = (data: unknown) => {
    if (typeof data !== "string") return { ok: true as const, value: data }
    try {
      return { ok: true as const, value: JSON.parse(data) as unknown }
    } catch {
      return { ok: false as const }
    }
  }

  const cleanupHostTunnel = (hostId: string, socket: WorkspaceRelayDurableObjectSocket, reason: string) => {
    const tunnel = hostTunnels.get(hostId)
    if (tunnel?.socket !== socket) return
    cleanupTunnelResources(tunnel, reason)
    hostTunnels.delete(hostId)
    directory.disconnectHost(hostId)
  }

  const cleanupUserHostedClient = (
    channelId: string,
    socket: WorkspaceRelayDurableObjectSocket,
    event?: WorkspaceRelayDurableObjectSocketEvent,
  ) => {
    for (const tunnel of hostTunnels.values()) {
      const active = tunnel.channels.get(channelId)
      if (!active || active.socket !== socket) continue
      tunnel.channels.delete(channelId)
      clients.delete(active)
      // Send result deliberately unchecked, unlike the frame paths: the client is
      // already gone and the channel already forgotten, so the only way this
      // fails is a dead tunnel socket — which `cleanupHostTunnel` handles on its
      // own close/error event. There is no third party left to inform.
      sendSocket(tunnel.socket, JSON.stringify({
        type: "ws.close",
        protocol: TUNNEL_PROTOCOL_VERSION,
        channel_id: channelId,
        code: safeCloseCode(event?.code, 1000),
        reason: event?.reason ?? "Client WebSocket closed",
      }))
      return
    }
  }

  const admitHostTunnel = async (request: Request, roomWorkspaceId: string, url: URL) => {
    if (!websocketRequest(request)) return json("websocket_upgrade_required", "Workspace Relay requires a WebSocket upgrade", 426)
    const hostId = clean(hostIdFromTunnelPath(url.pathname))
    if (!hostId) return json("host_tunnel_host_required", "Host tunnel id is required", 400)
    const workspaceIds = workspaceIdsFromSearch(url)
    if (!workspaceIds.includes(roomWorkspaceId)) {
      return json("host_tunnel_workspace_mismatch", "Host tunnel must include the room workspace id", 403)
    }
    const token = bearerToken(request.headers.get("authorization"))
    if (!token) return json("host_tunnel_token_required", "Host Tunnel Token is required", 401)
    try {
      await verifyHostTunnelToken(token, options.runtimeAccessKey, { hostId, workspaceIds })
    } catch (err) {
      if (err instanceof WorkspaceRelayAuthError) {
        return json(err.code, "Host Tunnel Token was denied", 403)
      }
      throw err
    }

    const connectedAt = options.now?.() ?? Date.now()
    const pair = acceptSocket({
      kind: "host-tunnel",
      hostId,
      workspaceIds,
      connectedAt,
    })
    const previous = hostTunnels.get(hostId)
    if (previous) {
      cleanupTunnelResources(previous, "Host tunnel replaced")
      closeSocket(previous.socket, 1012, "Host tunnel replaced")
    }
    hostTunnels.set(hostId, {
      hostId,
      workspaceIds,
      connectedAt,
      socket: pair.server,
      pending: new Map(),
      channels: new Map(),
    })
    directory.registerHostTunnel({ hostId, workspaceIds })
    if (!hibernation) {
      pair.server.addEventListener?.("message", (event) => {
        if (!event || event.data === undefined) return
        // Same guard as the hibernation `webSocketMessage` path: a bare `void` on
        // a rejecting promise is an unhandled rejection — no close, no log.
        void handleTunnelMessage(hostId, { data: event.data })
          .catch((err) => reportFrameHandlerFailure(pair.server, err))
      })
      pair.server.addEventListener?.("close", () => cleanupHostTunnel(hostId, pair.server, "User-hosted tunnel disconnected"))
      pair.server.addEventListener?.("error", () => cleanupHostTunnel(hostId, pair.server, "User-hosted tunnel disconnected"))
    }
    return upgradeResponse(pair.client, request)
  }

  const admitClient = async (request: Request, workspaceId: string) => {
    if (!websocketRequest(request)) return json("websocket_upgrade_required", "Workspace Relay requires a WebSocket upgrade", 426)
    const authorized = await authorizeWorkspaceRelayRequest(relayOptions, request, workspaceId)
    if (!authorized.ok) return authorized.response
    if (authorized.request.target.access !== "cloud") return admitUserHostedClient(request, authorized.request)
    return await admitCloudClient(request, authorized.request)
  }

  const admitCloudClient = async (request: Request, authorized: AuthorizedWorkspaceRelayRequest) => {
    // Trace state is only allocated when the header opts in — no behavior
    // change on the default path. `upstreamStartedAt` is captured before the
    // upstream open so upstreamOpenMs reflects the DO's outbound-WS admission
    // wall clock (the cross-provider handshake the June evaluation isolated).
    const trace = relayWebSocketTraceEnabled(request)
      ? { upstreamStartedAt: performance.now(), queueTimes: [] as number[], emitted: false }
      : undefined
    let upstream: WorkspaceRelayDurableObjectSocket
    try {
      upstream = await connectWebSocket(
        workspaceRelayTargetUrl(
          authorized.target,
          authorized.path,
          new URL(request.url).search,
        ).toString(),
        {
          headers: headerRecord(workspaceRelayForwardHeaders(
            new Headers(),
            authorized.relayHostToken,
            authorized.target.workspaceId,
            { userHosted: false, upstreamHeaders: authorized.target.upstreamHeaders },
          )),
        },
      )
    } catch {
      return json("upstream_unavailable", "Workspace upstream is unavailable", 503)
    }
    const upstreamConnectedAt = trace ? performance.now() : 0
    const pair = acceptSocket()
    const client = { request: authorized, socket: pair.server }
    clients.add(client)
    let closed = false
    let upstreamOpen = upstream.readyState === undefined || upstream.readyState === 1
    const queue: Array<string | ArrayBuffer | Uint8Array> = []
    /** Running byte size of `queue`; reset when it is flushed upstream. */
    let queuedBytes = 0
    const emitTrace = (openedAt: number) => {
      if (!trace || trace.emitted) return
      trace.emitted = true
      // Unchecked on purpose: this frame exists only when a bench opted in with
      // `x-claxedo-relay-ws-trace`, and losing a diagnostic must never affect the
      // connection it is measuring.
      sendSocket(pair.server, JSON.stringify({
        type: "relay.trace",
        wsUpstreamOpenMs: roundedMs(openedAt - trace.upstreamStartedAt),
        queuedFrames: trace.queueTimes.length,
        maxQueuedDelayMs: roundedMs(trace.queueTimes.reduce((max, at) => Math.max(max, openedAt - at), 0)),
      }))
    }
    const activeTokenTimer = watchRuntimeAccessToken(client, (reason) => {
      closeSocket(pair.server, 1008, reason)
    })
    const cleanupClient = (event?: WorkspaceRelayDurableObjectSocketEvent) => {
      if (closed) return
      closed = true
      if (activeTokenTimer) clearInterval(activeTokenTimer)
      clients.delete(client)
      closeSocket(upstream, safeCloseCode(event?.code, 1000), event?.reason ?? "Client WebSocket closed")
    }
    const cleanupUpstream = (event?: WorkspaceRelayDurableObjectSocketEvent) => {
      if (closed) return
      closed = true
      if (activeTokenTimer) clearInterval(activeTokenTimer)
      clients.delete(client)
      closeSocket(pair.server, safeCloseCode(event?.code), event?.reason ?? "")
    }
    const flushQueue = () => {
      upstreamOpen = true
      if (trace) emitTrace(performance.now())
      queuedBytes = 0
      for (const item of queue.splice(0)) {
        if (!sendSocket(upstream, item)) {
          closeSocket(pair.server, 1011, "Upstream WebSocket connection failed")
          return
        }
      }
    }
    const deliverClientFrame = orderedFrameDelivery((payload) => {
      if (!upstreamOpen) {
        // Admit on EITHER bound — see the constants. A burst of small frames
        // while the upstream is still connecting costs almost nothing to hold,
        // and this queue carries an ordered stream, so shedding entries would
        // corrupt it silently. Only genuinely large buffered traffic closes.
        const frameBytes = preOpenFrameBytes(payload)
        if (
          queue.length >= (options.upstreamWebSocketPreOpenQueueMaxFrames ?? UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_FRAMES_DEFAULT)
          && queuedBytes + frameBytes > (options.upstreamWebSocketPreOpenQueueMaxBytes ?? UPSTREAM_WS_PRE_OPEN_QUEUE_MAX_BYTES_DEFAULT)
        ) {
          closeSocket(pair.server, 1011, "Upstream WebSocket queue limit exceeded")
          cleanupClient({ code: 1011, reason: "Upstream WebSocket queue limit exceeded" })
          return
        }
        queuedBytes += frameBytes
        if (trace) trace.queueTimes.push(performance.now())
        queue.push(payload)
        return
      }
      if (!sendSocket(upstream, payload)) closeSocket(pair.server, 1011, "Upstream WebSocket connection failed")
    })
    pair.server.addEventListener?.("message", (event) => deliverClientFrame(event?.data))
    pair.server.addEventListener?.("close", cleanupClient)
    pair.server.addEventListener?.("error", cleanupClient)
    upstream.addEventListener?.("open", flushQueue)
    const deliverUpstreamFrame = orderedFrameDelivery((payload) => {
      if (!sendSocket(pair.server, payload)) {
        closeSocket(pair.server, 1011, "Client WebSocket send failed")
      }
    })
    upstream.addEventListener?.("message", (event) => deliverUpstreamFrame(event?.data))
    upstream.addEventListener?.("close", cleanupUpstream)
    upstream.addEventListener?.("error", () => cleanupUpstream({ code: 1011, reason: "Upstream WebSocket connection failed" }))
    // When connectWebSocket resolved an already-open socket (the common
    // workerd path: fetch() returns after the 101), the "open" event never
    // fires, so emit the trace here with the connect wall clock.
    if (trace && upstreamOpen) emitTrace(upstreamConnectedAt)
    return upgradeResponse(pair.client, request)
  }

  const admitUserHostedClient = (request: Request, authorized: AuthorizedWorkspaceRelayRequest) => {
    const tunnel = hostTunnels.get(authorized.target.hostId)
    if (!tunnel || !directory.activeHost({ hostId: authorized.target.hostId, workspaceId: authorized.target.workspaceId })) {
      return json("user_hosted_app_offline", "User-hosted workspace is offline", 503)
    }
    if (tunnel.channels.size >= (options.tunnelChannelCap ?? TUNNEL_CHANNEL_CAP_DEFAULT)) {
      return json("too_many_channels", "User-hosted tunnel has too many active WebSocket channels", 503)
    }
    const channelId = randomToken()
    const pair = acceptSocket({
      kind: "user-hosted-client",
      channelId,
      claims: authorized.claims,
      target: authorized.target,
      path: authorized.path,
      connectedAt: options.now?.() ?? Date.now(),
    })
    const client = {
      request: authorized,
      socket: pair.server,
      channelId,
    }
    clients.add(client)
    tunnel.channels.set(channelId, client)
    // Timers do not survive DO hibernation, which is why these are skipped on
    // that path. The alarm scheduled just below is what enforces revocation for
    // an IDLE hibernated connection (W6b.2); the per-frame cached check in
    // `handleUserHostedClientMessage` continues to cover active traffic.
    const activeTokenTimer = hibernation ? undefined : watchRuntimeAccessToken(client, (reason) => {
      closeSocket(pair.server, 1008, reason)
    })
    const activeTargetTimer = hibernation ? undefined : watchUserHostedTarget(client, (reason) => {
      closeSocket(pair.server, 1011, reason)
    })
    if (hibernation) void scheduleHibernatedRevocationCheck()
    if (!hibernation) {
      const cleanup = (event?: WorkspaceRelayDurableObjectSocketEvent) => {
        if (activeTokenTimer) clearInterval(activeTokenTimer)
        if (activeTargetTimer) clearInterval(activeTargetTimer)
        cleanupUserHostedClient(channelId, pair.server, event)
      }
      pair.server.addEventListener?.("message", (event) => {
        if (!event) return
        void handleUserHostedClientMessage(channelId, pair.server, event.data)
          .catch((err) => reportFrameHandlerFailure(pair.server, err))
      })
      pair.server.addEventListener?.("close", cleanup)
      pair.server.addEventListener?.("error", cleanup)
    }
    // If the host never learns the channel opened, nothing will ever answer this
    // client — it would sit on an established socket waiting forever. Fail the
    // upgrade instead, so the browser gets a 503 it knows to retry.
    const opened = sendSocket(tunnel.socket, JSON.stringify({
      type: "ws.open",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: channelId,
      workspace_id: authorized.target.workspaceId,
      path: authorized.path,
      headers: headerRecord(workspaceRelayForwardHeaders(
        new Headers(),
        authorized.relayHostToken,
        authorized.target.workspaceId,
        { userHosted: true },
      )),
    }))
    if (!opened) {
      tunnel.channels.delete(channelId)
      clients.delete(client)
      closeSocket(pair.server, 1011, "User-hosted tunnel unavailable")
      return json("user_hosted_app_offline", "User-hosted workspace is offline", 503)
    }
    return upgradeResponse(pair.client, request)
  }

  const forwardCloudHttp = async (request: Request, workspaceId: string, trace?: RelayTrace) => {
    const authorized = await traceSpan(trace, "relay-auth", () =>
      authorizeWorkspaceRelayRequest(relayOptions, request, workspaceId, {
        span: (name, run) => traceSpan(trace, name, run),
      })
    )
    if (!authorized.ok) return authorized.response
    if (authorized.request.target.access !== "cloud") {
      trace && (trace.routeKind = "user-hosted-http")
      return forwardUserHostedHttp(request, authorized.request, trace)
    }
    trace && (trace.routeKind = "cloud-http")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.forwardTimeoutMs ?? 30_000)
    try {
      const upstream = await traceSpan(trace, "upstream-fetch", () => (options.fetch ?? fetch)(
        workspaceRelayTargetUrl(
          authorized.request.target,
          authorized.request.path,
          new URL(request.url).search,
        ),
        workspaceRelayForwardRequestInit(request, authorized.request.relayHostToken, workspaceId, {
          signal: controller.signal,
          upstreamHeaders: authorized.request.target.upstreamHeaders,
        }),
      ))
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      })
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError"
      return Response.json(
        errorBody(
          aborted ? "upstream_timeout" : "upstream_unavailable",
          aborted ? "Workspace upstream timed out" : "Workspace upstream is unavailable",
        ),
        { status: aborted ? 504 : 503 },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  const forwardUserHostedHttp = async (request: Request, authorized: AuthorizedWorkspaceRelayRequest, trace?: RelayTrace) => {
    const tunnel = hostTunnels.get(authorized.target.hostId)
    if (!tunnel || !directory.activeHost({ hostId: authorized.target.hostId, workspaceId: authorized.target.workspaceId })) {
      return json("user_hosted_app_offline", "User-hosted workspace is offline", 503)
    }
    // Only NOT-yet-started requests count toward the pending cap. Started
    // streaming responses (SSE) are long-lived by design and capped + evicted
    // separately in `resolvePendingTunnelStream` — counting them here let
    // orphaned streams starve every subsequent request with 503s.
    const awaitingStart = [...tunnel.pending.values()].filter((entry) => entry.startedSeq === undefined).length
    if (awaitingStart >= (options.tunnelPendingHttpCap ?? TUNNEL_PENDING_HTTP_CAP_DEFAULT)) {
      return json("too_many_pending_requests", "User-hosted tunnel has too many pending HTTP requests", 503)
    }
    const requestId = randomToken()
    const init = workspaceRelayForwardRequestInit(request, authorized.relayHostToken, authorized.target.workspaceId, {
      userHosted: true,
    })
    const bodyMaxBytes = options.tunnelRequestBodyMaxBytes ?? TUNNEL_REQUEST_BODY_MAX_BYTES_DEFAULT
    const contentLength = Number(request.headers.get("content-length") ?? Number.NaN)
    if (Number.isFinite(contentLength) && contentLength > bodyMaxBytes) {
      return json("request_body_too_large", "User-hosted request body exceeds the relay limit", 413)
    }
    const bodyBytes = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await traceSpan(trace, "request-body", () => readRequestBodyCapped(request, bodyMaxBytes))
    if (bodyBytes === "too_large") {
      return json("request_body_too_large", "User-hosted request body exceeds the relay limit", 413)
    }
    const body = bodyBytes ? bytesToBase64(bodyBytes) : undefined
    const pending = new Promise<Response>((resolve, reject) => {
      const timeout = setTimeout(() => {
        tunnel.pending.delete(requestId)
        tunnel.socket.send?.(JSON.stringify({
          type: "http.response.flow",
          protocol: TUNNEL_PROTOCOL_VERSION,
          request_id: requestId,
          paused: false,
          reason: "closed",
        } satisfies TunnelHttpResponseFlow))
        reject(new Error("User-hosted tunnel timed out"))
      }, options.forwardTimeoutMs ?? 30_000)
      tunnel.pending.set(requestId, {
        chunks: [],
        bytes: 0,
        timeout,
        resolve,
        reject,
      })
    })
    tunnel.socket.send?.(JSON.stringify({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: requestId,
      workspace_id: authorized.target.workspaceId,
      method: request.method,
      path: `${authorized.path}${new URL(request.url).search}`,
      headers: headerRecord(init.headers instanceof Headers ? init.headers : new Headers(init.headers)),
      ...(body ? { body_base64: body } : {}),
      end: true,
    }))
    try {
      return await traceSpan(trace, "tunnel-wait", () => pending)
    } catch (err) {
      const timeout = err instanceof Error && err.message.includes("timed out")
      const responseTooLarge = err instanceof Error && err.message.includes("response body exceeds")
      return Response.json(
        errorBody(
          timeout
            ? "user_hosted_tunnel_timeout"
            : responseTooLarge
              ? "user_hosted_response_body_too_large"
              : "user_hosted_tunnel_unavailable",
          timeout
            ? "User-hosted tunnel timed out"
            : responseTooLarge
              ? "User-hosted response body exceeds the relay limit"
              : "User-hosted tunnel is unavailable",
        ),
        { status: responseTooLarge ? 413 : 503 },
      )
    }
  }

  return {
    async fetch(request: Request) {
      ensureHibernatedSocketsRebuilt()
      // Must run BEFORE any presence consult on this request: the offline gate
      // lives in `authorizeWorkspaceRelayRequest` (server.ts activeHost check),
      // which rejects user-hosted requests ahead of the admit/forward handlers.
      refreshHostPresenceFromSockets()
      const url = new URL(request.url)
      const roomWorkspaceId = workspaceRelayDurableObjectWorkspaceId(request)
      if (request.method === "OPTIONS" && (url.pathname.startsWith("/workspaces/") || url.pathname.startsWith("/host-tunnels/"))) {
        return corsPreflight(request)
      }
      if (url.pathname === "/health") {
        return Response.json({
          ok: !draining,
          service: "workspace-relay-room",
          mode: "cloudflare-durable-object",
          workspaceId: roomWorkspaceId,
          hostTunnelCount: hostTunnels.size,
          clientCount: clients.size,
          draining,
        }, { status: draining ? 503 : 200 })
      }
      if (draining) return json("relay_draining", "Workspace relay is shutting down; try another instance", 503)
      if (!roomWorkspaceId) return json("relay_workspace_required", "Workspace Relay requests must include a workspace id", 400)
      if (url.pathname.startsWith("/host-tunnels/")) return admitHostTunnel(request, roomWorkspaceId, url)
      if (url.pathname.startsWith("/workspaces/")) {
        if (websocketRequest(request)) return admitClient(request, roomWorkspaceId)
        const trace = traceRequest(request, "workspace-http", options)
        const roomTotalStartedAt = performance.now()
        const nextRequest = tracedRequest(request, trace)
        const response = await traceSpan(trace, "relay-room", () => forwardCloudHttp(nextRequest, roomWorkspaceId, trace))
        trace.phases.push({ name: "relay-room-total", ms: performance.now() - roomTotalStartedAt })
        const tracedResponse = withTraceHeaders(response, trace)
        logTrace(options, nextRequest, roomWorkspaceId, trace, tracedResponse)
        return withCors(request, tracedResponse)
      }
      return json("relay_route_not_found", "Workspace Relay route not found", 404)
    },
    async webSocketMessage(socket: WorkspaceRelayDurableObjectSocket, message: string | ArrayBuffer) {
      // Every throw below used to escape into the runtime, rejecting the DO's
      // message promise with NO close and NO log: the connection stayed open, the
      // client kept waiting, and nothing recorded why. A frame handler failing is
      // a relay-side bug, so it closes 1011 and says so — a client that sees a
      // close reconnects; one that sees silence hangs.
      try {
        ensureHibernatedSocketsRebuilt()
        const attachment = socketAttachment(socket)
        if (!attachment) return
        if (attachment.kind === "host-tunnel") {
          await handleTunnelMessage(attachment.hostId, { data: message })
          return
        }
        await handleUserHostedClientMessage(attachment.channelId, socket, message)
      } catch (err) {
        reportFrameHandlerFailure(socket, err)
      }
    },
    /**
     * Durable Object alarm entry point. Runs the hibernation-safe revocation
     * sweep (W6b.2). The Worker must forward `alarm()` here.
     */
    async alarm() {
      try {
        await runHibernatedRevocationCheck()
      } catch (err) {
        console.error(`[workspace-relay] revocation alarm failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    webSocketClose(socket: WorkspaceRelayDurableObjectSocket, code: number, reason: string) {
      ensureHibernatedSocketsRebuilt()
      const attachment = socketAttachment(socket)
      if (!attachment) return
      if (attachment.kind === "host-tunnel") {
        cleanupHostTunnel(attachment.hostId, socket, "User-hosted tunnel disconnected")
        return
      }
      cleanupUserHostedClient(attachment.channelId, socket, { code, reason })
    },
    webSocketError(socket: WorkspaceRelayDurableObjectSocket) {
      ensureHibernatedSocketsRebuilt()
      const attachment = socketAttachment(socket)
      if (!attachment) return
      if (attachment.kind === "host-tunnel") {
        cleanupHostTunnel(attachment.hostId, socket, "User-hosted tunnel disconnected")
        return
      }
      cleanupUserHostedClient(attachment.channelId, socket, { code: 1011, reason: "WebSocket error" })
    },
    state() {
      ensureHibernatedSocketsRebuilt()
      return {
        hostTunnelCount: hostTunnels.size,
        clientCount: clients.size,
        hostIds: [...hostTunnels.keys()],
        hostWorkspaceIds: Object.fromEntries([...hostTunnels].map(([hostId, tunnel]) => [hostId, tunnel.workspaceIds])),
      }
    },
    drain: drainController,
  }
}
