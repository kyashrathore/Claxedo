import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { resolveImport } from "./import-graph"
import {
  dependencyViolation,
  logicalCyclesFromEdges,
  logicalImportEdgesFromFiles,
  logicalOwner,
  malformedAliasSpecifiers,
  migrationManifestViolations,
  type MigrationManifest,
} from "./ownership"
import { prodSourcePaths, walk, type SourceFile } from "./scanners"
import manifest from "./migration-manifest.json"

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")

describe("logical ownership guard", () => {
  test("classifies every legacy file in the migration manifest", () => {
    const legacyFiles = walk(srcRoot)
      .map((file) => relative(srcRoot, file))
      .filter((file) => logicalOwner(file)?.startsWith("legacy/"))

    expect(migrationManifestViolations(legacyFiles, manifest as MigrationManifest)).toEqual([])
  })

  test("keeps final owners on the declared dependency graph", () => {
    const files: SourceFile[] = prodSourcePaths(appRoot).map((file) => ({
      path: relative(srcRoot, file),
      text: readFileSync(file, "utf8"),
    }))
    const edges = logicalImportEdgesFromFiles(files, (fromRelFile, specifier) => {
      const resolved = resolveImport(appRoot, path.join(srcRoot, fromRelFile), specifier)
      return resolved && resolved.startsWith(`${srcRoot}${path.sep}`) ? relative(srcRoot, resolved) : null
    })
    const offenders = edges.flatMap((edge) => {
      const violation = dependencyViolation(edge.from, edge.to)
      return violation ? [`${edge.file} imports ${edge.specifier}: ${violation}`] : []
    })

    expect(offenders).toEqual([])
    expect(logicalCyclesFromEdges(edges.filter((edge) => !edge.from.startsWith("legacy/") && !edge.to.startsWith("legacy/")))).toEqual([])
  })

  test("keeps absolute aliases free of relative path prefixes", () => {
    const files = walk(srcRoot)
      .filter((file) => /\.(?:ts|tsx)$/.test(file))
      .map((file) => ({ path: relative(srcRoot, file), text: readFileSync(file, "utf8") }))
      .filter((file) => !file.path.startsWith("architecture/"))

    expect(malformedAliasSpecifiers(files)).toEqual([])
  })
})

function relative(from: string, file: string) {
  return path.relative(from, file).split(path.sep).join("/")
}
