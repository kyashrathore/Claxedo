import { AbortError } from "@anthropic-ai/claude-agent-sdk"
import { errorMessage } from "@claxedo/helpers"
import { TransportError } from "../../contract/errors"

export function claudeStreamEndedWithoutResult(): TransportError {
  return new TransportError("claude", "protocol", "Claude SDK stream ended without a result")
}

export function claudeGoalNotCleared(message: string): TransportError {
  return new TransportError("claude", "protocol", message, { retryable: true })
}

export function claudeProcessFailed(error: unknown, stderr: string): unknown {
  if (error instanceof TransportError || error instanceof AbortError) return error
  return new TransportError("claude", "process", errorMessage(error), { retryable: true, cause: error, ...(stderr ? { detail: { stderr } } : {}) })
}
