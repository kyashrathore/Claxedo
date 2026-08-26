import { describe, expect, test } from "bun:test"
import { createEventCoalescer, type CoalescerPolicy } from "./event-coalescer"

// A representative event shape mirroring how global-sdk keys real OpenCode
// events: `status` collapses per session, `part` collapses per message-part and
// supersedes earlier `delta`s for the same part, `delta` is skippable.
type E =
  | { kind: "status"; session: string; value: number }
  | { kind: "part"; message: string; part: string; text: string }
  | { kind: "delta"; message: string; part: string; text: string }

const policy: CoalescerPolicy<E> = {
  coalesceKey: (directory, payload) => {
    if (payload.kind === "status") return `status:${payload.session}`
    if (payload.kind === "part") return `part:${directory}:${payload.message}:${payload.part}`
    return undefined
  },
  supersededDelta: (directory, payload) =>
    payload.kind === "part" && payload.text.length > 0
      ? `${directory}:${payload.message}:${payload.part}`
      : undefined,
  deltaIdentity: (directory, payload) =>
    payload.kind === "delta" ? `${directory}:${payload.message}:${payload.part}` : undefined,
}

/** Deterministic fake timer + clock so frame scheduling is directly observable. */
function harness() {
  const emitted: Array<{ directory: string; payload: E }> = []
  let clock = 0
  let pending: { fn: () => void; at: number } | undefined
  let nextHandle = 1
  let lastArmMs: number | undefined
  const coalescer = createEventCoalescer<E>({
    emit: (directory, payload) => emitted.push({ directory, payload }),
    policy,
    frameMs: 16,
    now: () => clock,
    setTimer: (fn, ms) => {
      pending = { fn, at: clock + ms }
      lastArmMs = ms
      // as-any: fake timer returns an opaque numeric handle; the real TimerHandle is never inspected.
      return nextHandle++ as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {
      pending = undefined
    },
  })
  return {
    emitted,
    enqueue: coalescer.enqueue,
    flush: coalescer.flush,
    pending: coalescer.pending,
    advance(ms: number) {
      clock += ms
      if (pending && clock >= pending.at) {
        const fn = pending.fn
        pending = undefined
        fn()
      }
    },
    hasTimer: () => pending !== undefined,
    lastArmMs: () => lastArmMs,
  }
}

describe("createEventCoalescer", () => {
  test("buffers events and emits them together on the scheduled frame", () => {
    const h = harness()
    h.enqueue("d", { kind: "status", session: "s1", value: 1 })
    h.enqueue("d", { kind: "status", session: "s2", value: 1 })
    expect(h.emitted).toEqual([]) // nothing emitted before the frame fires
    expect(h.pending()).toBe(2)

    h.advance(16)
    expect(h.emitted.map((e) => e.payload)).toEqual([
      { kind: "status", session: "s1", value: 1 },
      { kind: "status", session: "s2", value: 1 },
    ])
    expect(h.pending()).toBe(0)
  })

  test("collapses repeated keyed events in place to their latest value", () => {
    const h = harness()
    h.enqueue("d", { kind: "status", session: "s1", value: 1 })
    h.enqueue("d", { kind: "status", session: "s1", value: 2 })
    h.enqueue("d", { kind: "status", session: "s1", value: 3 })
    expect(h.pending()).toBe(1) // three enqueues, one queued slot

    h.advance(16)
    expect(h.emitted.map((e) => e.payload)).toEqual([{ kind: "status", session: "s1", value: 3 }])
  })

  test("drops deltas that a later full-part update superseded, keeping the part update", () => {
    const h = harness()
    h.enqueue("d", { kind: "part", message: "m", part: "p", text: "" }) // queued slot for the part
    h.enqueue("d", { kind: "delta", message: "m", part: "p", text: "a" })
    h.enqueue("d", { kind: "delta", message: "m", part: "p", text: "b" })
    // now a superseding part update replaces the coalesced part slot
    h.enqueue("d", { kind: "part", message: "m", part: "p", text: "final" })

    h.advance(16)
    expect(h.emitted.map((e) => e.payload)).toEqual([
      { kind: "part", message: "m", part: "p", text: "final" },
    ])
  })

  test("a first keyed full-part update supersedes deltas already queued for that part", () => {
    const h = harness()
    h.enqueue("d", { kind: "delta", message: "m", part: "p", text: "a" })
    h.enqueue("d", { kind: "delta", message: "m", part: "p", text: "b" })
    // No earlier full-part slot exists. Supersession must still follow the
    // incoming full payload rather than depend on a coalesced replacement.
    h.enqueue("d", { kind: "part", message: "m", part: "p", text: "final" })

    h.advance(16)
    expect(h.emitted.map((e) => e.payload)).toEqual([
      { kind: "part", message: "m", part: "p", text: "final" },
    ])
  })

  test("keeps a delta that arrives after the full-part update", () => {
    const h = harness()
    h.enqueue("d", { kind: "part", message: "m", part: "p", text: "base" })
    h.enqueue("d", { kind: "delta", message: "m", part: "p", text: "later" })

    h.advance(16)
    expect(h.emitted.map((e) => e.payload)).toEqual([
      { kind: "part", message: "m", part: "p", text: "base" },
      { kind: "delta", message: "m", part: "p", text: "later" },
    ])
  })

  test("keeps deltas whose part was not superseded", () => {
    const h = harness()
    h.enqueue("d", { kind: "delta", message: "m", part: "p", text: "a" })
    h.enqueue("d", { kind: "delta", message: "m", part: "q", text: "b" })
    h.advance(16)
    expect(h.emitted.map((e) => e.payload)).toEqual([
      { kind: "delta", message: "m", part: "p", text: "a" },
      { kind: "delta", message: "m", part: "q", text: "b" },
    ])
  })

  test("an explicit flush emits immediately and cancels the pending frame timer", () => {
    const h = harness()
    h.enqueue("d", { kind: "status", session: "s1", value: 1 })
    expect(h.hasTimer()).toBe(true)
    h.flush()
    expect(h.emitted).toHaveLength(1)
    expect(h.hasTimer()).toBe(false)
  })

  test("flush with an empty queue is a no-op", () => {
    const h = harness()
    h.flush()
    expect(h.emitted).toEqual([])
  })

  test("re-arms with the remaining frame budget after a partial advance, not a full frame", () => {
    const h = harness()
    h.enqueue("d", { kind: "status", session: "s1", value: 1 })
    expect(h.lastArmMs()).toBe(16) // first frame arms for the full budget

    h.advance(16) // flush fires and records `last = now()`
    expect(h.emitted).toHaveLength(1)

    h.advance(5) // 5ms elapse with no timer pending
    h.enqueue("d", { kind: "status", session: "s2", value: 1 })
    // the next frame must arm for the remaining budget (frameMs - elapsed = 16 - 5),
    // not another full frame, so bursts stay pinned to a ~16ms cadence.
    expect(h.lastArmMs()).toBe(11)
  })
})
