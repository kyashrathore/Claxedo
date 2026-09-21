import type { RecoveryErrorCode } from "@claxedo/agent-runtime-contract"

/** A caller's own deadline, so a harness request cannot outlive the operation that asked for it. */
export type RequestDeadline = {
  signal: AbortSignal
  deadlineAt: number
}

export class RecoveryCodedError extends Error {
  constructor(readonly code: RecoveryErrorCode, message: string) {
    super(message)
    this.name = "RecoveryCodedError"
  }
}

export function deadlineExceeded(what: string) {
  return new RecoveryCodedError("deadline_exceeded", `${what} did not answer within its deadline; its outcome is unknown`)
}

/**
 * Settles the caller at its deadline and detaches it from the request. It does
 * not cancel the request: `abandon` drops the owner's pending entry, and
 * whatever the provider does afterwards is reported against the operation
 * rather than rewritten into this caller's answer.
 */
export function settleAtRequestDeadline<T>(
  what: string,
  deadline: RequestDeadline,
  request: Promise<T>,
  abandon: () => void,
): Promise<T> {
  // The request outlives this promise on the deadline path, and an unobserved
  // rejection there would take the process down.
  void request.catch(() => {})
  const remaining = deadline.deadlineAt - Date.now()
  if (remaining <= 0 || deadline.signal.aborted) {
    abandon()
    return Promise.reject(deadlineExceeded(what))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const stop = () => {
      const first = !settled
      settled = true
      clearTimeout(timer)
      deadline.signal.removeEventListener("abort", expire)
      return first
    }
    const expire = () => {
      if (!stop()) return
      abandon()
      reject(deadlineExceeded(what))
    }
    const timer = setTimeout(expire, remaining)
    deadline.signal.addEventListener("abort", expire, { once: true })
    request.then(
      (value) => { if (stop()) resolve(value) },
      (error: unknown) => { if (stop()) reject(error) },
    )
  })
}
