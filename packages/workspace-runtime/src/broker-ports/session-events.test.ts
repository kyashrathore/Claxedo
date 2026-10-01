import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequestBroker, createTurnBroker } from "@claxedo/harness/broker"
import { Hono } from "hono"
import { createBus, type WorkspaceRuntimeEvent } from "../bus"
import type { RuntimeStore } from "../store"
import { openRuntimeStore } from "../store-file"
import { createRuntimeEventHub } from "../projection/runtime-event-hub"
import { workspaceEventsHandler } from "../routes/events"
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
  const store = openRuntimeStore(root)
  opened.push({ store, root })
  store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "c1",
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
  const rows = (sessionId: string) => store.database().prepare<{ type: string; payload_json: string }>(
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

test("one broker subagent update commits once and reaches SSE once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-delivery-"))
  const store = openRuntimeStore(root)
  const controller = new AbortController()
  let handler: ReturnType<typeof workspaceEventsHandler> | undefined
  try {
    store.bindSession({
      owner: { kind: "machine-owner" }, sessionId: "parent", workspaceId: "workspace",
      directory: "/work", connectionId: "connection", upstreamSessionId: "upstream",
      agentSessionId: "upstream", createdAt: 1,
    })
    const hub = createRuntimeEventHub()
    const ports = createStoreBrokerPorts(store, {
      ownerGeneration: "generation", patternEvaluator: async () => {}, publishers: hub,
      reportOwnerFailure: (_sessionId, error) => { throw error },
      retainLeasedTurnFailure: (_sessionId, _turn, error) => { throw error },
    })
    handler = workspaceEventsHandler({
      directory: "/work", workspaceId: "workspace", eventHub: hub,
      bus: createBus<WorkspaceRuntimeEvent>(), sequenceOrigin: () => 0,
    })
    const app = new Hono().get("/events", handler)
    const response = await app.request("http://localhost/events", { signal: controller.signal })
    expect(response.status).toBe(200)
    const raw: unknown[] = []
    const unsubscribe = hub.subscribeRuntime((event) => raw.push(event.payload))
    const update = { type: "subagent-updated" as const, subagentKey: "child", revision: 1, status: "running" as const }
    const ordinal = store.getSessionMaxSeq("parent")
    await ports.publishSubagent("parent", update)
    hub.publishGlobal({ directory: "/work", payload: { type: "session.commands", properties: { sessionID: "parent", commands: [] } } })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let wire = ""
    while (!wire.includes("session.commands")) {
      const next = await reader.read()
      if (next.done) break
      wire += decoder.decode(next.value, { stream: true })
    }
    controller.abort()
    unsubscribe()
    const frames = wire.split("\n\n").flatMap((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data:"))
      return data ? [JSON.parse(data.slice(5))] : []
    })
    expect(raw).toEqual([update])
    expect(store.getSessionMaxSeq("parent")).toBe(ordinal + 1)
    expect(frames.filter((frame) => frame.payload?.type === "subagent.updated")).toHaveLength(1)
  } finally {
    controller.abort()
    handler?.close()
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
