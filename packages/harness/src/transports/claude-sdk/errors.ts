import { TransportError } from "../../contract/errors"

export function claudeStreamEndedWithoutResult(): TransportError {
  return new TransportError("claude", "protocol", "Claude SDK stream ended without a result")
}

export function claudeGoalNotCleared(message: string): TransportError {
  return new TransportError("claude", "protocol", message, { retryable: true })
}
