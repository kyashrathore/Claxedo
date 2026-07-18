import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = path.resolve(import.meta.dirname, "..")
const publishedEntries = [
  "src/index.ts",
  "src/connectors/index.ts",
  "src/contracts/index.ts",
  "src/domain/index.ts",
  "src/hosted.ts",
  "src/matching.ts",
  "src/ports/index.ts",
  "src/conformance/index.ts",
].map((file) => path.join(root, file))
const retainedInternalRoots = [
  "src/db/schema.ts",
  "src/domain/attempt.ts",
  "src/domain/launch-readiness.ts",
  "src/domain/lifecycle.ts",
].map((file) => path.join(root, file))
const retiredDirectories = ["captain", "mcp", "model", "routes", "sdk", "substrate", "triggers"]
const retiredFiles = [
  "src/app.ts",
  "src/client.ts",
  "src/dir.ts",
  "src/execution.ts",
  "src/providers.ts",
  "src/repo.ts",
  "src/server.ts",
  "src/connectors/native.ts",
  "src/connectors/github/github.ts",
  "src/connectors/github/legacy-composio.ts",
  "src/triggers/scheduler.ts",
  "src/triggers/store.ts",
]
const compatibilityPackages = ["@composio/core", "@hono/zod-validator", "drizzle-orm", "ulid"]

describe("WorkGraph v2 public entrypoints", () => {
  it("contains only maintained V2 source plus explicit migration and internal domain roots", () => {
    expect(retiredDirectories.flatMap((directory) => {
      const candidate = path.join(root, "src", directory)
      return fs.existsSync(candidate) ? walk(candidate) : []
    })).toEqual([])
    expect(retiredFiles.filter((file) => fs.existsSync(path.join(root, file)))).toEqual([])

    const sourceFiles = walk(path.join(root, "src")).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    const visited = reachable([...publishedEntries, ...retainedInternalRoots])
    expect(sourceFiles.filter((file) => !visited.has(file)).map((file) => path.relative(root, file))).toEqual([])

    const imports = sourceFiles.flatMap((file) => readImportSpecifiers(fs.readFileSync(file, "utf8")))
    expect(compatibilityPackages.filter((dependency) => imports.some((specifier) => specifier === dependency || specifier.startsWith(`${dependency}/`))))
      .toEqual([])
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    expect(compatibilityPackages.filter((dependency) => dependency in pkg.dependencies || dependency in pkg.devDependencies)).toEqual([])
  })

  it("publishes only v2 composition plus explicit migration operations from the package root", () => {
    const source = fs.readFileSync(path.join(root, "src/index.ts"), "utf8")

    for (const legacyExport of [
      "createWorkGraph",
      "WorkGraphClient",
      "createApp",
      "registerWorkGraphTools",
      "startAttempts",
      "cancelNodeExecution",
      "openSqliteExecutionStore",
      "openSqliteEventStore",
    ]) expect(source).not.toMatch(new RegExp(`\\b${legacyExport}\\b`))
    expect(source).toContain("createSqliteWorkGraphService")
    expect(source).toContain("createWorkGraphHttpRouter")
    expect(source).toContain("applyLegacyWorkGraphMigration")
    expect(fs.existsSync(path.join(root, "src/adapters/sqlite/legacy-migration.ts"))).toBe(true)
    expect(fs.existsSync(path.join(root, "test/sqlite-legacy-migration.test.ts"))).toBe(true)
  })
})

function reachable(roots: string[]) {
  const visited = new Set<string>()
  const visit = (file: string) => {
    if (visited.has(file)) return
    visited.add(file)
    readImportSpecifiers(fs.readFileSync(file, "utf8")).filter((specifier) => specifier.startsWith(".")).forEach((specifier) => {
      const resolved = resolveTypeScriptImport(path.resolve(path.dirname(file), specifier))
      if (!resolved) throw new Error(`Cannot resolve ${specifier} from ${path.relative(root, file)}`)
      visit(resolved)
    })
  }
  roots.forEach(visit)
  return visited
}

function resolveTypeScriptImport(base: string) {
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}

function readImportSpecifiers(source: string) {
  return [
    ...source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]).filter((specifier): specifier is string => specifier !== undefined)
}

function walk(directory: string): string[] {
  return fs.readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name)
    return fs.statSync(file).isDirectory() ? walk(file) : [file]
  })
}
