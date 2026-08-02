import { createChangeCursor } from "@claxedo/workgraph/contracts"
import { afterEach, describe, expect, it } from "bun:test"
import { WorkGraphRunToolRoutes } from "./workgraph-run-tools"

const handles: Array<{ dispose(): void }> = []
afterEach(() => handles.splice(0).forEach((handle) => handle.dispose()))

describe("WorkGraph Run tools", () => {
  it("injects the bound Run identity and derives idempotency from the tool call", async () => {
    const operations: unknown[] = []
    let registration: { sessionId: string; callbackUrl: string; tools: Array<{ name: string }> } | undefined
    const app = WorkGraphRunToolRoutes({
      workspaceId: "workspace-1",
      broker: async (request) => {
        operations.push(request)
        return {
          ok: true,
          operationId: request.operation.operationId,
          cursor: createChangeCursor({ organizationId: "org", ownerUserId: "owner", position: operations.length }),
          value: { recorded: true },
        }
      },
      registerSessionTools: async (input) => { registration = input },
    })
    handles.push(app)
    const bound = await app.request("/api/workgraph/run-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: {
          runId: "run-1",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          generation: 4,
        },
        runtimeSessionId: "runtime-session-1",
        brokerUrl: "http://127.0.0.1",
      }),
    })
    expect(bound.status).toBe(200)
    expect(registration?.tools.map((tool) => tool.name)).toEqual([
      "workgraph_report_progress",
      "workgraph_complete_task",
    ])
    expect(registration?.sessionId).toBe("runtime-session-1")

    const progress = await fetch(registration!.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "runtime-session-1",
        name: "workgraph_report_progress",
        toolCallID: "call-progress",
        input: { level: "progress", summary: "Validated persistence" },
      }),
    })
    expect(progress.status).toBe(200)
    expect(operations[0]).toMatchObject({
      identity: { runId: "run-1", sessionId: "session-1", workspaceId: "workspace-1", generation: 4 },
      operation: {
        type: "record_checkpoint",
        operationId: "run_tool_run-1_call-progress",
        summary: "Validated persistence",
      },
    })

    const completed = await fetch(registration!.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "runtime-session-1",
        name: "workgraph_complete_task",
        toolCallID: "call-complete",
        input: {
          summary: "Implemented and verified",
          evidence: [{
            requirementId: "tests",
            evidence: { kind: "test_result", summary: "Tests pass", passed: true },
          }],
        },
      }),
    })
    expect(completed.status).toBe(200)
    expect(operations[1]).toMatchObject({
      identity: { runId: "run-1", sessionId: "session-1" },
      operation: { type: "complete", operationId: "run_tool_run-1_call-complete" },
    })
    expect(JSON.stringify(operations)).not.toContain("streamId")
    expect(JSON.stringify(operations)).not.toContain("workItemId")
  })

  it("registers only the structured notes tool for an exact master binding", async () => {
    let registration: { callbackUrl: string; tools: Array<{ name: string }> } | undefined
    let operation: unknown
    const app = WorkGraphRunToolRoutes({
      workspaceId: "workspace-1",
      broker: async (request) => {
        operation = request
        return {
          ok: true,
          operationId: request.operation.operationId,
          cursor: createChangeCursor({ organizationId: "org", ownerUserId: "owner", position: 1 }),
          value: { recorded: true },
        }
      },
      registerSessionTools: async (input) => { registration = input },
    })
    handles.push(app)
    const streamId = "stream-1"
    await app.request("/api/workgraph/run-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: { runId: `master_${streamId}`, streamId, sessionId: `ses_master_${streamId}`, workspaceId: "workspace-1", generation: 1 },
        tools: ["workgraph_update_stream_notes"],
        brokerUrl: "http://127.0.0.1",
      }),
    })
    expect(registration?.tools.map((tool) => tool.name)).toEqual(["workgraph_update_stream_notes"])
    const response = await fetch(registration!.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: `ses_master_${streamId}`,
        name: "workgraph_update_stream_notes",
        toolCallID: "notes-1",
        input: { status: ["Ready"], learnings: [], externalReferences: [] },
      }),
    })
    expect(response.status).toBe(200)
    expect(operation).toMatchObject({
      identity: { runId: `master_${streamId}`, streamId, sessionId: `ses_master_${streamId}` },
      operation: { type: "update_stream_notes", status: ["Ready"] },
    })
  })

  it("rejects a callback that claims another Session", async () => {
    let callbackUrl = ""
    const app = WorkGraphRunToolRoutes({
      workspaceId: "workspace-1",
      broker: async () => { throw new Error("must not execute") },
      registerSessionTools: async (input) => { callbackUrl = input.callbackUrl },
    })
    handles.push(app)
    await app.request("/api/workgraph/run-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: { runId: "run-1", sessionId: "session-1", workspaceId: "workspace-1", generation: 1 },
        brokerUrl: "http://127.0.0.1",
      }),
    })
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-2",
        name: "workgraph_report_progress",
        toolCallID: "call-1",
        input: { level: "progress", summary: "Wrong Session" },
      }),
    })
    expect(response.status).toBe(403)
  })

  it("rejects malformed broker origins without escaping a raw URL error", async () => {
    const app = WorkGraphRunToolRoutes({
      workspaceId: "workspace-1",
      broker: async () => { throw new Error("must not execute") },
      registerSessionTools: async () => undefined,
    })
    handles.push(app)
    const response = await app.request("/api/workgraph/run-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: { runId: "run-1", sessionId: "session-1", workspaceId: "workspace-1", generation: 1 },
        brokerUrl: "not a URL",
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "run_binding_broker_invalid" } })
  })

  it("bounds remote broker responses while streaming", async () => {
    let callbackUrl = ""
    let brokerAuthorization = null as string | null
    const app = WorkGraphRunToolRoutes({
      workspaceId: "workspace-1",
      brokerOrigin: "https://central.test",
      maxResponseBytes: 1_024,
      fetch: async (_input, init) => {
        brokerAuthorization = new Headers(init?.headers).get("authorization")
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(800))
            controller.enqueue(new Uint8Array(800))
            controller.close()
          },
        }))
      },
      registerSessionTools: async (input) => { callbackUrl = input.callbackUrl },
    })
    handles.push(app)
    const bound = await app.request("/api/workgraph/run-binding", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer relay-host-token",
        "x-claxedo-workgraph-broker-token": "runtime-token",
      },
      body: JSON.stringify({
        version: 1,
        identity: { runId: "run-1", sessionId: "session-1", workspaceId: "workspace-1", generation: 1 },
        brokerUrl: "https://central.test/path-is-ignored",
      }),
    })
    expect(bound.status).toBe(200)
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-1",
        name: "workgraph_report_progress",
        toolCallID: "call-1",
        input: { level: "progress", summary: "Boundary" },
      }),
    })
    expect(response.status).toBe(502)
    expect(brokerAuthorization).toBe("Bearer runtime-token")
    expect(await response.json()).toMatchObject({ error: { code: "run_operation_failed" } })
  })
})
