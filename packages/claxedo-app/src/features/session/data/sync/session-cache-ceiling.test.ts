import { beforeEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { clearOpenSessions, setOpenSessions } from "@/features/session/store/open-sessions"
import {
  SESSION_CACHE_LIMIT,
  enforceSessionCacheCeiling,
} from "./session-cache-cleanup"

// The ceiling that bounds per-session cache growth under mixed load. Before
// this was wired, `SESSION_CACHE_LIMIT` and `pickSessionCacheEvictions` had no
// callers at all — the policy was written down but never ran, so the only
// pruning was "the server dropped this session from its list" plus a 30-minute
// gcTime that every refetch resets. Neither reacts to session COUNT.

const seed = (sessionId: string, status: { type: string } = { type: "idle" }) => {
  queryClient.setQueryData(shellDataKeys.sessionId(sessionId, "status"), status)
  queryClient.setQueryData(shellDataKeys.sessionId(sessionId, "todo"), [{ id: `${sessionId}-todo` }])
}
const cached = (sessionId: string) =>
  queryClient.getQueryData(shellDataKeys.sessionId(sessionId, "status")) !== undefined

beforeEach(() => {
  queryClient.clear()
  clearOpenSessions()
})

describe("session cache ceiling", () => {
  test("caps live session caches at the limit instead of growing without bound", () => {
    const total = SESSION_CACHE_LIMIT + 25
    for (let i = 0; i < total; i++) {
      const id = `ses_${i}`
      seed(id)
      enforceSessionCacheCeiling(id)
    }

    const alive = Array.from({ length: total }, (_, i) => `ses_${i}`).filter(cached)
    expect(alive.length).toBeLessThanOrEqual(SESSION_CACHE_LIMIT)
    // The coldest go first and the most recent survives — this is an LRU, not a
    // flush: a user cycling sessions must keep the ones they just looked at.
    expect(cached(`ses_${total - 1}`)).toBe(true)
    expect(cached("ses_0")).toBe(false)
  })

  test("never evicts an OPEN session, however cold", () => {
    const pinned = "ses_open"
    seed(pinned)
    enforceSessionCacheCeiling(pinned)
    setOpenSessions([{ sessionId: pinned }])

    for (let i = 0; i < SESSION_CACHE_LIMIT + 20; i++) {
      const id = `ses_cold_${i}`
      seed(id)
      enforceSessionCacheCeiling(id)
    }

    // A mounted tab renders from these caches; dropping them would blank it.
    expect(cached(pinned)).toBe(true)
  })

  test("never evicts a BUSY session mid-turn", () => {
    const streaming = "ses_busy"
    seed(streaming, { type: "busy" })
    enforceSessionCacheCeiling(streaming)

    for (let i = 0; i < SESSION_CACHE_LIMIT + 20; i++) {
      const id = `ses_idle_${i}`
      seed(id)
      enforceSessionCacheCeiling(id)
    }

    // A background turn is exactly what a count-based eviction would hit first:
    // it is cold by recency while being the session that can least afford to
    // lose its status/requests caches.
    expect(cached(streaming)).toBe(true)
  })

  test("revisiting a session refreshes its recency", async () => {
    for (let i = 0; i < SESSION_CACHE_LIMIT; i++) {
      const id = `ses_${i}`
      seed(id)
      enforceSessionCacheCeiling(id)
    }

    // Recency is read from the cache's own `dataUpdatedAt`, so a "revisit" is
    // what it is in the app: hydration rewrites the session's caches. The gap
    // keeps the write a distinguishable millisecond later — real revisits are
    // seconds apart, and same-ms ties would otherwise order by insertion.
    await new Promise((resolve) => setTimeout(resolve, 2))
    seed("ses_0")
    enforceSessionCacheCeiling("ses_0")

    for (let i = 0; i < 10; i++) {
      const id = `ses_new_${i}`
      seed(id)
      enforceSessionCacheCeiling(id)
    }

    // The revisited session outlives sessions that were newer than it before
    // the revisit — that is the difference between an LRU and a FIFO.
    expect(cached("ses_0")).toBe(true)
    expect(cached("ses_1")).toBe(false)
  })
})
