import type { Placement } from "@/platform/runtime/placement"
import { queryClient } from "@/platform/query/query-client"
import { centralTransportForServer } from "@/platform/runtime/transport"

/**
 * Shared caching + transport plumbing for the two terminal-scoped fetchers
 * (`terminal-session-preview` and `terminal-log-summary`). Both previously
 * reimplemented the identical text normalizer, origin resolver, TTL staleness
 * check, query-client response-cache + in-flight coalescing pair, and
 * cloud-vs-local transport placement. Consolidating here means a fix to the
 * caching/dedupe logic propagates to both; each caller keeps only its distinct
 * cache-key composition, request path, and parse logic.
 */

/** Trim a value to a string, or "" if it is not a string. */
export const normalizeText = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/** Best-effort origin of a URL, falling back to the current window origin. */
export const originOf = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    if (typeof window !== "undefined") return window.location.origin
    return ""
  }
}

/** TTL budget for a cached entry: `hit` for a present value, `miss` for null. */
export type CacheTtl = { hit: number; miss: number }

type CacheEntry<T> = { value: T | null; at: number }

/** A cached entry is stale once older than its value-dependent TTL (or absent). */
export const isCacheEntryStale = <T>(entry: CacheEntry<T> | undefined, ttl: CacheTtl) => {
  if (!entry) return true
  const limit = entry.value ? ttl.hit : ttl.miss
  return Date.now() - entry.at > limit
}

/**
 * Read a fresh cached value, evicting and reporting `undefined` when stale so
 * the caller can decide whether to refetch. Distinguishes a fresh `null`
 * (known-empty) from `undefined` (unknown / needs load).
 */
export const readCachedEntry = <T>(cacheKey: readonly unknown[], ttl: CacheTtl): T | null | undefined => {
  const existing = queryClient.getQueryData<CacheEntry<T>>(cacheKey)
  if (isCacheEntryStale(existing, ttl)) {
    queryClient.removeQueries({ queryKey: cacheKey })
    return undefined
  }
  return existing?.value ?? null
}

/**
 * Response-cache + in-flight coalescing over the global queryClient. Returns a
 * fresh cached value, joins an in-flight request when one is running for the
 * same `requestKey`, otherwise invokes `run`, caches its result under
 * `cacheKey`, and clears the in-flight slot on settle. The in-flight promise
 * lives in the shared queryClient (never a module-private Map) so independent
 * consumers of the same target dedupe onto one request.
 */
export const loadCachedEntry = <T>(input: {
  cacheKey: readonly unknown[]
  requestKey: readonly unknown[]
  ttl: CacheTtl
  run: () => Promise<T | null>
}): Promise<T | null> => {
  const { cacheKey, requestKey, ttl, run } = input
  const existing = queryClient.getQueryData<CacheEntry<T>>(cacheKey)
  if (!isCacheEntryStale(existing, ttl)) return Promise.resolve(existing?.value ?? null)
  queryClient.removeQueries({ queryKey: cacheKey })

  const running = queryClient.getQueryData<Promise<T | null>>(requestKey)
  if (running) return running

  const next = run()
    .then((value) => {
      queryClient.setQueryData(cacheKey, { value, at: Date.now() } satisfies CacheEntry<T>)
      return value
    })
    .finally(() => {
      queryClient.removeQueries({ queryKey: requestKey })
    })

  queryClient.setQueryData(requestKey, next)
  return next
}

export type ResolvedWorkspaceRuntime = {
  kind?: "cloud" | "local" | "user-hosted" | null
  workspaceId?: string | null
} | null | undefined

/**
 * Transport placement for a terminal-scoped fetch: route non-local workspaces
 * that carry a workspaceId through the relay (loopback when the server itself
 * is loopback); everything else uses the server's default central transport.
 *
 * `workspace` is the caller's liveness read (`resolveWorkspaceRuntime`), which
 * hits the control plane's `/api/workspace/resolve` and — for a user-hosted
 * workspace addressed by its filesystem-path directory — never confirms a
 * kind there. `signedWorkspace` is that same directory's match in the signed
 * workspace inventory (the canonical resolver in
 * `platform/runtime/agent/signed-workspace.ts`, e.g.
 * `signedWorkspaceFromProjects`), passed by the caller when it has one. It is
 * consulted first so a confirmed signed match always wins the relay
 * placement even when the liveness read came back empty.
 */
export const terminalScopedPlacement = (
  site: string,
  workspace: ResolvedWorkspaceRuntime,
  signedWorkspace?: ResolvedWorkspaceRuntime,
): Placement => {
  const central = centralTransportForServer(site)
  const resolved = signedWorkspace?.kind && signedWorkspace.kind !== "local" && signedWorkspace.workspaceId
    ? signedWorkspace
    : workspace
  if (resolved?.kind && resolved.kind !== "local" && resolved.workspaceId) {
    return {
      workspaceId: resolved.workspaceId,
      hosting: "workspace",
      transport: central === "loopback" ? "loopback" : "workspace-relay",
    }
  }
  return { hosting: "workspace", transport: central }
}
