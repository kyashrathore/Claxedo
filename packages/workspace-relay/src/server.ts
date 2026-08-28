import { Hono } from "hono"
import { cors } from "hono/cors"
import { exportJWK, type JWK } from "jose"
import type { RuntimeAccessVerifierClaims, TokenVerifier } from "@claxedo/workspace-relay-protocol"
import {
  WorkspaceRelayAuthError,
  mintRelayHostToken,
  validateRuntimeAccessTokenClaims,
  verifyRuntimeAccessToken,
  type RelayAccess,
  type RelayBacking,
  type RelayClaimPair,
  type RelayJwtAlgorithm,
  type RelayKey,
  type RelayRole,
  type RuntimeAccessTokenClaims,
} from "./auth"
import type { WorkspaceRelayDirectory } from "./directory"
import { createOriginMatcher, DEFAULT_RELAY_APP_ORIGINS } from "./cors-origins"
import { bearerToken, errorBody } from "./http"

export type RelayHostPublicKey = {
  publicKey: CryptoKey | Uint8Array
  kid: string
}

export type WorkspaceRelayTarget = {
  workspaceId: string
  hostId: string
  baseUrl: string
  upstreamHeaders?: Record<string, string>
} & RelayClaimPair

export type RuntimeAccessTokenActiveResult =
  | {
      active: true
    }
  | {
      active: false
      code: string
      reason: string
    }

export type RevocationLookupArgs = { jti: string; workspaceId: string; hostId: string }
export type RevocationLookup = (args: RevocationLookupArgs) => Promise<RuntimeAccessTokenActiveResult>

export type CachedRevocationOptions = {
  /** TTL in milliseconds for cached revocation responses. Defaults to 10_000. */
  ttlMs?: number
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
}

export type TargetLookupArgs = { workspaceId: string; hostId: string }
export type TargetLookup = (args: TargetLookupArgs) => Promise<WorkspaceRelayTarget | undefined>

export type CachedTargetOptions = {
  /** TTL in milliseconds for positive target responses. Defaults to 5_000. */
  ttlMs?: number
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
}

export type WorkspaceRelayAuditEvent = {
  action:
    | "relay.request.accepted"
    | "relay.request.denied"
    | "relay.request.suppressed_summary"
    | "host_tunnel.connected"
    | "host_tunnel.disconnected"
  result: "allow" | "deny"
  reason?: string
  actorId?: string
  actorKind?: "human" | "agent"
  principalKind?: "user" | "service"
  role?: RelayRole
  workspaceId?: string
  hostId?: string
  method: string
  path: string
  /**
   * T16: only set on `relay.request.suppressed_summary` events. Counts the
   * number of `relay.request.accepted` audit events that were dropped by the
   * sampler in the previous flush interval.
   */
  suppressedCount?: number
}

export type WorkspaceRelayAuthOptions = {
  runtimeAccessKey: RelayKey
  /**
   * Cache signature/introspection-verified Runtime Access Token claims by the
   * full token string. Revocation/active checks, role enforcement, and target
   * resolution still run for every request after this cache hit. Defaults to
   * 10s and is always capped by the token's exp claim minus skew.
   */
  runtimeAccessTokenCacheTtlMs?: number
  /**
   * P-shared: optional override for runtime-access-token verification.
   *
   * When set, the relay calls this verifier instead of decoding the JWT
   * with `runtimeAccessKey`. The verifier returns `{ subject, scopes,
   * claims }`; the relay continues to use `claims` to drive
   * `resolveTarget` and the workspace/host audit fields. `runtimeAccessKey`
   * is then only used for legacy token paths and tests that exercise the
   * raw JWT codepath.
   *
   * This is the seam downstream users plug their own auth backend
   * through (Clerk-issued tokens, OIDC introspection, custom keys, etc.).
   * See `@claxedo/workspace-relay-protocol/token-verifier` for the
   * `HttpTokenVerifier` and `StaticTokenVerifier` reference impls.
   */
  tokenVerifier?: TokenVerifier<RuntimeAccessVerifierClaims>
  isRuntimeAccessTokenActive?: (
    claims: RuntimeAccessTokenClaims,
  ) => RuntimeAccessTokenActiveResult | Promise<RuntimeAccessTokenActiveResult>
}

export type WorkspaceRelayHostTokenOptions = {
  relayHostSigningKey: CryptoKey | Uint8Array
  relayHostAlgorithm: RelayJwtAlgorithm
  /**
   * Public keys to publish at `/.well-known/jwks.json`. The first entry is the
   * "current" mint key; any further entries are "next" keys (for rolling
   * rotation). Verifiers (workspace-runtime → workspace-host-service) consume
   * this set via `jose.createRemoteJWKSet`. Omit to disable the endpoint
   * (during rollout / for tests that do not need JWKS).
   */
  relayHostPublicKeys?: RelayHostPublicKey[]
  /**
   * `kid` to embed in the protected header of freshly minted RHTs. When
   * provided, verifiers can dispatch on `kid` to pick the matching key from
   * the published JWKS. Should match the `kid` of the first entry in
   * `relayHostPublicKeys` so JWKS and mint agree by construction.
   */
  relayHostMintKid?: string
  /**
   * Cache Relay Host Tokens minted from an already-verified Runtime Access
   * Token. The relay still verifies the RAT, checks revocation, enforces role,
   * and resolves the target on every request; this only avoids repeated signing
   * work for the same jti/target after those gates pass. Defaults to 30s.
   */
  relayHostTokenCacheTtlMs?: number
}

export type WorkspaceRelayRoutingOptions = {
  resolveTarget: (claims: RuntimeAccessTokenClaims) => WorkspaceRelayTarget | Promise<WorkspaceRelayTarget | undefined>
  fetch?: typeof fetch
  forwardTimeoutMs?: number
  directory?: WorkspaceRelayDirectory
  // Browser-origin allowlist for CORS. REPLACES the built-in default list
  // (Claxedo/OpenCode app origins plus localhost dev hosts) when provided —
  // self-hosted deployments are not forced to keep the product domains.
  // Pattern grammar: exact origin, `https://*.example.com`, `http://localhost:*`.
  allowedOrigins?: string[]
}

