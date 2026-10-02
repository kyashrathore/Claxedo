import { isRecord } from "@claxedo/helpers/guards"
import { sessionScopeReaches, type RuntimeAccessVerifierClaims, type TokenVerifier } from "@claxedo/workspace-relay-protocol"
import {
  WorkspaceRelayAuthError,
  isHostGeneration,
  mintRelayHostToken,
  validateRuntimeAccessTokenClaims,
  verifyRuntimeAccessToken,
  type HostTunnelTokenClaims,
  isRelayBacking,
  type RelayBacking,
  type RelayJwtAlgorithm,
  type RelayKey,
  type RelayRole,
  type RuntimeAccessTokenClaims,
} from "./auth"
import type { WorkspaceRelayDirectory } from "./directory"
import { bearerToken, errorBody } from "./http"
import { isHostTunnelTarget } from "./host-tunnel-forwarding"

export type WorkspaceRelayTarget = {
  workspaceId: string
  hostId: string
  baseUrl: string
  backing: RelayBacking
}

export type RuntimeAccessTokenActiveResult =
  | {
      active: true
    }
  | {
      active: false
      code: string
      reason: string
    }


export function parseWorkspaceRelayTarget(input: unknown): WorkspaceRelayTarget | undefined {
  if (!isRecord(input)) return undefined
  const row = input
  const { workspaceId, hostId, baseUrl } = row
  if (typeof workspaceId !== "string" || typeof hostId !== "string" || typeof baseUrl !== "string") return undefined
  // `access` is the retired spelling of the same fact. A payload carrying it
  // came from a control plane on the other side of the placement change, whose
  // `backing` may disagree with it; drop the target rather than pick one.
  if (row.access !== undefined) return undefined
  if (!isRelayBacking(row.backing)) return undefined
  if (!isAllowedRelayTargetBaseUrl({ baseUrl, backing: row.backing })) return undefined
  return {
    workspaceId,
    hostId,
    baseUrl,
    backing: row.backing,
  }
}

export function parseRuntimeAccessTokenActiveResult(input: unknown): RuntimeAccessTokenActiveResult | undefined {
  if (!isRecord(input)) return undefined
  const row = input
  if (row.active === true) return { active: true }
  if (row.active !== false) return undefined
  if (typeof row.code !== "string" || typeof row.reason !== "string") return undefined
  return { active: false, code: row.code, reason: row.reason }
}

/**
 * `GET /internal/relay/host-generation?enrollmentId=` as the control plane
 * answers it: the enrollment's current serving generation, or 404 for an
 * enrollment it does not know (`undefined` here).
 */
export type HostGenerationResult = {
  enrollmentId: string
  generation: number
  revoked: boolean
}

function parseHostGenerationResult(input: unknown): HostGenerationResult | undefined {
  if (!isRecord(input)) return undefined
  const row = input
  if (typeof row.enrollmentId !== "string" || !row.enrollmentId.trim()) return undefined
  if (!isHostGeneration(row.generation) || typeof row.revoked !== "boolean") return undefined
  return { enrollmentId: row.enrollmentId, generation: row.generation, revoked: row.revoked }
}

const HOST_GENERATION_LOOKUP_TIMEOUT_MS_DEFAULT = 5_000

/** The control plane's 404 body for an enrollment it does not know; any other 404 is a missing route. */
const HOST_GENERATION_ENROLLMENT_NOT_FOUND_CODE = "relay_resolver_enrollment_not_found"

export type HostGenerationResolverLookupOptions = {
  headers: Record<string, string>
  fetch?: (url: URL, init: RequestInit) => Promise<Response>
  /** Deadline per lookup; past it the lookup rejects, which the relay grades as unavailable. */
  timeoutMs?: number
}


