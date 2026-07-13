import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = path.resolve(import.meta.dirname, "..")
const contractsRoot = path.join(root, "src/contracts")
const entry = path.join(contractsRoot, "index.ts")
const safePackages = new Set(["zod"])

describe("contracts import boundary", () => {
  it("publishes the browser-safe contracts entry", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))

    expect(pkg.exports["./contracts"]).toEqual({
      types: "./dist/contracts/index.d.ts",
      browser: "./dist/contracts/index.mjs",
      import: "./dist/contracts/index.mjs",
      default: "./dist/contracts/index.mjs",
    })
  })

  it("reaches only contract files and explicitly safe packages", () => {
    const visited = new Set<string>()
    const violations: string[] = []

    const visit = (file: string, chain: string[]) => {
      if (visited.has(file)) return
      visited.add(file)

      readImportSpecifiers(fs.readFileSync(file, "utf8")).forEach((specifier) => {
        const nextChain = [...chain, specifier]

        if (!specifier.startsWith(".")) {
          if (!safePackages.has(specifier)) violations.push(`${nextChain.join(" -> ")} (package is not allowlisted)`)
          return
        }

        const resolved = resolveTypeScriptImport(path.resolve(path.dirname(file), specifier))
        if (!resolved) {
          violations.push(`${nextChain.join(" -> ")} (relative import cannot be resolved)`)
          return
        }
        if (!isWithin(contractsRoot, resolved)) {
          violations.push(`${nextChain.join(" -> ")} (escapes src/contracts to ${path.relative(root, resolved)})`)
          return
        }
        visit(resolved, nextChain)
      })
    }

    visit(entry, [path.relative(root, entry)])

    expect(violations).toEqual([])
    expect(visited).toContain(entry)
  })
})

function resolveTypeScriptImport(base: string) {
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")].find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  )
}

function isWithin(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function readImportSpecifiers(source: string) {
  return [
    ...source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]).filter((specifier): specifier is string => specifier !== undefined)
}
