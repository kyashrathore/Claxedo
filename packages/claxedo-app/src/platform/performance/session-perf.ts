/**
 * Session load / switch instrumentation for the hosted app.
 *
 * Always on, because the questions it answers ("why did opening this session
 * take 9 s from the phone?") are asked about production sessions after the
 * fact, when nobody armed a harness. Recording is cheap: a `performance.mark`
 * per phase, a `performance.measure` per completed span (both visible in the
 * DevTools Performance panel), and a bounded ring buffer of plain records.
 *
 * Read it from the console:
 *   __claxedoSessionPerf.summary()          — the last session opens, by phase
 *   __claxedoSessionPerf.events()           — every record, oldest first
 *   __claxedoSessionPerf.requests({slow: 500}) — runtime requests over 500 ms
 *   localStorage.setItem("claxedo:perf", "1") — also log each record live
 *
 * Three kinds of record:
 *   span     — a timed operation: the session-list read, a resolve probe, a
 *              runtime request (with the route it took and the status).
 *   phase    — a moment in a session open: started (rail click, URL, route),
 *              screen-mounted, messages-ready, first-fold-ready. Each carries
 *              the elapsed time from the open's start, so a summary reads as
 *              "click → messages 412 ms → first fold 538 ms".
 *   event    — anything else worth a timestamp.
 *
 * A session open is keyed by session id. A switch is an open whose start
 * names the previously open session, so the summary can say switch vs cold.
 */

export type PerfAttributes = Record<string, string | number | boolean | undefined>

export type PerfRecord =
  | { kind: "span"; name: string; at: number; ms: number; attrs: PerfAttributes }
  | { kind: "phase"; name: string; at: number; sessionId: string; sinceStartMs: number; attrs: PerfAttributes }
  | { kind: "event"; name: string; at: number; attrs: PerfAttributes }

export type SessionOpenPhase = "started" | "screen-mounted" | "messages-ready" | "first-fold-ready" | "timeline-mounted"

export type SessionOpenSummary = {
  sessionId: string
  from: string
  previousSessionId?: string
  startedAt: number
  phases: Partial<Record<Exclude<SessionOpenPhase, "started">, number>>
}

const RING_LIMIT = 400
const MARK_PREFIX = "claxedo:session"

type Clock = { now: () => number; mark?: (name: string) => unknown; measure?: (name: string, start: string, end: string) => unknown }

type Open = { sessionId: string; from: string; previousSessionId?: string; startedAt: number; startMark: string; phases: SessionOpenSummary["phases"] }

export type SessionPerf = ReturnType<typeof createSessionPerf>

