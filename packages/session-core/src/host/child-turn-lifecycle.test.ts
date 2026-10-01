import { expect, test } from "bun:test"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import { FakeTransport } from "../../../workspace-runtime/src/test-support/fake-transport"
import { createHostFixture, controlledTurn, sessionCreate, until, submittedOperation, LOOPBACK_ORIGIN, RECOVERY_TEST_CALLER, type HostFixture } from "../../../workspace-runtime/src/test-support/host-fixture"

const observation = (id: string, mode: "foreground" | "background" = "foreground"): SubagentObservation => ({
  observationId: id, providerId: id, providerKind: "test", status: "running", mode, transcript: { kind: "messages" },
})

async function fixture() {
  const control = controlledTurn("parent")
  const transport = new FakeTransport({ turn: () => control.events })
  const f = createHostFixture({ transports: { pi: transport } })
  await f.runtime.sessions.create(sessionCreate({ id: "parent" }))
  await f.runtime.turns.start({ sessionId: "parent", text: "work", origin: LOOPBACK_ORIGIN })
  await until(() => transport.turns.length === 1)
  return { ...f, transport, control, broker: transport.turns[0].broker }
}

test("child admission owns its own lease and terminal replay releases it exactly once", async () => {
  const f = await fixture()
  try {
    const parentLease = f.store.readTurnAuthority("parent")?.leaseId
    const child = await f.broker.observeSubagent(observation("child"))
    expect(child).toBeDefined()
    const childLease = f.store.readTurnAuthority(child!.sessionId)?.leaseId
    expect(childLease).toBeString()
    expect(childLease).not.toBe(parentLease)
    expect(f.store.readTurnAuthority("parent")?.leaseId).toBe(parentLease)
    const ending = { ...observation("child"), observationId: "end", status: "completed" as const }
    await f.broker.observeSubagent(ending)
    expect(f.store.readTurnAuthority(child!.sessionId)).toBeUndefined()
    const messages = f.store.getMessages(child!.sessionId)
    await f.broker.observeSubagent(ending)
    expect(f.store.getMessages(child!.sessionId)).toEqual(messages)
    expect(f.store.readTurnAuthority("parent")?.leaseId).toBe(parentLease)
  } finally { f.control.finish(); await f.dispose() }
})

test("a child whose turn cannot start releases its own lease", async () => {
  const f = await fixture()
  const original = f.store.startTurn.bind(f.store)
  let childId: string | undefined
  f.store.startTurn = (input) => { childId = input.sessionId; throw new Error("journal unavailable") }
  try {
    await expect(f.broker.observeSubagent(observation("child"))).rejects.toThrow("journal unavailable")
    expect(childId).toBeString()
    expect(f.store.readTurnAuthority(childId!)).toBeUndefined()
  } finally { f.store.startTurn = original; f.control.finish(); await f.dispose() }
})

test("a stale child terminal cannot release a replacement generation", async () => {
  const f = await fixture()
  try {
    const child = await f.broker.observeSubagent(observation("child"))
    const oldLease = f.store.readTurnAuthority(child!.sessionId)!.leaseId
    f.store.releaseTurnLease(child!.sessionId, oldLease)
    const replacement = f.store.acquireTurnLease(child!.sessionId)!
    await expect(f.broker.observeSubagent({ ...observation("child"), observationId: "late", status: "completed" })).rejects.toThrow()
    expect(f.store.readTurnAuthority(child!.sessionId)?.leaseId).toBe(replacement)
    expect(f.store.getSession(child!.sessionId)?.status).toBe("busy")
    f.store.releaseTurnLease(child!.sessionId, replacement)
  } finally { f.control.finish(); await f.dispose() }
})

