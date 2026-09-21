import { createIdleReaper, type IdleReaper } from "../shared/process-lifecycle"

/** Owns cancellation and human-wait-aware timeout for one initialize or session/new request. */
export function createStartupRequestLease(timeoutMs: number | undefined, idle: { release(): void }, method = "newSession", signal?: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  const cancelled = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(new Error(`ACP ${method} cancelled`))
    else controller.signal.addEventListener("abort", () => reject(new Error(`ACP ${method} cancelled`)), { once: true })
  })
  void cancelled.catch(() => {})
  let quiet: IdleReaper | undefined
  const timeout = timeoutMs === undefined ? undefined : new Promise<never>((_, reject) => {
    quiet = createIdleReaper({
      idleMs: timeoutMs,
      onIdle: () => reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms of inactivity`)),
    })
    quiet.touch()
  })
  return {
    controller,
    quiet,
    wait<T>(request: Promise<T>): Promise<T> {
      return Promise.race(timeout ? [request, timeout, cancelled] : [request, cancelled])
    },
    release() {
      signal?.removeEventListener("abort", abort)
      controller.abort()
      quiet?.cancel()
      idle.release()
    },
  }
}
