import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEventEnvelope } from "./contracts"
import { createRuntimeSubscription, type RuntimeSubscriber } from "./subscription"

const envelope = (text: string): AgentRuntimeEventEnvelope => ({
  sessionId: "s1",
  directory: "/work",
  payload: { type: "text-delta", delta: text } as AgentRuntimeEventEnvelope["payload"],
})

describe("createRuntimeSubscription with an eventDelivery policy", () => {
  test("refuses an identityless subscription — network subscribers must authenticate", () => {
    expect(() =>
      createRuntimeSubscription(new Set(), { sessionId: "s1" }, 8, async () => ({ deliver: true }) as never),
    ).toThrow("Subscription identity is required when eventDelivery is configured")
  })

  test("admits the host's own subscription via hostInternal and skips delivery filtering", async () => {
    // The exact defect: the prompt turn driver subscribes in-process with no
    // identity; with a policy composed, the old guard threw here and every
    // local prompt died before `turn.start`, surfacing only as a transient
    // bus session.error.
    const subscribers = new Set<RuntimeSubscriber>()
    let policyCalls = 0
    const stream = createRuntimeSubscription(
      subscribers,
      { sessionId: "s1", hostInternal: true },
      8,
      (async () => {
        policyCalls += 1
        return { deliver: false }
      }) as never,
    )
    expect(subscribers.size).toBe(1)
    for (const subscriber of subscribers) subscriber.push(envelope("hello"))
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect((first.value?.payload as { delta?: string }).delta).toBe("hello")
    // Host-internal readers see everything the host owns; the per-event
    // delivery policy is for identified (remote) subscribers only.
    expect(policyCalls).toBe(0)
    for (const subscriber of subscribers) subscriber.close()
    await iterator.return?.()
  })
})
