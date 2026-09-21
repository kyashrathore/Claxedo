import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { arg, envPositiveIntMs, requiredEnv, stopChild } from "./process"

const originalArgv = process.argv
const children: ChildProcess[] = []

afterEach(() => {
  process.argv = originalArgv
  delete process.env.HELPERS_TEST_MS
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL")
  }
})

function spawnChild(script: string, options?: { detached?: boolean }): ChildProcess {
  const child = spawn("sh", ["-c", script], { detached: options?.detached, stdio: "ignore" })
  children.push(child)
  return child
}

/**
 * A child that ignores SIGTERM. It reports readiness on stdout and the caller
 * waits for it: signalling between fork and the handler's registration would
 * hit the default disposition and kill it, which is a race in the test rather
 * than in stopChild.
 */
async function spawnUnkillableChild(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready')"],
    { stdio: ["ignore", "pipe", "ignore"] },
  )
  children.push(child)
  await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()))
  return child
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
}

describe("arg", () => {
  test("reads process.argv live at call time", () => {
    process.argv = ["bun", "script", "--port", "8080"]
    expect(arg("port")).toBe("8080")
    process.argv = ["bun", "script"]
    expect(arg("port")).toBeUndefined()
  })

  test("the first occurrence wins", () => {
    process.argv = ["bun", "script", "--port", "1", "--port", "2"]
    expect(arg("port")).toBe("1")
  })

  test("the equals form is deliberately NOT supported", () => {
    process.argv = ["bun", "script", "--port=8080"]
    expect(arg("port", "3000")).toBe("3000")
  })

  test("a flag-shaped, empty or absent value falls back", () => {
    process.argv = ["bun", "script", "--port", "--verbose"]
    expect(arg("port", "3000")).toBe("3000")
    process.argv = ["bun", "script", "--port", ""]
    expect(arg("port", "3000")).toBe("3000")
    process.argv = ["bun", "script", "--port"]
    expect(arg("port", "3000")).toBe("3000")
  })
})

describe("requiredEnv", () => {
  test("returns the trimmed value", () => {
    expect(requiredEnv({ TOKEN: "  t  " }, "TOKEN")).toBe("t")
  })

  test("missing and blank both throw, with the context in the message", () => {
    expect(() => requiredEnv({}, "TOKEN")).toThrow("TOKEN is required")
    expect(() => requiredEnv({ TOKEN: "  " }, "TOKEN")).toThrow("TOKEN is required")
    expect(() => requiredEnv({}, "TOKEN", "the relay")).toThrow("TOKEN is required for the relay")
  })
})

describe("envPositiveIntMs", () => {
  test("reads process.env at call time, so a test may set it after import", () => {
    expect(envPositiveIntMs("HELPERS_TEST_MS", 500)).toBe(500)
    process.env.HELPERS_TEST_MS = "1200"
    expect(envPositiveIntMs("HELPERS_TEST_MS", 500)).toBe(1200)
  })

  test("rounds a fractional value but returns the fallback unrounded", () => {
    process.env.HELPERS_TEST_MS = "10.6"
    expect(envPositiveIntMs("HELPERS_TEST_MS", 500)).toBe(11)
    process.env.HELPERS_TEST_MS = "abc"
    expect(envPositiveIntMs("HELPERS_TEST_MS", 0.5)).toBe(0.5)
  })

  test("zero, negative, blank and non-numeric all fall back", () => {
    for (const value of ["0", "-1", "", "   ", "abc", "Infinity"]) {
      process.env.HELPERS_TEST_MS = value
      expect(envPositiveIntMs("HELPERS_TEST_MS", 500)).toBe(500)
    }
  })
})

describe("stopChild", () => {
  test("SIGTERMs the child and resolves only once it is reaped", async () => {
    const child = spawnChild("sleep 30")
    const exit = exited(child)
    await stopChild(child)
    expect((await exit).signal).toBe("SIGTERM")
  })

  test.skipIf(process.platform === "win32")("escalates to SIGKILL when the grace period expires", async () => {
    const child = await spawnUnkillableChild()
    const exit = exited(child)
    await stopChild(child, { graceMs: 60 })
    expect((await exit).signal).toBe("SIGKILL")
  })

  test.skipIf(process.platform !== "win32")("on Windows the first signal already terminates, so escalation never runs", async () => {
    const child = await spawnUnkillableChild()
    const exit = exited(child)
    // A grace period far longer than the test could tolerate: `stopChild` may
    // only return this fast if the SIGTERM itself reaped the child, which is
    // what Windows does — every signal is TerminateProcess, and the handler
    // that makes this child unkillable on POSIX is never consulted.
    const started = Date.now()
    await stopChild(child, { graceMs: 60_000, killWaitMs: 60_000 })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect((await exit).signal).toBe("SIGTERM")
    expect(child.exitCode === null).toBe(true)
  })

  test("concurrent calls share one promise", () => {
    const child = spawnChild("sleep 30")
    const first = stopChild(child)
    expect(stopChild(child)).toBe(first)
    return first
  })

  test("releases both listeners before settling", async () => {
    const child = spawnChild("sleep 30")
    await stopChild(child)
    expect(child.listenerCount("error")).toBe(0)
  })

  test("an already-exited child and an undefined child are both no-ops", async () => {
    await stopChild(undefined)
    const child = spawnChild("exit 0")
    await exited(child)
    await stopChild(child)
    expect(child.exitCode).toBe(0)
  })

  test("processGroup stops a detached leader's whole group", async () => {
    const child = spawnChild("sleep 30 & sleep 30", { detached: true })
    const exit = exited(child)
    await stopChild(child, { processGroup: true })
    expect((await exit).signal).toBe("SIGTERM")
  })

  test("processGroup falls back to the child when it leads no group", async () => {
    const child = spawnChild("sleep 30")
    const exit = exited(child)
    await stopChild(child, { processGroup: true })
    expect((await exit).signal).toBe("SIGTERM")
  })
})
