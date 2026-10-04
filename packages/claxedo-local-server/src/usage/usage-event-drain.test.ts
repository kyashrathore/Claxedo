import { describe, expect, test, vi } from "vitest"
import { drainUsageEvents } from "./usage-event-drain"

describe("drainUsageEvents", () => {
  test("waits for a blocked queued event before flushing the meter", async () => {
    let release!: () => void
    const order: string[] = []
    const eventTail = new Promise<void>((resolve) => {
      release = () => {
        order.push("event")
        resolve()
      }
    })
    const flush = vi.fn(async () => { order.push("flush") })

    const stopping = drainUsageEvents(eventTail, { flush })
    await Promise.resolve()
    expect(flush).not.toHaveBeenCalled()

    release()
    await stopping
    expect(order).toEqual(["event", "flush"])
  })
})
