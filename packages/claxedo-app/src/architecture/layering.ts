import { readFileSync } from "node:fs"
import path from "node:path"
import { importSpecifiers, resolveImport } from "./import-graph"
import { prodSourcePaths, type SourceFile } from "./scanners"

export type DirEdge = {
  from: string
  to: string
  file: string
  specifier: string
}

/**
 * The first path segment under src/ that owns a legacy file, e.g.
 * "claxedo-ui/components/foo.tsx" -> "claxedo-ui". Root-level files
 * (app/entry/app.tsx, app/entry/main.tsx, app/entry/index.tsx, ...) have no owning directory and
 * are excluded from the layering graph -- they are entrypoints, not
 * a named module with a charter to defend. Final app/features/platform/ui/lib
 * boundaries are resolved by ownership.ts; this helper remains for the
 * shrink-only legacy-cycle ratchet while migration-manifest.json is non-empty.
 */
export function topLevelDir(relPath: string): string | null {
  const index = relPath.indexOf("/")
  return index < 0 ? null : relPath.slice(0, index)
}

/**
 * Pure edge extraction: every cross-top-level-directory production
 * import edge implied by `files`, given an injected specifier
 * resolver (relative file path + import specifier -> resolved
 * relative file path, or null if unresolvable). No filesystem access
 * -- safe to call with synthetic fixtures in tests.
 */
export function directoryImportEdgesFromFiles(
  files: SourceFile[],
  resolveSpecifier: (fromRelFile: string, specifier: string) => string | null,
): DirEdge[] {
  const edges: DirEdge[] = []

  for (const file of files) {
    const fromDir = topLevelDir(file.path)
    if (!fromDir) continue

    for (const specifier of importSpecifiers(file.text)) {
      const relTarget = resolveSpecifier(file.path, specifier)
      if (!relTarget) continue
      const toDir = topLevelDir(relTarget)
      if (!toDir || toDir === fromDir) continue
      edges.push({ from: fromDir, to: toDir, file: file.path, specifier })
    }
  }

  return edges
}

/**
 * Pure cycle detection: the set of top-level directory PAIRS that
 * import each other's internals in both directions (a 2-node cycle)
 * given a list of edges, reported as sorted "a<->b" keys. This is the
 * shape the LLD names explicitly ("context<->shell",
 * "components<->claxedo-ui") -- it does not detect longer cycles
 * (a -> b -> c -> a), which is a known, stated simplification. Pure
 * over `edges` -- safe to call with synthetic fixtures in tests.
 */
export function directoryCyclesFromEdges(edges: Pick<DirEdge, "from" | "to">[]): string[] {
  const pairs = new Set(edges.map((edge) => `${edge.from}->${edge.to}`))
  const dirs = new Set(edges.flatMap((edge) => [edge.from, edge.to]))

  const cycles = new Set<string>()
  for (const a of dirs) {
    for (const b of dirs) {
      if (a >= b) continue
      if (pairs.has(`${a}->${b}`) && pairs.has(`${b}->${a}`)) cycles.add(`${a}<->${b}`)
    }
  }
  return [...cycles].sort()
}

/**
 * Pure ratchet logic: live cycles not present in `baseline` -- new
 * regressions the guard test must fail on.
 */
export function newDirectoryCycles(liveCycles: string[], baseline: string[]): string[] {
  const baselineSet = new Set(baseline)
  return liveCycles.filter((pair) => !baselineSet.has(pair))
}

/**
 * Pure ratchet logic: baseline entries no longer present in
 * `liveCycles` -- stale entries the baseline file must prune.
 */
export function staleDirectoryCycles(liveCycles: string[], baseline: string[]): string[] {
  const live = new Set(liveCycles)
  return baseline.filter((pair) => !live.has(pair))
}

/**
 * Thin fs-reading wrapper: every cross-top-level-directory production
 * import edge in the real tree rooted at `appRoot`.
 */
export function directoryImportEdges(appRoot: string): DirEdge[] {
  const srcRoot = path.join(appRoot, "src")
  const files: SourceFile[] = prodSourcePaths(appRoot).map((file) => ({
    path: relative(srcRoot, file),
    text: readFileSync(file, "utf8"),
  }))

  return directoryImportEdgesFromFiles(files, (fromRelFile, specifier) => {
    const resolved = resolveImport(appRoot, path.join(srcRoot, fromRelFile), specifier)
    return resolved ? relative(srcRoot, resolved) : null
  })
}

/**
 * Thin fs-reading wrapper: the set of top-level directory pairs that
 * currently import each other's internals in both directions, for
 * the real tree rooted at `appRoot`.
 */
export function directoryCycles(appRoot: string): string[] {
  return directoryCyclesFromEdges(directoryImportEdges(appRoot))
}

function relative(from: string, file: string) {
  return path.relative(from, file).split(path.sep).join("/")
}
