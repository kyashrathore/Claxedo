import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname)

describe("agent-sdk-runtime architecture ratchets", () => {
  test("high-churn orchestration owners cannot grow", () => {
    // Exact reviewed ceilings. Runtime owns turn-input normalization and lease
    // wiring; Pi owns its transport-specific message projection. ACP, Codex,
    // OpenCode, and the shared SDK adapter delegate process/turn helpers to
    // adjacent modules.
    const ceilings: Record<string, number> = {
      "runtime.ts": 627,
      "harnesses/acp/index.ts": 693,
      "harnesses/codex/driver.ts": 961,
      "harnesses/shared/sdk-runtime-adapter.ts": 917,
      "harnesses/opencode/index.ts": 741,
      "harnesses/pi/index.ts": 730,
    }
    const violations = Object.entries(ceilings).flatMap(([file, ceiling]) => {
      const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n").length - 1
      return lines > ceiling ? [`${file}: ${lines} lines exceeds reviewed ceiling ${ceiling}`] : []
    })
    expect(violations).toEqual([])
  })

  test("runtime core does not depend on a concrete harness", () => {
    const concreteHarness = /from\s+["'][^"']*\/harnesses\/(?:acp|claude|codex|cursor|opencode|pi)(?:\/|["'])/
    const violations = productionFiles(path.join(root, "runtime"))
      .concat(path.join(root, "runtime.ts"))
      .flatMap((file) => concreteHarness.test(fs.readFileSync(file, "utf8")) ? [path.relative(root, file)] : [])
    expect(violations).toEqual([])
  })

  test("concrete harness implementations do not import one another", () => {
    const harnesses = ["acp", "claude", "codex", "cursor", "opencode", "pi"]
    const violations: string[] = []
    for (const harness of harnesses) {
      for (const file of productionFiles(path.join(root, "harnesses", harness))) {
        const source = fs.readFileSync(file, "utf8")
        for (const other of harnesses.filter((item) => item !== harness)) {
          if (new RegExp(`from\\s+["'][^"']*\\/${other}(?:\\/|["'])`).test(source)) {
            violations.push(`${path.relative(root, file)} imports ${other}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })
})

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return productionFiles(file)
    return /\.ts$/.test(entry.name) && !/\.(?:test|spec)\.ts$/.test(entry.name) ? [file] : []
  })
}