export function createHostGenerationResolverLookup(url: string, options: HostGenerationResolverLookupOptions): HostGenerationLookup {
  const fetcher = options.fetch ?? ((target, init) => fetch(target, init))
  const timeoutMs = options.timeoutMs ?? HOST_GENERATION_LOOKUP_TIMEOUT_MS_DEFAULT
  return async ({ enrollmentId }) => {
    const target = new URL(url)
    target.searchParams.set("enrollmentId", enrollmentId)
    const res = await fetcher(target, { headers: options.headers, signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 404) {
      const body: unknown = await res.json().catch(() => undefined)
      const error = isRecord(body) && isRecord(body.error) ? body.error : undefined
      if (error?.code === HOST_GENERATION_ENROLLMENT_NOT_FOUND_CODE) return undefined
      throw new Error(`relay host-generation resolver failed: 404 (no host-generation route at ${url})`)
    }
    if (!res.ok) throw new Error(`relay host-generation resolver failed: ${res.status} ${await res.text()}`)
    const result = parseHostGenerationResult(await res.json())
    if (!result) throw new Error("relay host-generation resolver returned a malformed result")
    return result
  }
}

export function hostTunnelIncumbentOutranks(incumbentGeneration: number, candidateGeneration: number) {
  return incumbentGeneration > candidateGeneration
}

function parseAbsoluteHttpUrl(baseUrl: string): URL | undefined {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return undefined
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
}

/**
 * The only destinations a `cloud-vm` target may reach over plaintext HTTP:
 * loopback, where the Relay Host Token on the request cannot leave the
 * machine. `127.0.0.0/8` is matched on the URL-normalised hostname — WHATWG
 * parsing already canonicalises `127.1`/`0177.0.0.1` forms — and each octet
 * is range-checked so a literal `127.999.1.1` hostname stays untrusted.
 */
function isLoopbackTargetHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host === "[::1]" || host.endsWith(".localhost")) return true
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return !!ipv4 && ipv4.slice(1).every((octet) => Number(octet) <= 255)
}

/**
 * Whether a resolved target's `baseUrl` names a destination the relay may
 * forward to.
 *
 * A `cloud-vm` target is fetched over the network with the Relay Host Token
 * attached, so it must be HTTPS — or HTTP to a loopback host, the only
 * plaintext transport that cannot put the token on a network. A
 * `local-worktree` target is reached over the host tunnel and its `baseUrl` is
 * never fetched — the control plane sends the empty string — so only that
 * placeholder or a well-formed HTTP(S) URL is admitted.
 */
function isAllowedRelayTargetBaseUrl(target: { baseUrl: string; backing: RelayBacking }): boolean {
  if (isHostTunnelTarget(target)) {
    if (target.baseUrl === "") return true
    return parseAbsoluteHttpUrl(target.baseUrl) !== undefined
  }
  const url = parseAbsoluteHttpUrl(target.baseUrl)
  if (!url) return false
  return url.protocol === "https:" || isLoopbackTargetHostname(url.hostname)
}

export type RevocationLookupArgs = { jti: string; workspaceId: string; hostId: string }
export type RevocationLookup = (args: RevocationLookupArgs) => Promise<RuntimeAccessTokenActiveResult>

