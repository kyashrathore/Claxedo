import { describe, expect, test } from "bun:test"

import { STARTUP_STEP_TIMEOUT_MS, StartupTimeoutError, withStartupTimeout } from "./startup-timeout"

describe("withStartupTimeout", () => {
  test("passes the value through when the step answers", async () => {
    await expect(withStartupTimeout(Promise.resolve("ready"), "Signing in", { timeoutMs: 50 })).resolves.toBe("ready")
  })

  test("passes a rejection through unchanged, so a real error is not masked as a timeout", async () => {
    const failure = new Error("descriptor is not valid JSON")
    await expect(withStartupTimeout(Promise.reject(failure), "Signing in", { timeoutMs: 50 })).rejects.toBe(failure)
  })

  /**
   * The live failure: `/api/auth/get-session` never answered, so boot never
   * reached `render()` and the page showed its spinner forever. A rejection is
   * what turns that into the startup-failure panel.
   */
  test("rejects when the step never settles, naming the step and the wait", async () => {
    const forever = new Promise<never>(() => {})
    const error = await withStartupTimeout(forever, "Signing in", { timeoutMs: 10 }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(StartupTimeoutError)
    expect((error as Error).message).toContain("Signing in")
    expect((error as Error).message).toContain("try again")
  })

  test("clears the losing timer once the step answers", async () => {
    const cleared: unknown[] = []
    let armed = 0
    await withStartupTimeout(Promise.resolve("ready"), "Signing in", {
      timeoutMs: 10_000,
      setTimeout: () => {
        armed += 1
        return "handle"
      },
      clearTimeout: ((handle: unknown) => cleared.push(handle)) as never,
    })
    expect(armed).toBe(1)
    expect(cleared).toEqual(["handle"])
  })

  test("defaults to a bound long enough for a slow network but short of forever", () => {
    expect(STARTUP_STEP_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
    expect(STARTUP_STEP_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })
})
