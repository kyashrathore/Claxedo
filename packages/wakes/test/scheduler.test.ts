import { expect, test, vi } from "vitest"
import { createScheduler } from "../src/scheduler"
import type { Wakes } from "../src/wakes"

test("stop drains a running delivery before its store can close", async () => {
  let release!: () => void
  const delivery = new Promise<void>((resolve) => {
    release = resolve
  })
  const runDue = vi.fn(() => delivery)
  const scheduler = createScheduler({ recover: async () => {}, runDue } as unknown as Wakes)
  scheduler.start()
  await Promise.resolve()
  expect(runDue).toHaveBeenCalledTimes(1)
  let stopped = false
  const stopping = scheduler.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  release()
  await stopping
  expect(stopped).toBe(true)
})

test("stopping during recovery prevents a late delivery", async () => {
  let release!: () => void
  const recovery = new Promise<void>((resolve) => {
    release = resolve
  })
  const runDue = vi.fn(async () => {})
  const scheduler = createScheduler({ recover: () => recovery, runDue } as unknown as Wakes, { intervalMs: 1 })
  scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(runDue).not.toHaveBeenCalled()
  const stopping = scheduler.stop()
  release()
  await stopping
  expect(runDue).not.toHaveBeenCalled()
})