export type WorkspaceRelayDrainOptions = {
  /**
   * T9: when this returns true the relay reports unhealthy via `/health` and
   * fast-paths every workspace request to a 503 (`relay_draining`) before
   * doing any auth or upstream work. Wired by `createWorkspaceRelayBun` to
   * the drain controller it exposes.
   */
  isDraining?: () => boolean
}

export type WorkspaceRelayTelemetryOptions = {
  audit?: (event: WorkspaceRelayAuditEvent) => void | Promise<void>
  /**
   * T16: probability (0.0 – 1.0) at which `relay.request.accepted` audit
   * events are emitted to the user `audit` callback. Denies and tunnel
   * lifecycle events are never sampled. When unset, defaults to 1.0
   * (emit every accept). Suppressed accepts are aggregated into a periodic
   * `relay.request.suppressed_summary` event (see `auditFlushIntervalMs`).
   */
  auditAcceptSampleRate?: number
  /**
   * T16: how often (ms) the sampler emits a `relay.request.suppressed_summary`
   * audit event with the count of suppressed accepts in the past interval.
   * Defaults to 60_000 (one minute). When sample rate is 1.0 no interval is
   * armed (nothing to flush). Exposed for tests.
   */
  auditFlushIntervalMs?: number
  /**
   * T16: random source for the sampler. Defaults to `Math.random`. Override
   * for deterministic tests.
   */
  random?: () => number
}

export type WorkspaceRelayMetricsOptions = {
  /**
   * T31: bearer token required to access `GET /metrics` from non-loopback
   * remotes. When unset, the endpoint allows loopback callers only (using
   * `metricsRemoteAddress` to identify the caller). When set, every request
   * must present `Authorization: Bearer <metricsToken>` regardless of origin.
   * Wired from `CLAXEDO_RELAY_METRICS_TOKEN` in main.ts.
   */
  metricsToken?: string
  /**
   * T31: returns the remote IP of the inbound `/metrics` request (used to
   * gate access to the loopback when `metricsToken` is unset). When this is
   * also unset, `/metrics` fails closed. The Bun adapter wires this resolver
   * through `Bun.Server.requestIP`; other callers should set either this or
   * `metricsToken`.
   */
  metricsRemoteAddress?: (request: Request) => string | undefined
  /**
   * T31: optional providers used to assemble the `/metrics` response body. The
   * fragmentation/slow-consumer counters live in the bun adapter's per-handler
   * telemetry, and the in-flight pending count lives on the drain controller.
   * `createWorkspaceRelayBun` wires these to make ops counters visible on
   * `/metrics` without giving `server.ts` a hard dependency on bun-only state.
   */
  metricsSources?: WorkspaceRelayMetricsSources
}

export type WorkspaceRelayOptions =
  & WorkspaceRelayAuthOptions
  & WorkspaceRelayHostTokenOptions
  & WorkspaceRelayRoutingOptions
  & WorkspaceRelayDrainOptions
  & WorkspaceRelayTelemetryOptions
  & WorkspaceRelayMetricsOptions

export type WorkspaceRelayMetricsSources = {
  fragmentation?: () => { fragmentsBuffered: number; oversizedClosed: number }
  slowConsumer?: () => { overflowEvents: number; timerFired: number; droppedRequests: number }
  drainPending?: () => number
}

/**
 * T31: shape of the JSON body returned by `GET /metrics`. Exported so the
 * bun adapter and ops dashboards can type-narrow against it.
 */
export type WorkspaceRelayMetrics = {
  fragmentation: { fragmentsBuffered: number; oversizedClosed: number }
  slowConsumer: { overflowEvents: number; timerFired: number; droppedRequests: number }
  directory: { activeHostCount: number }
  audit: { suppressedAccepts: number }
  drain?: { pendingCount: number }
}

export type AuthorizedWorkspaceRelayRequest = {
  claims: RuntimeAccessTokenClaims
  target: WorkspaceRelayTarget
  relayHostToken: string
  path: string
}

export type WorkspaceRelayAuthorizeTrace = {
  span<T>(name: string, run: () => Promise<T>): Promise<T>
}

export type WorkspaceRelayTracePhase = {
  name: string
  ms: number
}

export type WorkspaceRelayTrace = WorkspaceRelayAuthorizeTrace & {
  phases: WorkspaceRelayTracePhase[]
}

type RelayHostTokenCacheEntry = {
  token?: string
  promise?: Promise<string>
  expiresAt: number
}

const RELAY_HOST_TOKEN_CACHE_MAX_ENTRIES = 4096
const RUNTIME_ACCESS_TOKEN_CACHE_MAX_ENTRIES = 8192
const RESOLVER_CACHE_MAX_ENTRIES = 8192
const RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS_DEFAULT = 10_000
const relayHostTokenCaches = new WeakMap<WorkspaceRelayOptions, Map<string, RelayHostTokenCacheEntry>>()
const runtimeAccessTokenCaches = new WeakMap<WorkspaceRelayOptions, Map<string, {
  claims?: RuntimeAccessTokenClaims
  promise?: Promise<RuntimeAccessTokenClaims>
  expiresAt: number
}>>()

function pruneExpiringCache<T extends { expiresAt: number }>(cache: Map<string, T>, now: number, maxEntries: number) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
  while (cache.size >= maxEntries) {
    const key = cache.keys().next().value
    if (!key) return
    cache.delete(key)
  }
}

/**
 * Wraps a revocation lookup with a small in-memory cache keyed by `jti`.
 * Both positive and negative results are cached for the full TTL; revocation
 * lag is bounded by the same TTL by design. Concurrent misses share one lookup.
 */
