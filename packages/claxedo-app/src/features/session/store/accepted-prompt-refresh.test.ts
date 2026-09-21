import { afterEach, describe, expect, test } from "bun:test"
import {
  claimTurnCoverage,
  hasOutstandingTurnCoverage,
  outstandingTurnCoverage,
  readAcceptedPromptStatus,
  releaseTurnCoverage,
  readTurnCoverage,
  turnsAwaitingCoverage,
  requestAcceptedPromptRefresh,
  resetAcceptedPromptRefreshForTest,
  retireTurnCoverage,
} from "./accepted-prompt-refresh"

afterEach(() => resetAcceptedPromptRefreshForTest())

const scope = { directory: "/repo", sessionID: "ses_1" }
const turn = (turnId: string) => ({ ...scope, turnId })

function request(messageID: string, over = scope) {
  requestAcceptedPromptRefresh({ ...over, messageID })
}

describe("turn coverage obligations", () => {
  test("a newer turn does not displace the obligation an older one left", () => {
    request("msg_1")
    request("msg_2")

    expect(outstandingTurnCoverage(scope).map((entry) => entry.turnId)).toEqual(["msg_1", "msg_2"])
    expect(hasOutstandingTurnCoverage("msg_1")).toBe(true)
  })

  test("the same turn requested twice is one obligation", () => {
    request("msg_1")
    request("msg_1")

    expect(outstandingTurnCoverage(scope)).toHaveLength(1)
  })

  test("obligations are keyed by directory and session, not by turn id alone", () => {
    request("msg_1")
    request("msg_1", { directory: "/other", sessionID: "ses_1" })
    request("msg_1", { directory: "/repo", sessionID: "ses_2" })

    expect(outstandingTurnCoverage(scope)).toHaveLength(1)
    expect(outstandingTurnCoverage()).toHaveLength(3)
  })

  test("one scope cannot hold more than 64 outstanding turns, and the oldest is the one dropped", () => {
    for (let index = 0; index < 70; index += 1) request(`msg_${index}`)

    const outstanding = outstandingTurnCoverage(scope)
    expect(outstanding).toHaveLength(64)
    expect(outstanding[0].turnId).toBe("msg_6")
    expect(outstanding.at(-1)?.turnId).toBe("msg_69")
  })

  test("a bounded scope does not evict another session's obligations", () => {
    request("keep", { directory: "/repo", sessionID: "ses_2" })
    for (let index = 0; index < 70; index += 1) request(`msg_${index}`)

    expect(hasOutstandingTurnCoverage("keep")).toBe(true)
  })
})

describe("claiming one obligation", () => {
  test("a second owner is refused while the first holds the attempt", () => {
    request("msg_1")
    const first = {}
    const second = {}

    expect(claimTurnCoverage(turn("msg_1"), first)).toBe(true)
    expect(claimTurnCoverage(turn("msg_1"), second)).toBe(false)
  })

  test("two turns of one session are claimed independently", () => {
    request("msg_1")
    request("msg_2")
    const owner = {}

    expect(claimTurnCoverage(turn("msg_1"), owner)).toBe(true)
    expect(claimTurnCoverage(turn("msg_2"), owner)).toBe(true)
  })

  test("releasing an attempt keeps the obligation for the next mount", () => {
    request("msg_1")
    const unmounted = {}
    const remounted = {}

    expect(claimTurnCoverage(turn("msg_1"), unmounted)).toBe(true)
    releaseTurnCoverage(turn("msg_1"), unmounted)

    expect(hasOutstandingTurnCoverage("msg_1")).toBe(true)
    expect(claimTurnCoverage(turn("msg_1"), remounted)).toBe(true)
  })

  test("only the owner holding an attempt can release it", () => {
    request("msg_1")
    const owner = {}
    const stranger = {}
    claimTurnCoverage(turn("msg_1"), owner)

    releaseTurnCoverage(turn("msg_1"), stranger)

    expect(claimTurnCoverage(turn("msg_1"), stranger)).toBe(false)
  })

  test("a retired obligation cannot be claimed again", () => {
    request("msg_1")
    retireTurnCoverage(turn("msg_1"))

    expect(hasOutstandingTurnCoverage("msg_1")).toBe(false)
    expect(claimTurnCoverage(turn("msg_1"), {})).toBe(false)
  })

  test("retiring one turn leaves the other turns of the same session owed", () => {
    request("msg_1")
    request("msg_2")

    retireTurnCoverage(turn("msg_1"))

    expect(outstandingTurnCoverage(scope).map((entry) => entry.turnId)).toEqual(["msg_2"])
  })
})

