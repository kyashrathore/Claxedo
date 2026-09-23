/**
 * Resizing xterm re-enters its parser.
 *
 * `fitAddon.fit()` calls `terminal.resize()`, which calls
 * `WriteBuffer.flushSync()` — a synchronous re-entry into the parser. That is
 * illegal while an *async* parser handler is paused mid-write (an OSC handler
 * that returns a promise, an inline-image decode). xterm detects the illegal
 * re-entry, logs "improper continuation due to previous async handler, giving
 * up parsing", and leaves the parser permanently FAILed: the terminal renders
 * nothing further until it is torn down and rebuilt.
 *
 * The gate makes the resize wait for the parser to reach GROUND. xterm fires a
 * write's callback only once that chunk *and* any async handlers it triggered
 * have fully parsed, so counting in-flight writes is an exact idleness signal —
 * no polling, no heuristics.
 *
 * Wrap `terminal.write` once at creation, then route every fit through
 * `runWhenParserIdle`.
 */

type WriteFn = (data: string | Uint8Array, callback?: () => void) => void

export type ParserIdleGate = {
  /** Writes whose parse has not completed yet. */
  pending: number
  /** Work parked until `pending` reaches zero. At most one — see below. */
  queued: (() => void) | null
}

export function createParserIdleGate(): ParserIdleGate {
  return { pending: 0, queued: null }
}

/** Drop parked work (teardown, or a superseded resize). */
export function cancelParserIdleWork(gate: ParserIdleGate): void {
  gate.queued = null
}

function flushQueued(gate: ParserIdleGate): void {
  // Re-check: a write may have landed between the drain and this microtask,
  // in which case the parser is busy again and the work must stay parked.
  if (gate.pending !== 0) return
  const fn = gate.queued
  if (!fn) return
  gate.queued = null
  fn()
}

/**
 * Wrap a terminal's `write` so the gate can observe parse completion. The
 * caller's own callback still runs, and still runs first.
 */
export function wrapWrite(gate: ParserIdleGate, write: WriteFn): WriteFn {
  return (data, callback) => {
    gate.pending += 1
    write(data, () => {
      try {
        callback?.()
      } finally {
        gate.pending -= 1
        if (gate.pending === 0 && gate.queued) {
          // Defer to a microtask so a synchronous write issued from the
          // callback itself is counted before we decide the parser is idle.
          queueMicrotask(() => flushQueued(gate))
        }
      }
    })
  }
}

/**
 * Run `fn` now if the parser is idle, else park it until it is.
 *
 * Only the most recent parked callback survives: resizes are idempotent and
 * absolute, so coalescing a burst to the last one is correct and avoids a
 * queue of stale geometries replaying against the final size.
 */
export function runWhenParserIdle(gate: ParserIdleGate, fn: () => void): void {
  if (gate.pending === 0) {
    fn()
    return
  }
  gate.queued = fn
}
