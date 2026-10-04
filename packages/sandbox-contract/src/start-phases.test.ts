import { describe, expect, test } from "vitest"
import { createSandboxPhaseTimer, type SandboxPrebuildPhase } from "./start-phases"

describe("sandbox phase timer", () => {
  test("times each phase in order, including one that fails", async () => {
    let at = 1_000
    const timer = createSandboxPhaseTimer<SandboxPrebuildPhase>(() => at)
    await timer.measure("fetch", async () => { at += 250 })
    await expect(timer.measure("setup_script", async () => {
      at += 4_000
      throw new Error("setup.sh exited 1")
    })).rejects.toThrow("setup.sh exited 1")

    expect(timer.timings()).toEqual([{ phase: "fetch", durationMs: 250 }, { phase: "setup_script", durationMs: 4_000 }])
  })
})
