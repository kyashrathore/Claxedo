import { describe, expect, test } from "vitest"
import { claxedoBus, type ClaxedoEvent } from "../bus"
import { emitProvision } from "./provision-events"

describe("sandbox provision events", () => {
  test("emits provision event with workspace and extra metadata", () => {
    const events: ClaxedoEvent[] = []
    const cleanup = claxedoBus.subscribe((event) => events.push(event))

    emitProvision("ws-emit-1", "cloning", { message: "https://github.com/test/repo" })
    cleanup()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "provision",
      workspaceId: "ws-emit-1",
      step: "cloning",
      message: "https://github.com/test/repo",
    })
  })
})
