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

test("reports drained once the consumer has taken every pushed value and asks for more", async () => {
  const queue = new AsyncPushQueue<number>()
  queue.push(1)
  queue.push(2)
  let drained = false
  const settled = queue.drained().then(() => { drained = true })
  expect(await queue.next()).toEqual({ done: false, value: 1 })
  await Promise.resolve()
  expect(drained).toBe(false)
  expect(await queue.next()).toEqual({ done: false, value: 2 })
  await Promise.resolve()
  expect(drained).toBe(false)
  const waiting = queue.next()
  await settled
  expect(drained).toBe(true)
  await queue.drained()
  queue.push(3)
  expect(await waiting).toEqual({ done: false, value: 3 })
})

test("reports drained when the queue closes before the consumer asks again", async () => {
  const ended = new AsyncPushQueue<number>()
  ended.push(1)
  const afterEnd = ended.drained()
  ended.end()
  await afterEnd
  const failed = new AsyncPushQueue<number>()
  failed.push(1)
  const afterFailure = failed.drained()
  failed.fail(new Error("broken"))
  await afterFailure
})
