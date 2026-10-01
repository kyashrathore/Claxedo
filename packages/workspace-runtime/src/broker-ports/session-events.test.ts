import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequestBroker, createTurnBroker } from "@claxedo/harness/broker"
import { RuntimeStore } from "../store"
import { createRuntimeEventHub } from "../projection/runtime-event-hub"
import { BrokerBackgroundWork } from "./background-work"
import { BrokerEventDelivery } from "./delivery"
import { createStoreBrokerPorts } from "./index"
import { BrokerSessionEvents } from "./session-events"

const origin = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
const opened: { store: RuntimeStore; root: string }[] = []

afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.store.close()
    fs.rmSync(entry.root, { recursive: true, force: true })
  }
})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-events-"))
  const store = new RuntimeStore(root)
  opened.push({ store, root })
  store.bindSession({ sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "c1",
    upstreamSessionId: "up1", agentSessionId: "up1", createdAt: 1 })
  store.updateSessionConfig("s1", { harness: { id: "claude", access: "native" }, agent: "general",
    model: { providerID: "anthropic", modelID: "test" } })
  if (!store.acquireTurnLease("s1")) throw new Error("Expected turn lease")
  store.startTurn({ sessionId: "s1", assistantMessageId: "t1", agent: "general", model: { providerID: "anthropic", modelID: "test" }, parts: [] })
  const publishers = createRuntimeEventHub()
  const ports = createStoreBrokerPorts(store, { ownerGeneration: "g1", patternEvaluator: async () => {}, publishers,
    reportOwnerFailure: (_sessionId, error) => { throw error }, retainLeasedTurnFailure: (_sessionId, _turn, error) => { throw error } })
  const authority = ports.currentTurnAuthority("s1")
  if (!authority) throw new Error("Expected turn authority")
  const turn = createTurnBroker(createRequestBroker(ports), { authority, origin, signal: new AbortController().signal })
  const delivery = new BrokerEventDelivery(store, publishers)
  const events = new BrokerSessionEvents(store, delivery, new BrokerBackgroundWork(store, delivery))
  const rows = (sessionId: string) => store.brokerDatabase().prepare<{ type: string; payload_json: string }>(
    "SELECT type, payload_json FROM runtime_journal WHERE session_id = ? AND kind = 'event' ORDER BY seq").all(sessionId)
  return { store, ports, turn, events, rows }
}

const childText = (correlationKey: string) => ({ event: { type: "text-delta" as const, delta: "child output" },
  route: { kind: "child" as const, correlationKey } })

test("a child-routed event with no bound child is dropped with one diagnostic and never fails the provider turn", async () => {
  const { ports, rows } = setup()
  await ports.drainProviderEvent("s1", { turnId: "t1", assistantMessageId: "t1" }, childText("toolu_01STm6g5Pds1uf6iSBzu7sJb"))
  const diagnostics = rows("s1").filter((row) => row.type === "runtime.diagnostic").map((row) => JSON.parse(row.payload_json))
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0].properties.code).toBe("child_event_route_unbound")
  expect(diagnostics[0].properties.diagnostic.details).toEqual({ eventType: "text-delta", correlationKey: "toolu_01STm6g5Pds1uf6iSBzu7sJb" })
  expect(rows("s1").map((row) => row.type)).not.toContain("message.part.updated")
})

test("a child-routed event for a child whose turn finished is dropped with one diagnostic", async () => {
  const { store, ports, turn, rows } = setup()
  const child = await turn.observeSubagent({ observationId: "spawn", providerKind: "claude-agent", toolCallId: "toolu_agent",
    transcript: { kind: "messages" }, status: "running" })
  if (!child) throw new Error("Missing child session")
  turn.associateChild("toolu_agent", child)
  const leaseId = store.acquireTurnLease(child.sessionId)
  if (!leaseId) throw new Error("Expected child lease")
  store.startTurn({ sessionId: child.sessionId, assistantMessageId: child.assistantMessageId, agent: "general", parts: [] })
  store.finishTurn({ sessionId: child.sessionId, assistantMessageId: child.assistantMessageId, leaseId, outcome: { status: "completed", completedAt: 2 } })
  const before = rows(child.sessionId).length
  await ports.drainProviderEvent("s1", { turnId: "t1", assistantMessageId: "t1" }, childText("toolu_agent"))
  expect(rows(child.sessionId)).toHaveLength(before)
  const codes = rows("s1").filter((row) => row.type === "runtime.diagnostic").map((row) => JSON.parse(row.payload_json).properties.code)
  expect(codes).toEqual(["child_event_route_finished"])
})

