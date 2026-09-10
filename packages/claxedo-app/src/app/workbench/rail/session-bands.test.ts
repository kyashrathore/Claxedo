import { describe, expect, test } from "bun:test"
import { isStaleSession, settledForMs, splitSessionBands, STALE_AFTER_MS } from "./session-bands"

const HOUR = 60 * 60 * 1000
const NOW = 1_000 * HOUR

/** Created `createdHoursAgo` ago, last spoken to by a human `spokenHoursAgo` ago. */
function session(id: string, createdHoursAgo: number, spokenHoursAgo?: number) {
  return {
    id,
    createdAt: NOW - createdHoursAgo * HOUR,
    ...(spokenHoursAgo === undefined ? {} : { lastHumanTurnAt: NOW - spokenHoursAgo * HOUR }),
  }
}
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id)

describe("isStaleSession", () => {
  test("goes quiet once the reader's last turn is past the threshold", () => {
    expect(isStaleSession(session("a", 100, 1), { now: NOW })).toBe(false)
    expect(isStaleSession(session("a", 100, 3), { now: NOW })).toBe(true)
  })

  test("a session the reader has never spoken to is quiet, not exempt", () => {
    expect(isStaleSession(session("a", 100), { now: NOW })).toBe(true)
  })

  test("the threshold is two hours", () => {
    expect(STALE_AFTER_MS).toBe(2 * HOUR)
  })
})

describe("splitSessionBands", () => {
  test("both bands read newest-created first", () => {
    const rows = [session("old", 300, 1), session("new", 1, 1), session("mid", 100, 1)]
    const { active, settled } = splitSessionBands(rows, { now: NOW })
    expect(ids(active)).toEqual(["new", "mid", "old"])
    expect(settled).toEqual([])
  })

  test("an agent turn cannot move a row, because it never lands in lastHumanTurnAt", () => {
    // Both were last spoken to 3h ago; only `b` has since had an agent turn, which
    // advances `updatedAt` and nothing this reads.
    const rows = [session("a", 3, 3), session("b", 2, 3), session("c", 1, 1)]
    const bands = splitSessionBands(rows, { now: NOW })
    expect(ids(bands.active)).toEqual(["c"])
    expect(ids(bands.settled)).toEqual(["b", "a"])
  })

  test("messaging a session already in the active band moves nothing", () => {
    const before = splitSessionBands([session("a", 3, 1), session("b", 2, 1)], { now: NOW })
    const after = splitSessionBands([session("a", 3, 1), { ...session("b", 2, 1), lastHumanTurnAt: NOW }], { now: NOW })
    expect(ids(after.active)).toEqual(ids(before.active))
  })

  test("a session going quiet passes only the rows that went quiet before it", () => {
    // s6 and s4 spoken to recently; the rest are quiet.
    const rows = [6, 5, 4, 3, 2, 1].map((n) => session(`s${n}`, 10 - n, n === 6 || n === 4 ? 1 : 5))
    const bands = splitSessionBands(rows, { now: NOW })
    expect(ids(bands.active)).toEqual(["s6", "s4"])
    expect(ids(bands.settled)).toEqual(["s5", "s3", "s2", "s1"])
  })

  test("the newest session crossing over costs no movement at all", () => {
    const fresh = [3, 2, 1].map((n) => session(`s${n}`, 10 - n, n === 3 ? 1 : 5))
    const before = splitSessionBands(fresh, { now: NOW })
    expect([...ids(before.active), ...ids(before.settled)]).toEqual(["s3", "s2", "s1"])

    const quiet = [3, 2, 1].map((n) => session(`s${n}`, 10 - n, 5))
    const after = splitSessionBands(quiet, { now: NOW })
    expect(after.active).toEqual([])
    expect([...ids(after.active), ...ids(after.settled)]).toEqual(["s3", "s2", "s1"])
  })

  test("ties on createdAt resolve by id so two clients cannot disagree", () => {
    const rows = [
      { id: "b", createdAt: NOW, lastHumanTurnAt: NOW },
      { id: "a", createdAt: NOW, lastHumanTurnAt: NOW },
    ]
    expect(ids(splitSessionBands(rows, { now: NOW }).active)).toEqual(["a", "b"])
  })
})

describe("settledForMs", () => {
  test("reports the smallest staleness in the band — what is true of every row", () => {
    const settled = [session("a", 50, 9), session("b", 40, 4), session("c", 30, 7)]
    expect(settledForMs(settled, { now: NOW })).toBe(4 * HOUR)
  })

  test("rows never spoken to contribute no age rather than an infinite one", () => {
    expect(settledForMs([session("a", 50), session("b", 40, 6)], { now: NOW })).toBe(6 * HOUR)
    expect(settledForMs([session("a", 50)], { now: NOW })).toBeUndefined()
  })

  test("an empty band has no age", () => {
    expect(settledForMs([], { now: NOW })).toBeUndefined()
  })
})
