/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createWakeReread } from "./wake-reread"

function watch(initiallyAsleep: boolean, initiallyActive = true) {
  return createRoot((dispose) => {
    const [asleep, setAsleep] = createSignal(initiallyAsleep)
    const [active, setActive] = createSignal(initiallyActive)
    const rereads: Array<() => void> = []
    const readAsleep = createWakeReread({ asleep, active, reread: () => new Promise<void>((resolve) => rereads.push(resolve)) })
    return { setAsleep, setActive, rereads, readAsleep, dispose }
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("wake reread: a workspace that wakes re-reads once, and what was read while it slept stays unread until that read lands", async () => {
  const view = watch(true)
  expect(view.readAsleep()).toBe(true)
  expect(view.rereads.length).toBe(0)
  view.setAsleep(false)
  expect(view.rereads.length).toBe(1)
  expect(view.readAsleep(), "the reread has not answered yet").toBe(true)
  view.setActive(false)
  view.setActive(true)
  expect(view.rereads.length, "one wake, one reread").toBe(1)
  view.rereads[0]?.()
  await settle()
  expect(view.readAsleep()).toBe(false)
  view.dispose()
})

test("wake reread: a picker away from its pane at the wake re-reads when it is shown again", async () => {
  const view = watch(true, false)
  view.setAsleep(false)
  expect(view.rereads.length).toBe(0)
  expect(view.readAsleep()).toBe(true)
  view.setActive(true)
  expect(view.rereads.length).toBe(1)
  view.rereads[0]?.()
  await settle()
  expect(view.readAsleep()).toBe(false)
  view.dispose()
})

test("wake reread: a workspace that falls asleep again before the reread lands keeps its reads unread", async () => {
  const view = watch(true)
  view.setAsleep(false)
  view.setAsleep(true)
  view.rereads[0]?.()
  await settle()
  expect(view.readAsleep()).toBe(true)
  view.dispose()
})

test("wake reread: a running workspace never re-reads and its reads count", () => {
  const view = watch(false)
  view.setActive(false)
  view.setActive(true)
  expect(view.rereads.length).toBe(0)
  expect(view.readAsleep()).toBe(false)
  view.dispose()
})
