import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"

const root = path.resolve(import.meta.dirname, "..")

// The OpenCode harness adapter is transport-agnostic: hosts inject an engine
// handler via the `request` option (OpenCodeRequestFn). Importing the engine
// package here would force every consumer of this SDK to carry the embedded
// engine, which is a host decision.
describe("engine boundary", () => {
  test("agent-sdk-runtime sources never import the opencode engine package", () => {
    const violations: string[] = []
    const specifier = /(?:from\s+|import\(\s*|require\(\s*)["'](opencode(?:\/[^"']*)?)["']/g
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
          const source = fs.readFileSync(full, "utf8")
          for (const match of source.matchAll(specifier)) {
            violations.push(`${path.relative(root, full)} imports "${match[1]}"`)
          }
        }
      }
    }
    walk(path.join(root, "src"))
    expect(violations).toEqual([])
  })
})
