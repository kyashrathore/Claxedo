import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createFileWorkGraphSessionBindingStore, createHarnessWorkGraphGateway, createSessionV2WorkGraphGateway } from "./workgraph-session-gateway"
import type { ConnectionsService } from "@claxedo/connections"
import { ActorIDSchema, OwnerUserIDSchema, RequestIDSchema } from "@claxedo/workgraph/contracts"

describe("mounted WorkGraph Session V2 gateway", () => {
  it("persists harness Session placement so restart compensation can find it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workgraph-session-bindings-"))
    const file = path.join(directory, "bindings.json")
    try {
      await createFileWorkGraphSessionBindingStore(file).save({
        attemptId: "attempt_persisted",
        sessionId: "ses_persisted",
        directory: "/repo",
        harness: "claude-sdk",
      })
      const restored = createFileWorkGraphSessionBindingStore(file)
      await expect(restored.findByAttempt("attempt_persisted")).resolves.toMatchObject({ sessionId: "ses_persisted" })
      await expect(restored.findBySession("ses_persisted")).resolves.toMatchObject({ harness: "claude-sdk" })
      await expect(restored.all()).resolves.toEqual([
        expect.objectContaining({ sessionId: "ses_persisted", directory: "/repo" }),
      ])
      await restored.deleteByDirectory("/repo")
      await expect(restored.findByAttempt("attempt_persisted")).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("routes composer harnesses through the shared harness-aware Session runtime", async () => {
    const calls: Array<{ path: string; harness: string | null; body?: unknown }> = []
    const byAttempt = new Map<string, { attemptId: string; sessionId: string; directory: string; harness: string }>()
    const released: string[] = []
    const gateway = createHarnessWorkGraphGateway(async () => {
      throw new Error("non-OpenCode harnesses must not use Session V2")
    }, {
      sessionRequest: async (_directory, request) => {
        const url = new URL(request.url)
        calls.push({
          path: url.pathname,
          harness: url.searchParams.get("harness"),
          ...(request.body ? { body: await request.clone().json() } : {}),
        })
        if (url.pathname === "/session") return Response.json({ id: "ses_codex" }, { status: 201 })
        if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
        if (url.pathname === "/session/ses_codex") {
          return Response.json({ id: "ses_codex", lastTurn: { status: "completed", completedAt: 2 } })
        }
        if (url.pathname === "/session/ses_codex/message") {
          return Response.json([
            { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "Ship it" }] },
            { info: { id: "assistant", role: "assistant" }, parts: [{ type: "text", text: "Implemented and verified" }] },
          ])
        }
        throw new Error(`Unexpected request ${url.pathname}`)
      },
      bindings: {
        all: async () => [...byAttempt.values()],
        findByAttempt: async (attemptId) => byAttempt.get(attemptId),
        findBySession: async (sessionId) => [...byAttempt.values()].find((binding) => binding.sessionId === sessionId),
        save: async (binding) => { byAttempt.set(binding.attemptId, binding) },
        deleteByAttempt: async (attemptId) => { byAttempt.delete(attemptId) },
        deleteByDirectory: async (directory) => {
          for (const [attemptId, binding] of byAttempt) {
            if (binding.directory === directory) byAttempt.delete(attemptId)
          }
        },
      },
      releaseSessionRuntime: async (directory) => { released.push(directory) },
    })

    await expect(gateway.admit({
      attemptId: "attempt_codex",
      sessionId: "ses_workgraph_attempt_codex",
      directory: "/repo",
      title: "Item",
      prompt: "Ship it",
      profile: { ...profile, harness: "codex-app-server", tools: ["terminal"] },
    })).resolves.toBe("ses_workgraph_attempt_codex")
    expect(calls.slice(0, 2)).toEqual([
      {
        path: "/session",
        harness: "codex-app-server",
        body: {
          title: "Item",
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      },
      {
        path: "/session/ses_codex/prompt_async",
        harness: "codex-app-server",
        body: {
          messageID: "msg_workgraph_attempt_codex",
          parts: [{ type: "text", text: "Ship it" }],
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5" },
          variant: "high",
        },
      },
    ])
    await expect(gateway.result("ses_workgraph_attempt_codex")).resolves.toEqual({
      state: "succeeded",
      summary: "Implemented and verified",
      artifacts: [],
    })
    await gateway.releaseDirectory?.("/repo")
    expect(released).toEqual(["/repo"])
    await expect(gateway.result("ses_workgraph_attempt_codex")).rejects.toThrow("non-OpenCode harnesses must not use Session V2")
  })

  it("binds non-OpenCode harness tools before prompting without exposing durable Attempt identity", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = []
    const contexts: unknown[] = []
    const released: string[] = []
    const context = {
      organizationId: "acme" as never,
      ownerUserId: OwnerUserIDSchema.parse("local"),
      actor: { type: "user" as const, id: ActorIDSchema.parse("local") },
      requestId: RequestIDSchema.parse("request"),
      access: { mode: "owner" as const },
    }
    const gateway = createHarnessWorkGraphGateway(async () => {
      throw new Error("Pi must use the workspace runtime")
    }, {
      executeAttempt: async (_context, request) => ({
        ok: true,
        operationId: request.operation.operationId,
        cursor: "1" as never,
        value: {},
      }),
      attemptContexts: {
        bind: async (input) => { contexts.push(input) },
        release: async (sessionId) => { released.push(sessionId) },
      },
      sessionRequest: async (_directory, request) => {
        const path = new URL(request.url).pathname
        calls.push({
          path,
          method: request.method,
          ...(request.body ? { body: await request.clone().json() } : {}),
        })
        if (path === "/session") return Response.json({ id: "runtime-pi-session" }, { status: 201 })
        if (path === "/api/workgraph/attempt-binding") return Response.json({ bound: true })
        if (path.endsWith("/prompt_async")) return new Response(null, { status: 204 })
        if (path.endsWith("/abort")) return Response.json({ aborted: true })
        if (path.startsWith("/api/workgraph/attempt-binding/")) return Response.json({ unbound: true })
        throw new Error(`Unexpected request ${path}`)
      },
    })

    await expect(gateway.admit({
      attemptId: "attempt-pi",
      leaseEpoch: 9,
      sessionId: "workgraph-pi-session",
      directory: "/repo/worktree",
      workspaceId: "workspace-stream",
      title: "Item",
      prompt: "Implement the task",
      profile: { ...profile, harness: "pi", tools: [] },
      context,
    })).resolves.toBe("workgraph-pi-session")
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /session",
      "POST /api/workgraph/attempt-binding",
      "POST /session/runtime-pi-session/prompt_async",
    ])
    expect(calls[1]?.body).toEqual({
      version: 1,
      identity: {
        attemptId: "attempt-pi",
        sessionId: "workgraph-pi-session",
        workspaceId: "workspace-stream",
        leaseEpoch: 9,
      },
      runtimeSessionId: "runtime-pi-session",
      harness: "pi",
      brokerUrl: "http://127.0.0.1",
    })
    expect(contexts).toEqual([{
      identity: expect.objectContaining({ attemptId: "attempt-pi", sessionId: "workgraph-pi-session" }),
      context,
    }])
    const prompt = calls[2]?.body as { parts: unknown[] }
    expect(JSON.stringify(prompt.parts)).not.toContain("attempt-pi")
    expect(JSON.stringify(prompt.parts)).not.toContain("workspace-stream")

    await gateway.cancel("workgraph-pi-session", "test cleanup")
    expect(calls.map((call) => `${call.method} ${call.path}`).slice(-2)).toEqual([
      "POST /session/runtime-pi-session/abort",
      "DELETE /api/workgraph/attempt-binding/workgraph-pi-session",
    ])
    expect(released).toEqual(["workgraph-pi-session"])
  })

  it("releases non-OpenCode Attempt tools when the Session reaches a terminal turn", async () => {
    const calls: string[] = []
    const released: string[] = []
    const gateway = createHarnessWorkGraphGateway(async () => {
      throw new Error("Pi must use the workspace runtime")
    }, {
      executeAttempt: async (_context, request) => ({
        ok: true,
        operationId: request.operation.operationId,
        cursor: "1" as never,
        value: {},
      }),
      attemptContexts: {
        bind: async () => {},
        release: async (sessionId) => { released.push(sessionId) },
      },
      sessionRequest: async (_directory, request) => {
        const pathname = new URL(request.url).pathname
        calls.push(`${request.method} ${pathname}`)
        if (pathname === "/session") return Response.json({ id: "runtime-pi-session" }, { status: 201 })
        if (pathname === "/api/workgraph/attempt-binding") return Response.json({ bound: true })
        if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
        if (pathname === "/session/runtime-pi-session") {
          return Response.json({ lastTurn: { status: "completed", completedAt: 2 } })
        }
        if (pathname === "/session/runtime-pi-session/message") {
          return Response.json([
            { info: { role: "assistant" }, parts: [{ type: "text", text: "Implemented and verified" }] },
          ])
        }
        if (pathname === "/api/workgraph/attempt-binding/workgraph-pi-session") {
          return Response.json({ unbound: true })
        }
        throw new Error(`Unexpected request ${pathname}`)
      },
    })
    const context = {
      organizationId: "acme" as never,
      ownerUserId: OwnerUserIDSchema.parse("local"),
      actor: { type: "user" as const, id: ActorIDSchema.parse("local") },
      requestId: RequestIDSchema.parse("request-terminal"),
      access: { mode: "owner" as const },
    }

    await gateway.admit({
      attemptId: "attempt-pi",
      leaseEpoch: 9,
      sessionId: "workgraph-pi-session",
      directory: "/repo/worktree",
      workspaceId: "workspace-stream",
      title: "Item",
      prompt: "Implement the task",
      profile: { ...profile, harness: "pi", tools: [] },
      context,
    })
    await expect(gateway.result("workgraph-pi-session")).resolves.toEqual({
      state: "succeeded",
      summary: "Implemented and verified",
      artifacts: [],
    })
    expect(calls.slice(-3)).toEqual([
      "GET /session/runtime-pi-session",
      "DELETE /api/workgraph/attempt-binding/workgraph-pi-session",
      "GET /session/runtime-pi-session/message",
    ])
    expect(released).toEqual(["workgraph-pi-session"])
  })

  it("does not replay a non-OpenCode prompt after an indeterminate admission response", async () => {
    let promptRequests = 0
    let executions = 0
    let admitted = false
    const gateway = createHarnessWorkGraphGateway(async () => {
      throw new Error("non-OpenCode harnesses must not use Session V2")
    }, {
      sessionRequest: async (_directory, request) => {
        const pathname = new URL(request.url).pathname
        if (pathname === "/session") return Response.json({ id: "ses_runtime" }, { status: 201 })
        if (pathname.endsWith("/prompt_async")) {
          promptRequests++
          if (admitted) return new Response(null, { status: 204 })
          admitted = true
          executions++
          throw new Error("response lost")
        }
        throw new Error(`Unexpected request ${pathname}`)
      },
    })
    const input = {
      attemptId: "attempt_retry",
      sessionId: "ses_workgraph_attempt_retry",
      directory: "/repo",
      title: "Retry",
      prompt: "Ship it",
      profile: { ...profile, harness: "pi", tools: [] },
    }

    await expect(gateway.admit(input)).rejects.toThrow("response lost")
    await expect(gateway.admit(input)).resolves.toBe("ses_workgraph_attempt_retry")
    expect(promptRequests).toBe(2)
    expect(executions).toBe(1)
  })

  it("creates/adopts a Session and durably admits the prompt through SessionV2.prompt", async () => {
    const calls: Array<{ path: string; body?: unknown }> = []
    const gateway = createSessionV2WorkGraphGateway(async (request) => {
      calls.push({
        path: new URL(request.url).pathname,
        ...(request.body ? { body: await request.clone().json() } : {}),
      })
      if (new URL(request.url).pathname === "/api/session") return Response.json({ id: "ses_workgraph_attempt_1" })
      return Response.json({ data: { admittedSeq: 1 } })
    })

    await expect(
      gateway.admit({ attemptId: "attempt_1", directory: "/repo", title: "Item", prompt: "Ship it", profile }),
    ).resolves.toBe("ses_workgraph_attempt_1")
    expect(calls).toEqual([
      {
        path: "/api/session",
        body: {
          agent: "build",
          model: { providerID: "openai", id: "gpt-5", variant: "high" },
          tools: ["terminal"],
          location: { directory: "/repo" },
        },
      },
      {
        path: "/api/session/ses_workgraph_attempt_1/prompt",
        body: { id: "msg_workgraph_attempt_1", prompt: { text: "Ship it" }, delivery: "steer", resume: true },
      },
    ])
    expect(calls.some((call) => call.path.endsWith("/message"))).toBe(false)
  })

  it("rejects a create response without a real Session ID", async () => {
    const gateway = createSessionV2WorkGraphGateway(async () => Response.json({ data: {} }))
    await expect(
      gateway.admit({ attemptId: "attempt_1", directory: "/repo", title: "Item", prompt: "Ship it", profile }),
    ).rejects.toThrow("did not include a Session ID")
  })

  it("classifies only definitive create unavailability as unavailable", async () => {
    const unavailable = createSessionV2WorkGraphGateway(async () => new Response("missing", { status: 404 }))
    const unavailableError = await unavailable.admit({ attemptId: "missing", directory: "/repo", title: "Missing", prompt: "Plan", profile })
      .then(() => undefined, (error) => error)
    expect(unavailable.classifyAdmissionError?.(unavailableError)).toBe("unavailable")

    const rejected = createSessionV2WorkGraphGateway(async (request) =>
      new URL(request.url).pathname === "/api/session"
        ? Response.json({ id: "ses_rejected" })
        : new Response("invalid prompt", { status: 400 }))
    const rejectedError = await rejected.admit({ attemptId: "rejected", sessionId: "ses_rejected", directory: "/repo", title: "Rejected", prompt: "Plan", profile })
      .then(() => undefined, (error) => error)
    expect(rejected.classifyAdmissionError?.(rejectedError)).toBe("rejected")

    const indeterminate = createSessionV2WorkGraphGateway(async () => {
      throw new Error("response lost")
    })
    const indeterminateError = await indeterminate.admit({ attemptId: "retry", sessionId: "ses_retry", directory: "/repo", title: "Retry", prompt: "Plan", profile })
      .then(() => undefined, (error) => error)
    expect(indeterminate.classifyAdmissionError?.(indeterminateError)).toBe("indeterminate")
  })

  it("adopts a caller-owned durable Session ID for exact Recap retries", async () => {
    const calls: Array<{ path: string; body?: unknown }> = []
    const gateway = createSessionV2WorkGraphGateway(async (request) => {
      calls.push({ path: new URL(request.url).pathname, ...(request.body ? { body: await request.clone().json() } : {}) })
      if (new URL(request.url).pathname === "/api/session") return Response.json({ data: { id: "ses_workgraph_recap_job_1" } })
      return Response.json({ data: { admittedSeq: 1 } })
    })
    await gateway.admit({
      attemptId: "recap_job_1",
      sessionId: "ses_workgraph_recap_job_1",
      directory: "/repo",
      title: "Recap",
      prompt: "Return JSON",
      profile,
    })
    expect(calls[0]).toMatchObject({ body: { id: "ses_workgraph_recap_job_1", tools: ["terminal"] } })
    expect(calls[1]).toMatchObject({
      path: "/api/session/ses_workgraph_recap_job_1/prompt",
      body: { id: "msg_workgraph_recap_job_1", delivery: "steer", resume: true },
    })
  })

  it("registers exact Connection tools before prompt admission and removes them on cancel", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = []
    let tokenReads = 0
    let comments = 0
    const gateway = createSessionV2WorkGraphGateway(async (request) => {
      calls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        ...(request.body ? { body: await request.clone().json() } : {}),
      })
      if (new URL(request.url).pathname === "/api/session") return Response.json({ id: "ses_connected" })
      return request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ data: { admittedSeq: 1 } })
    }, {
      connections: {
        getById: async () => ({ id: "connection-1", integrationId: "github", owner: "org:acme", grantedCapabilities: ["work-source"] }),
        getToken: async () => {
          tokenReads++
          return { ok: true, response: { token: "live-secret", tokenType: "bearer" } }
        },
        reportAuthFailure: async () => undefined,
      } as unknown as ConnectionsService,
      resolveTeamOwner: (context) => `org:${context.organizationId}`,
      connectors: {
        github: {
          provider: "github",
          list: async () => ({ issues: [] }),
          comment: async () => { comments++ },
          update: async () => undefined,
        },
      },
    })
    const context = {
      organizationId: "acme" as never,
      ownerUserId: OwnerUserIDSchema.parse("local"),
      actor: { type: "user" as const, id: ActorIDSchema.parse("local") },
      requestId: RequestIDSchema.parse("request"),
      access: { mode: "owner" as const },
    }
    const connected = {
      ...profile,
      tools: ["connection_work_source_comment"],
      connectionIds: ["connection-1" as never],
    }

    await expect(gateway.admit({
      attemptId: "attempt-1",
      directory: "/repo",
      title: "Item",
      prompt: "Update it",
      profile: connected,
      context,
    })).resolves.toBe("ses_connected")
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/session",
      "POST /api/session/ses_connected/tool",
      "POST /api/session/ses_connected/prompt",
    ])
    const callbackUrl = (calls[1]?.body as { callbackUrl: string }).callbackUrl
    expect(calls[1]?.body).toMatchObject({
      callbackUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      tools: [{ name: "connection_work_source_comment" }],
    })
    expect(JSON.stringify(calls)).not.toContain("live-secret")

    const used = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "ses_connected",
        name: "connection_work_source_comment",
        input: {
          connectionId: "connection-1",
          externalId: "42",
          body: "Done",
          idempotencyKey: "comment-once",
        },
      }),
    })
    expect(used.status).toBe(200)
    expect(tokenReads).toBe(1)
    expect(comments).toBe(1)

    await gateway.cancel("ses_connected", "test cleanup")
    expect(calls.map((call) => `${call.method} ${call.path}`).slice(-2)).toEqual([
      "POST /api/session/ses_connected/interrupt",
      "DELETE /api/session/ses_connected/tool",
    ])
  })

  it("binds Attempt tools to trusted execution identity and removes them on cancel", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = []
    const operations: unknown[] = []
    const gateway = createSessionV2WorkGraphGateway(async (request) => {
      calls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        ...(request.body ? { body: await request.clone().json() } : {}),
      })
      if (new URL(request.url).pathname === "/api/session") return Response.json({ id: "ses_attempt" })
      return request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ data: { admittedSeq: 1 } })
    }, {
      executeAttempt: async (_context, request) => {
        operations.push(request)
        return { ok: true, operationId: request.operation.operationId, cursor: "1" as never, value: { recorded: true } }
      },
    })
    const context = {
      organizationId: "acme" as never,
      ownerUserId: OwnerUserIDSchema.parse("local"),
      actor: { type: "user" as const, id: ActorIDSchema.parse("local") },
      requestId: RequestIDSchema.parse("request"),
      access: { mode: "owner" as const },
    }

    await expect(gateway.admit({
      attemptId: "attempt-1",
      leaseEpoch: 7,
      directory: "/repo",
      title: "Item",
      prompt: "Ship it",
      profile,
      context,
    })).resolves.toBe("ses_attempt")
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/session",
      "POST /api/session/ses_attempt/tool",
      "POST /api/session/ses_attempt/prompt",
    ])
    const registration = calls[1]?.body as {
      callbackUrl: string
      tools: Array<{ name: string; callbackUrl: string }>
    }
    expect(registration.tools.map((tool) => tool.name)).toEqual([
      "workgraph_report_progress",
      "workgraph_complete_task",
    ])
    expect(registration.tools.every((tool) => tool.callbackUrl === registration.callbackUrl)).toBe(true)

    const used = await fetch(registration.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "ses_attempt",
        name: "workgraph_report_progress",
        toolCallID: "call-1",
        input: { level: "milestone", summary: "Implemented the boundary" },
      }),
    })
    expect(used.status).toBe(200)
    expect(operations).toEqual([{
      version: 1,
      identity: {
        attemptId: "attempt-1",
        sessionId: "ses_attempt",
        workspaceId: "/repo",
        leaseEpoch: 7,
      },
      operation: {
        type: "record_checkpoint",
        operationId: "attempt_tool_attempt-1_call-1",
        level: "milestone",
        summary: "Implemented the boundary",
        evidenceIds: [],
      },
    }])

    await gateway.cancel("ses_attempt", "test cleanup")
    expect(calls.map((call) => `${call.method} ${call.path}`).slice(-2)).toEqual([
      "POST /api/session/ses_attempt/interrupt",
      "DELETE /api/session/ses_attempt/tool",
    ])
  })

  it("projects explicit durable step settlement and artifacts instead of treating idle alone as success", async () => {
    const gateway = createSessionV2WorkGraphGateway(async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/session/active") return Response.json({ data: {} })
      if (url.pathname.endsWith("/history")) {
        return Response.json({
          data: [
            { type: "session.next.text.ended.1", durable: { seq: 4 }, data: { text: "Implemented and verified" } },
            { type: "session.next.step.ended.2", durable: { seq: 5 }, data: { finish: "stop", files: ["src/a.ts"] } },
          ],
          hasMore: false,
        })
      }
      throw new Error(`Unexpected request ${url.pathname}`)
    })

    await expect(gateway.result("ses_workgraph_attempt_1")).resolves.toEqual({
      state: "succeeded",
      summary: "Implemented and verified",
      artifacts: ["file:src/a.ts"],
    })
  })

  it("fails an inactive Session that promoted its prompt but stopped before a step settlement", async () => {
    const gateway = createSessionV2WorkGraphGateway(async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/session/active") return Response.json({ data: {} })
      if (url.pathname.endsWith("/history")) {
        return Response.json({
          data: [
            { type: "session.next.prompt.admitted", durable: { seq: 1 }, data: {} },
            { type: "session.next.prompted", durable: { seq: 2 }, data: {} },
          ],
          hasMore: false,
        })
      }
      throw new Error(`Unexpected request ${url.pathname}`)
    })

    await expect(gateway.result("ses_workgraph_attempt_1")).resolves.toEqual({
      state: "failed",
      message: "Session stopped before the provider step settled",
    })
  })

  it("fails ended Sessions with missing or blank semantic output", async () => {
    for (const text of [undefined, "   "]) {
      const gateway = createSessionV2WorkGraphGateway(async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/api/session/active") return Response.json({ data: {} })
        if (url.pathname.endsWith("/history")) {
          return Response.json({
            data: [
              ...(text === undefined ? [] : [{ type: "session.next.text.ended", durable: { seq: 1 }, data: { text } }]),
              { type: "session.next.step.ended", durable: { seq: 2 }, data: { files: [] } },
            ],
            hasMore: false,
          })
        }
        throw new Error(`Unexpected request ${url.pathname}`)
      })

      await expect(gateway.result("ses_workgraph_attempt_1")).resolves.toEqual({
        state: "failed",
        message: "session_output_missing",
      })
    }
  })

  it("fails closed on malformed or missing Session history data", async () => {
    for (const history of [
      { hasMore: false },
      { data: [], hasMore: "false" },
      { data: [{ type: "session.next.step.ended", data: null }], hasMore: false },
    ]) {
      const gateway = createSessionV2WorkGraphGateway(async (request) =>
        new URL(request.url).pathname === "/api/session/active"
          ? Response.json({ data: {} })
          : Response.json(history))
      await expect(gateway.result("ses_workgraph_attempt_1")).resolves.toEqual({
        state: "failed",
        message: "session_history_invalid",
      })
    }
  })
})

const profile = {
  environment: { kind: "local_worktree" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: ["terminal"],
  connectionIds: [],
}
