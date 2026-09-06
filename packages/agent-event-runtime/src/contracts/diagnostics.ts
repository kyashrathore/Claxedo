import { object, text } from "../value"

/** The declared severities, as the single source for both the type and the parser. */
const RUNTIME_DIAGNOSTIC_SEVERITIES = ["debug", "info", "warn", "error"] as const

export type RuntimeDiagnosticSeverity = (typeof RUNTIME_DIAGNOSTIC_SEVERITIES)[number]

export type RuntimeDiagnostic = {
  code: string
  message: string
  severity: RuntimeDiagnosticSeverity
  source?: string
  method?: string
  raw?: unknown
  details?: Record<string, unknown>
}

export function runtimeDiagnostic(input: {
  code: string
  message: string
  severity?: RuntimeDiagnosticSeverity
  source?: string
  method?: string
  raw?: unknown
  details?: Record<string, unknown>
}): RuntimeDiagnostic {
  return {
    code: input.code,
    message: input.message,
    severity: input.severity ?? "warn",
    ...(input.source ? { source: input.source } : {}),
    ...(input.method ? { method: input.method } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
    ...(input.details ? { details: input.details } : {}),
  }
}

function diagnosticSeverity(value: unknown): RuntimeDiagnosticSeverity | undefined {
  return RUNTIME_DIAGNOSTIC_SEVERITIES.find((severity) => severity === value)
}

/** Parses an unknown payload into diagnostics, dropping rows that carry no code or message. */
export function normalizeDiagnostics(input: unknown): RuntimeDiagnostic[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item: unknown) => {
    const row = object(item)
    if (!row) return []
    const { code, message } = row
    if (typeof code !== "string" || typeof message !== "string") return []
    return [runtimeDiagnostic({
      code,
      message,
      severity: diagnosticSeverity(row.severity) ?? "warn",
      source: text(row.source),
      method: text(row.method),
      raw: row.raw,
      details: object(row.details),
    })]
  })
}
