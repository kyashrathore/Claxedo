import { describe, expect, test } from "bun:test"
import { flush } from "solid-js"
import { createMountIdleGovernor } from "./mount-idle-governor"
import { mountReactive } from "@/lib/test-support/reactive-root"

type Timer = { handler: () => void; ms: number; nextFireAt: number }

function fakeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, Timer>()
  return {
    clock: {
      now: () => now,
      setInterval: (handler: () => void, ms: number) => {
        const id = nextId++
        timers.set(id, { handler, ms, nextFireAt: now + ms })
        return id
      },
      clearInterval: (id: unknown) => {
        timers.delete(id as number)
      },
    },
    // Exact interval semantics: fire each live timer at its scheduled times,
    // in order, exactly as often as its period fits in the advanced span.
    advance(ms: number) {
      const end = now + ms
      while (true) {
        let due: Timer | undefined
        for (const timer of timers.values()) {
          if (timer.nextFireAt <= end && (!due || timer.nextFireAt < due.nextFireAt)) due = timer
        }
        if (!due) break
        now = due.nextFireAt
        due.nextFireAt += due.ms
        due.handler()
      }
      now = end
    },
  }
}

// The governor writes its budget from DOM activity listeners and interval
// callbacks, with no owner current; only the governor itself is built under
// one, so the body below runs outside it.
const run = (body: (input: { governor: () => number; target: EventTarget; advance: (ms: number) => void }) => void) => {
  const { clock, advance } = fakeClock()
  const target = new EventTarget()
  const [governor, dispose] = mountReactive(() =>
    createMountIdleGovernor({
      baseLimit: 12,
      idleAfterMs: 180_000,
      backfillStepMs: 300,
      target,
      clock,
    }),
  )

  try {
    body({
      // Solid 2 stages signal writes until the scheduler flushes, and the
      // workbench reads this budget from a memo — i.e. after a flush — so each
      // read here settles first rather than the governor forcing flushes of its
      // own on every activity event.
      governor: () => {
        flush()
        return governor()
      },
      target,
      advance,
    })
  } finally {
    dispose()
  }
}

describe("workbench/mount-idle-governor", () => {
  test("keeps the full budget while the user stays active", () => {
    run(({ governor, target, advance }) => {
      expect(governor()).toBe(12)
      for (let i = 0; i < 10; i++) {
        advance(60_000)
        target.dispatchEvent(new Event("keydown"))
      }
      expect(governor()).toBe(12)
    })
  })

  test("drops the budget to zero after the idle threshold", () => {
    run(({ governor, advance }) => {
      advance(200_000)
      expect(governor()).toBe(0)
    })
  })

  test("refills one slot per backfill step after the user returns", () => {
    run(({ governor, target, advance }) => {
      advance(200_000)
      expect(governor()).toBe(0)
      target.dispatchEvent(new Event("pointermove"))
      advance(300)
      expect(governor()).toBe(1)
      advance(600)
      expect(governor()).toBe(3)
      advance(10_000)
      expect(governor()).toBe(12)
    })
  })

  test("a second idle period interrupts an in-progress refill", () => {
    run(({ governor, target, advance }) => {
      advance(200_000)
      target.dispatchEvent(new Event("keydown"))
      advance(600)
      expect(governor()).toBe(2)
      advance(200_000)
      expect(governor()).toBe(0)
    })
  })

  test("without an event target (SSR) the budget is constant", () => {
    const [governor, dispose] = mountReactive(() => createMountIdleGovernor({ baseLimit: 7, target: null }))
    try {
      expect(governor()).toBe(7)
    } finally {
      dispose()
    }
  })
})
