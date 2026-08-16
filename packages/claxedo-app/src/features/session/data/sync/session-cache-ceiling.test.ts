import { beforeEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { clearOpenSessions, setOpenSessions } from "@/features/session/store/open-sessions"
import { conversationSnapshotKey } from "@/features/session/conversation/conversation-chat-client"
import {
  SESSION_CACHE_BYTE_BUDGET,
  SESSION_CACHE_LIMIT,
  enforceSessionCacheCeiling,
  scheduleSessionCacheCeiling,
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

/**
 * Seed a session whose transcript weighs roughly `mb` megabytes by the app's own
 * estimator — one message carrying a string of that many characters, which the
 * estimator counts a byte apiece (ASCII).
 */
const seedHeavy = (sessionId: string, mb: number) => {
  seed(sessionId)
  queryClient.setQueryData(conversationSnapshotKey(sessionId), [
    { id: `${sessionId}-m0`, role: "assistant", parts: [{ type: "text", text: "x".repeat(mb * 1024 * 1024) }] },
  ])
}
const budgetMB = SESSION_CACHE_BYTE_BUDGET / 1024 ** 2

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

  test("caps total transcript bytes while the session COUNT still reads green", () => {
    // The case a count cap cannot see: a handful of enormous sessions. Each is
    // a fifth of the budget, so the count never approaches SESSION_CACHE_LIMIT
    // while the payload runs past it.
    const each = Math.ceil(budgetMB / 5)
    const total = 12
    for (let i = 0; i < total; i++) {
      seedHeavy(`ses_big_${i}`, each)
      enforceSessionCacheCeiling(`ses_big_${i}`)
    }

    const alive = Array.from({ length: total }, (_, i) => `ses_big_${i}`).filter(cached)
    expect(alive.length).toBeLessThan(SESSION_CACHE_LIMIT)
    expect(alive.length).toBeLessThanOrEqual(6)
    expect(cached(`ses_big_${total - 1}`)).toBe(true)
    expect(cached("ses_big_0")).toBe(false)
  })

  test("evicts by weight, not by count, when light sessions are plentiful", () => {
    // Twenty featherweight sessions sit well inside both ceilings; adding two
    // heavyweights must drop the cold heavyweight, not sweep the light ones.
    for (let i = 0; i < 20; i++) {
      seed(`ses_light_${i}`)
      enforceSessionCacheCeiling(`ses_light_${i}`)
    }
    seedHeavy("ses_heavy_cold", budgetMB)
    enforceSessionCacheCeiling("ses_heavy_cold")
    seedHeavy("ses_heavy_warm", budgetMB)
    enforceSessionCacheCeiling("ses_heavy_warm")

    expect(cached("ses_heavy_warm")).toBe(true)
    expect(cached("ses_heavy_cold")).toBe(false)
    // Dropping the one session that actually freed the budget is enough — the
    // light ones cost nothing and evicting them would buy nothing.
    expect(cached("ses_light_19")).toBe(true)
    expect(cached("ses_light_0")).toBe(true)
  })

  test("never evicts an OPEN session to satisfy the byte budget", () => {
    const pinned = "ses_open_heavy"
    seedHeavy(pinned, budgetMB)
    enforceSessionCacheCeiling(pinned)
    setOpenSessions([{ sessionId: pinned }])

    for (let i = 0; i < 4; i++) {
      seedHeavy(`ses_more_${i}`, budgetMB)
      enforceSessionCacheCeiling(`ses_more_${i}`)
    }

    // Over budget and unevictable is the honest outcome: blanking a mounted
    // pane to hit a number would trade a memory limit for a broken screen.
    expect(cached(pinned)).toBe(true)
  })

  test("scheduling runs the ceiling off the hydration path, once per burst", async () => {
    // Sizing a transcript is a deep walk, so the pass must not run inside the
    // hydration that triggers it — and a burst of switches must not queue one
    // pass each. The last session of the burst is the one being opened, so it
    // is the one the deferred pass must keep.
    const total = SESSION_CACHE_LIMIT + 10
    for (let i = 0; i < total; i++) {
      seed(`ses_${i}`)
      scheduleSessionCacheCeiling(`ses_${i}`)
    }

    // Nothing has run yet: hydration returned without paying for the sweep.
    expect(cached("ses_0")).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 20))

    const alive = Array.from({ length: total }, (_, i) => `ses_${i}`).filter(cached)
    expect(alive.length).toBeLessThanOrEqual(SESSION_CACHE_LIMIT)
    expect(cached(`ses_${total - 1}`)).toBe(true)
  })

  test("a growing BUSY session does not drag others out of the cache", () => {
    // A streaming session is pinned, so its exact weight changes no decision —
    // and it is sized from its last measurement precisely so the switch path
    // never re-walks it. Growth behind that pin must not start evicting the
    // idle sessions around it on the strength of a size nobody re-read.
    seedHeavy("ses_streaming", 1)
    queryClient.setQueryData(shellDataKeys.sessionId("ses_streaming", "status"), { type: "busy" })
    enforceSessionCacheCeiling("ses_streaming")
    seedHeavy("ses_neighbour", 1)
    enforceSessionCacheCeiling("ses_neighbour")

    // The turn streams on: same session, far more transcript.
    seedHeavy("ses_streaming", budgetMB * 2)
    queryClient.setQueryData(shellDataKeys.sessionId("ses_streaming", "status"), { type: "busy" })
    enforceSessionCacheCeiling("ses_neighbour")

    expect(cached("ses_streaming")).toBe(true)
    expect(cached("ses_neighbour")).toBe(true)
  })

  test("re-measures a session whose transcript grew", () => {
    // The size estimate is memoized against the snapshot's `dataUpdatedAt`. A
    // stale memo would let a session that ballooned after its first measurement
    // stay resident forever — the exact shape of a long streaming turn.
    seed("ses_grower")
    enforceSessionCacheCeiling("ses_grower")
    seedHeavy("ses_grower", budgetMB * 2)
    seed("ses_other")
    enforceSessionCacheCeiling("ses_other")

    expect(cached("ses_grower")).toBe(false)
  })
})
