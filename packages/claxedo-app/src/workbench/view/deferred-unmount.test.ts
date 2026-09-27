/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createDeferredUnmount, type AfterPaint } from "./deferred-unmount"

function paints() {
  const queued: Array<() => void> = []
  let waiting = 0
  const afterPaint: AfterPaint = (run) => {
    let live = true
    waiting += 1
    queued.push(() => {
      if (!live) return
      live = false
      waiting -= 1
      run()
    })
    return () => {
      if (!live) return
      live = false
      waiting -= 1
    }
  }
  return { afterPaint, waiting: () => waiting, paint: () => queued.splice(0).forEach((run) => run()) }
}

test("a content hidden by a swap stays mounted until the frame that hides it has painted", () => {
  createRoot((dispose) => {
    const frames = paints()
    const [wanted, setWanted] = createSignal(true)
    const mounted = createDeferredUnmount(wanted, frames.afterPaint)
    setWanted(false)
    expect(mounted()).toBe(true)
    frames.paint()
    expect(mounted()).toBe(false)
    setWanted(true)
    expect(mounted(), "a content shown again mounts in the same task").toBe(true)
    dispose()
  })
})

test("a burst of switches keeps at most one unmount waiting, and a content shown again before the paint keeps its view", () => {
  createRoot((dispose) => {
    const frames = paints()
    const [wanted, setWanted] = createSignal(true)
    const mounted = createDeferredUnmount(wanted, frames.afterPaint)
    for (let switches = 0; switches < 20; switches += 1) {
      setWanted(false)
      expect(frames.waiting()).toBe(1)
      setWanted(true)
      expect(frames.waiting()).toBe(0)
    }
    frames.paint()
    expect(mounted()).toBe(true)
    setWanted(false)
    setWanted(true)
    setWanted(false)
    expect(frames.waiting()).toBe(1)
    frames.paint()
    expect(mounted()).toBe(false)
    expect(frames.waiting()).toBe(0)
    dispose()
  })
})

test("a slot disposed while its unmount waits leaves nothing waiting", () => {
  const frames = paints()
  createRoot((dispose) => {
    const [wanted, setWanted] = createSignal(true)
    createDeferredUnmount(wanted, frames.afterPaint)
    setWanted(false)
    dispose()
  })
  expect(frames.waiting()).toBe(0)
})