export function createCachedRevocationClient(
  inner: RevocationLookup,
  options: CachedRevocationOptions = {},
): RevocationLookup {
  const ttlMs = options.ttlMs ?? 10_000
  const now = options.now ?? Date.now
  const cache = new Map<string, {
    expiresAt: number
    promise?: Promise<RuntimeAccessTokenActiveResult>
    result?: RuntimeAccessTokenActiveResult
  }>()

  return async (args) => {
    const at = now()
    const entry = cache.get(args.jti)
    if (entry && entry.expiresAt > at) {
      if (entry.result) return entry.result
      if (entry.promise) return await entry.promise
    }

    const promise = inner(args)
      .then((result) => {
        pruneExpiringCache(cache, now(), RESOLVER_CACHE_MAX_ENTRIES)
        cache.set(args.jti, { result, expiresAt: now() + ttlMs })
        return result
      })
      .catch((err) => {
        cache.delete(args.jti)
        throw err
      })
    cache.set(args.jti, { promise, expiresAt: at + ttlMs })
    return await promise
  }
}

/**
 * Caches positive workspace target lookups by workspace+host. Missing targets
 * are only coalesced while in flight, not retained, so cold-start polling can
 * see readiness as soon as the control plane records it.
 */
export function createCachedTargetClient(
  inner: TargetLookup,
  options: CachedTargetOptions = {},
): TargetLookup {
  const ttlMs = options.ttlMs ?? 5_000
  const now = options.now ?? Date.now
  const cache = new Map<string, {
    expiresAt: number
    promise?: Promise<WorkspaceRelayTarget | undefined>
    result?: WorkspaceRelayTarget
  }>()

  return async (args) => {
    const key = `${args.workspaceId}\0${args.hostId}`
    const at = now()
    const entry = cache.get(key)
    if (entry && entry.expiresAt > at) {
      if (entry.result) return entry.result
      if (entry.promise) return await entry.promise
    }

    const promise = inner(args)
      .then((result) => {
        pruneExpiringCache(cache, now(), RESOLVER_CACHE_MAX_ENTRIES)
        if (result) cache.set(key, { result, expiresAt: now() + ttlMs })
        else cache.delete(key)
        return result
      })
      .catch((err) => {
        cache.delete(key)
        throw err
      })
    cache.set(key, { promise, expiresAt: at + ttlMs })
    return await promise
  }
}

function protocolToken(header: string | undefined) {
  return header
    ?.split(",")
    .map((item) => item.trim())
    .find((item) => item.startsWith("claxedo-rat."))
    ?.slice("claxedo-rat.".length)
}

function runtimeAccessToken(request: Request) {
  return bearerToken(request.headers.get("authorization") ?? undefined)
    ?? protocolToken(request.headers.get("sec-websocket-protocol") ?? undefined)
}

// Headers a hostile client must not be able to set on requests we forward to
// the host service. The host (and anything sitting in front of it inside the
// trust boundary) trusts these headers to identify the caller and the
// upstream chain, so we strip them on the way in and replace them with relay-
// controlled values where appropriate.
//
// Stripped exactly (case-insensitive Headers lookup):
//   - x-forwarded-for / x-forwarded-host / x-forwarded-proto / x-real-ip
//     (would otherwise let a client spoof their IP / origin host / scheme to
//     anything downstream that trusts these headers).
//   - any "x-claxedo-internal-*" header (reserved namespace for relay → host
//     internal signaling; clients have no business setting these).
//   - any "x-supervisor-*" header (reserved for control-plane → VM supervisor
//     traffic, not user data path).
//
// We deliberately do NOT preserve any client-supplied x-forwarded-* value: the
// relay sits directly between the user and the host service with no trusted
// proxy in front of it, so the only honest upstream chain is "the relay".
// Instead we set a single relay-controlled marker, x-forwarded-by, that the
// host service can use to verify the request actually came through us.
const DANGEROUS_INBOUND_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
] as const
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const
const DANGEROUS_INBOUND_HEADER_PATTERNS: ReadonlyArray<RegExp> = [
  /^x-claxedo-internal-/i,
  /^x-supervisor-/i,
]

function isDangerousInboundHeader(name: string) {
  const lower = name.toLowerCase()
  if ((DANGEROUS_INBOUND_HEADERS as ReadonlyArray<string>).includes(lower)) return true
  if ((HOP_BY_HOP_HEADERS as ReadonlyArray<string>).includes(lower)) return true
  for (const pattern of DANGEROUS_INBOUND_HEADER_PATTERNS) {
    if (pattern.test(lower)) return true
  }
  return false
}

export type WorkspaceRelayForwardHeadersOptions = {
  /**
   * When true, also strip the `Cookie` request header. User-hosted workspaces
   * run on the user's laptop where the host process may share a cookie jar
   * with the browser (e.g. localhost dev tooling); passing through cookies
   * verbatim risks leaking sensitive session data to the host. Cloud-vm
   * workspaces sit behind a dedicated network boundary where session cookies
   * may legitimately be needed (e.g. workspace dashboards), so the default
   * is to NOT strip cookies. T26.
   */
  userHosted?: boolean
  upstreamHeaders?: Record<string, string>
}

export type WorkspaceRelayForwardRequestInitOptions = WorkspaceRelayForwardHeadersOptions & {
  signal?: AbortSignal
}

function forwardHeaders(
  input: Headers,
  relayHostToken: string,
  workspaceId: string,
  options: WorkspaceRelayForwardHeadersOptions = {},
) {
  const headers = new Headers(input)
  headers.delete("host")
  // Defense-in-depth: drop any headers a client could use to spoof the
  // upstream chain or impersonate internal/control-plane traffic. See the
  // comment block on DANGEROUS_INBOUND_HEADERS above for the rationale.
  // Snapshot the names first so we can mutate `headers` while iterating.
  const inboundNames = new Set<string>()
  headers.forEach((_value, name) => inboundNames.add(name))
  for (const name of inboundNames) {
    if (isDangerousInboundHeader(name)) headers.delete(name)
  }
  // T26: strip Cookie when forwarding into a user-hosted workspace. See
  // WorkspaceRelayForwardHeadersOptions for rationale.
  if (options.userHosted) headers.delete("cookie")
  // Bun's fetch auto-decodes gzip/br responses but errors on malformed
  // upstream content-encoding (Daytona occasionally serves gzip-marked
  // responses that fail Zlib decompression). Force identity encoding so the
  // body streams through verbatim and the browser handles decompression.
  headers.set("accept-encoding", "identity")
  headers.delete("authorization")
  headers.delete("Authorization")
  headers.set("Authorization", `Bearer ${relayHostToken}`)
  headers.set("x-workspace-id", workspaceId)
  headers.set("X-Daytona-Skip-Preview-Warning", "true")
  headers.set("X-Daytona-Skip-Last-Activity-Update", "true")
  for (const [name, value] of Object.entries(options.upstreamHeaders ?? {})) {
    const trimmed = value.trim()
    if (trimmed) headers.set(name, trimmed)
  }
  // Single relay-controlled marker that lets the host service distinguish
  // traffic coming through the relay from any other inbound source. We do not
  // attempt to preserve a client IP here because the relay is not behind a
  // trusted proxy in our deployment, so any inbound x-forwarded-for value is
  // attacker-controlled and has already been removed above.
  headers.set("x-forwarded-by", "workspace-relay")
  return headers
}

