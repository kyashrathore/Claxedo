import { runtimeDiagnostic, type RuntimeDiagnostic } from "@claxedo/agent-runtime-contract"

export type AcpTranslationDiagnostic =
  | "acp.malformed_raw_input"
  | "acp.malformed_raw_output"
  | "acp.malformed_content"
  | "acp.malformed_plan"
  | "acp.malformed_config_options"
  | "acp.malformed_location"
  | "acp.unknown_content_type"
  | "acp.dropped_content"
  | "acp.empty_error_extraction"
  | "acp.impossible_state_transition"

export type AcpDiagnosticContext = {
  agent?: string
  toolCallId?: string
  title?: string
  kind?: string
  shape?: unknown
  reason?: string
}

export type AcpDiagnostics = {
  items: RuntimeDiagnostic[]
}

export function shape(value: unknown): unknown {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return { type: "array", length: value.length }
  if (typeof value === "object") return { type: "object", keys: Object.keys(value).sort() }
  return typeof value
}

export function diagnoseTranslation(
  diagnostics: AcpDiagnostics,
  event: AcpTranslationDiagnostic,
  ctx: AcpDiagnosticContext,
): void {
  diagnostics.items.push(runtimeDiagnostic({
    code: event,
    message: ctx.reason ? `${event}: ${ctx.reason}` : event,
    severity: event === "acp.dropped_content" ? "info" : "warn",
    details: { acp: ctx as Record<string, unknown> },
  }))
}
