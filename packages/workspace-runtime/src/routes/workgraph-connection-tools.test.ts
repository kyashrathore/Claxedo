import { describe, expect, test } from "bun:test"
import { WorkGraphConnectionToolRoutes } from "./workgraph-connection-tools"
import { createWorkspaceRuntimeApp } from "../server"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"

const binding = {
  version: 1,
  identity: { attemptId: "attempt-1", sessionId: "session-1", workspaceId: "workspace-1" },
  connectionIds: ["connection-1"],
  tools: ["connection_work_source_list", "connection_work_source_comment", "connection_work_source_update"],
  brokerUrl: "https://central.test",
} as const

describe("WorkGraph Connection tools", () => {
  test("is mounted by the workspace runtime with the trusted local broker seam", async () => {
    let callbackUrl = ""
    const runtime = createWorkspaceRuntimeApp({
      exposure: loopbackWorkspaceRuntimeExposure(),
      target: { workspaceId: "workspace-1", directory: process.cwd() },
      workgraphConnectionBroker: async () => ({ type: "update", ok: true }),
      opencodeRequest: async (request) => {
        if (new URL(request.url).pathname.endsWith("/tool") && request.method === "POST") {
          callbackUrl = String((await request.json() as { callbackUrl?: string }).callbackUrl)
        }
        return new Response(null, { status: 204 })
      },
    })
    try {
      const response = await runtime.app.request("/api/workgraph/connection-binding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(binding),
      })
      expect(response.status).toBe(200)
      expect(callbackUrl).toStartWith("http://127.0.0.1:")
    } finally {
      runtime.dispose()
    }
    await expect(fetch(callbackUrl)).rejects.toThrow()
  })

  test("requires a RAT for HTTP broker bindings and forwards identity without provider credentials", async () => {
    const forwarded: Array<{ url: string; authorization: string | null; body: unknown }> = []
    let registration: { callbackUrl: string } | undefined
    const app = WorkGraphConnectionToolRoutes({
      workspaceId: "workspace-1",
      brokerOrigin: "https://central.test",
      registerSessionTools: async (input) => { registration = input },
      fetch: async (input, init) => {
        forwarded.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        })
        return Response.json({
          type: "list",
          issues: [{ externalId: "42", title: "Fix", body: "Details", status: "open", updatedAt: 1_783_900_800_000 }],
        })
      },
    })
    expect((await app.request("/api/workgraph/connection-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(binding),
    })).status).toBe(401)
    expect((await app.request("/api/workgraph/connection-binding", {
      method: "POST",
      headers: {
        authorization: "Bearer relay-host-token",
        "content-type": "application/json",
        "x-claxedo-workgraph-broker-token": "rat-secret",
      },
      body: JSON.stringify(binding),
    })).status).toBe(200)

    const response = await invokeCallback(registration!.callbackUrl, {
      connectionId: "connection-1",
      providerUserId: "octocat",
      filters: { assigned: "true" },
    })
    expect(response.status).toBe(200)
    expect(forwarded).toEqual([{
      url: "https://central.test/internal/workgraph/connection-operation",
      authorization: "Bearer rat-secret",
      body: {
        version: 1,
        identity: {
          attemptId: "attempt-1",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          connectionId: "connection-1",
        },
        operation: { type: "list", providerUserId: "octocat", filters: { assigned: "true" } },
      },
    }])
    expect(JSON.stringify(forwarded[0]?.body)).not.toContain("rat-secret")
    expect(JSON.stringify(await response.json())).not.toMatch(/token|authorization/i)
    app.dispose()
  })

  test("uses an injected trusted broker for local composition without HTTP credentials", async () => {
    const calls: unknown[] = []
    let registration: { callbackUrl: string } | undefined
    const app = WorkGraphConnectionToolRoutes({
      workspaceId: "workspace-1",
      registerSessionTools: async (input) => { registration = input },
      broker: async (request) => {
        calls.push(request)
        return { type: "comment", ok: true }
      },
    })
    expect((await app.request("/api/workgraph/connection-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(binding),
    })).status).toBe(200)
    const response = await invokeCallback(registration!.callbackUrl, {
      connectionId: "connection-1",
      externalId: "42",
      body: "Shipped",
      idempotencyKey: "comment-1",
    }, "connection_work_source_comment")
    expect(response.status).toBe(200)
    expect(calls).toEqual([{
      version: 1,
      identity: {
        attemptId: "attempt-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        connectionId: "connection-1",
      },
      operation: { type: "comment", externalId: "42", body: "Shipped", idempotencyKey: "comment-1" },
    }])
    app.dispose()
  })

  test("propagates a strictly validated central broker error with its HTTP status", async () => {
    const response = await requestThroughHttpBroker(async () => Response.json({
      error: {
        code: "connection_provider_rate_limited",
        message: "Connection provider rate limit was reached",
        retryable: true,
      },
    }, { status: 429 }))

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: {
        code: "connection_provider_rate_limited",
        message: "Connection provider rate limit was reached",
        retryable: true,
      },
    })

    const redacted = await requestThroughHttpBroker(async () => Response.json({
      error: {
        code: "connection_provider_rate_limited",
        message: "provider response contained secret-live-token",
        retryable: true,
      },
    }, { status: 429 }))
    expect(redacted.status).toBe(429)
    expect(await redacted.json()).toEqual({
      error: {
        code: "connection_provider_rate_limited",
        message: "Connection provider rate limit was reached",
        retryable: true,
      },
    })
  })

  test("sanitizes malformed central broker errors and transport failures", async () => {
    const malformed = await requestThroughHttpBroker(async () => Response.json({
      error: {
        code: "provider_denied",
        message: "Sensitive provider detail",
        retryable: false,
        details: "must not cross the runtime boundary",
      },
    }, { status: 403 }))
    expect(malformed.status).toBe(502)
    expect(await malformed.json()).toEqual({
      error: { code: "connection_operation_failed", message: "Connection operation failed" },
    })

    const invalidJson = await requestThroughHttpBroker(async () => new Response("not-json", { status: 503 }))
    expect(invalidJson.status).toBe(502)
    expect(await invalidJson.json()).toEqual({
      error: { code: "connection_operation_failed", message: "Connection operation failed" },
    })

    const transport = await requestThroughHttpBroker(async () => {
      throw new Error("secret transport detail")
    })
    expect(transport.status).toBe(502)
    expect(await transport.json()).toEqual({
      error: { code: "connection_operation_failed", message: "Connection operation failed" },
    })
  })

  test("injects canonical Session identity into Core tool callbacks", async () => {
    const calls: unknown[] = []
    let registration: { sessionId: string; callbackUrl: string; tools: Array<{ name: string; inputSchema: Record<string, unknown> }> } | undefined
    const app = WorkGraphConnectionToolRoutes({
      workspaceId: "workspace-1",
      broker: async (request) => {
        calls.push(request)
        return { type: "comment", ok: true }
      },
      registerSessionTools: async (input) => { registration = input },
    })
    expect((await app.request("/api/workgraph/connection-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...binding, tools: ["connection_work_source_comment"] }),
    })).status).toBe(200)
    expect(registration?.tools[0]?.inputSchema.properties).not.toHaveProperty("sessionId")

    expect((await app.request("/api/workgraph/tools/connection_work_source_comment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        connectionId: "connection-1",
        externalId: "42",
        body: "Bypass",
        idempotencyKey: "bypass",
      }),
    })).status).toBe(404)

    const response = await fetch(registration!.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-1",
        name: "connection_work_source_comment",
        toolCallID: "call-1",
        input: { connectionId: "connection-1", externalId: "42", body: "Done", idempotencyKey: "once" },
      }),
    })
    expect(response.status).toBe(200)
    expect(calls).toEqual([{
      version: 1,
      identity: {
        attemptId: "attempt-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        connectionId: "connection-1",
      },
      operation: { type: "comment", externalId: "42", body: "Done", idempotencyKey: "once" },
    }])
    expect((await app.request("/api/workgraph/connection-binding/session-1", { method: "DELETE" })).status).toBe(200)
  })

  test("denies a callback that selects another bound Session", async () => {
    const registrations = new Map<string, string>()
    const calls: unknown[] = []
    const app = WorkGraphConnectionToolRoutes({
      workspaceId: "workspace-1",
      broker: async (request) => {
        calls.push(request)
        return { type: "comment", ok: true }
      },
      registerSessionTools: async (input) => { registrations.set(input.sessionId, input.callbackUrl) },
    })
    for (const [sessionId, attemptId] of [["session-1", "attempt-1"], ["session-2", "attempt-2"]]) {
      expect((await app.request("/api/workgraph/connection-binding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...binding,
          identity: { ...binding.identity, sessionId, attemptId },
          tools: ["connection_work_source_comment"],
        }),
      })).status).toBe(200)
    }

    const response = await fetch(registrations.get("session-1")!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-2",
        name: "connection_work_source_comment",
        toolCallID: "call-cross-session",
        input: { connectionId: "connection-1", externalId: "42", body: "Bypass", idempotencyKey: "cross-session" },
      }),
    })
    expect(response.status).toBe(403)
    expect(calls).toEqual([])
    app.dispose()
  })

  test("rejects an untrusted broker origin before any outbound request", async () => {
    let requested = false
    const app = WorkGraphConnectionToolRoutes({
      workspaceId: "workspace-1",
      brokerOrigin: "https://central.test",
      registerSessionTools: async () => undefined,
      fetch: async () => {
        requested = true
        return Response.json({ type: "update", ok: true })
      },
    })
    const response = await app.request("/api/workgraph/connection-binding", {
      method: "POST",
      headers: { authorization: "Bearer rat-secret", "content-type": "application/json" },
      body: JSON.stringify({ ...binding, brokerUrl: "http://169.254.169.254/latest/meta-data" }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: "connection_binding_broker_mismatch",
        message: "Connection broker does not match the trusted central origin",
      },
    })
    expect(requested).toBe(false)
    app.dispose()
  })

  test("bounds central broker time and response size", async () => {
    const timedOut = await requestThroughHttpBroker(async (_input, init) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
      return Response.json({ type: "list", issues: [] })
    }, { timeoutMs: 5, maxResponseBytes: 1024 })
    expect(timedOut.status).toBe(502)
    expect(await timedOut.json()).toEqual({
      error: { code: "connection_operation_failed", message: "Connection operation failed" },
    })

    const oversized = await requestThroughHttpBroker(async () => new Response(JSON.stringify({
      type: "list",
      issues: [],
      padding: "x".repeat(128),
    }), { headers: { "content-type": "application/json" } }), { timeoutMs: 1_000, maxResponseBytes: 64 })
    expect(oversized.status).toBe(502)
    expect(await oversized.json()).toEqual({
      error: { code: "connection_operation_failed", message: "Connection operation failed" },
    })
  })

  test("fails closed for workspace mismatch, ambiguous rebinding, and unbound tools or Connections", async () => {
    let registration: { callbackUrl: string } | undefined
    const app = WorkGraphConnectionToolRoutes({
      workspaceId: "workspace-1",
      registerSessionTools: async (input) => { registration = input },
      broker: async () => ({ type: "update", ok: true }),
    })
    expect((await app.request("/api/workgraph/connection-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...binding, identity: { ...binding.identity, workspaceId: "workspace-2" } }),
    })).status).toBe(403)
    expect((await app.request("/api/workgraph/connection-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...binding, tools: ["connection_work_source_list"] }),
    })).status).toBe(200)
    expect((await app.request("/api/workgraph/connection-binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...binding, identity: { ...binding.identity, attemptId: "attempt-2" } }),
    })).status).toBe(409)
    expect((await invokeCallback(registration!.callbackUrl, {
      connectionId: "connection-1",
      externalId: "42",
      status: "done",
      idempotencyKey: "update-1",
    }, "connection_work_source_update")).status).toBe(403)
    expect((await invokeCallback(registration!.callbackUrl, {
      connectionId: "connection-2",
      providerUserId: "octocat",
      filters: {},
    })).status).toBe(403)
    app.dispose()
  })
})