describe("status reconciliation", () => {
  test("forwards its abort signal to the canonical request", async () => {
    const controller = new AbortController()
    let observed: AbortSignal | undefined
    const result = await readAcceptedPromptStatus({
      sessionID: "ses_1",
      signal: controller.signal,
      client: {
        session: {
          status: async (_parameters, options) => {
            observed = options?.signal
            return { data: { ses_1: { type: "busy" as const } } }
          },
        },
      },
    })

    expect(observed).toBe(controller.signal)
    expect(result).toEqual({ type: "busy" })
  })

  test("a status read that fails reports nothing rather than idle", async () => {
    const result = await readAcceptedPromptStatus({
      sessionID: "ses_1",
      client: { session: { status: async () => { throw new Error("unreachable") } } },
    })

    expect(result).toBeUndefined()
  })
})

describe("what a coverage page settles", () => {
  const owed = turn("msg_1")

  test("a complete page for this turn discharges the obligation", () => {
    expect(readTurnCoverage(owed, { turnId: "msg_1", coverage: "complete" })).toEqual({ merge: true, answer: "complete" })
  })

  test("a partial page for this turn is merged but settles nothing", () => {
    expect(readTurnCoverage(owed, { turnId: "msg_1", coverage: "partial" })).toEqual({ merge: true, answer: "unresolved" })
  })

  // The defect this rule exists for: a reply describing the turn that replaced
  // this one would otherwise both retire the obligation and merge its window.
  test.each(["complete", "partial", "unavailable"] as const)(
    "a %s page for a different turn is neither merged nor an answer about this one",
    (coverage) => {
      expect(readTurnCoverage(owed, { turnId: "msg_2", coverage })).toEqual({ merge: false, answer: "unresolved" })
    },
  )

  test("only the owner's own unavailable answer retires the obligation", () => {
    expect(readTurnCoverage(owed, { turnId: "msg_1", coverage: "unavailable" })).toEqual({ merge: false, answer: "unavailable" })
  })

  test("a read that produced no page settles nothing", () => {
    expect(readTurnCoverage(owed, undefined)).toEqual({ merge: false, answer: "unresolved" })
  })
})

describe("rebuilding obligations from a loaded history range", () => {
  const replied = (ids: string[]) => (turnId: string) => ids.includes(turnId)

  test("a turn whose reply never landed is still owed", () => {
    expect(turnsAwaitingCoverage(["msg_1", "msg_2", "msg_3"], replied(["msg_1", "msg_3"]))).toEqual(["msg_2"])
  })

  test("a range whose replies all landed owes nothing", () => {
    expect(turnsAwaitingCoverage(["msg_1", "msg_2"], replied(["msg_1", "msg_2"]))).toEqual([])
  })

  test("an empty range owes nothing", () => {
    expect(turnsAwaitingCoverage([], replied([]))).toEqual([])
  })

  // The newest turns are the ones a reader is looking at, so a range longer
  // than the cap keeps those rather than the oldest.
  test("a range longer than the cap keeps the newest turns, in order", () => {
    const ids = Array.from({ length: 70 }, (_, index) => `msg_${index}`)
    const awaiting = turnsAwaitingCoverage(ids, () => false, 64)
    expect(awaiting).toHaveLength(64)
    expect(awaiting[0]).toBe("msg_6")
    expect(awaiting.at(-1)).toBe("msg_69")
  })

  test("a rebuilt range becomes obligations the owner can claim", () => {
    for (const turnId of turnsAwaitingCoverage(["msg_1", "msg_2"], replied(["msg_1"]))) {
      requestAcceptedPromptRefresh({ ...scope, messageID: turnId })
    }

    expect(outstandingTurnCoverage(scope).map((entry) => entry.turnId)).toEqual(["msg_2"])
    expect(claimTurnCoverage(turn("msg_2"), {})).toBe(true)
  })
})
