import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent, RuntimeNoticeSeverity } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { refusalRetraction } from "./responses"
import { claudeNotice, type ClaudeFrameEvent } from "./sdk-message"
import type { ClaudeTranslatorMemory } from "./translator-memory"

function notice(code: string, message: string | undefined, severity: RuntimeNoticeSeverity = "info", details?: Record<string, unknown>) {
  return message ? [claudeNotice(code, message, severity, details)] : []
}

function retryCause(frame: Record<string, unknown>) {
  const status = asFiniteNumber(frame.error_status)
  return [text(frame.error), status === undefined ? undefined : `HTTP ${status}`].filter((part) => part !== undefined).join(", ")
}

function retryEvents(frame: Record<string, unknown>): AgentRuntimeEvent[] {
  const attempt = asFiniteNumber(frame.attempt)
  const delayMs = asFiniteNumber(frame.retry_delay_ms)
  const limit = asFiniteNumber(frame.max_retries)
  const cause = retryCause(frame)
  const counted = attempt !== undefined && limit !== undefined ? `; retry ${attempt} of ${limit}` : ""
  return [{ type: "session-retry", message: `The model request failed${cause ? ` (${cause})` : ""}${counted}`,
    ...(attempt !== undefined ? { attempt } : {}), ...(delayMs !== undefined ? { delayMs } : {}) }]
}

function recalledPaths(frame: Record<string, unknown>) {
  const memories = Array.isArray(frame.memories) ? frame.memories : []
  const paths = memories.flatMap((memory) => text(asRecord(memory)?.path) ?? [])
  return paths.length ? `Recalled from memory: ${paths.join(", ")}` : undefined
}

function fallbackMessage(frame: Record<string, unknown>) {
  return text(frame.content) ?? `Claude switched from ${String(frame.original_model)} to ${String(frame.fallback_model)}`
}

export function systemNotice(subtype: string, frame: Record<string, unknown>, memory: ClaudeTranslatorMemory, event: ClaudeFrameEvent): AgentRuntimeEvent[] | undefined {
  switch (subtype) {
    case "api_retry":
      return retryEvents(frame)
    case "notification":
      return notice(subtype, text(frame.text))
    case "memory_recall":
      return notice(subtype, recalledPaths(frame))
    case "informational":
      return notice(subtype, text(frame.content), frame.level === "warning" || frame.prevent_continuation === true ? "warn" : "info")
    case "model_fallback":
    case "model_consent_fallback":
      return notice(subtype, fallbackMessage(frame), "warn")
    case "model_refusal_fallback":
      return [...refusalRetraction(memory, frame.retracted_message_uuids, event), ...notice(subtype, fallbackMessage(frame), "warn")]
    case "model_refusal_no_fallback":
      return notice(subtype, text(frame.content), "warn")
    case "mirror_error":
      return notice(subtype, text(frame.error), "warn")
    default:
      return undefined
  }
}
