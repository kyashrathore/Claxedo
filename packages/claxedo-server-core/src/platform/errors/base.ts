/**
 * The one base every Claxedo error extends, carrying the three things a caller
 * needs to handle a failure without inspecting its message text: what went
 * wrong (`code`), how it surfaces over HTTP (`status`), and whether trying
 * again could plausibly do better (`retryable`).
 *
 * `retryable` defaults to FALSE: an unclassifiable error treated as transient
 * is how a non-idempotent write gets replayed. Opting in has to be deliberate.
 */

export type ClaxedoErrorInit = {
  /** Stable identifier a client may branch on. Snake case by convention. */
  code: string
  message: string
  /** HTTP status this failure should surface as. Defaults to 500. */
  status?: number
  /** Whether a retry could plausibly succeed. Defaults to false. */
  retryable?: boolean
  cause?: unknown
}

export class ClaxedoError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean

  constructor(init: ClaxedoErrorInit) {
    super(init.message, ...(init.cause !== undefined ? [{ cause: init.cause }] : []))
    // `new.target` is the most-derived constructor, so a subclass reports its
    // own name without restating it. Omitting this reports "Error" in logs.
    this.name = new.target.name
    this.code = init.code
    this.status = init.status ?? 500
    this.retryable = init.retryable ?? false
  }
}

export function isClaxedoError(error: unknown): error is ClaxedoError {
  return error instanceof ClaxedoError
}

/**
 * The HTTP status for ANY thrown value.
 *
 * Reads the structural shape rather than requiring `ClaxedoError`, because
 * errors cross package boundaries (`@claxedo/workgraph`, the SDK) where an
 * `instanceof` check fails against a different realm's class identity while the
 * fields are still there.
 */
export function statusOf(error: unknown, fallback = 500) {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === "number" && status >= 100 && status <= 599 ? status : fallback
}

export function codeOf(error: unknown, fallback = "internal_error") {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && code ? code : fallback
}

/**
 * Whether a failure is worth retrying. Defaults to false for unknown shapes —
 * see the note on `retryable` above.
 */
export function isRetryable(error: unknown) {
  return (error as { retryable?: unknown } | null)?.retryable === true
}

/**
 * The structured body every API error response uses. Flattening this to a
 * scalar `{ error: "..." }` is what `tests/governance/codebase-shape.test.ts` forbids.
 */
export function errorBody(error: unknown, fallbackMessage = "Internal error") {
  const message = error instanceof Error && error.message ? error.message : fallbackMessage
  return { error: { code: codeOf(error), message } }
}
