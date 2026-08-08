/**
 * Contract test for the tokentracker-cli deep import used by
 * server-usage-limits.ts. The package ships no exports map and no semver
 * guarantee on internals, so every version bump must keep this green:
 *  1. the deep-import path resolves and exposes the functions we call;
 *  2. merely loading the module is inert — no network, no child processes,
 *     no filesystem writes (the security-audit property we adopted it under).
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import child_process from "node:child_process"
import fs from "node:fs"

describe("tokentracker-cli deep-import contract", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("module loads without side effects and exposes the expected surface", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const spawnSpy = vi.spyOn(child_process, "spawn")
    const execFileSpy = vi.spyOn(child_process, "execFile")
    const execFileSyncSpy = vi.spyOn(child_process, "execFileSync")
    const writeSpy = vi.spyOn(fs, "writeFileSync")
    const appendSpy = vi.spyOn(fs, "appendFileSync")
    const mkdirSpy = vi.spyOn(fs, "mkdirSync")

    const mod = await import("tokentracker-cli/src/lib/usage-limits.js")

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

  test("credential readers used by credentials/sync remain exported", async () => {
    // subscriptions.js is the reference implementation for multi-platform
    // credential reading (Linux .credentials.json fallback); if we consolidate
    // sync.ts onto it, these are the exports that must survive a bump.
    const subs = await import("tokentracker-cli/src/lib/subscriptions.js")
    expect(typeof subs.readClaudeCodeAccessToken).toBe("function")
    expect(typeof subs.readCodexAuthBundle).toBe("function")
  })
})
