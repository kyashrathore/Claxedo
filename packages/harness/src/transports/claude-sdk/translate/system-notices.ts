import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent, RuntimeNoticeSeverity } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { own } from "../../../translate/value"
import { refusalRetraction } from "./responses"
import { claudeNotice, type ClaudeFrameEvent } from "./sdk-message"
import type { ClaudeTranslatorMemory } from "./translator-memory"

type Notice = { message: (frame: Record<string, unknown>) => string | undefined; severity?: RuntimeNoticeSeverity }

const noticeProtocolMap: Record<string, Notice> = {
  notification: { message: (frame) => text(frame.text) },
  memory_recall: { message: recalledPaths },
  informational: { message: (frame) => text(frame.content) },
  model_fallback: { message: fallbackMessage, severity: "warn" },
  model_consent_fallback: { message: fallbackMessage, severity: "warn" },
  model_refusal_fallback: { message: fallbackMessage, severity: "warn" },
  model_refusal_no_fallback: { message: (frame) => text(frame.content), severity: "warn" },
  mirror_error: { message: (frame) => text(frame.error), severity: "warn" },
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
  if (subtype === "api_retry") return retryEvents(frame)
  const spec = own(noticeProtocolMap, subtype)
  if (!spec) return undefined
  const message = spec.message(frame)
  const severity = subtype === "informational" && (frame.level === "warning" || frame.prevent_continuation === true) ? "warn" : spec.severity
  const retracted = subtype === "model_refusal_fallback" ? refusalRetraction(memory, frame.retracted_message_uuids, event) : []
  return [...retracted, ...(message ? [claudeNotice(subtype, message, severity)] : [])]
}
