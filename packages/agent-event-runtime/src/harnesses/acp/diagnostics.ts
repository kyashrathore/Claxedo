import { runtimeDiagnostic, type RuntimeDiagnostic } from "../../contracts/diagnostics"

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

export type AcpDiagnostics = {
  items: RuntimeDiagnostic[]
}

export function createAcpDiagnostics(): AcpDiagnostics {
  return { items: [] }
}

export function shape(value: unknown): unknown {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return { type: "array", length: value.length }
  if (typeof value === "object") return { type: "object", keys: Object.keys(value as Record<string, unknown>).sort() }
  return typeof value
}

export function diagnoseTranslation(
  diagnostics: AcpDiagnostics,
  event: AcpTranslationDiagnostic,
  ctx: AcpDiagnosticContext,
): void {
  const level =
    event === "acp.dropped_content"
      ? "info"
      : "warn"
  diagnostics.items.push(runtimeDiagnostic({
    code: event,
    message: ctx.reason ? `${event}: ${ctx.reason}` : event,
    severity: level,
    details: { acp: ctx as Record<string, unknown> },
  }))
}
