import { asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEventOf, FirstTurnErrorClass } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { v2 } from "./protocol"

const INFO_MESSAGES: Readonly<Record<string, string>> = {
  usageLimitExceeded: "You've reached your Codex usage limit.",
  rateLimitExceeded: "Codex is rate limited. Try again shortly.",
  serverOverloaded: "Codex is overloaded. Try again in a moment.",
  unauthorized: "Codex rejected the credential. Run `codex login` or sync a valid Codex credential, then retry.",
  contextWindowExceeded: "This turn exceeded the Codex context window.",
  cyberPolicy: "Codex refused this request due to a safety policy.",
  flexUnavailable: "Flex capacity is unavailable. Try another model or service tier.",
  tooManyDenials: "Codex stopped the turn after too many denied approvals.",
}

const PINNED_INFO_CLASSES = {
  usageLimitExceeded: "usage_limit",
  rateLimitExceeded: "rate_limit",
  serverOverloaded: "model",
  unauthorized: "credential",
  sandboxError: "workspace",
  threadRollbackFailed: "session",
  contextWindowExceeded: "unknown",
  sessionBudgetExceeded: "unknown",
  cyberPolicy: "unknown",
  misalignmentPolicyViolation: "unknown",
  internalServerError: "unknown",
  badRequest: "unknown",
  other: "unknown",
} as const satisfies Record<Extract<v2.CodexErrorInfo, string>, FirstTurnErrorClass>

const INFO_CLASSES: Readonly<Record<string, FirstTurnErrorClass>> = { ...PINNED_INFO_CLASSES, flexUnavailable: "model", tooManyDenials: "unknown" }

function httpStatusClass(status: unknown): FirstTurnErrorClass {
  if (status === 429) return "rate_limit"
  return status === 401 || status === 403 ? "credential" : "unknown"
}

function codexErrorInfoClass(info: unknown): FirstTurnErrorClass | undefined {
  const name = text(info)
  if (name) return Object.hasOwn(INFO_CLASSES, name) ? INFO_CLASSES[name] : "unknown"
  const variant = Object.values(asRecord(info) ?? {})[0]
  if (!variant) return undefined
  return httpStatusClass(asRecord(variant)?.httpStatusCode)
}

function errorClass(info: unknown, message: string | undefined, lastLimitedRateLimitMessage: string | undefined) {
  const fromInfo = codexErrorInfoClass(info)
  if (fromInfo && fromInfo !== "unknown") return fromInfo
  const limited = lastLimitedRateLimitMessage && (message === undefined || message.startsWith(lastLimitedRateLimitMessage))
  return limited ? "usage_limit" : fromInfo
}

export function turnErrorEvent(
  error: Record<string, unknown> | undefined,
  rowMessage: string | undefined,
  lastLimitedRateLimitMessage: string | undefined,
  fallback: string,
): AgentRuntimeEventOf<"error"> {
  const message = turnErrorMessage(error, lastLimitedRateLimitMessage) ?? rowMessage
  const errorClassValue = errorClass(error?.codexErrorInfo, message, lastLimitedRateLimitMessage)
  return {
    type: "error",
    error: message ?? lastLimitedRateLimitMessage ?? fallback,
    ...(errorClassValue ? { errorClass: errorClassValue } : {}),
  }
}

export function turnErrorMessage(error: Record<string, unknown> | undefined, lastLimitedRateLimitMessage?: string) {
  const message = text(error?.message) ?? text(asRecord(error?.message)?.message)
  const details = text(error?.additionalDetails)
  const info = text(error?.codexErrorInfo)
  const fromInfo = info && Object.hasOwn(INFO_MESSAGES, info) ? INFO_MESSAGES[info] : undefined
  const generic = !message || message.trim().toLowerCase() === "session error"
  const head = generic ? fromInfo ?? lastLimitedRateLimitMessage : message
  if (!head) return details
  if (details && !head.includes(details)) return `${head.replace(/\.$/, "")}. ${details}`
  return head
}