export function createSessionPerf(input: { clock?: Clock; log?: (record: PerfRecord) => void; logEnabled?: () => boolean } = {}) {
  const clock: Clock = input.clock ?? (typeof performance !== "undefined"
    ? {
      now: () => performance.now(),
      mark: (name) => performance.mark(name),
      measure: (name, start, end) => performance.measure(name, start, end),
    }
    : { now: () => Date.now() })
  const ring: PerfRecord[] = []
  const opens = new Map<string, Open>()
  let lastOpened: string | undefined
  let sequence = 0

  const enabled = input.logEnabled ?? (() => {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem("claxedo:perf") === "1"
    } catch {
      return false
    }
  })
  const emit = (record: PerfRecord) => {
    ring.push(record)
    if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT)
    if (input.log) input.log(record)
    else if (enabled()) console.info("[claxedo:perf]", record.kind, record.name, record)
  }
  const mark = (name: string) => {
    try {
      clock.mark?.(name)
    } catch {
      // A mark is a convenience for the Performance panel, never a requirement.
    }
  }
  const measure = (name: string, start: string, end: string) => {
    try {
      clock.measure?.(name, start, end)
    } catch {
      // Same: a missing mark must not turn instrumentation into a failure.
    }
  }

  return {
    /** Time an operation. `end` records the span; call it exactly once. */
    span(name: string, attrs: PerfAttributes = {}) {
      const started = clock.now()
      let done = false
      return {
        end: (more: PerfAttributes = {}) => {
          if (done) return
          done = true
          emit({ kind: "span", name, at: started, ms: Math.round((clock.now() - started) * 10) / 10, attrs: { ...attrs, ...more } })
        },
      }
    },
    /** Time a promise-returning operation, recording its outcome. */
    async timed<T>(name: string, attrs: PerfAttributes, run: () => Promise<T>): Promise<T> {
      const span = this.span(name, attrs)
      try {
        const result = await run()
        span.end({ ok: true })
        return result
      } catch (error) {
        span.end({ ok: false, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    },
    event(name: string, attrs: PerfAttributes = {}) {
      emit({ kind: "event", name, at: clock.now(), attrs })
    },
    /**
     * A session open begins: from a rail click, a URL load, or a route change.
     * The previously opened session (if any) makes this a switch. Starting the
     * same session twice keeps the first start — the click, not the mount.
     */
    openStart(sessionId: string, from: string) {
      if (opens.get(sessionId)) return
      const startMark = `${MARK_PREFIX}.open.${sessionId}.${++sequence}`
      const open: Open = {
        sessionId,
        from,
        ...(lastOpened && lastOpened !== sessionId ? { previousSessionId: lastOpened } : {}),
        startedAt: clock.now(),
        startMark,
        phases: {},
      }
      opens.set(sessionId, open)
      lastOpened = sessionId
      mark(startMark)
      emit({ kind: "phase", name: "started", at: open.startedAt, sessionId, sinceStartMs: 0, attrs: { from, ...(open.previousSessionId ? { previousSessionId: open.previousSessionId } : {}) } })
    },
    /** A phase of an open completed. Without a recorded start, the mount starts one ("route"). */
    openPhase(sessionId: string, phase: Exclude<SessionOpenPhase, "started">, attrs: PerfAttributes = {}) {
      if (!opens.has(sessionId)) this.openStart(sessionId, "route")
      const open = opens.get(sessionId)!
      if (open.phases[phase] !== undefined) return
      const now = clock.now()
      const since = Math.round((now - open.startedAt) * 10) / 10
      open.phases[phase] = since
      const endMark = `${open.startMark}.${phase}`
      mark(endMark)
      measure(`${MARK_PREFIX}.${phase}`, open.startMark, endMark)
      emit({ kind: "phase", name: phase, at: now, sessionId, sinceStartMs: since, attrs })
    },
    /** The last N session opens with their phase timings, newest first. */
    summary(limit = 10): SessionOpenSummary[] {
      return [...opens.values()].slice(-limit).reverse().map((open) => ({
        sessionId: open.sessionId,
        from: open.from,
        ...(open.previousSessionId ? { previousSessionId: open.previousSessionId } : {}),
        startedAt: open.startedAt,
        phases: { ...open.phases },
      }))
    },
    events(): readonly PerfRecord[] {
      return [...ring]
    },
    /** Runtime/control-plane request spans, optionally only the slow or failed ones. */
    requests(filter: { slow?: number; failed?: boolean } = {}) {
      return ring.filter((record): record is Extract<PerfRecord, { kind: "span" }> =>
        record.kind === "span"
        && record.name.startsWith("request.")
        && (filter.slow === undefined || record.ms >= filter.slow)
        && (!filter.failed || record.attrs.ok === false || (typeof record.attrs.status === "number" && record.attrs.status >= 400)))
    },
    clear() {
      ring.length = 0
      opens.clear()
      lastOpened = undefined
    },
  }
}

declare global {
  interface Window {
    __claxedoSessionPerf?: SessionPerf
  }
}

/** The app-wide recorder, exposed on `window.__claxedoSessionPerf` for the console. */
export const sessionPerf: SessionPerf = createSessionPerf()
if (typeof window !== "undefined") window.__claxedoSessionPerf = sessionPerf

/** The part of a URL worth recording: origin + path, never a query (it can carry ids and paths). */
export function requestName(url: string | URL): string {
  try {
    const parsed = typeof url === "string" ? new URL(url, typeof location !== "undefined" ? location.href : "http://local") : url
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return String(url)
  }
}

/** Record one completed request span with the route it took. */
export function recordRequest(input: {
  name: string
  url: string | URL
  method?: string
  via?: string
  startedAt: number
  status?: number
  error?: unknown
  attrs?: PerfAttributes
}) {
  const ms = Math.round((sessionPerf ? performance.now() - input.startedAt : 0) * 10) / 10
  sessionPerf.event(`request.${input.name}`, {
    url: requestName(input.url),
    method: input.method ?? "GET",
    ...(input.via ? { via: input.via } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.error ? { ok: false, error: input.error instanceof Error ? input.error.message : String(input.error) } : {}),
    ms,
    ...input.attrs,
  })
}
