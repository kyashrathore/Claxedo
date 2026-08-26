import { describe, expect, test } from "bun:test"
import { createHistoryFill, HISTORY_FILL_EARLIEST_MS } from "./history-fill"

type Callback = () => void

function scheduler() {
  let token = 0
  const timers = new Map<number, { callback: Callback; delay: number }>()
  const frames = new Map<number, Callback>()
  const idles = new Map<number, Callback>()

  return {
    timers,
    frames,
    idles,
    scheduleTimer(callback: Callback, delay: number) {
      const id = ++token
      timers.set(id, { callback, delay })
      return id
    },
    cancelTimer(id: number) {
      timers.delete(id)
    },
    scheduleFrame(callback: Callback) {
      const id = ++token
      frames.set(id, callback)
      return id
    },
    cancelFrame(id: number) {
      frames.delete(id)
    },
    scheduleIdle(callback: Callback) {
      const id = ++token
      idles.set(id, callback)
      return id
    },
    cancelIdle(id: number) {
      idles.delete(id)
    },
    runTimer() {
      const entry = [...timers.entries()][0]
      if (!entry) throw new Error("Expected a timer")
      timers.delete(entry[0])
      entry[1].callback()
    },
    runFrame() {
      const entry = [...frames.entries()][0]
      if (!entry) throw new Error("Expected a frame")
      frames.delete(entry[0])
      entry[1]()
    },
    runIdle() {
      const entry = [...idles.entries()][0]
      if (!entry) throw new Error("Expected an idle callback")
      idles.delete(entry[0])
      entry[1]()
    },
  }
}

describe("createHistoryFill", () => {
  test("does not auto-load in the first 50 ms and reveals exactly once after the activation deadline, frames, and idle", () => {
    let currentTime = 0
    let loads = 0
    const queue = scheduler()
    const fill = createHistoryFill({
      eligible: () => true,
      reveal: () => loads += 1,
      now: () => currentTime,
      ...queue,
    })

    fill.activate("workspace-a/session-a")
    fill.schedule()
    fill.schedule()

    expect([...queue.timers.values()].map((entry) => entry.delay)).toEqual([HISTORY_FILL_EARLIEST_MS])
    currentTime = 50
    expect(loads).toBe(0)
    expect(queue.frames.size).toBe(0)
    expect(queue.idles.size).toBe(0)

    currentTime = HISTORY_FILL_EARLIEST_MS
    queue.runTimer()
    expect(loads).toBe(0)
    queue.runFrame()
    expect(loads).toBe(0)
    queue.runFrame()
    expect(loads).toBe(0)
    queue.runIdle()
    expect(loads).toBe(1)

    expect(queue.timers.size).toBe(0)
    expect(queue.frames.size).toBe(0)
    expect(queue.idles.size).toBe(0)
  })

  test("cancels the previous session and anchors the replacement deadline to its activation", () => {
    let currentTime = 0
    let loads = 0
    const queue = scheduler()
    const fill = createHistoryFill({
      eligible: () => true,
      reveal: () => loads += 1,
      now: () => currentTime,
      ...queue,
    })

    fill.activate("workspace-a/session-a")
    fill.schedule()

    currentTime = 25
    fill.activate("workspace-a/session-b")
    expect(queue.timers.size).toBe(0)

    fill.schedule()
    expect([...queue.timers.values()].map((entry) => entry.delay)).toEqual([HISTORY_FILL_EARLIEST_MS])

    currentTime = 125
    queue.runTimer()
    queue.runFrame()
    fill.cancel()

    expect(queue.frames.size).toBe(0)
    expect(queue.idles.size).toBe(0)
    expect(loads).toBe(0)
  })
})
