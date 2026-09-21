import { validateElicitationContent, type ElicitationContent, type ElicitationSchema } from "./elicitation"

export type ElicitationValidationCode = "invalid_answer" | "invalid_schema" | "validation_timeout" | "validation_unavailable" | "validation_busy" | "validation_cancelled"
export class ElicitationValidationError extends Error {
  constructor(readonly code: ElicitationValidationCode, message: string) {
    super(message)
    this.name = "ElicitationValidationError"
  }
}
/** Consent links are displayed without fetching or accepting embedded credentials. */
export function validateElicitationUrl(value: string): void {
  const url = new URL(value)
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Elicitation URL must be HTTP(S) without embedded credentials")
}

export type ElicitationPatternCheck = { field: string; pattern: string; value?: string }
export type ElicitationPatternEvaluator = (checks: ElicitationPatternCheck[], signal?: AbortSignal) => Promise<void>
export const ELICITATION_PATTERN_LIMITS = { fields: 64, pattern: 4096, value: 65536, total: 262144 } as const

export function elicitationPatternChecks(schema: ElicitationSchema, content?: ElicitationContent): ElicitationPatternCheck[] {
  const checks: ElicitationPatternCheck[] = []
  let total = 0
  for (const [field, property] of Object.entries(schema.properties)) {
    if (property.type !== "string" || property.pattern == null) continue
    if (typeof property.pattern !== "string" || property.pattern.length > ELICITATION_PATTERN_LIMITS.pattern) {
      throw new ElicitationValidationError("invalid_schema", `Pattern for ${field} exceeds the supported size`)
    }
    const value = content?.[field]
    if (typeof value === "string" && value.length > ELICITATION_PATTERN_LIMITS.value) {
      throw new ElicitationValidationError("invalid_answer", `Value for ${field} exceeds the pattern validation size limit`)
    }
    total += field.length + property.pattern.length + (typeof value === "string" ? value.length : 0)
    checks.push({ field, pattern: property.pattern, ...(typeof value === "string" ? { value } : {}) })
    if (checks.length > ELICITATION_PATTERN_LIMITS.fields || total > ELICITATION_PATTERN_LIMITS.total) {
      throw new ElicitationValidationError(content ? "invalid_answer" : "invalid_schema", "Form exceeds pattern validation limits")
    }
  }
  return checks
}

/** Complete response validation; the evaluator must isolate native regex work. */
export async function validateElicitationResponse(schema: ElicitationSchema, value: unknown, evaluate: ElicitationPatternEvaluator, signal?: AbortSignal): Promise<ElicitationContent> {
  try { validateElicitationContent(schema, value) }
  catch (error) { throw new ElicitationValidationError("invalid_answer", error instanceof Error ? error.message : "Invalid form response") }
  const checks = elicitationPatternChecks(schema, value)
  if (signal?.aborted) throw new ElicitationValidationError("validation_cancelled", "Form validation was cancelled")
  if (checks.length) await evaluate(checks, signal)
  return value
}
