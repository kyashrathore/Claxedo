import { expect, test } from "bun:test"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, tick, LOOPBACK_ORIGIN } from "../test-support/host-fixture"

test.each([false, true])("unbound child usage reaches the hub once after the consumer closes early=%s", async (early) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const transport = new FakeTransport()
  transport.send = async function* () {
    yield { event: { type: "usage", contextSize: 100, contextUsed: 10,
      observation: { kind: "delta", tokens: { input: 7, output: 2, reasoning: null, cache: { read: null, write: null } } } },
      route: { kind: "child", correlationKey: "unbound" } }
    await gate
    yield { event: { type: "finish", sessionId: "s" } }
  }
  const f = createHostFixture({ transports: { pi: transport } })
  const metered: unknown[] = []
  f.eventHub.subscribeGlobal(({ payload }) => { if (payload.type === "session.usage") metered.push(payload) })
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "s" }))
    const consumer = f.runtime.events.subscribe({ sessionId: "s" })[Symbol.asyncIterator]()
    await f.runtime.turns.start({ sessionId: "s", text: "work", origin: LOOPBACK_ORIGIN })
    await tick()
    expect(metered).toEqual([])
    if (early) await consumer.return?.()
    release()
    await f.runtime.dispose()
    expect(metered).toHaveLength(1)
    expect(metered[0]).toMatchObject({ type: "session.usage", properties: { sessionID: "s", observation: { tokens: { input: 7, output: 2 } } } })
    if (early) {
      const remaining: unknown[] = []
      for (;;) { const next = await consumer.next(); if (next.done) break; remaining.push(next.value.payload.type) }
      expect(remaining).not.toContain("session.usage")
    } else await consumer.return?.()
  } finally { release(); await f.dispose() }
})
