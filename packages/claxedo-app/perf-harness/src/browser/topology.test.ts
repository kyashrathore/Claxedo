import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const browserRoot = import.meta.dir
const sourceRoot = path.dirname(browserRoot)
const scanner = new Bun.Transpiler({ loader: "ts" })

function imports(file: string) {
  return scanner.scanImports(readFileSync(file, "utf8").replace(/^#![^\n]*(?:\n|$)/, ""))
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? sources(file) : file.endsWith(".ts") && !file.endsWith(".test.ts") ? [file] : []
  })
}

test("browser modules form an acyclic graph and never import the lane orchestrator", () => {
  const files = sources(browserRoot)
  const graph = new Map(files.map((file) => [file, imports(file)
    .filter((entry) => entry.path.startsWith("."))
    .map((entry) => path.resolve(path.dirname(file), `${entry.path}.ts`))]))
  const violations: string[] = []
  const visited = new Set<string>()
  function visit(file: string, chain: string[]) {
    if (chain.includes(file)) {
      violations.push(`cycle: ${[...chain, file].map((item) => path.relative(sourceRoot, item)).join(" -> ")}`)
      return
    }
    if (visited.has(file)) return
    for (const dependency of graph.get(file) ?? []) {
      if (dependency === path.join(sourceRoot, "browser-runner.ts")) violations.push(`${file} imports browser-runner`)
      if (graph.has(dependency)) visit(dependency, [...chain, file])
    }
    visited.add(file)
  }
  for (const file of files) visit(file, [])
  expect(violations).toEqual([])
})

test("memory and diagnostic probes use browser owners without loading suite execution", () => {
  const consumers = [
    ...sources(sourceRoot).filter((file) => /\/memory-(?:runner|lane)\.ts$/.test(file)),
    ...sources(path.join(sourceRoot, "../probes")),
  ]
  const violations = consumers.flatMap((file) => imports(file)
    .filter((entry) => entry.path.endsWith("/browser-runner"))
    .map(() => path.relative(sourceRoot, file)))
  expect(consumers.length).toBeGreaterThan(2)
  expect(violations).toEqual([])
  expect(sources(sourceRoot).filter((file) => path.basename(file).startsWith("debug-"))).toEqual([])
})
