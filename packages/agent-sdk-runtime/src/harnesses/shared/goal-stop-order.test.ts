import { describe, expect, test } from "bun:test"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { interruptGoalTurn, settleGoalStop, type GoalTurnInterrupt } from "./goal-stop-order"

function lifecycle(input: { busy: boolean; order: string[] }): GoalTurnInterrupt & { release(): void } {
  let idle: (() => void) | undefined
  return {
    abort(sessionId: string) {
      input.order.push(`abort:${sessionId}`)
      return input.busy
    },
    whenIdle(sessionId: string) {
      input.order.push(`whenIdle:${sessionId}`)
      if (!input.busy) return Promise.resolve()
      return new Promise<void>((resolve) => {
        idle = resolve
      })
    },
    release() {
      input.order.push("idle")
      idle?.()
    },
  }
}

const paused: RuntimeGoalSnapshot = {
  sessionId: "session-1",
  objective: "Ship safely",
  status: "paused",
  createdAt: 1,
  updatedAt: 2,
}

describe("goal stop ordering", () => {
  test("continuation is disabled, the turn interrupted, and only then settled", async () => {
    const order: string[] = []
    const turns = lifecycle({ busy: true, order })
    const settled = settleGoalStop<null>({
      sessionId: "session-1",
      lifecycle: turns,
      disableContinuation: async () => {
        order.push("disable")
        return { ok: true, goal: null }
      },
      settle: async () => {
        order.push("settle")
        return { ok: true, goal: null }
      },
    })
    // The stop must not settle while the interrupted turn is still running.
    await Promise.resolve()
    expect(order).toEqual(["disable", "abort:session-1", "whenIdle:session-1"])
    turns.release()
    expect(await settled).toEqual({ ok: true, goal: null })
    expect(order).toEqual(["disable", "abort:session-1", "whenIdle:session-1", "idle", "settle"])
  })

  test("a failed disable interrupts nothing and is returned untouched", async () => {
    const order: string[] = []
    const failure = { ok: false as const, status: "failed" as const, message: "provider refused" }
    expect(await settleGoalStop<RuntimeGoalSnapshot>({
      sessionId: "session-1",
      lifecycle: lifecycle({ busy: true, order }),
      disableContinuation: async () => failure,
      settle: async () => ({ ok: true, goal: paused }),
    })).toEqual(failure)
    expect(order).toEqual([])
  })

  test("without a settle step the disabling result is the answer", async () => {
    const order: string[] = []
    expect(await settleGoalStop<RuntimeGoalSnapshot>({
      sessionId: "session-1",
      lifecycle: lifecycle({ busy: false, order }),
      disableContinuation: async () => ({ ok: true, goal: paused }),
    })).toEqual({ ok: true, goal: paused })
    expect(order).toEqual(["abort:session-1"])
  })

  test("a session with no registered turn has nothing to wait for", async () => {
    const order: string[] = []
    await interruptGoalTurn("session-1", lifecycle({ busy: false, order }))
    expect(order).toEqual(["abort:session-1"])
  })
})
