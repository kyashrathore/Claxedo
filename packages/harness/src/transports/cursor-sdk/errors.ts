import { TransportError } from "../../contract/errors"
import type { HostFailure } from "./protocol"

export function cursorSdkFailure(failure: HostFailure): TransportError {
  const detail = { ...(failure.name ? { sdkError: failure.name } : {}), ...(failure.code ? { code: failure.code } : {}) }
  return new TransportError("cursor", "sdk", failure.message, {
    ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
    ...(Object.keys(detail).length ? { detail } : {}),
  })
}

export function cursorRunResultMissing(): TransportError {
  return new TransportError("cursor", "sdk", "Cursor omitted its run result", { retryable: false })
}

export function cursorRunStatusUnknown(status: string): TransportError {
  return new TransportError("cursor", "sdk", `Cursor reported unknown run status ${status}`, { retryable: false })
}

export function cursorStopPending(what: string): TransportError {
  return new TransportError("cursor", "worker", `${what}: Cursor cancelled the run, and it had not ended by the stop's deadline`, { retryable: true })
}

export function cursorSteerUnanswered(): TransportError {
  return new TransportError("cursor", "sdk", "Cursor answered the steer with no outcome", { retryable: false })
}
