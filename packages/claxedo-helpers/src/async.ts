import { isRecord } from "./guards"

/**
 * The lifecycle timers accept an injectable clock, so a handle is whatever that
 * clock returned. The platform issues either a numeric id (browsers, Bun) or a
 * `Timeout` object (Node); anything else was not issued by `setTimeout` and is
 * left alone.
 */
export function clearOpaqueTimer(handle: unknown): void {
  if (typeof handle === "number") clearTimeout(handle)
  else if (isNodeTimeout(handle)) clearTimeout(handle)
}

function isNodeTimeout(value: unknown): value is NodeJS.Timeout {
  return isRecord(value) && typeof value.unref === "function"
}

/**
 * ALWAYS schedules the timer, including for `ms === 0` and negative ms:
 * `await sleep(0)` must stay a macrotask yield. Callers in the SSE drain loop
 * and in the Solid suites use it precisely to return control to the event loop,
 * which a microtask-only resolve does not do.
 *
 * Does not `unref()` the handle — unref does not exist in the renderer or on
 * workerd.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface KeyedSerializer<K> {
  run<T>(key: K, operation: () => Promise<T>): Promise<T>
  clear(): void
}

/**
 * Serializes async work per key: equal keys never overlap, different keys run
 * concurrently. A rejected operation neither blocks nor poisons its successors,
 * and `run` returns the operation's own promise, so the caller sees the original
 * value and the original rejection reason.
 */
export function createKeyedSerializer<K = string>(): KeyedSerializer<K> {
  const tails = new Map<K, Promise<void>>()
  return {
    run<T>(key: K, operation: () => Promise<T>): Promise<T> {
      const previous = tails.get(key)
      // No previous work means this operation's turn is now, so it is invoked
      // synchronously rather than deferred by a microtask.
      const result = previous ? previous.catch(() => undefined).then(operation) : operation()
      const tail = result.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      void tail.then(() => {
        // Identity guard: only drop the entry if it is still the tail this call
        // installed, so concurrent callers never delete each other's queue.
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    },
    clear(): void {
      // Teardown only: in-flight work is not cancelled.
      tails.clear()
    },
  }
}

/**
 * Polls until the endpoint answers ok or the deadline passes. A non-ok response
 * and ANY thrown fetch error — connection refused while a process is still
 * booting, DNS, abort — are both swallowed and retried. The body is never read;
 * callers that want the payload re-fetch it.
 */
export async function waitForHealth(
  url: string,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const intervalMs = options?.intervalMs ?? 150
  const deadline = Date.now() + (options?.timeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      // Still booting; fall through to the interval sleep and retry.
    }
    await sleep(intervalMs)
  }
  return false
}

export function singleFlightUntil<Args extends unknown[], Result>(
  run: (...args: Args) => Promise<Result>,
  settled: (result: Result) => boolean,
): (...args: Args) => Promise<Result> {
  let inFlight: Promise<Result> | undefined
  let final: Promise<Result> | undefined
  return (...args) => {
    if (final) return final
    if (inFlight) return inFlight
    const attempt = run(...args)
    inFlight = attempt
    const release = () => { if (inFlight === attempt) inFlight = undefined }
    void attempt.then((result) => {
      if (settled(result)) final = attempt
      release()
    }, release)
    return attempt
  }
}

export function limitConcurrency(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  return async (work) => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve))
    active += 1
    try {
      return await work()
    } finally {
      active -= 1
      queue.shift()?.()
    }
  }
}
