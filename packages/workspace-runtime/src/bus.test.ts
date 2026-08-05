import { describe, expect, it } from "bun:test"
import { createBus, workspaceRuntimeBus } from "./bus"

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

describe("workspaceRuntimeBus", () => {
  it("is one process-wide instance across separate module evaluations", async () => {
    // dist ships each public entry as its own bundle, each inlining bus.ts.
    // Query-suffixed imports stand in for those duplicate module instances.
    const a = (await import(`./bus?bundle=${"a"}`)) as typeof import("./bus")
    const b = (await import(`./bus?bundle=${"b"}`)) as typeof import("./bus")
    expect(a).not.toBe(b)
    expect(a.workspaceRuntimeBus).toBe(b.workspaceRuntimeBus)
    expect(a.workspaceRuntimeBus).toBe(workspaceRuntimeBus)

    const seen: string[] = []
    const unsubscribe = b.workspaceRuntimeBus.subscribe((event) => seen.push(event.type))
    a.workspaceRuntimeBus.publish({ type: "heartbeat" })
    unsubscribe()
    expect(seen).toEqual(["heartbeat"])
  })
})
