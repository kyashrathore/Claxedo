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
// the `bypassFetchThrottle` symbol below, or via an `Accept:
// text/event-stream` header which we detect heuristically.

const DEFAULT_CAP = 4

// Attaching this symbol to RequestInit.signal via a side-channel won't work
// because Request copies headers/init but not arbitrary properties. We use
// a WeakSet of fetch input identifiers (the input arg itself when it's a
// Request, or an explicit init.headers["X-Fetch-Bypass"] marker for the
// string/URL case). Callers shouldn't depend on a particular shape — the
// `bypassFetchThrottle()` helper hides it.
const FETCH_BYPASS_HEADER = "x-fetch-bypass-throttle"

function isEventStreamRequest(init?: RequestInit | undefined, input?: string | URL | Request): boolean {
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

function hasBypassHeader(init?: RequestInit | undefined, input?: string | URL | Request): boolean {
  const seek = (h: HeadersInit | undefined) => {
    if (!h) return false
    if (h instanceof Headers) return h.has(FETCH_BYPASS_HEADER)
    if (Array.isArray(h)) return h.some(([k]) => k.toLowerCase() === FETCH_BYPASS_HEADER)
    const rec = h as Record<string, string>
    return rec[FETCH_BYPASS_HEADER] !== undefined || rec[FETCH_BYPASS_HEADER.toUpperCase()] !== undefined
  }
  if (seek(init?.headers)) return true
  if (input instanceof Request && input.headers.has(FETCH_BYPASS_HEADER)) return true
  return false
}

// Attaches the bypass marker to an init. Long-lived consumers (SSE, WS
// upgrades, anything that holds a connection across many seconds) should
// pass their init through this so the throttle leaves them alone.
//
// WARNING: the marker is a real header and IS sent on the wire. Do NOT use it
// on cross-origin requests (relay/control-plane) — the CORS preflight will
// fail unless the server allow-lists it. SSE consumers don't need it at all:
// `Accept: text/event-stream` already bypasses the throttle.
export function bypassFetchThrottle<T extends RequestInit | undefined>(init: T): T {
  const headers = new Headers(init?.headers)
  headers.set(FETCH_BYPASS_HEADER, "1")
  return { ...init, headers } as T
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
  if (isEventStreamRequest(init, input) || hasBypassHeader(init, input)) {
    return underlying()
  }
  const release = await getFetchThrottle().acquire()
  try {
    return await underlying()
  } finally {
    release()
  }
}
