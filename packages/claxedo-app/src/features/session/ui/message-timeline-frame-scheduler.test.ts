import { describe, expect, test } from "bun:test"
import { createTimelineFrameScheduler } from "./message-timeline-frame-scheduler"

describe("timeline frame ownership", () => {
  test("settled callbacks release their frame ownership", () => {
    const callbacks = new Map<number, FrameRequestCallback>()
    let next = 1
    const scheduler = createTimelineFrameScheduler({
      request: (callback) => {
        const id = next++
        callbacks.set(id, callback)
        return id
      },
      cancel: () => {},
    })

    const calls: number[] = []
    const id = scheduler.request((time) => calls.push(time))
    expect(scheduler.pending()).toBe(1)
    callbacks.get(id)?.(12)
    expect(calls).toEqual([12])
    expect(scheduler.pending()).toBe(0)
  })

  test("cancelAll cancels focus, reveal, anchor, and progressive frames without late commits", () => {
    const callbacks = new Map<number, FrameRequestCallback>()
    const cancelled: number[] = []
    let next = 1
    const scheduler = createTimelineFrameScheduler({
      request: (callback) => {
        const id = next++
        callbacks.set(id, callback)
        return id
      },
      cancel: (id) => cancelled.push(id),
    })
    const committed: number[] = []
    const ids = Array.from({ length: 4 }, (_, index) => scheduler.request(() => committed.push(index)))

    scheduler.cancelAll()
    for (const id of ids) {
      if (!cancelled.includes(id)) callbacks.get(id)?.(0)
    }

    expect(cancelled).toEqual(ids)
    expect(committed).toEqual([])
    expect(scheduler.pending()).toBe(0)
  })

  test("individual cancellation is idempotent", () => {
    const cancelled: number[] = []
    const scheduler = createTimelineFrameScheduler({ request: () => 7, cancel: (id) => cancelled.push(id) })
    const id = scheduler.request(() => {})
    scheduler.cancel(id)
    scheduler.cancel(id)
    scheduler.cancel(undefined)
    expect(cancelled).toEqual([7])
  })
})
