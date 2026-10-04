/**
 * Guards the exact-pinned, deep tokentracker-cli import the usage-limits
 * adapter beside this file makes. A bump that moves the export, or that makes
 * importing the module do something, fails here rather than at a user's first
 * refresh.
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import child_process from "node:child_process"
import fs from "node:fs"

describe("tokentracker-cli deep-import contract", () => {
  afterEach(() => vi.restoreAllMocks())

  test("the usage-limits module loads without side effects and exposes the surface the reader calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const spawnSpy = vi.spyOn(child_process, "spawn")
    const execFileSpy = vi.spyOn(child_process, "execFile")
    const execFileSyncSpy = vi.spyOn(child_process, "execFileSync")
    const writeSpy = vi.spyOn(fs, "writeFileSync")
    const appendSpy = vi.spyOn(fs, "appendFileSync")
    const mkdirSpy = vi.spyOn(fs, "mkdirSync")

    const specifier = "tokentracker-cli/src/lib/usage-limits.js"
    const mod = await import(specifier)
    expect(typeof mod.getUsageLimits).toBe("function")
    expect(typeof mod.resetUsageLimitsCache).toBe("function")
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(spawnSpy).not.toHaveBeenCalled()
    expect(execFileSpy).not.toHaveBeenCalled()
    expect(execFileSyncSpy).not.toHaveBeenCalled()
    expect(writeSpy).not.toHaveBeenCalled()
    expect(appendSpy).not.toHaveBeenCalled()
    expect(mkdirSpy).not.toHaveBeenCalled()
  })
})
