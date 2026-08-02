export type RuntimeDiagnosticSeverity = "debug" | "info" | "warn" | "error"

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

export function normalizeDiagnostics(input: unknown): RuntimeDiagnostic[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    if (typeof row.code !== "string" || typeof row.message !== "string") return []
    const severity =
      row.severity === "debug" || row.severity === "info" || row.severity === "warn" || row.severity === "error"
        ? row.severity
        : "warn"
    return [runtimeDiagnostic({
      code: row.code,
      message: row.message,
      severity,
      source: typeof row.source === "string" ? row.source : undefined,
      method: typeof row.method === "string" ? row.method : undefined,
      raw: row.raw,
      details: row.details && typeof row.details === "object" && !Array.isArray(row.details)
        ? row.details as Record<string, unknown>
        : undefined,
    })]
  })
}