function targetUrl(target: WorkspaceRelayTarget, path: string, search: string) {
  const url = new URL(path.replace(/^\/+/, ""), target.baseUrl.endsWith("/") ? target.baseUrl : `${target.baseUrl}/`)
  url.search = search
  return url
}

// A PTY WebSocket upgrade is a GET but still grants an interactive shell.
const RELAY_VIEWER_DENIED_PATH = /^\/api\/wr\/pty(?:\/|$)/

function relayRuntimePath(request: Request) {
  try {
    const decoded = decodeURIComponent(new URL(request.url).pathname.replace(/^\/workspaces\/[^/]+\/?/, "/"))
      .replace(/^\/+/, "/")
    // Authorize on the SAME pathname that will be forwarded. `targetUrl` resolves
    // the path through `new URL`, which parses any `?`/`#` a decoded %3F/%23
    // introduced as query/fragment and drops it from the pathname. Resolve it the
    // same way here so a viewer cannot smuggle `/api/wr/pty%3Fx` (authz sees
    // "/api/wr/pty?x", which the deny regex misses, but forwarding hits the real
    // "/api/wr/pty") past the gate. Query strings ride in `request.url` search,
    // not the pathname, so legitimate requests are unaffected.
    return new URL(decoded.replace(/^\/+/, ""), "http://relay.invalid/").pathname
  } catch {
    return undefined
  }
}

function roleAllowsRelayRequest(role: RelayRole, method: string, path: string) {
  if (role === "owner" || role === "admin" || role === "editor") return true
  if (role === "viewer") {
    if (RELAY_VIEWER_DENIED_PATH.test(path)) return false
    return method === "GET" || method === "HEAD" || method === "OPTIONS"
  }
  return false
}

function relayHostTokenCacheTtlMs(options: WorkspaceRelayOptions, claims: RuntimeAccessTokenClaims) {
  const configured = options.relayHostTokenCacheTtlMs ?? 30_000
  if (!Number.isFinite(configured) || configured <= 0) return 0
  const tokenRemaining = claims.exp * 1000 - Date.now() - 5_000
  return Math.max(0, Math.min(configured, tokenRemaining))
}

function relayHostTokenCacheKey(
  options: WorkspaceRelayOptions,
  claims: RuntimeAccessTokenClaims,
  target: WorkspaceRelayTarget,
) {
  return [
    claims.jti,
    claims.sub,
    claims.actor_id ?? "",
    claims.actor_kind ?? "",
    claims.actor_public_id ?? "",
    claims.actor_name ?? "",
    claims.actor_avatar_url ?? "",
    claims.org_id,
    claims.role,
    claims.workspace_id,
    claims.host_id,
    target.access,
    target.backing,
    options.relayHostMintKid ?? "",
  ].join("\0")
}

function relayHostTokenCache(options: WorkspaceRelayOptions) {
  let cache = relayHostTokenCaches.get(options)
  if (cache) return cache
  cache = new Map()
  relayHostTokenCaches.set(options, cache)
  return cache
}

function runtimeAccessTokenCache(options: WorkspaceRelayOptions) {
  let cache = runtimeAccessTokenCaches.get(options)
  if (cache) return cache
  cache = new Map()
  runtimeAccessTokenCaches.set(options, cache)
  return cache
}

function runtimeAccessTokenCacheTtlMs(options: WorkspaceRelayOptions, claims: RuntimeAccessTokenClaims, now: number) {
  const configured = options.runtimeAccessTokenCacheTtlMs ?? RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS_DEFAULT
  if (!Number.isFinite(configured) || configured <= 0) return 0
  const tokenRemaining = claims.exp * 1000 - now - 5_000
  return Math.max(0, Math.min(configured, tokenRemaining))
}

function pruneRuntimeAccessTokenCache(
  cache: Map<string, { claims?: RuntimeAccessTokenClaims; promise?: Promise<RuntimeAccessTokenClaims>; expiresAt: number }>,
  now: number,
) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
  while (cache.size >= RUNTIME_ACCESS_TOKEN_CACHE_MAX_ENTRIES) {
    const key = cache.keys().next().value
    if (!key) return
    cache.delete(key)
  }
}

async function verifyRuntimeAccessTokenForRequest(
  options: WorkspaceRelayOptions,
  token: string,
  workspaceId: string,
) {
  const verified = options.tokenVerifier
    ? await options.tokenVerifier.verify(token).then((result) =>
        validateRuntimeAccessTokenClaims(result.claims, { workspaceId })
      )
    : await verifyRuntimeAccessToken(token, options.runtimeAccessKey, { workspaceId })
  return verified
}

