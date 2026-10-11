import { describe, expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { settleAtRequestDeadline, withDeadlineSignal } from "./deadline"

const expired = (what: string) => new Error(`${what} expired`)

test("a request result wins and abandonment does not run", async () => {
  let abandoned = 0
  const result = await settleAtRequestDeadline("read", {
    deadlineAt: Date.now() + 1_000, signal: new AbortController().signal,
  }, Promise.resolve("ok"), () => { abandoned++ }, expired)
  expect(result).toBe("ok")
  expect(abandoned).toBe(0)
})

test("abort settles once and detaches a late rejecting request", async () => {
  const controller = new AbortController()
  let rejectRequest!: (error: Error) => void
  const request = new Promise<string>((_resolve, reject) => { rejectRequest = reject })
  let abandoned = 0
  const result = settleAtRequestDeadline("read", {
    deadlineAt: Date.now() + 1_000, signal: controller.signal,
  }, request, () => { abandoned++ }, expired)
  controller.abort()
  await expect(result).rejects.toThrow("read expired")
  rejectRequest(new Error("late"))
  await Promise.resolve()
  expect(abandoned).toBe(1)
})

test("an expired request never starts waiting", async () => {
  let abandoned = 0
  const result = settleAtRequestDeadline("read", {
    deadlineAt: Date.now() - 1, signal: new AbortController().signal,
  }, Promise.resolve("late"), () => { abandoned++ }, expired)
  await expect(result).rejects.toThrow("read expired")
  expect(abandoned).toBe(1)
})

test.each(["abort", "timeout"] as const)("the losing deadline resource is released when %s wins", async (winner) => {
  const controller = new AbortController()
  const clear = spyOn(globalThis, "clearTimeout")
  const remove = spyOn(controller.signal, "removeEventListener")
  let abandoned = 0
  try {
    const pending = settleAtRequestDeadline("stop", { signal: controller.signal, deadlineAt: Date.now() + (winner === "abort" ? 60_000 : 10) },
      new Promise<never>(() => {}), () => { abandoned++ }, (_what, aborted) => new Error(aborted ? "aborted" : "timed out"))
    if (winner === "abort") controller.abort()
    await expect(pending).rejects.toThrow(winner === "abort" ? "aborted" : "timed out")
    expect(clear).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]?.[0]).toBe("abort")
    expect(abandoned).toBe(1)
  } finally { clear.mockRestore(); remove.mockRestore() }
})

describe("withDeadlineSignal", () => {
  // A fresh process whose only work is the deadline: an unreferenced timer
  // there never fires. Bun on Windows waits forever, so a run killed at
  // `timeoutMs` printed nothing; elsewhere the process exits first. No
  // top-level await, since bun stays alive while one is pending.
  const alone = (body: string, timeoutMs = 4_000) => {
    const module = JSON.stringify(new URL("./deadline.ts", import.meta.url).href)
    const result = spawnSync(process.execPath, ["-e", `import(${module}).then(({ withDeadlineSignal }) => { ${body} })`], { encoding: "utf8", timeout: timeoutMs })
    if (result.error && (result.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw result.error
    return result.stdout.trim()
  }

  test("aborts work that never settles when it is the process's only work", () => {
    expect(alone(`
      withDeadlineSignal(20, (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))))
        .catch((error) => process.stdout.write(error.name))
    `)).toBe("TimeoutError")
  })

  test("AbortSignal.timeout alone never fires there, which is why the helper exists", () => {
    expect(alone(`
      const signal = AbortSignal.timeout(20)
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
        .catch((error) => process.stdout.write(error.name))
    `, 2_000)).toBe("")
  })

  test("a settled result lets the process exit at once", () => {
    const started = performance.now()
    expect(alone(`withDeadlineSignal(10_000, async () => "done").then((value) => process.stdout.write(value))`)).toBe("done")
    expect(performance.now() - started).toBeLessThan(3_000)
  })

  test("a parent abort reaches the work with the parent's reason", async () => {
    const parent = new AbortController()
    const working = withDeadlineSignal(10_000, (signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }), parent.signal)
    parent.abort(new Error("caller left"))
    await expect(working).rejects.toThrow("caller left")
  })
})
