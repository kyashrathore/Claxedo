export class ControlPlaneRequestTimeoutError extends Error {
  readonly status = 503 as const
  readonly code = "control_plane_request_timeout" as const

  constructor() {
    super("Control Plane request timed out")
    this.name = "ControlPlaneRequestTimeoutError"
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
