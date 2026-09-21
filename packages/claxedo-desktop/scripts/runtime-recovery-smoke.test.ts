import { expect, test } from "bun:test"
import * as fs from "node:fs"

import { RUNTIME_RECOVERY_SMOKE_BUNDLE, runRuntimeRecoverySmoke } from "./runtime-recovery-smoke"

test("the bundled daemon publishes its identity, blocks a drain by name, reopens it, and refuses a mismatched pid", async () => {
  if (!fs.existsSync(RUNTIME_RECOVERY_SMOKE_BUNDLE)) {
    console.warn("[skip] claxedo-server bundle missing — run `bun run predev` first")
    return
  }

  const report = await runRuntimeRecoverySmoke()
  expect(report.strayProcesses).toEqual([])
  expect(report.steps.map((step) => step.name)).toEqual([
    "lease held",
    "discovery carries identity",
    "machine inventory",
    "terminal owned",
    "handoff release survived",
    "drain blocked",
    "ingress gated",
    "drain released",
    "identity mismatch refused",
    "daemon released",
    "no strays",
  ])
}, 240_000)
