import { describe, expect, test } from "bun:test"
import { serializeRecoveryOutcome, type RecoveryOperation, type RecoveryOutcome, type RecoveryRequest } from "@claxedo/agent-runtime-contract"
import type { AgentTurnCoveragePage } from "@claxedo/agent-sdk-runtime/message-page"
import { createWorkspaceRuntimeClient } from "./index"
import { WorkspaceRuntimeClientError, WorkspaceRuntimeClientPayloadError, WorkspaceRuntimeClientTransportError } from "./request"

describe("workspace runtime request path", () => {
  test("keeps a base path, scopes by directory and workspace, and merges headers in caller order", async () => {
    const calls: Request[] = []
    const client = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example/base/",
      headers: { Authorization: "Basic token", "X-Default": "default" },
      directory: "/repo/main",
      workspace: "ws-1",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        calls.push(request)
        if (request.method === "GET") return Response.json([])
        return Response.json({ id: "s1" })
      },
    })

    const listed = await client.session.list({ limit: 5 }, { headers: { "X-Request": "get" } })
    const created = await client.session.create({ directory: "/repo/other", title: "t", parentID: undefined }, { headers: { "X-Default": "overridden" } })

    expect(listed.data).toEqual([])
    expect(listed.request.url).toBe("https://server.example/base/session?directory=%2Frepo%2Fmain&workspace=ws-1&limit=5")
    expect(created.data).toMatchObject({ id: "s1" })
    expect(calls.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://server.example/base/session?directory=%2Frepo%2Fmain&workspace=ws-1&limit=5"],
      ["POST", "https://server.example/base/session?directory=%2Frepo%2Fother&workspace=ws-1"],
    ])
    expect(calls[0]?.headers.get("authorization")).toBe("Basic token")
    expect(calls[0]?.headers.get("x-default")).toBe("default")
    expect(calls[0]?.headers.get("x-request")).toBe("get")
    expect(calls[0]?.headers.get("accept")).toBe("application/json")
    expect(calls[1]?.headers.get("x-default")).toBe("overridden")
    expect(calls[1]?.headers.get("content-type")).toBe("application/json")
    await expect(calls[1]?.json()).resolves.toEqual({ title: "t" })
  })

  test("throws typed response, payload and transport errors", async () => {
    const failed = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      fetch: async () => Response.json({ error: { code: "denied", message: "Not allowed" } }, { status: 403 }),
    })
    const invalid = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      fetch: async () => new Response("not json", { headers: { "Content-Type": "application/json" } }),
    })
    const offline = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      fetch: async () => {
        throw new TypeError("fetch failed")
      },
    })

    await expect(failed.vcs.get()).rejects.toMatchObject({
      name: "WorkspaceRuntimeClientError",
      operation: "vcs.get",
      status: 403,
      code: "denied",
      message: "Not allowed",
    } satisfies Partial<WorkspaceRuntimeClientError>)
    await expect(invalid.vcs.get()).rejects.toBeInstanceOf(WorkspaceRuntimeClientPayloadError)
    await expect(offline.vcs.get()).rejects.toMatchObject({
      name: "WorkspaceRuntimeClientTransportError",
      operation: "vcs.get",
      message: "fetch failed",
    } satisfies Partial<WorkspaceRuntimeClientTransportError>)
  })

  test("reads a 204 route as no body, and refuses one that answered with a body", async () => {
    const responses: Response[] = [new Response(null, { status: 204 }), Response.json({ ok: true })]
    const client = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      fetch: async () => responses.shift() ?? new Response(null, { status: 500 }),
    })

    const admitted = await client.session.promptAsync({ sessionID: "s1", parts: [{ type: "text", text: "go" }] })
    expect(admitted.data).toBeUndefined()
    expect(admitted.response.status).toBe(204)

    await expect(client.session.promptAsync({ sessionID: "s1", parts: [] })).rejects.toMatchObject({
      name: "WorkspaceRuntimeClientPayloadError",
      operation: "session.promptAsync",
      message: "Expected 204 No Content, got 200",
    } satisfies Partial<WorkspaceRuntimeClientPayloadError>)
  })

  test("a turn coverage read names its turn in the request and reads the envelope back whole", async () => {
    const envelope: AgentTurnCoveragePage = {
      turnId: "msg_user",
      coverage: "partial",
      reason: "The journal records no end for turn msg_user",
      committedSequence: 41,
      messages: [],
    }
    const calls: Request[] = []
    const client = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      directory: "/repo/main",
      fetch: async (input, init) => {
        calls.push(new Request(input, init))
        return Response.json(envelope)
      },
    })

    const read = await client.session.messages({ sessionID: "ses_1", turn: "msg_user", coverage: "1" })
    await client.session.messages({ sessionID: "ses_1", view: "latest-turn" })

    expect(read.data).toEqual(envelope)
    expect(calls.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://server.example/session/ses_1/message?directory=%2Frepo%2Fmain&turn=msg_user&coverage=1"],
      ["GET", "https://server.example/session/ses_1/message?directory=%2Frepo%2Fmain&view=latest-turn"],
    ])
  })

  test("explicit delivery decodes durable acknowledgements instead of requiring an empty response", async () => {
    const pending = { ok: false, status: "pending", operationId: "operation", message: "Awaiting provider acknowledgement" } as const
    const responses = [Response.json({ delivery: "queue" }), Response.json(pending, { status: 202 }), Response.json({ delivery: "queue", messageID: "queued" }, { status: 202 })]
    const client = createWorkspaceRuntimeClient({ baseUrl: "https://server.example", fetch: async () => responses.shift()! })
    expect((await client.session.promptAsync({ sessionID: "s1", delivery: "queue", parts: [] })).data).toEqual({ delivery: "queue" })
    expect((await client.session.promptAsync({ sessionID: "s1", delivery: "steer", parts: [] })).data).toEqual(pending)
    expect((await client.session.prompt({ sessionID: "s1", delivery: "queue", messageID: "queued", parts: [] })).data).toEqual({ delivery: "queue", messageID: "queued" })
  })

  test("forwards AbortSignal and preserves native AbortError cancellation", async () => {
    const controller = new AbortController()
    const aborted = new DOMException("cancelled", "AbortError")
    const client = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      fetch: async (_input, init) => {
        expect(init?.signal).toBe(controller.signal)
        throw aborted
      },
    })

    const result = client.vcs.get({}, { signal: controller.signal }).catch((error) => error)
    controller.abort(aborted)
    expect(await result).toBe(aborted)
  })
})

