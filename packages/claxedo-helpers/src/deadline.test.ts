import { expect, test } from "bun:test"
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