async function requestThroughHttpBroker(
  request: typeof fetch,
  limits = { timeoutMs: 1_000, maxResponseBytes: 1024 },
) {
  let registration: { callbackUrl: string } | undefined
  const app = WorkGraphConnectionToolRoutes({
    workspaceId: "workspace-1",
    brokerOrigin: "https://central.test",
    brokerRequestLimits: limits,
    registerSessionTools: async (input) => { registration = input },
    fetch: request,
  })
  expect((await app.request("/api/workgraph/connection-binding", {
    method: "POST",
    headers: { authorization: "Bearer rat-secret", "content-type": "application/json" },
    body: JSON.stringify(binding),
  })).status).toBe(200)
  try {
    return await fetch(registration!.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-1",
        name: "connection_work_source_list",
        toolCallID: "call-list",
        input: { connectionId: "connection-1", providerUserId: "octocat", filters: {} },
      }),
    })
  } finally {
    await app.request("/api/workgraph/connection-binding/session-1", {
      method: "DELETE",
      headers: { authorization: "Bearer rat-secret" },
    })
  }
}

async function invokeCallback(
  callbackUrl: string,
  input: Record<string, unknown>,
  name = "connection_work_source_list",
) {
  return await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionID: "session-1",
      name,
      toolCallID: `call-${name}`,
      input,
    }),
  })
}
