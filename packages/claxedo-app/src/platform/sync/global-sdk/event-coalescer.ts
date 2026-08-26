// Frame-batched event coalescer extracted from context/global-sdk.tsx's inline
// SSE flush queue. Incoming stream events are buffered and flushed together on
// the next frame so a burst of updates causes one reactive pass, not one per
// event. Events carrying a coalesce key (e.g. the latest status/part for a
// message) collapse in place to their newest value, and stream deltas that a
// later full-part update has superseded are dropped at flush time.
//
// Timer/clock/batch are injectable so the frame scheduling can be driven with
// fake timers in tests without a Solid runtime.

type TimerHandle = ReturnType<typeof setTimeout>

export type QueuedEvent<E> = { directory: string; payload: E }

export type CoalescerPolicy<E> = {
  /** Coalesce key for events that should collapse to their latest value, or undefined to always append. */
  coalesceKey: (directory: string, payload: E) => string | undefined
  /** For a full event, the identity of earlier queued deltas it supersedes. */
  supersededDelta?: (directory: string, payload: E) => string | undefined
  /** For a delta event, its identity so it can be dropped when superseded; undefined for non-deltas. */
  deltaIdentity?: (directory: string, payload: E) => string | undefined
}

export type EventCoalescerOptions<E> = {
  emit: (directory: string, payload: E) => void
  policy: CoalescerPolicy<E>
  batch?: (fn: () => void) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  frameMs?: number
}

export function createEventCoalescer<E>(options: EventCoalescerOptions<E>) {
  const emit = options.emit
  const policy = options.policy
  const batch = options.batch ?? ((fn: () => void) => fn())
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  const frameMs = options.frameMs ?? 16

  // Double-buffered so the flush pass can reuse the drained array as the next
  // queue without reallocating on every frame.
  let queue: QueuedEvent<E>[] = []
  let buffer: QueuedEvent<E>[] = []
  const coalesced = new Map<string, number>()
  // Queue indexes, not identities: a full update supersedes only deltas that
  // arrived before it. A later delta for the same part must remain ordered.
  const staleDeltaIndexes = new Set<number>()
  let timer: TimerHandle | undefined
  let last = 0

  const flush = () => {
    if (timer) clearTimer(timer)
    timer = undefined

    if (queue.length === 0) return

    const events = queue
    const skip = staleDeltaIndexes.size > 0 ? new Set(staleDeltaIndexes) : undefined
    queue = buffer
    buffer = events
    queue.length = 0
    coalesced.clear()
    staleDeltaIndexes.clear()

    last = now()
    batch(() => {
      for (let index = 0; index < events.length; index++) {
        if (skip?.has(index)) continue
        const event = events[index]!
        emit(event.directory, event.payload)
      }
    })

    buffer.length = 0
  }

  const schedule = () => {
    if (timer) return
    const elapsed = now() - last
    timer = setTimer(flush, Math.max(0, frameMs - elapsed))
  }

  const enqueue = (directory: string, payload: E) => {
    // A full update supersedes earlier deltas even when it is the first keyed
    // update for this frame. Supersession describes the payload, not whether
    // the coalesced slot happened to exist already.
    const superseded = policy.supersededDelta?.(directory, payload)
    if (superseded) {
      for (let index = 0; index < queue.length; index++) {
        const event = queue[index]!
        if (policy.deltaIdentity?.(event.directory, event.payload) === superseded) {
          staleDeltaIndexes.add(index)
        }
      }
    }

    const k = policy.coalesceKey(directory, payload)
    if (k) {
      const i = coalesced.get(k)
      if (i !== undefined) {
        queue[i] = { directory, payload }
        return
      }
      coalesced.set(k, queue.length)
    }
    queue.push({ directory, payload })
    schedule()
  }

  return {
    enqueue,
    flush,
    pending: () => queue.length,
  }
}
