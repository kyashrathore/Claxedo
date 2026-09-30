import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent, RuntimeNoticeSeverity } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { claudeNotice } from "./sdk-message"

function notice(code: string, message: string | undefined, severity: RuntimeNoticeSeverity = "info", details?: Record<string, unknown>) {
  return message ? [claudeNotice(code, message, severity, details)] : []
}

function retryMessage(frame: Record<string, unknown>) {
  const cause = [text(frame.error), asFiniteNumber(frame.error_status)].filter((part) => part !== undefined).join(" ")
  const delay = Math.round((asFiniteNumber(frame.retry_delay_ms) ?? 0) / 1000)
  return `Claude is retrying the model request (attempt ${String(frame.attempt)} of ${String(frame.max_retries)}${cause ? `, ${cause}` : ""}) in ${delay} s`
}

function recalledPaths(frame: Record<string, unknown>) {
  const memories = Array.isArray(frame.memories) ? frame.memories : []
  const paths = memories.flatMap((memory) => text(asRecord(memory)?.path) ?? [])
  return paths.length ? `Recalled from memory: ${paths.join(", ")}` : undefined
}

function fallbackMessage(frame: Record<string, unknown>) {
  return text(frame.content) ?? `Claude switched from ${String(frame.original_model)} to ${String(frame.fallback_model)}`
}

export function systemNotice(subtype: string, frame: Record<string, unknown>): AgentRuntimeEvent[] | undefined {
  switch (subtype) {
    case "api_retry":
      return notice(subtype, retryMessage(frame), "warn")
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
      return notice(subtype, fallbackMessage(frame), "warn", { retractedMessageUuids: Array.isArray(frame.retracted_message_uuids) ? frame.retracted_message_uuids : [] })
    case "model_refusal_no_fallback":
      return notice(subtype, text(frame.content), "warn")
    case "mirror_error":
      return notice(subtype, text(frame.error), "warn")
    default:
      return undefined
  }
}