export type CachedRevocationOptions = {
  /** TTL in milliseconds for cached revocation responses. Defaults to 10_000. */
  ttlMs?: number
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * `generation` is the value the caller holds (a token's, a socket's). The
 * cached client uses it to decide whether a cached answer may stand in for a
 * fresh one; an uncached lookup ignores it. Resolves `undefined` for an
 * unknown enrollment and THROWS when the control plane cannot be reached —
 * the throw is the "unavailable" signal every consumer grades separately.
 */
export type HostGenerationLookupArgs = { enrollmentId: string; generation: number }
export type HostGenerationLookup = (args: HostGenerationLookupArgs) => Promise<HostGenerationResult | undefined>

export type CachedHostGenerationOptions = {
  /** TTL in milliseconds for cached host-generation answers. Defaults to 10_000. */
  ttlMs?: number
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
}

export type TargetLookupArgs = { workspaceId: string; hostId: string; routingId?: string }
export type TargetLookup = (args: TargetLookupArgs) => Promise<WorkspaceRelayTarget | undefined>

export type WorkspaceRelayAuditEvent = {
  action:
    | "relay.request.accepted"
    | "relay.request.denied"
    | "relay.request.suppressed_summary"
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
   * Only set on `relay.request.suppressed_summary` events. Counts the
   * number of `relay.request.accepted` audit events that were dropped by the
   * sampler in the previous flush interval.
   */
  suppressedCount?: number
}

export type WorkspaceRelayAuthOptions = {
  runtimeAccessKey: RelayKey
  /**
   * Serving-generation fence for host tunnels. A relay composed without it
   * refuses every host tunnel `host_generation_unverifiable`.
   */
  resolveHostGeneration?: HostGenerationLookup
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
   * through (issuer-signed tokens, OIDC introspection, custom keys, etc.).
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
   * `kid` to embed in the protected header of freshly minted RHTs. When
   * provided, verifiers can dispatch on `kid` to pick the matching key from
   * the published JWKS, so it must be the `kid` of the current key the Worker
   * publishes at `/.well-known/jwks.json`.
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
}

export type WorkspaceRelayTelemetryOptions = {
  audit?: (event: WorkspaceRelayAuditEvent) => void | Promise<void>
  /**
   * Probability (0.0 – 1.0) at which `relay.request.accepted` audit
   * events are emitted to the user `audit` callback. Denies are never
   * sampled. When unset, defaults to 1.0 (emit every accept). Suppressed
   * accepts are aggregated into a periodic `relay.request.suppressed_summary`
   * event (see `auditFlushIntervalMs`).
   */
  auditAcceptSampleRate?: number
  /**
   * How often (ms) the sampler emits a `relay.request.suppressed_summary`
   * audit event with the count of suppressed accepts in the past interval.
   * Defaults to 60_000 (one minute). When sample rate is 1.0 no interval is
   * armed (nothing to flush). Exposed for tests.
   */
  auditFlushIntervalMs?: number
  /**
   * Random source for audit and trace sampling. Defaults to `Math.random`.
   * Override for deterministic tests.
   */
  random?: () => number
}

export type WorkspaceRelayOptions =
  & WorkspaceRelayAuthOptions
  & WorkspaceRelayHostTokenOptions
  & WorkspaceRelayRoutingOptions
  & WorkspaceRelayTelemetryOptions

export type AuthorizedWorkspaceRelayRequest = {
  claims: RuntimeAccessTokenClaims
  target: WorkspaceRelayTarget
  relayHostToken: string
  path: string
}

export type WorkspaceRelayAuthorizeTrace = {
  span<T>(name: string, run: () => Promise<T>): Promise<T>
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
const REVOCATION_CACHE_TTL_MS_DEFAULT = 10_000

export const RUNTIME_ACCESS_TOKEN_ACTIVE_CHECK_INTERVAL_MS_DEFAULT = 30_000
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
  const ttlMs = options.ttlMs ?? REVOCATION_CACHE_TTL_MS_DEFAULT
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
 * The longest a revoked Runtime Access Token can keep working after the
 * authority records the revocation, derived from the configured TTLs rather
 * than measured timing.
 *
 * Every relayed HTTP request re-runs the active check, so a cached `active`
 * answer delays denial by at most `revocationCacheTtlMs`. An established
 * socket adds at most one re-check interval — its watcher can tick just
 * before the stale entry expires — so pass the room's
 * `runtimeAccessTokenActiveCheckIntervalMs` as `activeCheckIntervalMs`;
 * omit it for the per-request path. A non-positive interval means the socket
 * has no revocation watcher at all and the function reports no bound: the
 * token's `exp`, enforced locally by the socket expiry timer, is then the
 * only deadline, and it caps every path even while the revocation authority
 * is unreachable.
 */
export function runtimeAccessTokenRevocationDelayMs(input: {
  revocationCacheTtlMs?: number
  activeCheckIntervalMs?: number
} = {}): number {
  const configuredTtl = input.revocationCacheTtlMs ?? REVOCATION_CACHE_TTL_MS_DEFAULT
  const ttlMs = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 0
  if (input.activeCheckIntervalMs === undefined) return ttlMs
  if (!Number.isFinite(input.activeCheckIntervalMs) || input.activeCheckIntervalMs <= 0) {
    return Number.POSITIVE_INFINITY
  }
  return ttlMs + input.activeCheckIntervalMs
}

/**
 * Caches host-generation answers by enrollment id with the fence's own rules:
 * a cached answer stands only while it is at least the caller's generation
 * (equal admits; higher is a refusal that needs no fresh read), and a caller
 * holding a HIGHER generation than the cache — or than the answer an in-flight
 * lookup settles on — forces a refresh so a fresh `acquire` is never refused
 * on a stale answer. Unknown enrollments and failures are not cached;
 * concurrent misses share one lookup.
 */
export function createCachedHostGenerationClient(
  inner: HostGenerationLookup,
  options: CachedHostGenerationOptions = {},
): HostGenerationLookup {
  const ttlMs = options.ttlMs ?? 10_000
  const now = options.now ?? Date.now
  const cache = new Map<string, {
    expiresAt: number
    promise?: Promise<HostGenerationResult | undefined>
    result?: HostGenerationResult
  }>()

  return async (args) => {
    for (;;) {
      const at = now()
      const entry = cache.get(args.enrollmentId)
      if (entry && entry.expiresAt > at) {
        if (entry.result && entry.result.generation >= args.generation) return entry.result
        if (!entry.result && entry.promise) {
          // A lookup another caller started may have been answered for a
          // lower generation than this caller holds; that answer is as stale
          // for it as a cached one would be, so re-read after it settles.
          const shared = await entry.promise
          if (!shared || shared.generation >= args.generation) return shared
          continue
        }
      }

      const promise = inner(args)
        .then((result) => {
          pruneExpiringCache(cache, now(), RESOLVER_CACHE_MAX_ENTRIES)
          if (result) cache.set(args.enrollmentId, { result, expiresAt: now() + ttlMs })
          else cache.delete(args.enrollmentId)
          return result
        })
        .catch((err) => {
          cache.delete(args.enrollmentId)
          throw err
        })
      cache.set(args.enrollmentId, { promise, expiresAt: at + ttlMs })
      return await promise
    }
  }
}

/**
 * `retryable: false` means the control plane refused this generation, so the
 * host must not simply reconnect with it; `retryable: true` means the control
 * plane could not be asked, and a reconnect is the recovery.
 */
export type HostTunnelGenerationDecision =
  | { ok: true }
  | {
      ok: false
      retryable: false
      code:
        | "host_generation_superseded"
        | "host_generation_unknown"
        | "host_generation_unverifiable"
        | "host_enrollment_revoked"
        | "host_enrollment_unknown"
      reason: string
    }
  | {
      ok: false
      retryable: true
      code: "host_generation_lookup_unavailable"
      reason: string
    }

export async function checkHostTunnelGeneration(
  lookup: HostGenerationLookup | undefined,
  claims: Pick<HostTunnelTokenClaims, "enrollment_id" | "generation">,
): Promise<HostTunnelGenerationDecision> {
  if (!lookup) {
    return {
      ok: false,
      retryable: false,
      code: "host_generation_unverifiable",
      reason: "Host tunnel generation cannot be verified by a relay without a host-generation resolver",
    }
  }
  let result: HostGenerationResult | undefined
  try {
    result = await lookup({ enrollmentId: claims.enrollment_id, generation: claims.generation })
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      code: "host_generation_lookup_unavailable",
      reason: `Host generation lookup is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!result) {
    return { ok: false, retryable: false, code: "host_enrollment_unknown", reason: "Host enrollment is unknown" }
  }
  if (result.revoked) {
    return { ok: false, retryable: false, code: "host_enrollment_revoked", reason: "Host enrollment was revoked" }
  }
  if (result.generation > claims.generation) {
    return { ok: false, retryable: false, code: "host_generation_superseded", reason: "Host tunnel generation was superseded" }
  }
  if (result.generation < claims.generation) {
    return { ok: false, retryable: false, code: "host_generation_unknown", reason: "Host tunnel generation is ahead of the control plane" }
  }
  return { ok: true }
}

export function createCoalescedTargetClient(inner: TargetLookup): TargetLookup {
  const pending = new Map<string, Promise<WorkspaceRelayTarget | undefined>>()
  return (args) => {
    const key = `${args.workspaceId}\0${args.hostId}\0${args.routingId ?? ""}`
    const existing = pending.get(key)
    if (existing) return existing
    const promise = Promise.resolve().then(() => inner(args)).finally(() => {
      if (pending.get(key) === promise) pending.delete(key)
    })
    if (pending.size < RESOLVER_CACHE_MAX_ENTRIES) pending.set(key, promise)
    return promise
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
   * When true, also strip the `Cookie` request header. A host tunnel ends on a
   * machine somebody uses, whose cookie jar the browser may share (localhost
   * dev tooling); passing cookies verbatim risks leaking session data to it. A
   * cloud-vm sits behind a dedicated network boundary where a session cookie
   * may legitimately be needed, so the default is to not strip cookies.
   */
  hostTunnel?: boolean
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
  if (options.hostTunnel) headers.delete("cookie")
  // Bun's fetch auto-decodes gzip/br responses but errors on malformed
  // upstream content-encoding. Force identity encoding so the body streams
  // through verbatim and the browser handles decompression.
  headers.set("accept-encoding", "identity")
  headers.delete("authorization")
  headers.delete("Authorization")
  headers.set("Authorization", `Bearer ${relayHostToken}`)
  headers.set("x-workspace-id", workspaceId)
  // Single relay-controlled marker that lets the host service distinguish
  // traffic coming through the relay from any other inbound source. We do not
  // attempt to preserve a client IP here because the relay is not behind a
  // trusted proxy in our deployment, so any inbound x-forwarded-for value is
  // attacker-controlled and has already been removed above.
  headers.set("x-forwarded-by", "workspace-relay")
  return headers
}

function targetUrl(target: WorkspaceRelayTarget, path: string, search: string) {
  const base = new URL(target.baseUrl.endsWith("/") ? target.baseUrl : `${target.baseUrl}/`)
  // `path` is request text, but `new URL(path, base)` honours a scheme or
  // `//host` inside it — "http:other.example/x" resolves absolute and the
  // fetch would carry the Relay Host Token to that origin. The pathname
  // setter treats the whole string as path text and keeps it on the
  // validated target's origin.
  const url = new URL(base)
  url.pathname = `${base.pathname}${path.replace(/^\/+/, "")}`
  url.search = search
  url.hash = ""
  return url
}

function relayRuntimePath(request: Request) {
  try {
    const decoded = decodeURIComponent(new URL(request.url).pathname.replace(/^\/workspaces\/[^/]+\/?/, "/"))
      .replace(/^\/+/, "/")
    // Authorize on the SAME pathname that will be forwarded. `targetUrl` resolves
    // the path through `new URL`, which parses any `?`/`#` a decoded %3F/%23
    // introduced as query/fragment and drops it from the pathname. Resolve it the
    // same way here so a viewer cannot smuggle `/api/wr/pty%3Fx` (authz sees
    // "/api/wr/pty?x", which a path rule misses, but forwarding hits the real
    // "/api/wr/pty") past the gate. Query strings ride in `request.url` search,
    // not the pathname, so legitimate requests are unaffected.
    return new URL(decoded.replace(/^\/+/, ""), "http://relay.invalid/").pathname
  } catch {
    return undefined
  }
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
    claims.principal_kind,
    claims.actor_id,
    claims.actor_kind,
    claims.org_id,
    claims.role,
    claims.workspace_id,
    claims.host_id,
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

function relayHostMintInput(
  options: WorkspaceRelayOptions,
  claims: RuntimeAccessTokenClaims,
  target: WorkspaceRelayTarget,
) {
  return {
    principalKind: claims.principal_kind,
    actorId: claims.actor_id,
    userId: claims.user_id,
    actorKind: claims.actor_kind,
    parentJti: claims.jti,
    ...(claims.actor_public_id && claims.actor_name
      ? {
          actorPublicId: claims.actor_public_id,
          actorName: claims.actor_name,
          ...(claims.actor_avatar_url ? { actorAvatarUrl: claims.actor_avatar_url } : {}),
        }
      : {}),
    ...(claims.channel_identity
      ? {
          channelIdentity: {
            channel: claims.channel_identity.channel,
            externalUserId: claims.channel_identity.external_user_id,
            identityVersion: claims.channel_identity.identity_version,
          },
        }
      : {}),
    orgId: claims.org_id,
    role: claims.role,
    ...(claims.session_id ? { sessionId: claims.session_id } : {}),
    ...target,
    ...(options.relayHostMintKid ? { kid: options.relayHostMintKid } : {}),
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
      promise = mintRelayHostToken(
        relayHostMintInput(options, claims, target),
        options.relayHostSigningKey,
        options.relayHostAlgorithm,
      )
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
    await mintRelayHostToken(
      relayHostMintInput(options, claims, target),
      options.relayHostSigningKey,
      options.relayHostAlgorithm,
    )
  )
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
 * Sampler state lives on a WeakMap keyed by the options object, so every
 * authorization made with the same options — a room's HTTP requests and
 * WebSocket admissions alike — shares one suppressed counter and flush timer.
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

/** Stops the flush timer for `options` and emits any suppressed count it still holds. */
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
  return Response.json(errorBody(input.code, input.message), { status: input.status })
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
    if (!path || !sessionScopeReaches(claims.session_id, path, new URL(request.url).search)) {
      return {
        ok: false,
        code: "relay_scope_denied",
        response: await deny(options, {
          code: "relay_scope_denied",
          message: "Runtime Access Token scope does not reach this relay request",
          status: 403,
          claims,
          request,
        }),
      }
    }
    const target = await span("target-resolve", async () => await options.resolveTarget(claims))
    if (
      !target
      || target.workspaceId !== claims.workspace_id
      || target.hostId !== claims.host_id
      // A programmatic resolveTarget never passed through the resolver wire
      // parse, so the same destination rule is applied again here, the last
      // check before the room forwards.
      || !isAllowedRelayTargetBaseUrl(target)
    ) {
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
      isHostTunnelTarget(target)
      && !options.directory?.activeHost({ hostId: target.hostId, workspaceId: target.workspaceId })
    ) {
      return {
        ok: false,
        code: "host_tunnel_offline",
        response: await deny(options, {
          code: "host_tunnel_offline",
          message: "The machine serving this workspace is offline",
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
