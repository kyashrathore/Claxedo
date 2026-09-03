import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname)

describe("agent-sdk-runtime architecture ratchets", () => {
  test("high-churn orchestration owners cannot grow", () => {
    const ceilings: Record<string, number> = {
      // Re-measured at the Goal-mode merge into dev: these owners now carry the
      // runtime Goal surface (mutations, publication, provider-turn projection)
      // on top of the decomposed process/turn helpers reviewed before it.
      // Further extraction (e.g. a PiGoalController) shrinks them; growth fails.
      //
      // Re-measured again where the Cloudflare multiplayer branch merged in.
      // sdk-runtime-adapter.ts threads the host's durable turn admission fence
      // through every producer write, and opencode/index.ts gained the session
      // shell and summarize adapter methods. runtime.ts threads the same fence
      // but stays below its previous ceiling because the durable turn record
      // moved out to runtime/turn-record.ts.
      //
      // Re-measured again for the resolved-model contract: the ACP adapter and
      // the native-SDK adapter each state their own config-options payload, so
      // both gained the one small producer that names the model their harness
      // reported. Moving either producer to a shared owner is not possible —
      // ACP options keep the agent's protocol shape and the SDK's do not.
      // Re-measured for the turn author travelling with its prompt and the
      // turn message-id owner: the runtime hands the harness the turn's author
      // and mints the reply id through agent-event-runtime's convention.
      "runtime.ts": 992,
      "harnesses/acp/index.ts": 844,
      "harnesses/codex/driver.ts": 755,
      "harnesses/shared/sdk-runtime-adapter.ts": 890,
      "harnesses/opencode/index.ts": 906,
      "harnesses/pi/index.ts": 988,
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
