import { expect, test } from "bun:test"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { ProviderTurnResult, RoutedEvent, SessionBroker } from "@claxedo/harness/contract"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, until, LOOPBACK_ORIGIN, type HostFixture } from "../test-support/host-fixture"

const background = (toolCallId: string): SubagentObservation => ({
  observationId: `${toolCallId}:running`, providerKind: "claude-agent", toolCallId, toolCallRole: "spawn",
  status: "running", mode: "background", transcript: { kind: "messages" },
})

function journal(f: HostFixture, sessionId: string) {
  return JSON.stringify(f.store.brokerDatabase().prepare<{ payload_json: string }>(
    "SELECT payload_json FROM runtime_journal WHERE session_id = ? ORDER BY seq").all(sessionId))
}

test("a provider turn the harness starts as its prompted turn ends is admitted once that turn releases the session, and delivers its child frames", async () => {
  const brokers = new Map<string, SessionBroker>()
  const admissions: Promise<ProviderTurnResult>[] = []
  let child: string | undefined
  const report = (): AsyncIterable<RoutedEvent> => (async function* () {
    yield { event: { type: "text-delta", delta: "the background agent reported back" }, route: { kind: "child", correlationKey: "toolu_agent" } }
    yield { event: { type: "text-delta", delta: "report" } }
    yield { event: { type: "finish", sessionId: "parent" } }
  })()
  const transport = new FakeTransport({
    beforeStart: async (input, broker) => { brokers.set(input.sessionId, broker) },
    turn: ({ broker }) => (async function* () {
      const ref = await broker.observeSubagent(background("toolu_agent"))
      broker.associateChild("toolu_agent", ref!)
      child = ref!.sessionId
      yield { type: "finish" as const, sessionId: "parent" }
      admissions.push(brokers.get("parent")!.admitProviderTurn({ reason: "provider" }, report))
    })(),
  })
  const f = createHostFixture({ transports: { pi: transport } })
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "parent" }))
    await f.runtime.turns.start({ sessionId: "parent", text: "work", origin: LOOPBACK_ORIGIN })
    await until(() => admissions.length === 1, "provider turn asked for")
    const admitted = await admissions[0]
    if (!admitted.admitted) throw new Error(`provider turn refused: ${admitted.reason}`)
    expect(await admitted.settled).toEqual({ state: "completed" })
    expect(journal(f, child!)).toContain("the background agent reported back")
    expect(f.store.getSession("parent")?.lastTurn?.status).toBe("completed")
    expect(f.store.readTurnAuthority("parent")).toBeUndefined()
  } finally { await f.dispose() }
})

test("disposing the runtime ends a provider turn's wait for its session at once, as closed", async () => {
  const brokers = new Map<string, SessionBroker>()
  const transport = new FakeTransport({ beforeStart: async (input, broker) => { brokers.set(input.sessionId, broker) } })
  const f = createHostFixture({ transports: { pi: transport } })
  await f.runtime.sessions.create(sessionCreate({ id: "parent" }))
  const held = f.store.acquireTurnLease("parent")
  if (!held) throw new Error("Expected the session's lease")
  let decided: ProviderTurnResult | undefined
  void brokers.get("parent")!.admitProviderTurn({ reason: "provider" }, async function* () {
    yield { event: { type: "finish", sessionId: "parent" } }
  }).then((result) => { decided = result })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(decided).toBeUndefined()
  const started = Date.now()
  await f.dispose()
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(decided).toEqual({ admitted: false, reason: "closed" })
})
