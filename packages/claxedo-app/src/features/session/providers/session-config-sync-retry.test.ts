import { describe, expect, test } from "bun:test"
import type { LocalSelectionState } from "../store/local-selection-handoff"
import { createSessionSyncRetry, type SessionSyncRetryDeps } from "./session-config-sync-retry"

// Deterministic fake clock: the scheduler's backoff timers are captured here and only fire
// when the test explicitly runs them, so retries are driven by the test, never wall-clock.
function fakeClock() {
  const timers: Array<{ fn: () => void }> = []
  return {
    schedule: (fn: () => void, _ms: number) => {
      const handle = { fn }
      timers.push(handle)
      return {
        cancel: () => {
          const i = timers.indexOf(handle)
          if (i >= 0) timers.splice(i, 1)
        },
      }
    },
    runNext: () => {
      const next = timers.shift()
      next?.fn()
    },
    size: () => timers.length,
  }
}

// Flush the microtask queue so the injected patch promise's then/catch/finally chain settles.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const stateA: LocalSelectionState = { agent: "build", model: { providerID: "anthropic", modelID: "opus" }, variant: null }
const stateB: LocalSelectionState = { agent: "plan", model: { providerID: "anthropic", modelID: "sonnet" }, variant: null }

type Harness = {
  retry: ReturnType<typeof createSessionSyncRetry>
  clock: ReturnType<typeof fakeClock>
  calls: LocalSelectionState[]
  successes: LocalSelectionState[]
  exhaustedStates: LocalSelectionState[]
  setReady: (value: boolean) => void
  setResolver: (fn: () => Promise<unknown>) => void
}

function harness(overrides?: Partial<SessionSyncRetryDeps> & { maxAttempts?: number }): Harness {
  const clock = fakeClock()
  const calls: LocalSelectionState[] = []
  const successes: LocalSelectionState[] = []
  const exhaustedStates: LocalSelectionState[] = []
  let ready = true
  let resolver: () => Promise<unknown> = async () => {
    throw new Error("patch failed")
  }

  const retry = createSessionSyncRetry({
    maxAttempts: overrides?.maxAttempts ?? 5,
    backoffMs: overrides?.backoffMs ?? (() => 10),
    scopeReady: overrides?.scopeReady ?? (() => ready),
    patch: overrides?.patch ?? (async (_session, state) => {
      calls.push(state)
      return resolver()
    }),
    onSuccess: overrides?.onSuccess ?? ((_session, state) => successes.push(state)),
    onExhausted: overrides?.onExhausted ?? ((_session, state) => exhaustedStates.push(state)),
    schedule: overrides?.schedule ?? clock.schedule,
  })

  return {
    retry,
    clock,
    calls,
    successes,
    exhaustedStates,
    setReady: (value) => {
      ready = value
    },
    setResolver: (fn) => {
      resolver = fn
    },
  }
}

