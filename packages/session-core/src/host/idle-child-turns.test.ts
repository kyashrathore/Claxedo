import { expect, test } from "bun:test"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { RequestAnswer, SessionBroker } from "@claxedo/harness/contract"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, until, LOOPBACK_ORIGIN } from "../test-support/host-fixture"

const observation = (toolCallId: string, status: SubagentObservation["status"] = "running"): SubagentObservation => ({
  observationId: `${toolCallId}:${status}`, providerId: toolCallId, providerKind: "codex", toolCallId, toolCallRole: "spawn",
  status, mode: "background", transcript: { kind: "live" },
})

async function idleParent() {
  const brokers = new Map<string, SessionBroker>()
  const transport = new FakeTransport({ beforeStart: async (input, broker) => { brokers.set(input.sessionId, broker) } })
  const f = createHostFixture({ transports: { pi: transport } })
  await f.runtime.sessions.create({ ...sessionCreate({ id: "parent" }), agent: "build", model: { providerID: "test", modelID: "session-model" } })
  await f.runtime.turns.start({ sessionId: "parent", text: "hello", origin: LOOPBACK_ORIGIN })
  ;(await f.runtime.turns.whenIdle("parent")).abandon()
  return { f, session: brokers.get("parent")! }
}

test("a child that opens while its parent is idle runs its own turn on the session's model, owns its requests, and settles from its terminal", async () => {
  const { f, session } = await idleParent()
  try {
    const child = await session.observeSubagent(observation("thread-child"))
    session.associateChild("thread-child", child!)
    expect(f.store.turnEvidence(child!.sessionId, child!.assistantMessageId)).toMatchObject({ started: true, finished: false })
    expect(f.store.getSession(child!.sessionId)?.status).toBe("busy")
    const started = f.store.database().prepare<{ payload_json: string }>(
      "SELECT payload_json FROM runtime_journal WHERE session_id = ? AND kind = 'control' AND type = 'turn.start'").get(child!.sessionId)
    expect(JSON.parse(started!.payload_json).model).toEqual({ providerID: "test", modelID: "session-model" })

    const answers: RequestAnswer[] = []
    void session.ask({ kind: "question", requestId: "idle-question", child: { correlationKey: "thread-child" },
      question: { id: "idle-question", sessionID: "parent", questions: [{ header: "Go", question: "Continue?", options: [] }] } })
      .then((answer) => { answers.push(answer) })
    await until(() => f.store.listQuestions("/repo").length === 1, "child question filed")
    expect(f.store.listQuestions("/repo")[0]?.sessionID).toBe(child!.sessionId)

    await session.observeSubagent(observation("thread-child", "completed"))
    await until(() => answers.length === 1, "child question cancelled")
    expect(answers).toEqual([{ kind: "cancelled" }])
    expect(f.store.turnEvidence(child!.sessionId, child!.assistantMessageId)).toMatchObject({ started: true, finished: true })
    expect(f.store.getSession(child!.sessionId)?.lastTurn?.status).toBe("completed")
    expect(f.store.readTurnAuthority(child!.sessionId)).toBeUndefined()
  } finally { await f.dispose() }
})

test("a finished child that a later message wakes while its parent is idle opens and settles a new turn", async () => {
  const { f, session } = await idleParent()
  try {
    const first = await session.observeSubagent(observation("thread-child"))
    session.associateChild("thread-child", first!)
    await session.observeSubagent(observation("thread-child", "completed"))
    const woken = await session.observeSubagent({ ...observation("thread-child"), observationId: "woken", toolCallId: "turn-2" })
    expect(woken!.sessionId).toBe(first!.sessionId)
    expect(woken!.assistantMessageId).not.toBe(first!.assistantMessageId)
    expect(f.store.turnEvidence(woken!.sessionId, woken!.assistantMessageId)).toMatchObject({ started: true, finished: false })
    await session.observeSubagent({ ...observation("thread-child", "completed"), observationId: "woken-done", toolCallId: "turn-2" })
    expect(f.store.turnEvidence(woken!.sessionId, woken!.assistantMessageId)).toMatchObject({ started: true, finished: true })
    expect(f.store.readTurnAuthority(woken!.sessionId)).toBeUndefined()
  } finally { await f.dispose() }
})

test("a background child that finishes while its parent is idle publishes its own idle", async () => {
  const { f, session } = await idleParent()
  try {
    const child = await session.observeSubagent(observation("thread-child"))
    session.associateChild("thread-child", child!)
    const idled: string[] = []
    const unsubscribe = f.eventHub.subscribeGlobal(({ payload }) => {
      if (payload.type === "session.idle") idled.push(payload.properties.sessionID)
    })
    try {
      await session.observeSubagent(observation("thread-child", "completed"))
      expect(idled).toEqual([child!.sessionId])
    } finally { unsubscribe() }
  } finally { await f.dispose() }
})

test("a child whose own stream finished its reply while its parent is idle settles without a second idle", async () => {
  const { f, session } = await idleParent()
  try {
    const child = await session.observeSubagent(observation("thread-child"))
    session.associateChild("thread-child", child!)
    const idled: string[] = []
    const unsubscribe = f.eventHub.subscribeGlobal(({ payload }) => {
      if (payload.type === "session.idle") idled.push(payload.properties.sessionID)
    })
    try {
      await session.publishChild({ event: { type: "finish", sessionId: child!.sessionId }, route: { kind: "child", correlationKey: "thread-child" } })
      await session.observeSubagent(observation("thread-child", "completed"))
      expect(idled).toEqual([child!.sessionId])
      expect(f.store.getSession(child!.sessionId)?.lastTurn?.status).toBe("completed")
    } finally { unsubscribe() }
  } finally { await f.dispose() }
})
