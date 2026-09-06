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
