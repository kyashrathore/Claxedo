import { expect, test } from "bun:test"
import type { RoutedEvent } from "@claxedo/harness/contract"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, LOOPBACK_ORIGIN, sessionCreate, until } from "../test-support/host-fixture"

const exhaustions: Record<string, RoutedEvent[]> = {
  "a stream": [{ event: { type: "text-delta", delta: "unfinished" } }],
  "a child's finish, then a stream": [
    { event: { type: "text-delta", delta: "unfinished parent" } },
    { event: { type: "finish", sessionId: "child" }, route: { kind: "child", correlationKey: "child" } },
  ],
}

for (const [sequence, events] of Object.entries(exhaustions)) {
  test(`${sequence} exhausted without a parent terminal fails the turn and retains pending handoff`, async () => {
    const transport = new FakeTransport({ kind: "pi-durable" })
    transport.send = async function* () { yield* events }
    const fixture = createHostFixture({ transports: { pi: transport } })
    try {
      const session = await fixture.runtime.sessions.create(sessionCreate())
      fixture.store.updateSessionConfig(session.id, { handoff: { pending: true, transcript: "saved context", from: { id: "pi", access: "native" } } })
      await fixture.runtime.turns.start({ sessionId: session.id, text: "continue", origin: LOOPBACK_ORIGIN })
      await until(() => !!fixture.store.getSession(session.id)?.lastTurn)
      expect(fixture.store.getSession(session.id)?.lastTurn).toMatchObject({ status: "failed", detail: { code: "missing_terminal_event" } })
      expect(fixture.store.getSessionConfig(session.id)?.handoff?.pending).toBe(true)
    } finally { await fixture.dispose() }
  })
}

test("a turn whose transport ends on its own cancelled terminal records the turn as cancelled", async () => {
  const transport = new FakeTransport({ kind: "claude-sdk" })
  transport.send = async function* (session) {
    yield { event: { type: "text-delta", delta: "stopping" } }
    yield { event: { type: "cancelled", sessionId: session.binding.sessionId } }
  }
  const fixture = createHostFixture({ transports: { pi: transport } })
  try {
    const session = await fixture.runtime.sessions.create(sessionCreate())
    await fixture.runtime.turns.start({ sessionId: session.id, text: "stop soon", origin: LOOPBACK_ORIGIN })
    await until(() => !!fixture.store.getSession(session.id)?.lastTurn)
    expect(fixture.store.getSession(session.id)?.lastTurn).toMatchObject({ status: "cancelled", reason: "abort" })
  } finally { await fixture.dispose() }
})