test("ending the parent interrupts only foreground children and preserves background work", async () => {
  const f = await fixture()
  try {
    const foreground = await f.broker.observeSubagent(observation("fg"))
    const background = await f.broker.observeSubagent(observation("bg", "background"))
    const backgroundLease = f.store.readTurnAuthority(background!.sessionId)?.leaseId
    f.control.finish()
    await f.runtime.dispose()
    expect(f.store.getSession(foreground!.sessionId)?.status).toBe("idle")
    expect(f.store.readTurnAuthority(foreground!.sessionId)).toBeUndefined()
    expect(f.store.getSession(background!.sessionId)?.status).toBe("busy")
    expect(f.store.readTurnAuthority(background!.sessionId)?.leaseId).toBe(backgroundLease)
  } finally { f.control.finish(); await f.dispose() }
})

test("a child whose lease is owned by another domain reports turn_authority_unavailable", async () => {
  const f = await fixture()
  try {
    const admitted = await f.runtime.subagents.admit("parent", observation("owned"))
    const lease = f.store.acquireTurnLease(admitted.childSessionId!)!
    const parentLease = f.store.readTurnAuthority("parent")?.leaseId
    await expect(f.broker.observeSubagent(observation("owned"))).rejects.toMatchObject({ code: "turn_authority_unavailable", sessionId: admitted.childSessionId })
    expect(f.store.readTurnAuthority(admitted.childSessionId!)?.leaseId).toBe(lease)
    expect(f.store.readTurnAuthority("parent")?.leaseId).toBe(parentLease)
    f.store.releaseTurnLease(admitted.childSessionId!, lease)
  } finally { f.control.finish(); await f.dispose() }
})

test("a foreground child its parent's end interrupted is admitted again by a later parent turn's new observation", async () => {
  const controls = [controlledTurn("parent"), controlledTurn("parent")]
  const transport = new FakeTransport({ turn: () => controls[transport.turns.length - 1].events })
  const f = createHostFixture({ transports: { pi: transport } })
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "parent" }))
    await f.runtime.turns.start({ sessionId: "parent", text: "first", origin: LOOPBACK_ORIGIN })
    await until(() => transport.turns.length === 1)
    const child = await transport.turns[0].broker.observeSubagent(observation("child"))
    const firstLease = f.store.readTurnAuthority(child!.sessionId)?.leaseId
    controls[0].finish()
    ;(await f.runtime.turns.whenIdle("parent")).abandon()
    expect(f.store.readTurnAuthority(child!.sessionId)).toBeUndefined()
    expect(subagentStatus(f, child!.sessionId)).toBe("running")
    await f.runtime.turns.start({ sessionId: "parent", text: "second", origin: LOOPBACK_ORIGIN })
    await until(() => transport.turns.length === 2)
    const again = await transport.turns[1].broker.observeSubagent({ ...observation("child"), observationId: "second-start" })
    expect(again?.sessionId).toBe(child!.sessionId)
    expect(again?.assistantMessageId).not.toBe(child!.assistantMessageId)
    expect(f.store.getSession(child!.sessionId)?.status).toBe("busy")
    expect(f.store.readTurnAuthority(child!.sessionId)?.leaseId).toBeString()
    expect(f.store.readTurnAuthority(child!.sessionId)?.leaseId).not.toBe(firstLease)
    expect(subagentStatus(f, child!.sessionId)).toBe("running")
    await transport.turns[1].broker.observeSubagent({ ...observation("child"), observationId: "second-end", status: "completed" })
    expectTwoFinishedTurns(f, child!.sessionId)
  } finally { for (const control of controls) control.finish(); await f.dispose() }
})

test("a child the store records as finished stays finished when its running observation is replayed or repeated", async () => {
  const f = await fixture()
  try {
    const child = await f.broker.observeSubagent(observation("child", "background"))
    await f.broker.observeSubagent({ ...observation("child", "background"), observationId: "end", status: "completed" })
    expect(f.store.readTurnAuthority(child!.sessionId)).toBeUndefined()
    const replay = await f.broker.observeSubagent(observation("child", "background"))
    const repeated = await f.broker.observeSubagent({ ...observation("child", "background"), observationId: "late-running" })
    expect(replay?.assistantMessageId).toBe(child!.assistantMessageId)
    expect(repeated?.assistantMessageId).toBe(child!.assistantMessageId)
    expect(f.store.getSession(child!.sessionId)?.status).toBe("idle")
    expect(f.store.readTurnAuthority(child!.sessionId)).toBeUndefined()
    expect(subagentStatus(f, child!.sessionId)).toBe("completed")
  } finally { f.control.finish(); await f.dispose() }
})

