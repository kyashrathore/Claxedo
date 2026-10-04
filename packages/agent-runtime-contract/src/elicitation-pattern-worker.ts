import type { ElicitationPatternCheck } from "./elicitation-validation"

/** Worker-only evaluator. Self-contained so Node can serialize trusted code without a worker asset. */
export function evaluateNativeElicitationPatterns(checks: ElicitationPatternCheck[]): { code: "invalid_schema" | "invalid_answer"; message: string } | null {
  for (const check of checks) {
    let pattern: RegExp
    try { pattern = new RegExp(check.pattern, "u") }
    catch { return { code: "invalid_schema", message: `Invalid pattern for ${check.field}` } }
    if (check.value !== undefined && !pattern.test(check.value)) return { code: "invalid_answer", message: `Invalid value for ${check.field}` }
  }
  return null
}
