import { asRecord } from "@claxedo/agent-runtime-contract"
import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEventEnvelope } from "./contracts"
import { createRuntimeSubscription, type RuntimeSubscriber } from "./subscription"

const envelope = (text: string): AgentRuntimeEventEnvelope => ({
  sessionId: "s1",
  directory: "/work",
  payload: { type: "text-delta", delta: text } as AgentRuntimeEventEnvelope["payload"],
})

describe("createRuntimeSubscription", () => {
  test("an event buffered before the subscriber closes still drains to its reader", async () => {
    const subscribers = new Set<RuntimeSubscriber>()
    const stream = createRuntimeSubscription(subscribers, { sessionId: "s1" }, 8)
    expect(subscribers.size).toBe(1)
    for (const subscriber of subscribers) subscriber.push(envelope("hello"))
    for (const subscriber of subscribers) subscriber.close()
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(asRecord(first.value?.payload)?.delta).toBe("hello")
    expect((await iterator.next()).done).toBe(true)
  })
})
