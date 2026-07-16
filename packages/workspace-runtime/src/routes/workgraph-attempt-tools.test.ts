import { createChangeCursor } from "@claxedo/workgraph/contracts"
import { afterEach, describe, expect, it } from "vitest"
import { WorkGraphAttemptToolRoutes } from "./workgraph-attempt-tools"

const handles: Array<{ dispose(): void }> = []
afterEach(() => handles.splice(0).forEach((handle) => handle.dispose()))

describe("WorkGraph Attempt tools", () => {
  it("injects the bound Attempt identity and derives idempotency from the tool call", async () => {
    const operations: unknown[] = []
    let registration: { sessionId: string; callbackUrl: string; tools: Array<{ name: string }> } | undefined
    const app = WorkGraphAttemptToolRoutes({
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
    const bound = await app.request("/api/workgraph/attempt-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: {
          attemptId: "attempt-1",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          leaseEpoch: 4,
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
      identity: { attemptId: "attempt-1", sessionId: "session-1", workspaceId: "workspace-1", leaseEpoch: 4 },
      operation: {
        type: "record_checkpoint",
        operationId: "attempt_tool_attempt-1_call-progress",
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
      identity: { attemptId: "attempt-1", sessionId: "session-1" },
      operation: { type: "complete", operationId: "attempt_tool_attempt-1_call-complete" },
    })
    expect(JSON.stringify(operations)).not.toContain("streamId")
    expect(JSON.stringify(operations)).not.toContain("workItemId")
  })

  it("rejects a callback that claims another Session", async () => {
    let callbackUrl = ""
    const app = WorkGraphAttemptToolRoutes({
      workspaceId: "workspace-1",
      broker: async () => { throw new Error("must not execute") },
      registerSessionTools: async (input) => { callbackUrl = input.callbackUrl },
    })
    handles.push(app)
    await app.request("/api/workgraph/attempt-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: { attemptId: "attempt-1", sessionId: "session-1", workspaceId: "workspace-1" },
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
    const app = WorkGraphAttemptToolRoutes({
      workspaceId: "workspace-1",
      broker: async () => { throw new Error("must not execute") },
      registerSessionTools: async () => undefined,
    })
    handles.push(app)
    const response = await app.request("/api/workgraph/attempt-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: { attemptId: "attempt-1", sessionId: "session-1", workspaceId: "workspace-1" },
        brokerUrl: "not a URL",
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "attempt_binding_broker_invalid" } })
  })

  it("bounds remote broker responses while streaming", async () => {
    let callbackUrl = ""
    let brokerAuthorization: string | null = null
    const app = WorkGraphAttemptToolRoutes({
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
    const bound = await app.request("/api/workgraph/attempt-binding", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer relay-host-token",
        "x-claxedo-workgraph-broker-token": "runtime-token",
      },
      body: JSON.stringify({
        version: 1,
        identity: { attemptId: "attempt-1", sessionId: "session-1", workspaceId: "workspace-1" },
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
    expect(await response.json()).toMatchObject({ error: { code: "attempt_operation_failed" } })
  })
})
