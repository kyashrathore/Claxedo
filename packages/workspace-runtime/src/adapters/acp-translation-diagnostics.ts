import { Log } from "../log"

const log = Log.create({ service: "acp-translation" })

export type AcpTranslationDiagnostic =
  | "acp.registry_miss"
  | "acp.generic_fallback"
  | "acp.malformed_raw_input"
  | "acp.malformed_raw_output"
  | "acp.malformed_location"
  | "acp.unknown_content_type"
  | "acp.dropped_content"
  | "acp.empty_error_extraction"
  | "acp.impossible_state_transition"
  | "acp.nested_session_unrepresented"
  | "acp.todo_merge_unrepresented"

export type AcpDiagnosticContext = {
  agent?: string
  version?: string
  sessionId?: string
  toolCallId?: string
  title?: string
  name?: string
  kind?: string
  intent?: string
  extractor?: string
  shape?: unknown
  reason?: string
}

export function shape(value: unknown): unknown {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return { type: "array", length: value.length }
  if (typeof value === "object") return { type: "object", keys: Object.keys(value as Record<string, unknown>).sort() }
  return typeof value
}

export function diagnoseTranslation(event: AcpTranslationDiagnostic, ctx: AcpDiagnosticContext): void {
  const level =
    event === "acp.registry_miss" ||
    event === "acp.generic_fallback" ||
    event === "acp.dropped_content"
      ? "info"
      : "warn"
  log[level](event, ctx as Record<string, unknown>)
}
