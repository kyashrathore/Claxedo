import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname)

describe("agent-sdk-runtime architecture ratchets", () => {
  test("high-churn orchestration owners cannot grow", () => {
    const ceilings: Record<string, number> = {
      // Reviewed line counts for the orchestration owners that attract every
      // new feature. Each is the file's exact length at its last review, with
      // no headroom, so the next feature must name an owner rather than append.
      // They orchestrate; the concepts they carry are owned elsewhere.
      // `runtime.ts` delegates the Goal surface to `runtime/goal-controller.ts`,
      // per-session turn admission to `runtime/turn-admission.ts`, a turn's
      // prompt to `runtime/turn-record.ts` (whose system block is composed in
      // `session-model.ts`) and the instruction block's admission to
      // `session-instructions.ts`; `harnesses/codex/driver.ts` delegates the
      // brokered provider to `harnesses/codex/broker.ts`, the operator login to
      // `harnesses/codex/operator-login.ts`, Agent Plugins validation to
      // `harnesses/codex/plugin-launch.ts` and `turn/steer` to
      // `harnesses/codex/protocol.ts`; `harnesses/shared/sdk-runtime-adapter.ts`
      // delegates steering to `harnesses/shared/turn-steering.ts` and keeps only
      // the entrypoint.
      "runtime.ts": 834,
      "harnesses/acp/index.ts": 831,
      "harnesses/codex/driver.ts": 632,
      "harnesses/shared/sdk-runtime-adapter.ts": 885,
      // Its one growth is the import of the trim that stops a blank
      // `PI_CODING_AGENT_DIR` from putting the profile in the process cwd.
      "harnesses/pi/index.ts": 13,
    }
    const violations = Object.entries(ceilings).flatMap(([file, ceiling]) => {
      const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n").length - 1
      return lines > ceiling ? [`${file}: ${lines} lines exceeds reviewed ceiling ${ceiling}`] : []
    })
    expect(violations).toEqual([])
  })

  test("runtime core does not depend on a concrete harness", () => {
    const concreteHarness = /from\s+["'][^"']*\/harnesses\/(?:acp|claude|codex|cursor|pi)(?:\/|["'])/
    const violations = productionFiles(path.join(root, "runtime"))
      .concat(path.join(root, "runtime.ts"))
      .flatMap((file) => concreteHarness.test(fs.readFileSync(file, "utf8")) ? [path.relative(root, file)] : [])
    expect(violations).toEqual([])
  })

  test("concrete harness implementations do not import one another", () => {
    const harnesses = ["acp", "claude", "codex", "cursor", "pi"]
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
    return entry.name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(entry.name) ? [file] : []
  })
}
