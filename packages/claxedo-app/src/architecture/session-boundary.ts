import { readFileSync } from "node:fs"
import path from "node:path"
import { importSpecifiers, resolveImport } from "./import-graph"
import { topLevelDir } from "./layering"
import { prodSourcePaths, type SourceFile } from "./scanners"

/**
 * The post-D1 session-client layer lives under `src/session/**`. It is the
 * headless composition seam that WP-02 wants importable without dragging the
 * whole app shell along. To keep that seam honest it must not reach UP into the
 * app-shell chrome: it may not import the internals of these top-level
 * directories. (Root-level `src/context/*` is the app-shell provider tree;
 * `shell/`, `pane/`, and `claxedo-ui/` are shell chrome.)
 *
 * The rule is the deliverable; a shrink-only baseline records the current
 * offenders (session/store descends from shell/ and still imports it). Driving
 * the baseline to empty is Wave-5+ debt work.
 */
export const SESSION_DIR = "session"

export const SESSION_FORBIDDEN_TARGET_DIRS = ["pane", "shell", "claxedo-ui", "context"] as const

export type SessionBoundaryViolation = {
  file: string
  specifier: string
  target: string
}

/**
 * Pure detection: every production import from a `session/**` file into the
 * internals of a forbidden top-level directory, given an injected specifier
 * resolver (relative file path + specifier -> resolved relative file path, or
 * null). No filesystem access -- safe to call with synthetic fixtures.
 */
export function sessionBoundaryViolationsFromFiles(
  files: SourceFile[],
  resolveSpecifier: (fromRelFile: string, specifier: string) => string | null,
): SessionBoundaryViolation[] {
  const forbidden = new Set<string>(SESSION_FORBIDDEN_TARGET_DIRS)
  const violations: SessionBoundaryViolation[] = []

  for (const file of files) {
    if (topLevelDir(file.path) !== SESSION_DIR) continue

    for (const specifier of importSpecifiers(file.text)) {
      const relTarget = resolveSpecifier(file.path, specifier)
      if (!relTarget) continue
      const toDir = topLevelDir(relTarget)
      if (!toDir || !forbidden.has(toDir)) continue
      violations.push({ file: file.path, specifier, target: relTarget })
    }
  }

  return violations
}

/**
 * Stable, migration-form-independent key for a violation: the importing file
 * and its resolved target (never the raw specifier, so an `@/` <-> relative
 * rewrite does not churn the baseline).
 */
export function sessionBoundaryKey(violation: SessionBoundaryViolation): string {
  return `${violation.file} -> ${violation.target}`
}

/** Thin fs-reading wrapper over the real tree rooted at `appRoot`. */
export function sessionBoundaryViolationKeys(appRoot: string): string[] {
  const srcRoot = path.join(appRoot, "src")
  const files: SourceFile[] = prodSourcePaths(appRoot).map((file) => ({
    path: path.relative(srcRoot, file).split(path.sep).join("/"),
    text: readFileSync(file, "utf8"),
  }))

  const resolve = (fromRelFile: string, specifier: string) => {
    const resolved = resolveImport(appRoot, path.join(srcRoot, fromRelFile), specifier)
    return resolved ? path.relative(srcRoot, resolved).split(path.sep).join("/") : null
  }

  return [...new Set(sessionBoundaryViolationsFromFiles(files, resolve).map(sessionBoundaryKey))].sort()
}

/** Pure ratchet logic: live violations absent from `baseline` -- new regressions. */
export function newSessionBoundaryViolations(live: string[], baseline: string[]): string[] {
  const baselineSet = new Set(baseline)
  return live.filter((key) => !baselineSet.has(key))
}

/** Pure ratchet logic: baseline entries no longer live -- entries to prune. */
export function staleSessionBoundaryViolations(live: string[], baseline: string[]): string[] {
  const liveSet = new Set(live)
  return baseline.filter((key) => !liveSet.has(key))
}
