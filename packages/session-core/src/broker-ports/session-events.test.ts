import { testSessionCore } from "../../../workspace-runtime/src/test-support/session-core"
const testPlacement = testSessionCore("/workspace", "ws-events-test").placement
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { createBus, type WorkspaceRuntimeEvent } from "../bus"
import { createRuntimeEventHub } from "../projection/runtime-event-hub"
import { workspaceEventsHandler } from "../routes/events"
import { openRuntimeStore } from "../../../workspace-runtime/src/store-file"
import { createStoreBrokerPorts } from "./index"

test("one broker subagent update commits once and reaches SSE once", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "subagent-delivery-"))
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
    placement: testPlacement,
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
    rmSync(root, { recursive: true, force: true })
  }
})
