import { describe, expect, test } from "bun:test"
import { createMemoryRunStore } from "./session-env"
import { createVirtualSessionEnv } from "./virtual-session-env"

describe("SessionEnv", () => {
  test("virtual env persists files across exec calls", async () => {
    const env = createVirtualSessionEnv()

    await env.exec("mkdir -p /tmp && printf hello > /tmp/greeting.txt")

    expect(Buffer.from(await env.readFile("/tmp/greeting.txt")).toString()).toBe("hello")
    expect((await env.exec("cat /tmp/greeting.txt")).stdout).toBe("hello")
  })

  test("memory run store returns monotonic replay events from cursor", () => {
    const store = createMemoryRunStore<string>()

    store.appendEvent({ runId: "run-1", payload: "first", createdAt: 1 })
    store.appendEvent({ runId: "run-1", payload: "second", createdAt: 2 })

    expect(store.getEvents("run-1", 1)).toEqual([{
      runId: "run-1",
      eventIndex: 1,
      payload: "second",
      createdAt: 2,
    }])
  })
})