describe("createSessionSyncRetry", () => {
  test("permanent failure fires exactly maxAttempts then stops", async () => {
    const h = harness({ maxAttempts: 5 })

    h.retry.arm("ses", stateA, { deliberate: true })
    await settle()
    expect(h.calls.length).toBe(1) // attempt 1
    expect(h.clock.size()).toBe(1) // one backoff scheduled

    // Drive the deliberate backoff retries.
    for (let expected = 2; expected <= 5; expected++) {
      h.clock.runNext()
      await settle()
      expect(h.calls.length).toBe(expected)
    }

    // 5th failure exhausts the cycle: no further timer, no further PATCH.
    expect(h.clock.size()).toBe(0)
    expect(h.retry.exhausted("ses")).toBe(true)
    expect(h.retry.pending("ses")).toBe(false)
    expect(h.exhaustedStates.length).toBe(1)

    // Churn after exhaustion must NOT re-fire (this is the isFetching-toggle case).
    h.retry.arm("ses", stateA, { deliberate: false })
    await settle()
    expect(h.calls.length).toBe(5)
    expect(h.clock.size()).toBe(0)
  })

  test("a subsequent user change re-arms after exhaustion", async () => {
    const h = harness({ maxAttempts: 3 })

    h.retry.arm("ses", stateA, { deliberate: true })
    await settle()
    h.clock.runNext()
    await settle()
    h.clock.runNext()
    await settle()
    expect(h.calls.length).toBe(3)
    expect(h.retry.exhausted("ses")).toBe(true)

    // Explicit new selection resets the ledger and fires a fresh attempt.
    h.retry.arm("ses", stateB, { deliberate: true })
    await settle()
    expect(h.calls.length).toBe(4)
    expect(h.calls[3]).toEqual(stateB)
    expect(h.retry.exhausted("ses")).toBe(false)
    expect(h.retry.attemptsFor("ses")).toBe(1)
  })

  test("a transient failure recovers on the next deliberate retry", async () => {
    const h = harness({ maxAttempts: 5 })
    let attempt = 0
    h.setResolver(async () => {
      attempt++
      if (attempt === 1) throw new Error("transient")
      return { ok: true }
    })

    h.retry.arm("ses", stateA, { deliberate: true })
    await settle()
    expect(h.calls.length).toBe(1)
    expect(h.clock.size()).toBe(1)

    h.clock.runNext() // deliberate retry
    await settle()
    expect(h.calls.length).toBe(2)
    expect(h.successes.length).toBe(1)
    expect(h.successes[0]).toEqual(stateA)
    // Recovery clears the ledger: not pending, not exhausted, no lingering timer.
    expect(h.retry.pending("ses")).toBe(false)
    expect(h.retry.exhausted("ses")).toBe(false)
    expect(h.clock.size()).toBe(0)
  })

  test("same-state hydration churn does not stack attempts or PATCHes", async () => {
    const h = harness()

    // First churn arms; the PATCH stays in flight (resolver never settles this test).
    h.setResolver(() => new Promise<unknown>(() => {}))
    h.retry.arm("ses", stateA, { deliberate: false })
    await settle()
    expect(h.calls.length).toBe(1)

    // Repeated churn while in flight must be a no-op (single-flight).
    h.retry.arm("ses", stateA, { deliberate: false })
    h.retry.arm("ses", stateA, { deliberate: false })
    await settle()
    expect(h.calls.length).toBe(1)
  })

  test("churn before scope is ready fires once, only after scope becomes ready", async () => {
    const h = harness()
    h.setReady(false)

    // Armed while scope is not ready: recorded but nothing fires yet.
    h.retry.arm("ses", stateA, { deliberate: false })
    await settle()
    expect(h.calls.length).toBe(0)

    // Scope flips ready; the next churn advances the idle attempt exactly once.
    h.setReady(true)
    h.setResolver(() => new Promise<unknown>(() => {})) // hold it in flight
    h.retry.arm("ses", stateA, { deliberate: false })
    await settle()
    expect(h.calls.length).toBe(1)
  })

  test("deliberate re-arm during an in-flight PATCH stays single-flight then flushes newest state", async () => {
    const h = harness()
    let release: (() => void) | undefined
    let phase = 0
    h.setResolver(
      () =>
        new Promise<unknown>((resolve, reject) => {
          phase++
          if (phase === 1) {
            // First PATCH: hold until released, then fail.
            release = () => reject(new Error("stale"))
          } else {
            resolve({ ok: true })
          }
        }),
    )

    h.retry.arm("ses", stateA, { deliberate: true })
    await settle()
    expect(h.calls.length).toBe(1)
    expect(h.calls[0]).toEqual(stateA)

    // New selection while the first PATCH is still in flight — must not fire concurrently.
    h.retry.arm("ses", stateB, { deliberate: true })
    await settle()
    expect(h.calls.length).toBe(1)

    // Release the stale PATCH; the newer state flushes on the freed channel.
    release?.()
    await settle()
    expect(h.calls.length).toBe(2)
    expect(h.calls[1]).toEqual(stateB)
    expect(h.successes[0]).toEqual(stateB)
    expect(h.retry.pending("ses")).toBe(false)
  })

  test("dispose cancels pending backoff timers", async () => {
    const h = harness()
    h.retry.arm("ses", stateA, { deliberate: true })
    await settle()
    expect(h.clock.size()).toBe(1)

    h.retry.dispose()
    expect(h.clock.size()).toBe(0)
    expect(h.retry.pending("ses")).toBe(false)
    expect(h.retry.attemptsFor("ses")).toBe(0)
  })
})
