import { expect, test } from "bun:test"
import { withinDeadline } from "./checkpoint"

test("checkpoint waits refuse an already expired deadline", async () => {
  expect(await withinDeadline(Promise.resolve(), Date.now() - 1)).toBe(false)
})

test("checkpoint waits preserve completion and producer failure", async () => {
  expect(await withinDeadline(Promise.resolve(), Date.now() + 1_000)).toBe(true)
  await expect(withinDeadline(Promise.reject(new Error("producer failed")), Date.now() + 1_000)).rejects.toThrow("producer failed")
})
