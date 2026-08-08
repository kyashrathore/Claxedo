import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"

// Narrows `status` back to the literal the base widens to `number`: callers
// pass it straight to `c.json(body, status)`, which takes a status-code union.
// Declared by merging rather than as a `declare` class field because this file
// is loaded through Playwright's babel transform, which rejects `declare`
// fields unless @babel/plugin-transform-typescript is configured. Merging is
// purely type-level, so it erases cleanly under any transform.
export interface ControlPlaneRequestTimeoutError {
  readonly status: 503
}

export class ControlPlaneRequestTimeoutError extends ClaxedoError {
  constructor() {
    // Retryable, but only jointly with the caller's own idempotency check: the
    // request was not cancelled and may still commit, so a store adapter must
    // gate a replay on the OPERATION being safe to repeat, not on this flag.
    super({
      code: "control_plane_request_timeout",
      message: "Control Plane request timed out",
      status: 503,
      retryable: true,
    })
  }
}

/**
 * Reads a positive-integer millisecond bound from `name`, falling back to
 * `fallbackMs`. Zero and negative values fall back rather than disabling the
 * bound: an unbounded wait is never what an operator means by "0".
 */
export function timeoutMsFromEnv(
  name: string,
  fallbackMs: number,
  env: Record<string, string | undefined> = process.env,
) {
  const configured = Number(env[name])
  return Number.isFinite(configured) && configured > 0 ? configured : fallbackMs
}

/**
 * Bounds caller wait time only. The underlying fetch is not cancelled and may
 * finish later; store mutations remain responsible for their own idempotency.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutError: () => Error = () => new ControlPlaneRequestTimeoutError(),
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(timeoutError()),
      ms,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
