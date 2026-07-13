import { describe, expect, it } from "vitest"
import { createSessionV2WorkGraphGateway } from "./workgraph-session-gateway"
import type { ConnectionsService } from "@claxedo/connections"
import { ActorIDSchema, OwnerUserIDSchema, RequestIDSchema } from "@claxedo/workgraph/contracts"

describe("mounted WorkGraph Session V2 gateway", () => {
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
        getById: async () => ({ id: "connection-1", integrationId: "github", owner: undefined, grantedCapabilities: ["work-source"] }),
        getToken: async () => ({ ok: true, response: { token: "live-secret", tokenType: "bearer" } }),
        reportAuthFailure: async () => undefined,
      } as unknown as ConnectionsService,
    })
    const context = {
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
    expect(calls[1]?.body).toMatchObject({
      callbackUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      tools: [{ name: "connection_work_source_comment" }],
    })
    expect(JSON.stringify(calls)).not.toContain("live-secret")

    await gateway.cancel("ses_connected", "test cleanup")
    expect(calls.map((call) => `${call.method} ${call.path}`).slice(-2)).toEqual([
      "POST /api/session/ses_connected/interrupt",
      "DELETE /api/session/ses_connected/tool",
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
  isolation: "stream" as const,
  cleanup: "destroy_on_close" as const,
  integration: "manual" as const,
}
