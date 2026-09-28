import { expect, spyOn, test } from "bun:test"
import { settleAtRequestDeadline } from "./deadline"

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
