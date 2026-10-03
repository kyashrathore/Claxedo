import { test } from "node:test"
import assert from "node:assert/strict"
import type { AgentPresentationEvent, SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { SessionBroker } from "@claxedo/harness/contract"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, LOOPBACK_ORIGIN } from "../test-support/host-fixture"

const observation = (status: SubagentObservation["status"]): SubagentObservation => ({
  observationId: `child:${status}`, providerId: "child", providerKind: "codex", toolCallId: "child", toolCallRole: "spawn",
  status, mode: "background", transcript: { kind: "live" },
})

for (const status of ["completed", "failed"] as const) {
  void test(`an idle parent's ${status} child publishes the committed terminal exactly once`, async () => {
    let broker: SessionBroker | undefined
    const transport = new FakeTransport({ beforeStart: async (_input, session) => { broker = session } })
    const fixture = createHostFixture({ transports: { pi: transport } })
    const frames: AgentPresentationEvent[] = []
    try {
      await fixture.runtime.sessions.create(sessionCreate({ id: "parent" }))
      await fixture.runtime.turns.start({ sessionId: "parent", text: "Work", origin: LOOPBACK_ORIGIN })
      ;(await fixture.runtime.turns.whenIdle("parent")).abandon()
      assert.ok(broker)
      const child = await broker.observeSubagent(observation("running"))
      assert.ok(child)
      broker.associateChild("child", child)
      const unsubscribe = fixture.eventHub.subscribeGlobal(({ payload }) => { frames.push(payload) })
      try { await broker.observeSubagent(observation(status)) } finally { unsubscribe() }
      const terminalType = status === "failed" ? "session.error" : "session.idle"
      assert.equal(frames.filter((frame) => frame.type === terminalType).length, 1)
      const records = fixture.store.database().prepare<{ type: string }>("SELECT type FROM runtime_journal WHERE session_id = ? AND type IN ('session.error', 'session.idle')").all(child.sessionId)
      assert.deepEqual(records, [{ type: terminalType }])
      assert.deepEqual(fixture.store.sessionAttentionHistory(child.sessionId, 0, 256).events.map((event) => event.outcome), [status])
      assert.equal(fixture.store.getSession(child.sessionId)!.lastTurn!.status, status)
      assert.equal(fixture.store.readTurnAuthority(child.sessionId), undefined)
    } finally { await fixture.dispose() }
  })
}

void test("a child stream's published completion is not reappended when its observation settles", async () => {
  let broker: SessionBroker | undefined
  const transport = new FakeTransport({ beforeStart: async (_input, session) => { broker = session } })
  const fixture = createHostFixture({ transports: { pi: transport } })
  const frames: AgentPresentationEvent[] = []
  try {
    await fixture.runtime.sessions.create(sessionCreate({ id: "parent" }))
    await fixture.runtime.turns.start({ sessionId: "parent", text: "Work", origin: LOOPBACK_ORIGIN })
    ;(await fixture.runtime.turns.whenIdle("parent")).abandon()
    assert.ok(broker)
    const child = await broker.observeSubagent(observation("running"))
    assert.ok(child)
    broker.associateChild("child", child)
    const unsubscribe = fixture.eventHub.subscribeGlobal(({ payload }) => { frames.push(payload) })
    try {
      await broker.publishChild({ event: { type: "finish", sessionId: child.sessionId }, route: { kind: "child", correlationKey: "child" } })
      await broker.observeSubagent(observation("completed"))
    } finally { unsubscribe() }
    assert.equal(frames.filter((frame) => frame.type === "session.idle").length, 1)
    assert.equal(fixture.store.sessionAttentionHistory(child.sessionId, 0, 256).events.length, 1)
  } finally { await fixture.dispose() }
})
