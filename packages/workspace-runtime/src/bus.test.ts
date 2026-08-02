import { describe, expect, it } from "bun:test"
import { createBus } from "./bus"

describe("createBus", () => {
  it("delivers to later subscribers when an earlier subscriber throws", () => {
    const errors: unknown[] = []
    const events: string[] = []
    const bus = createBus<string>({ onSubscriberError: (error) => errors.push(error) })

    bus.subscribe(() => {
      throw new Error("subscriber failed")
    })
    bus.subscribe((event) => events.push(event))

    expect(() => bus.publish("ready")).not.toThrow()
    expect(events).toEqual(["ready"])
    expect((errors[0] as Error).message).toBe("subscriber failed")
  })

  it("reports rejected async subscribers without blocking later subscribers", async () => {
    const errors: unknown[] = []
    const events: string[] = []
    const bus = createBus<string>({ onSubscriberError: (error) => errors.push(error) })

    bus.subscribe(async () => {
      throw new Error("async subscriber failed")
    })
    bus.subscribe((event) => events.push(event))

    bus.publish("running")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toEqual(["running"])
    expect((errors[0] as Error).message).toBe("async subscriber failed")
  })
})