test("a child-routed event that arrives while the parent has no turn reaches its bound child through the same resolver", async () => {
  const { turn, events, rows } = setup()
  const child = await turn.observeSubagent({ observationId: "spawn", providerKind: "claude-agent", toolCallId: "toolu_agent",
    transcript: { kind: "messages" }, status: "running", mode: "background" })
  if (!child) throw new Error("Missing child session")
  turn.associateChild("toolu_agent", child)
  await events.drainChildEvent("s1", childText("toolu_agent"))
  expect(rows(child.sessionId).map((row) => row.type)).toContain("message.part.updated")
  await events.drainChildEvent("s1", childText("toolu_unknown"))
  const codes = rows("s1").filter((row) => row.type === "runtime.diagnostic").map((row) => JSON.parse(row.payload_json).properties.code)
  expect(codes).toEqual(["child_event_route_unbound"])
})

test("outside reports retain their explicit execution owner and stable identity", async () => {
  const { store, events } = setup()
  const report = { type: "agent-message" as const, eventId: "handback-1", sender: "reviewer", message: "Report ready", senderTaskId: "task-1" }
  await events.publishSessionEvent("s1", report, "t1")
  await events.publishSessionEvent("s1", { ...report, eventId: "handback-2", message: "Second report" }, "t1")
  await events.publishSessionEvent("s1", report, "t1")
  const notices = store.getMessages("s1").flatMap((message) => message.parts).filter((part) => part.type === "notice")
  expect(notices).toHaveLength(2)
  expect(notices).toMatchObject([
    { messageID: "t1", notice: { kind: "agent-message", sender: "reviewer", message: "Report ready", senderTaskId: "task-1" } },
    { messageID: "t1", notice: { kind: "agent-message", message: "Second report" } },
  ])
  await expect(events.publishSessionEvent("s1", report, "foreign-message")).rejects.toThrow("does not belong")
})

test("outside completion notices have distinct stable part ids", async () => {
  const { store, events } = setup()
  for (const eventId of ["done-1", "done-2", "done-1"]) {
    await events.publishSessionEvent("s1", { type: "harness-notice", eventId, code: "claude_sdk.task_notification", message: eventId }, "t1")
  }
  expect(store.getMessages("s1").flatMap((message) => message.parts).filter((part) => part.type === "notice"))
    .toHaveLength(2)
})

test("replayed peer reports keep their persisted owner after continuation and broker recreation", async () => {
  const { store, events, ports } = setup()
  const report = { type: "agent-message" as const, eventId: "peer-uuid", sender: "reviewer", message: "Report ready" }
  await events.publishSessionEvent("s1", report, "t1")
  store.startTurn({ sessionId: "s1", assistantMessageId: "t2", agent: "general", parts: [] })
  const delivery = new BrokerEventDelivery(store, createRuntimeEventHub())
  const recreated = new BrokerSessionEvents(store, delivery, new BrokerBackgroundWork(store, delivery))
  await recreated.publishSessionEvent("s1", report, "t2")
  await ports.drainProviderEvent("s1", { turnId: "t2", assistantMessageId: "t2" }, { event: report })
  const notices = store.getMessages("s1").flatMap((message) => message.parts).filter((part) => part.type === "notice")
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ messageID: "t1", notice: { kind: "agent-message", message: "Report ready" } })
})
