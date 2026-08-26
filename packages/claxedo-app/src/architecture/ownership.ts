import { importSpecifiers } from "./import-graph"
import type { SourceFile } from "./scanners"

export type MigrationEntry = {
  source: string
  target: string
  owner: string
  unit: number
}

export type MigrationManifest = {
  version: number
  retiredRoots: string[]
  entries: MigrationEntry[]
}

export type LogicalEdge = {
  from: string
  to: string
  file: string
  specifier: string
}

const finalRoots = new Set(["app", "features", "platform", "ui", "lib", "architecture"])

export function logicalOwner(relPath: string): string | null {
  const parts = normalize(relPath).split("/")
  if (parts.length < 2) return /\.d\.ts$|\.md$/.test(parts[0]) ? null : "legacy/root"
  if (!finalRoots.has(parts[0])) return `legacy/${parts[0]}`
  if (parts[0] === "features" || parts[0] === "platform") return parts[1] ? `${parts[0]}/${parts[1]}` : parts[0]
  return parts[0]
}

export function dependencyViolation(from: string, to: string): string | undefined {
  if (from === to) return
  if (from.startsWith("legacy/")) return
  if (to.startsWith("legacy/")) return `${from} imports ${to}: final owners cannot depend on legacy paths`
  if (from === "architecture") return
  if (to === "architecture") return `${from} imports architecture: production owners cannot depend on guard tooling`
  if (from === "app") return
  if (from.startsWith("features/")) {
    if (to === "ui" || to === "lib" || to.startsWith("platform/")) return
    if (to.startsWith("features/"))
      return `${from} imports ${to}: feature-to-feature imports must be composed by app/integrations`
    return `${from} imports ${to}: features may depend only on platform, ui, and lib`
  }
  if (from.startsWith("platform/")) {
    if (to.startsWith("platform/")) return
    if (to === "lib") return
    return `${from} imports ${to}: platform capabilities may depend only on other platform capabilities and lib`
  }
  if (from === "ui") {
    if (to === "lib") return
    return `ui imports ${to}: reusable UI may depend only on lib`
  }
  if (from === "lib") return `lib imports ${to}: lib must remain dependency-light and owner-independent`
  return `${from} imports ${to}: unknown logical owner`
}

export function logicalCyclesFromEdges(edges: Pick<LogicalEdge, "from" | "to">[]) {
  const graph = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, new Set())
    graph.get(edge.from)!.add(edge.to)
  }
  const cycles = new Set<string>()
  const visit = (start: string, node: string, path: string[], active: Set<string>) => {
    for (const next of graph.get(node) ?? []) {
      if (next === start) {
        cycles.add([...path, node, start].join(" -> "))
        continue
      }
      if (active.has(next) || next < start) continue
      visit(start, next, [...path, node], new Set([...active, next]))
    }
  }
  for (const start of [...graph.keys()].sort()) visit(start, start, [], new Set([start]))
  return [...cycles].sort()
}

export function logicalImportEdgesFromFiles(
  files: SourceFile[],
  resolveSpecifier: (fromRelFile: string, specifier: string) => string | null,
): LogicalEdge[] {
  return files.flatMap((file) => {
    const from = logicalOwner(file.path)
    if (!from) return []
    return importSpecifiers(file.text).flatMap((specifier) => {
      const target = resolveSpecifier(file.path, specifier)
      if (!target) return []
      const to = logicalOwner(target)
      if (!to || to === from) return []
      return [{ from, to, file: file.path, specifier }]
    })
  })
}

export function malformedAliasSpecifiers(files: SourceFile[]) {
  const pattern = /["'](?:\.@\/|(?:\.\.\/)+\.?@\/)/g
  return files.flatMap((file) =>
    file.text
      .split("\n")
      .flatMap((line, index) =>
        [...line.matchAll(pattern)].map((match) => ({ file: file.path, line: index + 1, match: match[0].slice(1) })),
      ),
  )
}

export function migrationManifestViolations(liveLegacyFiles: string[], manifest: MigrationManifest) {
  const live = [...new Set(liveLegacyFiles.map(normalize))].sort()
  const sources = manifest.entries.map((entry) => normalize(entry.source))
  const targets = manifest.entries.map((entry) => normalize(entry.target))
  const sourceSet = new Set(sources)
  const liveSet = new Set(live)
  const violations: string[] = []

  for (const root of manifest.retiredRoots) {
    const file = live.find((candidate) => candidate === root || candidate.startsWith(`${root}/`))
    if (file) violations.push(`${root}: retired legacy root still contains ${file}`)
  }
  for (const file of live) {
    if (!sourceSet.has(file)) violations.push(`${file}: legacy file is missing from migration-manifest.json`)
  }
  for (const source of sources) {
    if (!liveSet.has(source)) violations.push(`${source}: manifest source is missing from the live tree`)
  }
  for (const source of duplicates(sources)) violations.push(`${source}: duplicate manifest source`)
  for (const target of duplicates(targets)) violations.push(`${target}: duplicate manifest target`)
  for (const entry of manifest.entries) {
    const owner = logicalOwner(entry.target)
    if (owner === entry.owner) continue
    violations.push(`${entry.source}: target ${entry.target} resolves to ${owner ?? "no owner"}, not ${entry.owner}`)
  }
  const entriesBySource = new Map(manifest.entries.map((entry) => [normalize(entry.source), entry]))
  for (const entry of manifest.entries) {
    if (!/\.(?:test|vitest|spec)\.(?:ts|tsx)$/.test(entry.source)) continue
    const base = normalize(entry.source).replace(/\.(?:integration\.)?(?:test|vitest|spec)\.(?:ts|tsx)$/, "")
    const subject = entriesBySource.get(`${base}.ts`) ?? entriesBySource.get(`${base}.tsx`)
    if (!subject || subject.owner === entry.owner) continue
    violations.push(
      `${entry.source}: test owner ${entry.owner} differs from subject ${subject.source} owner ${subject.owner}`,
    )
  }
  return violations
}

function duplicates(items: string[]) {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const item of items) {
    if (seen.has(item)) duplicates.add(item)
    seen.add(item)
  }
  return [...duplicates].sort()
}

function normalize(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "")
}
