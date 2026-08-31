// Global concurrency limiter for outbound HTTP fetches. Mirrors the
// HTTP/1.1 connection-pool semantics at the JS layer so a bootstrap that
// fires N parallel requests doesn't pile 30+ items into the browser's
// network queue — it lets at most CAP run at a time and queues the rest in
// FIFO order. Without this cap, a multi-workspace bootstrap can stall for
// 20–180s on app open because every workspace's per-directory fan-out
// competes against the 2 SSE streams the app holds open permanently.
//
// Long-lived requests (SSE streams) must NOT hold a slot, or the
// throttle's queue would never drain. Callers identify these requests via
// the `bypassFetchThrottle` marker below, or via an `Accept:
// text/event-stream` header which we detect heuristically.

const DEFAULT_CAP = 4

// Keep the marker out of the HTTP request. A wire header would trigger CORS
// preflights for control-plane calls and require every server to allow-list a
// client-only scheduling detail. Auth fetch preserves enumerable symbol keys
// when it enriches RequestInit, while the native fetch implementation ignores
// the extra property.
const FETCH_BYPASS = Symbol("fetch-bypass-throttle")
type FetchThrottleInit = RequestInit & { [FETCH_BYPASS]?: true }

function requestPathname(input?: string | URL | Request): string | undefined {
  if (!input) return
  const raw = input instanceof Request ? input.url : String(input)
  try {
    return new URL(raw, "http://local.invalid").pathname
  } catch {
    return raw.split("?")[0]
  }
}

/**
 * Long-lived event streams identified by path, even when Accept was dropped
 * (e.g. `new Request(nextUrl, previousRequest)` does not copy headers in
 * every runtime). These must never occupy a throttle slot.
 */
export function isEventStreamPath(input?: string | URL | Request): boolean {
  const pathname = requestPathname(input)
  if (!pathname) return false
  if (pathname === "/event" || pathname === "/global/event") return true
  if (pathname.endsWith("/api/wr/events") || pathname.endsWith("/api/wr/runtime-events")) return true
  return /^\/workspaces\/[^/]+\/(global\/)?event$/.test(pathname)
}

function isEventStreamRequest(init?: RequestInit | undefined, input?: string | URL | Request): boolean {
  if (isEventStreamPath(input)) return true
  const accept = (() => {
    const h = init?.headers
    if (!h) return undefined
    if (h instanceof Headers) return h.get("Accept") ?? undefined
    if (Array.isArray(h)) {
      const row = h.find(([k]) => k.toLowerCase() === "accept")
      return row?.[1]
    }
    const rec = h as Record<string, string>
    return rec["Accept"] ?? rec["accept"] ?? undefined
  })()
  if (accept && accept.includes("text/event-stream")) return true
  if (input instanceof Request) {
    const v = input.headers.get("Accept")
    if (v && v.includes("text/event-stream")) return true
  }
  return false
}

// Attaches the local-only bypass marker to an init. Long-lived consumers (SSE,
// bounded long polls, WS upgrades) pass their init through this so they never
// occupy an ordinary request slot.
export function bypassFetchThrottle<T extends RequestInit>(init: T): T {
  return { ...init, [FETCH_BYPASS]: true } as T
}

// Read side of the marker. Survives object spread (own enumerable symbol
// key), so intermediaries that clone inits via `{ ...init }` keep it.
export function isFetchThrottleBypassed(init?: RequestInit): boolean {
  return (init as FetchThrottleInit | undefined)?.[FETCH_BYPASS] === true
}

type FetchThrottle = {
  acquire: () => Promise<() => void>
  inFlight: () => number
  queued: () => number
}

function createThrottle(cap: number): FetchThrottle {
  let running = 0
  const waiters: Array<() => void> = []

  const release = () => {
    running -= 1
    const next = waiters.shift()
    if (next) next()
  }

  const acquire = async () => {
    if (running < cap) {
      running += 1
      return release
    }
    await new Promise<void>((resolve) => {
      waiters.push(() => {
        running += 1
        resolve()
      })
    })
    return release
  }

  return {
    acquire,
    inFlight: () => running,
    queued: () => waiters.length,
  }
}

let globalThrottle: FetchThrottle | undefined

export function getFetchThrottle(): FetchThrottle {
  if (!globalThrottle) globalThrottle = createThrottle(DEFAULT_CAP)
  if (typeof window !== "undefined") {
    // as-any: exposes throttle counters on an untyped browser debug hook.
    ;(window as unknown as { __fetchThrottle?: { inFlight: number; queued: number; cap: number } }).__fetchThrottle = {
      get inFlight() { return globalThrottle!.inFlight() },
      get queued() { return globalThrottle!.queued() },
      cap: DEFAULT_CAP,
    } as never
  }
  return globalThrottle
}

// Test-only override so suites can drive deterministic concurrency limits
// or reset between tests. Production code should never call this.
export function __setFetchThrottleForTests(cap: number) {
  globalThrottle = createThrottle(cap)
}

export function __resetFetchThrottleForTests() {
  globalThrottle = undefined
}

/**
 * Wraps an underlying fetch call with the global concurrency cap.
 * SSE streams and explicitly-marked bypass requests skip the cap so
 * long-lived connections cannot starve the queue.
 */
export async function throttledFetch(
  underlying: () => Promise<Response>,
  init?: RequestInit | undefined,
  input?: string | URL | Request,
): Promise<Response> {
  if (isEventStreamRequest(init, input) || isFetchThrottleBypassed(init)) {
    return underlying()
  }
  const release = await getFetchThrottle().acquire()
  try {
    return await underlying()
  } finally {
    release()
  }
}
