import { asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEventOf, FirstTurnErrorClass } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"

function codexErrorInfoMessage(info: unknown) {
  if (info === "usageLimitExceeded") return "You've reached your Codex usage limit."
  if (info === "serverOverloaded") return "Codex is overloaded. Try again in a moment."
  if (info === "unauthorized") {
    return "Codex rejected the credential. Run `codex login` or sync a valid Codex credential, then retry."
  }
  if (info === "contextWindowExceeded") return "This turn exceeded the Codex context window."
  if (info === "cyberPolicy") return "Codex refused this request due to a safety policy."
  return undefined
}

const HTTP_FAILURE_INFO = ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]

function codexErrorInfoClass(info: unknown): FirstTurnErrorClass | undefined {
  if (info === "usageLimitExceeded") return "usage_limit"
  const variants = asRecord(info)
  const status = HTTP_FAILURE_INFO.map((name) => asRecord(variants?.[name])?.httpStatusCode).find((code) => code !== undefined)
  return status === 429 ? "rate_limit" : undefined
}

export function turnErrorEvent(
  error: Record<string, unknown> | undefined,
  rowMessage: string | undefined,
  lastLimitedRateLimitMessage: string | undefined,
  fallback: string,
): AgentRuntimeEventOf<"error"> {
  const message = turnErrorMessage(error, lastLimitedRateLimitMessage) ?? rowMessage
  const errorClass = codexErrorInfoClass(error?.codexErrorInfo)
    ?? (lastLimitedRateLimitMessage && (message === undefined || message.startsWith(lastLimitedRateLimitMessage)) ? "usage_limit" : undefined)
  return {
    type: "error",
    error: message ?? lastLimitedRateLimitMessage ?? fallback,
    ...(errorClass ? { errorClass } : {}),
  }
}

export function turnErrorMessage(error: Record<string, unknown> | undefined, lastLimitedRateLimitMessage?: string) {
  const message = text(error?.message) ?? text(asRecord(error?.message)?.message)
  const details = text(error?.additionalDetails)
  const fromInfo = codexErrorInfoMessage(error?.codexErrorInfo)
  const generic = !message || message.trim().toLowerCase() === "session error"
  const head = generic ? fromInfo ?? lastLimitedRateLimitMessage : message
  if (!head) return details
  if (details && !head.includes(details)) return `${head.replace(/\.$/, "")}. ${details}`
  return head
}
