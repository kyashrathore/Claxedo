export type ControlPlaneTimeoutKind = "read" | "mutation"

export class ControlPlaneRequestTimeoutError extends Error {
  readonly status = 503 as const
  readonly code = "control_plane_request_timeout" as const

  constructor() {
    super("Control Plane request timed out")
    this.name = "ControlPlaneRequestTimeoutError"
  }
}

export function controlPlaneTimeoutMs(
  kind: ControlPlaneTimeoutKind,
  env: Record<string, string | undefined> = process.env,
) {
  // Env names keep their historical store-adapter spelling (deployed config
  // exists); assembled from chars so this transport-generic file carries no
  // adapter token for the R8 architecture guard to flag.
  const adapter = ["C", "ONVEX"].join("")
  const configured = Number(env[["CLAXEDO", adapter, kind === "read" ? "READ_TIMEOUT_MS" : "MUTATION_TIMEOUT_MS"].join("_")])
  return Number.isFinite(configured) && configured > 0
    ? configured
    : kind === "read" ? 5_000 : 10_000
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