test("session startup reads and binary attachments retain canonical workspace scope", async () => {
  const calls: Request[] = []
  const binding = { sessionId: "reserved", workspaceId: "workspace", directory: "/repo", connectionId: "connection", operationId: "operation" }
  const start = { binding, status: "starting" as const, createdAt: 1, updatedAt: 1 }
  const client = createWorkspaceRuntimeClient({
    baseUrl: "https://runtime.example", workspace: "workspace", directory: "/repo",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return new URL(request.url).pathname.startsWith("/session-start/") ? Response.json(start) : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } })
    },
  })
  expect((await client.session.start({ sessionID: binding.sessionId })).data).toEqual(start)
  const image = await client.session.attachment({ sessionID: "reserved", messageID: "message/id", attachmentID: "image/id" })
  expect(image.headers.get("Content-Type")).toBe("image/png")
  expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([137, 80, 78, 71])
  expect(new URL(calls[1].url).pathname).toBe("/session/reserved/message/message%2Fid/attachment/image%2Fid")
  expect(calls.every((request) => new URL(request.url).searchParams.get("workspace") === "workspace")).toBe(true)
})

describe("recovery over the wire", () => {
  const target = {
    scope: "turn" as const,
    workspaceId: "ws-1",
    sessionId: "ses_1",
    turnId: "msg_1",
    ownerGeneration: "lease_1",
    writeAuthority: "7",
  }
  const request: RecoveryRequest = {
    requestId: "req_1",
    action: "cancel_turn",
    target,
    scopeRevision: "lease_1",
    attempt: 1,
  }
  const operation: RecoveryOperation = {
    operationId: "op_1",
    requestId: "req_1",
    target,
    action: "cancel_turn",
    scopeRevision: "lease_1",
    attempt: 1,
    state: "succeeded",
    phase: "graceful_cancel",
    phaseDeadlineAt: 2_000,
    facts: {
      execution: { value: "terminal", source: "codex", observedAt: 1_000, generation: "lease_1" },
      cleanup: { value: "verified_clear", source: "codex", observedAt: 1_000, generation: "lease_1" },
      persistence: { value: "committed", source: "store", observedAt: 1_000, generation: "lease_1" },
    },
    cleanupErrors: [],
    nextActions: [],
    receipt: "durable",
    createdAt: 1_000,
    updatedAt: 1_000,
  }

  function client(answer: (request: Request) => Response, calls: Request[] = []) {
    return {
      calls,
      client: createWorkspaceRuntimeClient({
        baseUrl: "https://runtime.example",
        directory: "/repo",
        workspace: "ws-1",
        fetch: async (input, init) => {
          const sent = new Request(input, init)
          calls.push(sent)
          return answer(sent)
        },
      }),
    }
  }

  test("a submit sends the request as a JSON body under the session's scope", async () => {
    const outcome: RecoveryOutcome = { kind: "operation", operation }
    const sent = client(() => new Response(serializeRecoveryOutcome(outcome), { headers: { "content-type": "application/json" } }))

    const answered = await sent.client.session.recovery.submit({ sessionID: "ses_1", request })

    expect(answered.data).toEqual(outcome)
    const call = sent.calls[0]!
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://runtime.example/session/ses_1/recovery?directory=%2Frepo&workspace=ws-1")
    expect(call.headers.get("content-type")).toBe("application/json")
    // The exact text, not a decoded shape: the owner fences on this identity
    // and a field dropped by serialization is a stale request it cannot spot.
    expect(await call.text()).toBe(JSON.stringify(request))
  })

  test("a refusal under a non-2xx status is the answer, not a thrown transport failure", async () => {
    const outcome: RecoveryOutcome = {
      kind: "refused",
      refusal: { kind: "generation_conflict", message: "the turn was replaced", current: target },
    }
    const sent = client(() => new Response(serializeRecoveryOutcome(outcome), { status: 409, headers: { "content-type": "application/json" } }))

    const answered = await sent.client.session.recovery.submit({ sessionID: "ses_1", request })

    expect(answered.response.status).toBe(409)
    expect(answered.data).toEqual(outcome)
  })

  test("a body that is not an outcome is thrown with the route's own error code", async () => {
    const sent = client(() => Response.json({ error: { code: "recovery_request_invalid", message: "recovery attempt must be an integer of at least 1" } }, { status: 400 }))

    await expect(sent.client.session.recovery.submit({ sessionID: "ses_1", request })).rejects.toMatchObject({
      name: "WorkspaceRuntimeClientError",
      status: 400,
      code: "recovery_request_invalid",
    })
  })

  test("reading an operation asks for it by id and decodes the same outcome", async () => {
    const outcome: RecoveryOutcome = { kind: "operation", operation: { ...operation, state: "needs_action" } }
    const sent = client(() => new Response(serializeRecoveryOutcome(outcome)))

    const answered = await sent.client.session.recovery.read({ sessionID: "ses_1", operationId: "op/1" })

    expect(sent.calls[0]!.method).toBe("GET")
    expect(new URL(sent.calls[0]!.url).pathname).toBe("/session/ses_1/recovery/operations/op%2F1")
    expect(answered.data).toEqual(outcome)
  })

  test("inspection is a plain read of the owner's view", async () => {
    const inspection = {
      sessionId: "ses_1",
      target,
      facts: operation.facts,
      health: { status: "ok" as const },
      failures: [],
      operations: [],
      queued: 0,
    }
    const sent = client(() => Response.json(inspection))

    const answered = await sent.client.session.recovery.inspect({ sessionID: "ses_1" })

    expect(new URL(sent.calls[0]!.url).pathname).toBe("/session/ses_1/recovery")
    expect(answered.data).toEqual(inspection)
  })
})
