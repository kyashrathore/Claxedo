import { describe, expect, test, vi } from "vitest"
import { createBus, type ClaxedoEvent } from "./bus"

vi.mock("@claxedo/workspace-runtime", () => ({
  claxedoBus: {
    publish() {},
    subscribe() {
      return () => {}
    },
  },
}))

describe("claxedo bus event contract", () => {
  test("delivers to later subscribers when an earlier subscriber throws", () => {
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

  test("reports rejected async subscribers without blocking later subscribers", async () => {
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

  test("publishes session lifecycle events", () => {
    const bus = createBus<ClaxedoEvent>()
    const events: ClaxedoEvent[] = []
    const unsubscribe = bus.subscribe((event) => events.push(event))

    bus.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: "/workspace",
      workspaceId: "ws_1",
      draftId: "draft_1",
      sessionID: "ses_1",
      info: { id: "ses_1" },
      ts: 1,
    })

    unsubscribe()

    expect(events).toEqual([
      {
        type: "session.lifecycle",
        phase: "created",
        directory: "/workspace",
        workspaceId: "ws_1",
        draftId: "draft_1",
        sessionID: "ses_1",
        info: { id: "ses_1" },
        ts: 1,
      },
    ])
  })
})
