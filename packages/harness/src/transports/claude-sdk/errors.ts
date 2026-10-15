import { AbortError } from "@anthropic-ai/claude-agent-sdk"
import { errorMessage } from "@claxedo/helpers"
import { TransportError } from "../../contract/errors"
import { stderrReason } from "../../rpc/stderr-tail"

export function claudeStreamEndedWithoutResult(): TransportError {
  return new TransportError("claude", "protocol", "Claude SDK stream ended without a result")
}

export function claudeGoalNotCleared(message: string): TransportError {
  return new TransportError("claude", "protocol", message, { retryable: true })
}

export function claudeProcessFailed(error: unknown, stderr: string): unknown {
  if (error instanceof TransportError || error instanceof AbortError) return error
  const reason = stderrReason(stderr)
  const message = reason ? `${errorMessage(error)}: ${reason}` : errorMessage(error)
  return new TransportError("claude", "process", message, { retryable: true, cause: error, ...(stderr ? { detail: { stderr } } : {}) })
}
