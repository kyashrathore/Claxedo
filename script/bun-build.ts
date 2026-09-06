/**
 * Running `Bun.build` and reporting what it says.
 *
 * `Bun.build` defaults to `throw: true`, so a failed bundle rejects with an
 * `AggregateError` and never returns `success: false`. Six build scripts in
 * this repository were written against the other contract and each grew its
 * own `if (!result.success)` branch — none of which could run. The branches
 * were not merely redundant; three things were lost inside them:
 *
 *   1. `bundle-claxedo-server.ts` removed its `dist.pending-<pid>` staging
 *      directory there, so a failed desktop server bundle leaked one every
 *      time. That is what `onFailure` below exists for.
 *   2. `verify-mermaid-svg-sanitizer.mjs` held the only log formatter in the
 *      repository that reads `position` and names a file, line and column.
 *      Everywhere else a bundling failure identified no source location at
 *      all. That formatter is now `describeBuildLog`, and every caller gets it.
 *   3. `logs` is typed as populated on success as well as failure, and no site
 *      read it outside the unreachable branch. Anything Bun reports on a
 *      successful build is printed here instead of discarded.
 *
 * The config parameter omits `throw` deliberately: with it fixed at the
 * default there is exactly one failure path, and no caller can reintroduce a
 * `success: false` that nothing checks.
 */

type BuildLogPosition = {
  file: string
  line: number
  column: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readPosition(value: unknown): BuildLogPosition | undefined {
  if (!isRecord(value)) return undefined
  const { file, line, column } = value
  if (typeof file !== "string" || typeof line !== "number" || typeof column !== "number") return undefined
  return { file, line, column }
}

/**
 * Anything Bun hands back that is not a log entry in the expected shape.
 *
 * `String(someObject)` is `[object Object]`, which reports a build failure as
 * no information at all — the exact defect this helper exists to stop. Objects
 * are serialized instead, and the two cases `JSON.stringify` cannot represent
 * (functions, symbols) are named rather than rendered as `undefined`.
 */
function describeUnrecognized(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  try {
    return JSON.stringify(value) ?? "[unrecognized build log]"
  } catch {
    return "[unrecognized build log]"
  }
}

/**
 * One line per log entry, carrying the source location when there is one.
 *
 * `logs` mixes `BuildMessage` and `ResolveMessage`, and only the latter
 * declares `toString`, so joining the entries relied on an undeclared runtime
 * detail for half of them — and even where it worked it dropped the position.
 * These read the fields instead.
 *
 * `position` is optional and its absence is meaningful rather than incidental:
 * measured on Bun 1.3.14, an unresolved import (`ResolveMessage`) and a syntax
 * error (`BuildMessage`) both carry one, while a missing entrypoint file
 * (`BuildMessage`, `ModuleNotFound`) has none, because no source location
 * applies. The location is therefore omitted rather than rendered as
 * `undefined:undefined:undefined`.
 */
export function describeBuildLog(log: unknown): string {
  if (!isRecord(log)) return describeUnrecognized(log)
  const level = typeof log.level === "string" ? log.level : "error"
  const message = typeof log.message === "string" ? log.message : describeUnrecognized(log)
  const position = readPosition(log.position)
  const where = position ? ` (${position.file}:${position.line}:${position.column})` : ""
  return `${level}: ${message}${where}`
}

/** The individual messages behind a thrown build failure, in report order. */
function buildFailureLogs(error: unknown): unknown[] {
  if (error instanceof AggregateError && Array.isArray(error.errors)) return error.errors
  return [error]
}

export type RunBunBuildOptions = {
  /**
   * Run before the failure is rethrown — for undoing side effects the build
   * itself created, such as a staging directory that would otherwise leak.
   * Failures here are not swallowed: they surface in place of the build error,
   * which is the more useful signal, since a cleanup that cannot run is a bug
   * of its own.
   */
  onFailure?: () => void
}

/**
 * Build, and on failure raise `label` with every message Bun produced.
 *
 * The original `AggregateError` is preserved as `cause`, so nothing is hidden
 * behind the formatted summary. The `BuildOutput` is returned unchanged.
 */
export async function runBunBuild(
  label: string,
  config: Omit<Bun.BuildConfig, "throw">,
  options?: RunBunBuildOptions,
): Promise<Bun.BuildOutput> {
  let result: Bun.BuildOutput
  try {
    result = await Bun.build(config)
  } catch (error) {
    options?.onFailure?.()
    const detail = buildFailureLogs(error).map(describeBuildLog).join("\n")
    throw new Error(detail ? `${label}\n${detail}` : label, { cause: error })
  }

  for (const log of result.logs) console.warn(describeBuildLog(log))
  return result
}