async function cachedRuntimeAccessTokenClaims(
  options: WorkspaceRelayOptions,
  token: string,
  workspaceId: string,
) {
  const configured = options.runtimeAccessTokenCacheTtlMs ?? RUNTIME_ACCESS_TOKEN_CACHE_TTL_MS_DEFAULT
  if (!Number.isFinite(configured) || configured <= 0) {
    return await verifyRuntimeAccessTokenForRequest(options, token, workspaceId)
  }
  const now = Date.now()
  const cache = runtimeAccessTokenCache(options)
  const key = `${workspaceId}\0${token}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) {
    if (cached.claims) return cached.claims
    if (cached.promise) return await cached.promise
  }
  let promise: Promise<RuntimeAccessTokenClaims> | undefined
  try {
    promise = verifyRuntimeAccessTokenForRequest(options, token, workspaceId)
    pruneRuntimeAccessTokenCache(cache, now)
    cache.set(key, { promise, expiresAt: now + configured })
    const claims = await promise
    const ttlMs = runtimeAccessTokenCacheTtlMs(options, claims, now)
    if (ttlMs > 0) cache.set(key, { claims, expiresAt: now + ttlMs })
    else cache.delete(key)
    return claims
  } catch (err) {
    if (promise && cache.get(key)?.promise === promise) cache.delete(key)
    throw err
  }
}

function pruneRelayHostTokenCache(cache: Map<string, RelayHostTokenCacheEntry>, now: number) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
  while (cache.size >= RELAY_HOST_TOKEN_CACHE_MAX_ENTRIES) {
    const key = cache.keys().next().value
    if (!key) return
    cache.delete(key)
  }
}

async function relayHostTokenFor(
  options: WorkspaceRelayOptions,
  claims: RuntimeAccessTokenClaims,
  target: WorkspaceRelayTarget,
  trace: WorkspaceRelayAuthorizeTrace,
) {
  const ttlMs = relayHostTokenCacheTtlMs(options, claims)
  if (ttlMs <= 0) {
    return await uncachedRelayHostTokenFor(options, claims, target, trace)
  }
  const key = relayHostTokenCacheKey(options, claims, target)
  const now = Date.now()
  const cache = relayHostTokenCache(options)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) {
    if (cached.promise) {
      return await trace.span("rht-cache", async () => await cached.promise!)
    }
    await trace.span("rht-cache", async () => {})
    return cached.token!
  }
  let promise: Promise<string> | undefined
  try {
    const token = await trace.span("rht-mint", async () => {
      promise = mintRelayHostToken({
        subject: claims.sub,
        // Preserve the authoritative RAT identifier so downstream renewable
        // stream leases can be checked against the same revocation record.
        jti: claims.jti,
        ...relayActorInput(claims),
        orgId: claims.org_id,
        role: claims.role,
        ...target,
        ...(options.relayHostMintKid ? { kid: options.relayHostMintKid } : {}),
      }, options.relayHostSigningKey, options.relayHostAlgorithm)
      pruneRelayHostTokenCache(cache, now)
      cache.set(key, { promise, expiresAt: now + ttlMs })
      return await promise
    })
    cache.set(key, {
      token,
      expiresAt: now + ttlMs,
    })
    return token
  } catch (err) {
    if (promise && cache.get(key)?.promise === promise) cache.delete(key)
    throw err
  }
}

async function uncachedRelayHostTokenFor(
  options: WorkspaceRelayOptions,
  claims: RuntimeAccessTokenClaims,
  target: WorkspaceRelayTarget,
  trace: WorkspaceRelayAuthorizeTrace,
) {
  return await trace.span("rht-mint", async () =>
    await mintRelayHostToken({
      subject: claims.sub,
      jti: claims.jti,
      ...relayActorInput(claims),
      orgId: claims.org_id,
      role: claims.role,
      ...target,
      ...(options.relayHostMintKid ? { kid: options.relayHostMintKid } : {}),
    }, options.relayHostSigningKey, options.relayHostAlgorithm)
  )
}

function relayActorInput(claims: RuntimeAccessTokenClaims) {
  if (!claims.actor_id || !claims.actor_kind) return { actorId: undefined, actorKind: undefined } as const
  return {
    actorId: claims.actor_id,
    actorKind: claims.actor_kind,
    ...(claims.actor_public_id && claims.actor_name
      ? {
          actorPublicId: claims.actor_public_id,
          actorName: claims.actor_name,
          ...(claims.actor_avatar_url ? { actorAvatarUrl: claims.actor_avatar_url } : {}),
        }
      : {}),
  } as const
}

export function workspaceRelayTargetUrl(target: WorkspaceRelayTarget, path: string, search: string) {
  return targetUrl(target, path, search)
}

export function workspaceRelayForwardHeaders(
  input: Headers,
  relayHostToken: string,
  workspaceId: string,
  options: WorkspaceRelayForwardHeadersOptions = {},
) {
  return forwardHeaders(input, relayHostToken, workspaceId, options)
}

export function workspaceRelayForwardRequestInit(
  request: Request,
  relayHostToken: string,
  workspaceId: string,
  options: WorkspaceRelayForwardRequestInitOptions = {},
) {
  const init: RequestInit = {
    method: request.method,
    headers: forwardHeaders(request.headers, relayHostToken, workspaceId, options),
    body: request.body,
    duplex: "half",
    redirect: "manual",
    ...(options.signal ? { signal: options.signal } : {}),
  } as RequestInit
  if (request.method === "GET" || request.method === "HEAD") delete init.body
  return init
}

/**
 * T16: per-options-object sampler state. We store the suppressed-event counter
 * (and the periodic flush timer) on a WeakMap keyed by `WorkspaceRelayOptions`
 * so that `authorizeWorkspaceRelayRequest`, the bun adapter's tunnel audit
 * helper, and the relay's own `createWorkspaceRelay` HTTP routes all share the
 * same suppressed counter without anyone having to thread a stateful sampler
 * object through their call signatures.
 */
type AuditSamplerState = {
  suppressedCount: number
  timer: ReturnType<typeof setInterval> | undefined
  flushIntervalMs: number
  random: () => number
  sampleRate: number
}

const auditSamplers = new WeakMap<WorkspaceRelayOptions, AuditSamplerState>()

function getOrCreateAuditSampler(options: WorkspaceRelayOptions): AuditSamplerState {
  let state = auditSamplers.get(options)
  if (!state) {
    const sampleRate = clampSampleRate(options.auditAcceptSampleRate)
    state = {
      suppressedCount: 0,
      timer: undefined,
      flushIntervalMs: options.auditFlushIntervalMs ?? 60_000,
      random: options.random ?? Math.random,
      sampleRate,
    }
    auditSamplers.set(options, state)
  }
  return state
}

function clampSampleRate(rate: number | undefined): number {
  if (rate === undefined) return 1
  if (!Number.isFinite(rate)) return 1
  if (rate < 0) return 0
  if (rate > 1) return 1
  return rate
}

function ensureFlushTimer(options: WorkspaceRelayOptions, state: AuditSamplerState) {
  if (state.timer) return
  if (state.sampleRate >= 1) return
  if (state.flushIntervalMs <= 0) return
  const timer = setInterval(() => {
    flushSuppressedSummary(options, state)
  }, state.flushIntervalMs)
  // Don't keep the event loop alive just for this timer (Node/Bun-specific).
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref?: () => void }).unref!()
  }
  state.timer = timer
}

function flushSuppressedSummary(options: WorkspaceRelayOptions, state: AuditSamplerState) {
  const count = state.suppressedCount
  if (count <= 0) return
  state.suppressedCount = 0
  void options.audit?.({
    action: "relay.request.suppressed_summary",
    result: "allow",
    method: "INTERNAL",
    path: "/",
    suppressedCount: count,
  })
}

/**
 * T16: dispose the sampler's periodic flush timer for a given options object.
 * Tests call this in cleanup so the bun process can exit.
 */
export function disposeAuditSampler(options: WorkspaceRelayOptions) {
  const state = auditSamplers.get(options)
  if (!state) return
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = undefined
  }
  // Flush any remaining suppressed events synchronously so observers don't lose them.
  flushSuppressedSummary(options, state)
  auditSamplers.delete(options)
}

export function createWorkspaceRelayTrace(): WorkspaceRelayTrace {
  const phases: WorkspaceRelayTracePhase[] = []
  return {
    phases,
    async span<T>(name: string, run: () => Promise<T>): Promise<T> {
      const startedAt = performance.now()
      try {
        return await run()
      } finally {
        phases.push({ name, ms: performance.now() - startedAt })
      }
    },
  }
}

function roundedMs(value: number) {
  return Math.round(value * 100) / 100
}

export function workspaceRelayServerTiming(trace: WorkspaceRelayTrace) {
  return trace.phases
    .map((phase) => `${phase.name};dur=${roundedMs(phase.ms)}`)
    .join(", ")
}

export function workspaceRelayTimingResponse(response: Response, trace: WorkspaceRelayTrace) {
  const value = workspaceRelayServerTiming(trace)
  if (!value) return response
  const headers = new Headers(response.headers)
  const prev = headers.get("server-timing")
  headers.set("server-timing", prev ? `${prev}, ${value}` : value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function audit(options: WorkspaceRelayOptions, event: WorkspaceRelayAuditEvent) {
  if (event.action === "relay.request.accepted") {
    const state = getOrCreateAuditSampler(options)
    if (state.sampleRate < 1) {
      ensureFlushTimer(options, state)
      // Sample: keep when random() < rate. At rate=0 this is always false.
      if (state.random() >= state.sampleRate) {
        state.suppressedCount += 1
        return
      }
    }
  }
  await options.audit?.(event)
}

const defaultOriginMatcher = createOriginMatcher(DEFAULT_RELAY_APP_ORIGINS)

// Memoize per-options matchers so deny paths (which only receive the options
// bag) share one compiled matcher with the main CORS middleware.
const originMatchers = new WeakMap<object, (origin: string) => boolean>()

function originMatcherFor(options: WorkspaceRelayOptions) {
  if (!options.allowedOrigins) return defaultOriginMatcher
  let matcher = originMatchers.get(options)
  if (!matcher) {
    matcher = createOriginMatcher(options.allowedOrigins)
    originMatchers.set(options, matcher)
  }
  return matcher
}

function denyCorsHeaders(request: Request, originAllowed: (origin: string) => boolean = defaultOriginMatcher) {
  const origin = request.headers.get("origin")
  if (!origin) return undefined
  // Mirror the main CORS allowlist so deny responses are visible to the
  // browser instead of being hidden behind a CORS error.
  if (!originAllowed(origin)) return undefined
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "Accept, Authorization, Content-Type, Last-Event-ID, X-Fetch-Bypass-Throttle, X-Daytona-Skip-Preview-Warning, X-Workspace-Id, X-OpenCode-Directory, X-Claxedo-Runner, X-Claxedo-Model, X-Claxedo-Draft-Id, X-Claxedo-Binary",
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  }
}

async function deny(options: WorkspaceRelayOptions, input: {
  code: string
  message: string
  status: 401 | 403 | 503
  claims?: RuntimeAccessTokenClaims
  request: Request
}) {
  const url = new URL(input.request.url)
  await audit(options, {
    action: "relay.request.denied",
    result: "deny",
    reason: input.code,
    actorId: input.claims?.actor_id,
    actorKind: input.claims?.actor_kind,
    principalKind: input.claims?.principal_kind,
    ...(input.claims ? { role: input.claims.role } : {}),
    workspaceId: input.claims?.workspace_id,
    hostId: input.claims?.host_id,
    method: input.request.method,
    path: url.pathname,
  })
  return Response.json(errorBody(input.code, input.message), {
    status: input.status,
    headers: denyCorsHeaders(input.request, originMatcherFor(options)),
  })
}

export async function authorizeWorkspaceRelayRequest(
  options: WorkspaceRelayOptions,
  request: Request,
  workspaceId: string,
  trace?: WorkspaceRelayAuthorizeTrace,
): Promise<
  | { ok: true; request: AuthorizedWorkspaceRelayRequest }
  | { ok: false; response: Response; code: string }
> {
  const token = runtimeAccessToken(request)
  if (!token) {
    return {
      ok: false,
      code: "runtime_access_token_required",
      response: await deny(options, {
        code: "runtime_access_token_required",
        message: "Runtime Access Token is required",
        status: 401,
        request,
      }),
    }
  }

  try {
    // P-shared: prefer the unified `tokenVerifier` when configured.
    // The verifier returns `{ subject, scopes, claims }`; we hydrate
    // those into the existing `RuntimeAccessTokenClaims` shape so the
    // rest of the request path is unchanged. The legacy JWT codepath
    // remains the default for callers that have not opted in.
    const span = <T>(name: string, run: () => Promise<T>) => trace ? trace.span(name, run) : run()
    const claims = await span("rat-verify", async () =>
      await cachedRuntimeAccessTokenClaims(options, token, workspaceId)
    )
    const active = await span("rat-active", async (): Promise<RuntimeAccessTokenActiveResult> => {
      return await options.isRuntimeAccessTokenActive?.(claims) ?? { active: true }
    })
    if (!active.active) {
      return {
        ok: false,
        code: active.code,
        response: await deny(options, {
          code: active.code,
          message: active.reason,
          status: 401,
          claims,
          request,
        }),
      }
    }
    const path = relayRuntimePath(request)
    if (!path || !roleAllowsRelayRequest(claims.role, request.method, path)) {
      return {
        ok: false,
        code: "relay_role_denied",
        response: await deny(options, {
          code: "relay_role_denied",
          message: "Workspace role does not allow this relay request",
          status: 403,
          claims,
          request,
        }),
      }
    }
    const target = await span("target-resolve", async () => await options.resolveTarget(claims))
    if (!target || target.workspaceId !== claims.workspace_id || target.hostId !== claims.host_id) {
      return {
        ok: false,
        code: "relay_target_unavailable",
        response: await deny(options, {
          code: "relay_target_unavailable",
          message: "Workspace relay target is unavailable",
          status: 403,
          claims,
          request,
        }),
      }
    }
    if (
      target.access === "user-hosted"
      && !options.directory?.activeHost({ hostId: target.hostId, workspaceId: target.workspaceId })
    ) {
      return {
        ok: false,
        code: "user_hosted_app_offline",
        response: await deny(options, {
          code: "user_hosted_app_offline",
          message: "User-hosted workspace is offline",
          status: 503,
          claims,
          request,
        }),
      }
    }
    await span("audit", async () => await audit(options, {
      action: "relay.request.accepted",
      result: "allow",
      actorId: claims.actor_id,
      actorKind: claims.actor_kind,
      principalKind: claims.principal_kind,
      role: claims.role,
      workspaceId: claims.workspace_id,
      hostId: claims.host_id,
      method: request.method,
      path: new URL(request.url).pathname,
    }))
    const relayHostToken = await relayHostTokenFor(options, claims, target, { span })
    return {
      ok: true,
      request: {
        claims,
        target,
        relayHostToken,
        path,
      },
    }
  } catch (err) {
    const code = err instanceof WorkspaceRelayAuthError ? err.code : "relay_request_failed"
    return {
      ok: false,
      code,
      response: await deny(options, {
        code,
        message: "Workspace relay request was denied",
        status: code.includes("mismatch") ? 403 : 401,
        request,
      }),
    }
  }
}

export async function forwardWorkspaceRelayRequest(
  request: Request,
  target: WorkspaceRelayTarget,
  relayHostToken: string,
  path: string,
  requestFetch: typeof fetch,
  timeoutMs: number,
  trace?: WorkspaceRelayAuthorizeTrace,
  originAllowed: (origin: string) => boolean = defaultOriginMatcher,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const span = <T>(name: string, run: () => Promise<T>) => trace ? trace.span(name, run) : run()
  try {
    const upstream = await span("upstream-fetch", async () => await requestFetch(
      targetUrl(target, path, new URL(request.url).search),
      workspaceRelayForwardRequestInit(request, relayHostToken, target.workspaceId, {
        signal: controller.signal,
        upstreamHeaders: target.upstreamHeaders,
      }),
    ))
    const headers = new Headers(upstream.headers)
    headers.delete("access-control-allow-origin")
    headers.delete("access-control-allow-credentials")
    headers.delete("access-control-allow-headers")
    headers.delete("access-control-allow-methods")
    headers.delete("access-control-expose-headers")
    headers.delete("access-control-max-age")
    for (const [key, value] of Object.entries(denyCorsHeaders(request, originAllowed) ?? {})) {
      headers.set(key, value)
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError"
    return Response.json(
      errorBody(
        aborted ? "upstream_timeout" : "upstream_unavailable",
        aborted ? "Workspace upstream timed out" : "Workspace upstream is unavailable",
      ),
      { status: aborted ? 504 : 503, headers: denyCorsHeaders(request, originAllowed) },
    )
  } finally {
    clearTimeout(timer)
  }
}

export type WorkspaceRelayApp = Hono & {
  /**
   * T16: clear the sampler's periodic flush timer. Tests must call this so
   * `setInterval` doesn't keep the process alive after the test exits.
   */
  disposeAuditSampler(): void
}

/**
 * T31: read the suppressed-accept counter for a given options object. Surfaced
 * for the `/metrics` route handler. Returns 0 if no sampler state has been
 * created yet (no requests have been audit-sampled), which is the same value
 * an external observer would see.
 */
export function getAuditSuppressedCount(options: WorkspaceRelayOptions): number {
  return auditSamplers.get(options)?.suppressedCount ?? 0
}

const LOOPBACK_REMOTES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
])

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const trimmed = address.trim()
  if (LOOPBACK_REMOTES.has(trimmed)) return true
  // 127.0.0.0/8 — anything starting with `127.` is loopback per RFC 5735.
  if (/^127\./.test(trimmed)) return true
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.99).
  if (/^::ffff:127\./i.test(trimmed)) return true
  return false
}

type MetricsAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; code: string; message: string }

function checkMetricsAuth(options: WorkspaceRelayOptions, request: Request): MetricsAuthResult {
  if (options.metricsToken) {
    const presented = bearerToken(request.headers.get("authorization") ?? undefined)
    if (!presented || presented !== options.metricsToken) {
      return {
        ok: false,
        status: 401,
        code: "metrics_unauthorized",
        message: "Metrics endpoint requires a valid bearer token",
      }
    }
    return { ok: true }
  }
  // No token configured: gate on loopback. If no resolver is wired, fail
  // closed; production should set either `metricsToken` or
  // `metricsRemoteAddress`, and the Bun adapter wires the latter by default.
  if (!options.metricsRemoteAddress) {
    return {
      ok: false,
      status: 401,
      code: "metrics_unauthorized",
      message: "Metrics endpoint is restricted to loopback or bearer-token clients",
    }
  }
  const address = options.metricsRemoteAddress(request)
  if (isLoopbackAddress(address)) return { ok: true }
  return {
    ok: false,
    status: 401,
    code: "metrics_unauthorized",
    message: "Metrics endpoint is restricted to loopback or bearer-token clients",
  }
}

function buildMetricsBody(options: WorkspaceRelayOptions): WorkspaceRelayMetrics {
  const sources = options.metricsSources ?? {}
  const fragmentation = sources.fragmentation?.() ?? { fragmentsBuffered: 0, oversizedClosed: 0 }
  const slowConsumer = sources.slowConsumer?.() ?? {
    overflowEvents: 0,
    timerFired: 0,
    droppedRequests: 0,
  }
  const activeHostCount = options.directory?.size?.() ?? 0
  const suppressedAccepts = getAuditSuppressedCount(options)
  const body: WorkspaceRelayMetrics = {
    fragmentation,
    slowConsumer,
    directory: { activeHostCount },
    audit: { suppressedAccepts },
  }
  if (sources.drainPending) {
    body.drain = { pendingCount: sources.drainPending() }
  }
  return body
}

export function createWorkspaceRelay(options: WorkspaceRelayOptions): WorkspaceRelayApp {
  const app = new Hono() as WorkspaceRelayApp
  const originAllowed = originMatcherFor(options)

  app.use("*", cors({
    origin: (origin) => {
      if (!origin) return undefined
      return originAllowed(origin) ? origin : undefined
    },
    allowHeaders: [
      "Accept",
      "Authorization",
      "Content-Type",
      "X-Daytona-Skip-Preview-Warning",
      "X-Workspace-Id",
      "X-OpenCode-Directory",
      "X-Claxedo-Runner",
      "X-Claxedo-Model",
      "X-Claxedo-Draft-Id",
      "X-Claxedo-Binary",
    ],
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }))

  app.get("/health", (c) => {
    // T9: report unhealthy as soon as draining starts so Fly removes this
    // instance from routing.
    if (options.isDraining?.()) {
      return c.json(
        { ok: false, service: "workspace-relay", draining: true },
        503,
      )
    }
    return c.json({ ok: true, service: "workspace-relay" })
  })

  /**
   * JWKS endpoint for the Relay Host Token (RHT) signing key(s).
   *
   * Mirror of the RAT JWKS endpoint on `claxedo-server`. Publishes the public
   * counterpart of the relay's RHT signing key so the Workspace Host Service
   * can verify RHTs via `jose.createRemoteJWKSet` and the relay's signing key
   * can be rotated without redeploying every workspace VM.
   *
   * 503 when no keys are configured (so misconfiguration is loud rather than
   * silently serving an empty JWKS).
   */
  app.get("/.well-known/jwks.json", async (c) => {
    const sources = options.relayHostPublicKeys ?? []
    if (sources.length === 0) {
      return c.json(
        {
          error: {
            code: "jwks_no_keys_configured",
            message: "No Relay Host Token public keys are configured for the JWKS endpoint",
          },
        },
        503,
      )
    }
    let keys: JWK[]
    try {
      keys = await Promise.all(sources.map(async (source) => {
        const jwk = await exportJWK(source.publicKey)
        return {
          ...jwk,
          kid: source.kid,
          alg: "EdDSA",
          use: "sig",
        }
      }))
    } catch (err) {
      return c.json(
        {
          error: {
            code: "jwks_invalid_key",
            message: "A configured RHT public key could not be exported as a JWK",
            detail: err instanceof Error ? err.message : String(err),
          },
        },
        500,
      )
    }
    c.header("cache-control", "public, max-age=300")
    return c.json({ keys })
  })

  app.disposeAuditSampler = () => disposeAuditSampler(options)

  /**
   * T31: ops-only metrics endpoint. Surfaces fragmentation, slow-consumer,
   * directory size, audit suppressed-accept count, and drain pending count.
   *
   * Auth model:
   *   - If `metricsToken` is configured, every request MUST present
   *     `Authorization: Bearer <metricsToken>` (loopback or not).
   *   - Otherwise the endpoint requires the caller to be loopback. The
   *     loopback check uses `metricsRemoteAddress(request)` — when that is
   *     also unset (no resolver wired), the endpoint fails closed.
   */
  app.get("/metrics", (c) => {
    const authResult = checkMetricsAuth(options, c.req.raw)
    if (!authResult.ok) {
      return c.json(
        errorBody(authResult.code, authResult.message),
        authResult.status,
      )
    }
    return c.json(buildMetricsBody(options))
  })

  app.all("/workspaces/:workspaceId/*", async (c) => {
    const trace = createWorkspaceRelayTrace()
    // T9: cheap fast-path before auth so a draining instance never even
    // verifies a token for a request it can't serve. Mirrors the same
    // short-circuit in the Bun adapter for the cloud-vm direct path.
    if (options.isDraining?.()) {
      return Response.json(
        errorBody("relay_draining", "Workspace relay is shutting down; try another instance"),
        { status: 503, headers: denyCorsHeaders(c.req.raw, originAllowed) },
      )
    }
    const response = await trace.span("relay-total", async () => {
      const relay = await authorizeWorkspaceRelayRequest(options, c.req.raw, c.req.param("workspaceId"), trace)
      if (!relay.ok) return relay.response
      return await forwardWorkspaceRelayRequest(
        new Request(c.req.raw),
        relay.request.target,
        relay.request.relayHostToken,
        relay.request.path,
        options.fetch ?? fetch,
        options.forwardTimeoutMs ?? 30_000,
        trace,
        originAllowed,
      )
    })
    return workspaceRelayTimingResponse(response, trace)
  })

  return app
}
