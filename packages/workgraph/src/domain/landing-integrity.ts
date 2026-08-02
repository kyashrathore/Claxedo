export type LandingFileChange = Readonly<{
  path: string
  before?: string
  after?: string
}>

export type LandingIntegrityFinding = Readonly<{
  path: string
  rule: "typescript_any" | "typescript_suppression" | "tsconfig_strictness" | "charter_pattern"
  message: string
}>

export type LandingIntegrityEvaluation =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false
      error: Readonly<{
        code: "landing_integrity_violation"
        findings: readonly LandingIntegrityFinding[]
      }>
    }>

/**
 * Rejects a landing when its resulting diff adds a TypeScript escape hatch or
 * weakens compiler strictness. Charter patterns extend this floor; they cannot
 * remove the built-in rules.
 */
export function evaluateLandingIntegrity(input: Readonly<{
  changes: readonly LandingFileChange[]
  forbiddenPatterns?: readonly string[]
}>): LandingIntegrityEvaluation {
  const findings = input.changes.flatMap((change) => [
    ...typescriptEscapeHatches(change),
    ...tsconfigStrictness(change),
    ...charterPatterns(change, input.forbiddenPatterns ?? []),
  ])
  if (findings.length) return { ok: false, error: { code: "landing_integrity_violation", findings } }
  return { ok: true }
}

function typescriptEscapeHatches(change: LandingFileChange): LandingIntegrityFinding[] {
  if (!/\.(?:[cm]?ts|tsx)$/i.test(change.path)) return []
  const before = change.before ?? ""
  const after = change.after ?? ""
  return [
    ...(count(after, /\bany\b/g) > count(before, /\bany\b/g)
      ? [{ path: change.path, rule: "typescript_any" as const, message: "Landing introduces a new TypeScript any" }]
      : []),
    ...(count(after, /@ts-(?:ignore|expect-error)\b/g) > count(before, /@ts-(?:ignore|expect-error)\b/g)
      ? [{ path: change.path, rule: "typescript_suppression" as const, message: "Landing introduces a TypeScript suppression directive" }]
      : []),
  ]
}

function tsconfigStrictness(change: LandingFileChange): LandingIntegrityFinding[] {
  if (!/(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(change.path) || change.after === undefined) return []
  const before = compilerOptions(change.before)
  const after = compilerOptions(change.after)
  if (!after) return []
  const strictBefore = before?.strict === true
  const weakened = strictFlags.some((flag) => {
    const prior = before?.[flag]
    const next = after[flag]
    if (next === false && (prior === true || strictBefore || (flag === "strict" && prior !== false))) return true
    return prior === true && next !== true
  })
  return weakened
    ? [{ path: change.path, rule: "tsconfig_strictness", message: "Landing weakens TypeScript compiler strictness" }]
    : []
}

function charterPatterns(change: LandingFileChange, patterns: readonly string[]): LandingIntegrityFinding[] {
  const before = change.before ?? ""
  const after = change.after ?? ""
  return patterns.flatMap((pattern) => {
    if (!pattern || occurrences(after, pattern) <= occurrences(before, pattern)) return []
    return [{
      path: change.path,
      rule: "charter_pattern" as const,
      message: `Landing introduces charter-forbidden pattern: ${pattern}`,
    }]
  })
}

function compilerOptions(content: string | undefined): Record<string, unknown> | undefined {
  if (content === undefined) return {}
  try {
    const parsed = JSON.parse(content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    const options = (parsed as Record<string, unknown>).compilerOptions
    return options && typeof options === "object" && !Array.isArray(options) ? options as Record<string, unknown> : {}
  } catch {
    return
  }
}

function count(content: string, pattern: RegExp) {
  return content.match(pattern)?.length ?? 0
}

function occurrences(content: string, pattern: string) {
  return content.split(pattern).length - 1
}

const strictFlags = [
  "strict",
  "alwaysStrict",
  "noImplicitAny",
  "noImplicitThis",
  "strictBindCallApply",
  "strictBuiltinIteratorReturn",
  "strictFunctionTypes",
  "strictNullChecks",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
] as const
