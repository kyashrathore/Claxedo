/**
 * Running `Bun.build` and reporting what it says, and the dist build a
 * workspace package script composes from its bundles.
 *
 * `Bun.build` defaults to `throw: true`, so a failed bundle rejects with an
 * `AggregateError` and never returns `success: false`. The config parameter
 * omits `throw` so that stays the only failure path: no caller can branch on a
 * `success: false` that never arrives. `logs` is populated on success too, and
 * is printed rather than discarded.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { publishedExportsPlugin } from "./published-exports-plugin"

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

/** Entrypoints and `root` are relative to the package; output always lands in its `dist`. */
export type PackageBundle = Omit<Bun.BuildConfig, "throw" | "outdir">

/**
 * Replace a package's `dist` with its bundles and, unless `declarations` is
 * false, the declaration tree its `tsconfig.build.json` emits beside them.
 * Sibling `@claxedo/*` packages bundle from their published dist, as an npm
 * consumer would get them.
 */
export async function buildPackage(input: {
  root: string
  bundles: readonly PackageBundle[]
  declarations?: boolean
}): Promise<Bun.BuildOutput[]> {
  const dist = path.join(input.root, "dist")
  const label = `${path.basename(input.root)} bundle failed`
  fs.rmSync(dist, { recursive: true, force: true })
  const outputs: Bun.BuildOutput[] = []
  for (const bundle of input.bundles) {
    outputs.push(await runBunBuild(label, {
      ...bundle,
      entrypoints: bundle.entrypoints.map((entry) => path.resolve(input.root, entry)),
      root: bundle.root === undefined ? undefined : path.resolve(input.root, bundle.root),
      outdir: dist,
      plugins: [publishedExportsPlugin(), ...(bundle.plugins ?? [])],
    }))
  }
  if (input.declarations !== false) {
    execFileSync(path.join(input.root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], {
      cwd: input.root,
      stdio: "inherit",
    })
  }
  return outputs
}
