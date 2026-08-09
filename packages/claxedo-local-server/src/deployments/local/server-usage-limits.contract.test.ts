/** Guards the exact-pinned, deep TokenTracker imports owned by local usage. */
import { afterEach, describe, expect, test, vi } from "vitest"
import child_process from "node:child_process"
import fs from "node:fs"

describe("tokentracker-cli deep-import contract", () => {
  afterEach(() => vi.restoreAllMocks())

  test("module loads without side effects and exposes the expected surface", async () => {
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

  test("credential readers used by credentials sync remain exported", async () => {
    const specifier = "tokentracker-cli/src/lib/subscriptions.js"
    const subscriptions = await import(specifier)
    expect(typeof subscriptions.readClaudeCodeAccessToken).toBe("function")
    expect(typeof subscriptions.readCodexAuthBundle).toBe("function")
  })

  test("embedded history is inert and fails closed unless cloud and telemetry are disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const writeSpy = vi.spyOn(fs, "writeFileSync")
    const specifier = "tokentracker-cli/src/lib/rollout.js"
    const mod = await import(specifier)
    expect(typeof mod.scanLocalHistory).toBe("function")
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(writeSpy).not.toHaveBeenCalled()
    await expect(mod.scanLocalHistory({
      sourceHome: "/fixture",
      stateDir: "/fixture-state",
      since: 0,
      until: 1,
      upload: true as never,
      telemetry: false,
      classify: () => "external",
    })).rejects.toThrow("upload:false")
  })
})
