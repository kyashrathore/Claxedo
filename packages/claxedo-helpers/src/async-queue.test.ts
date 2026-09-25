import { expect, test } from "bun:test"
import { AsyncPushQueue } from "./async-queue"

test("delivers buffered values before end and ignores later pushes", async () => {
  const queue = new AsyncPushQueue<number>()
  queue.push(1)
  queue.end()
  queue.push(2)
  expect(await queue.next()).toEqual({ done: false, value: 1 })
  expect(await queue.next()).toEqual({ done: true, value: undefined })
})

test("releases every pending pull and preserves the failure", async () => {
  const queue = new AsyncPushQueue<number>()
  const first = queue.next()
  const second = queue.next()
  const failure = new Error("broken")
  queue.fail(failure)
  expect(first).rejects.toBe(failure)
  expect(second).rejects.toBe(failure)
  expect(queue.next()).rejects.toBe(failure)
})

test("delivers buffered values before failure", async () => {
  const queue = new AsyncPushQueue<number>()
  queue.push(1)
  queue.fail(new Error("broken"))
  expect(await queue.next()).toEqual({ done: false, value: 1 })
  expect(queue.next()).rejects.toThrow("broken")
})