function subagentStatus(f: HostFixture, childSessionId: string) {
  return f.store.database().prepare<{ status: string }>("SELECT status FROM session_subagent WHERE child_session_id = ?").get(childSessionId)?.status
}

function expectTwoFinishedTurns(f: HostFixture, childSessionId: string) {
  const assistants = f.store.getMessages(childSessionId).filter((message) => message.info.role === "assistant")
  expect(new Set(assistants.map((message) => message.info.id)).size).toBe(2)
  expect(f.store.database().prepare<{ count: number }>(
    "SELECT COUNT(*) AS count FROM runtime_journal WHERE session_id = ? AND type = 'turn.finish'",
  ).get(childSessionId)?.count).toBe(2)
  expect(f.store.readTurnAuthority(childSessionId)).toBeUndefined()
  expect(f.store.getSession(childSessionId)?.status).toBe("idle")
}

test("a child terminal the store refuses keeps the child's lease until reconcile finishes it", async () => {
  const f = await fixture()
  const finish = f.store.finishTurn.bind(f.store)
  try {
    const child = await f.broker.observeSubagent(observation("refused", "background"))
    const leaseId = f.store.readTurnAuthority(child!.sessionId)?.leaseId
    f.store.finishTurn = (input) => {
      if (input.sessionId === child!.sessionId) throw new Error("child finish refused")
      return finish(input)
    }
    await expect(f.broker.observeSubagent({ ...observation("refused", "background"), observationId: "refused-end", status: "completed" }))
      .rejects.toThrow("child finish refused")
    f.store.finishTurn = finish
    expect(f.store.readTurnAuthority(child!.sessionId)?.leaseId).toBe(leaseId)
    expect(f.store.acquireTurnLease(child!.sessionId)).toBeUndefined()
    const inspection = f.runtime.recovery.inspect(child!.sessionId)
    expect(inspection.health).toMatchObject({ status: "degraded", reason: "persistence_unavailable" })
    const retained = inspection.failures.find((failure) => failure.code === "persistence_unavailable")
    const reconciled = submittedOperation(await f.runtime.recovery.submit({
      requestId: "reconcile-child", action: "reconcile_session", target: retained!.target, scopeRevision: "1", attempt: 1,
    }, RECOVERY_TEST_CALLER))
    expect(reconciled.state).toBe("succeeded")
    expect(f.store.getSession(child!.sessionId)?.lastTurn?.status).toBe("completed")
    expect(f.store.readTurnAuthority(child!.sessionId)).toBeUndefined()
    const next = f.store.acquireTurnLease(child!.sessionId)
    expect(next).toBeString()
    f.store.releaseTurnLease(child!.sessionId, next!)
  } finally { f.store.finishTurn = finish; f.control.finish(); await f.dispose() }
})

test("a host-minted child running its own turn is bound to the call that created it without a second turn", async () => {
  const f = await fixture()
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "host-child" }))
    await f.runtime.subagents.admit("parent", { observationId: "create", subagentKey: "subagent_host", status: "pending",
      providerKind: "claxedo", providerId: "host-child", childSessionId: "host-child", transcript: { kind: "live" } })
    const ownTurn = f.store.acquireTurnLease("host-child")!
    const bound = await f.broker.observeSubagent({ observationId: "codex:host-subagent:thread:call_1", harnessExecutionId: "thread",
      subagentKey: "subagent_host", toolCallId: "call_1", toolCallRole: "spawn", status: "running",
      providerId: "host-child", providerKind: "claxedo", childSessionId: "host-child", transcript: { kind: "live" } })
    expect(bound?.sessionId).toBe("host-child")
    expect(f.store.readTurnAuthority("host-child")?.leaseId).toBe(ownTurn)
    expect(f.store.getMessages("host-child")).toEqual([])
    f.store.releaseTurnLease("host-child", ownTurn)
  } finally { f.control.finish(); await f.dispose() }
})
