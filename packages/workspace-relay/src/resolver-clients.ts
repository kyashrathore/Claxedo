import { isRecord } from "@claxedo/helpers/guards"
import { isHostGeneration } from "./auth"
import type { WorkspaceRelayTarget } from "./relay-target"

export type RuntimeAccessTokenActiveResult =
  | {
      active: true
    }
  | {
      active: false
      code: string
      reason: string
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
const RESOLVER_CACHE_MAX_ENTRIES = 8192
const REVOCATION_CACHE_TTL_MS_DEFAULT = 10_000
const TARGET_CACHE_TTL_MS_DEFAULT = 10_000
export function pruneExpiringCache<T extends { expiresAt: number }>(cache: Map<string, T>, now: number, maxEntries: number) {
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
export type CachedTargetOptions = { ttlMs?: number; now?: () => number }
/**
 * Wraps the target lookup with a small in-memory cache keyed by workspace,
 * host and routing id. Only a resolved target is cached: a workspace whose
 * sandbox is still starting answers nothing, and must be seen the moment it
 * is ready. Concurrent misses share one lookup. A target that stopped keeps
 * answering for at most the TTL, the same lag the revocation cache allows.
 */
export function createCachedTargetClient(inner: TargetLookup, options: CachedTargetOptions = {}): TargetLookup {
  const ttlMs = options.ttlMs ?? TARGET_CACHE_TTL_MS_DEFAULT
  const now = options.now ?? Date.now
  const cache = new Map<string, { expiresAt: number; promise?: Promise<WorkspaceRelayTarget | undefined>; target?: WorkspaceRelayTarget }>()
  return async (args) => {
    const key = `${args.workspaceId}\0${args.hostId}\0${args.routingId ?? ""}`
    const at = now()
    const entry = cache.get(key)
    if (entry && entry.expiresAt > at) {
      if (entry.target) return entry.target
      if (entry.promise) return await entry.promise
    }
    const promise = inner(args)
      .then((target) => {
        pruneExpiringCache(cache, now(), RESOLVER_CACHE_MAX_ENTRIES)
        if (target) cache.set(key, { target, expiresAt: now() + ttlMs })
        else cache.delete(key)
        return target
      })
      .catch((err) => {
        cache.delete(key)
        throw err
      })
    cache.set(key, { promise, expiresAt: at + ttlMs })
    return await promise
  }
}
