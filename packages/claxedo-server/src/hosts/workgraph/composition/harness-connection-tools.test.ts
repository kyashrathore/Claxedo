import { describe, expect, it, vi } from "vitest"
import {
  createHarnessWorkGraphGateway,
  createLocalWorkGraphConnectionBroker,
  type WorkGraphConnectionRunBinding,
} from "./session-gateway"
import { WorkGraphConnectionToolRoutes } from "@claxedo/workgraph/runtime-adapter"
import type { ConnectionsService } from "@claxedo/connections"
import { ActorIDSchema, OwnerUserIDSchema, RequestIDSchema } from "@claxedo/workgraph/contracts"

const profile = {
  environment: { kind: "local_worktree" as const, placement: "shared" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claude-sdk",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: ["connection_work_source_comment"],
  connectionIds: ["connection-1" as never],
}

const context = {
  organizationId: "acme" as never,
  ownerUserId: OwnerUserIDSchema.parse("local"),
  actor: { type: "user" as const, id: ActorIDSchema.parse("local") },
  requestId: RequestIDSchema.parse("request-harness-connections"),
  access: { mode: "owner" as const },
}

const connectionsStub = {
  getById: async () => ({ id: "connection-1", integrationId: "github", owner: "org:acme", grantedCapabilities: ["work-source"] }),
  getToken: async () => ({ ok: true, response: { token: "live-secret", tokenType: "bearer" } }),
  reportAuthFailure: async () => undefined,
} as unknown as ConnectionsService

describe("Connection-bound Runs on harness Sessions", () => {
  it("admits a Connection-bound Run on a non-OpenCode harness and registers the runtime binding", async () => {
    const runtimeSessionId = "ses_runtime_claude"
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const bound: WorkGraphConnectionRunBinding[] = []
    const released: string[] = []
    const gateway = createHarnessWorkGraphGateway({
      connections: connectionsStub,
      resolveTeamOwner: (owner) => `org:${owner.organizationId}`,
      connectionBindings: {
        bind: async (binding) => {
          bound.push(binding)
        },
        release: async (sessionId) => {
          released.push(sessionId)
        },
      },
      sessionRequest: async (_directory, request) => {
        const url = new URL(request.url)
        calls.push({
          method: request.method,
          path: url.pathname,
          ...(request.body ? { body: await request.clone().json() } : {}),
        })
        if (url.pathname === "/session") return Response.json({ id: runtimeSessionId }, { status: 201 })
        if (url.pathname === "/api/workgraph/connection-binding") return Response.json({ bound: true })
        if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
        if (url.pathname === `/session/${runtimeSessionId}`) {
          return Response.json({ id: runtimeSessionId, lastTurn: { status: "completed", completedAt: 2 } })
        }
        if (url.pathname === `/session/${runtimeSessionId}/message`) {
          return Response.json([
            { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "Comment on the issue" }] },
            { info: { id: "assistant", role: "assistant" }, parts: [{ type: "text", text: "Commented" }] },
          ])
        }
        if (url.pathname.startsWith("/api/workgraph/connection-binding/")) return Response.json({ unbound: true })
        throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
      },
    })

    await expect(gateway.admit({
      runId: "run_connected",
      streamId: "stream_connected",
      sessionId: "ses_workgraph_connected",
      directory: "/repo",
      workspaceId: "workspace_connected",
      title: "Item",
      prompt: "Comment on the issue",
      profile,
      context,
    })).resolves.toBe("ses_workgraph_connected")

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /session",
      "POST /api/workgraph/connection-binding",
      `POST /session/${runtimeSessionId}/prompt_async`,
    ])
    expect(calls[1]?.body).toEqual({
      version: 1,
      identity: { runId: "run_connected", sessionId: runtimeSessionId, workspaceId: "workspace_connected" },
      connectionIds: ["connection-1"],
      tools: ["connection_work_source_comment"],
      brokerUrl: "http://127.0.0.1",
    })
    expect(bound).toEqual([{
      context,
      ownerPartition: "org:acme",
      runId: "run_connected",
      streamId: "stream_connected",
      sessionId: runtimeSessionId,
      workspaceId: "workspace_connected",
      connectionIds: ["connection-1"],
      tools: ["connection_work_source_comment"],
    }])

    await expect(gateway.result("ses_workgraph_connected")).resolves.toMatchObject({ state: "succeeded" })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      `DELETE /api/workgraph/connection-binding/${runtimeSessionId}`,
    )
    expect(released).toEqual([runtimeSessionId])
  })

  it("routes Connection-bound OpenCode Runs through the same Session rail", async () => {
    const sessionPaths: string[] = []
    const gateway = createHarnessWorkGraphGateway({
      connections: connectionsStub,
      resolveTeamOwner: (owner) => `org:${owner.organizationId}`,
      connectionBindings: {
        bind: async () => undefined,
        release: async () => undefined,
      },
      sessionRequest: async (_directory, request) => {
        sessionPaths.push(new URL(request.url).pathname)
        return new Response("runtime unavailable in this test", { status: 503 })
      },
    })

    await expect(gateway.admit({
      runId: "run_opencode",
      directory: "/repo",
      title: "Item",
      prompt: "Comment on the issue",
      profile: { ...profile, harness: "opencode" },
      context,
    })).rejects.toThrow("Harness Session request failed")
    expect(sessionPaths).toEqual(["/session"])
  })

  it("refuses Connection-bound harness Runs when no Connection binding registry is composed", async () => {
    const gateway = createHarnessWorkGraphGateway({
      connections: connectionsStub,
      resolveTeamOwner: (owner) => `org:${owner.organizationId}`,
      sessionRequest: async () => {
        throw new Error("admission must fail before any session request")
      },
    })

    await expect(gateway.admit({
      runId: "run_unregistered",
      directory: "/repo",
      title: "Item",
      prompt: "Comment on the issue",
      profile,
      context,
    })).rejects.toThrow("Connection-bound Runs require a Connection binding registry")
  })

  it("executes a Connection tool on the harness rail against the server-authored binding", async () => {
    const comments: unknown[] = []
    const bindings = new Map<string, WorkGraphConnectionRunBinding>()
    const broker = createLocalWorkGraphConnectionBroker({
      connections: connectionsStub,
      resolveTeamOwner: (owner) => `org:${owner.organizationId}`,
      connectors: {
        github: {
          provider: "github",
          list: async () => ({ issues: [] }),
          comment: async (_authorization: unknown, operation: unknown) => {
            comments.push(operation)
          },
          update: async () => undefined,
        } as never,
      },
      resolveBinding: async (sessionId) => bindings.get(sessionId),
    })
    let callbackUrl = ""
    const routes = WorkGraphConnectionToolRoutes({
      workspaceId: "workspace_connected",
      broker,
      registerSessionTools: async (registration) => {
        callbackUrl = registration.callbackUrl
      },
      unregisterSessionTools: async () => undefined,
    })
    try {
      bindings.set("ses_runtime_claude", {
        context,
        ownerPartition: "org:acme",
        runId: "run_connected",
        streamId: "stream_connected",
        sessionId: "ses_runtime_claude",
        workspaceId: "workspace_connected",
        connectionIds: ["connection-1"],
        tools: ["connection_work_source_comment"],
      })
      const registered = await routes.request("/api/workgraph/connection-binding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          identity: { runId: "run_connected", sessionId: "ses_runtime_claude", workspaceId: "workspace_connected" },
          connectionIds: ["connection-1"],
          tools: ["connection_work_source_comment"],
          brokerUrl: "http://127.0.0.1",
        }),
      })
      expect(registered.status).toBe(200)
      expect(callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
      const invoked = await fetch(callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: "ses_runtime_claude",
          name: "connection_work_source_comment",
          input: {
            connectionId: "connection-1",
            externalId: "42",
            body: "Done",
            idempotencyKey: "comment-once",
          },
        }),
      })
      expect(invoked.status).toBe(200)
      expect(comments).toEqual([
        expect.objectContaining({ externalId: "42", body: "Done", idempotencyKey: "comment-once" }),
      ])
    } finally {
      routes.dispose()
    }
  })

  it("denies a Connection operation whose identity does not match the registered binding", async () => {
    const binding: WorkGraphConnectionRunBinding = {
      context,
      ownerPartition: "org:acme",
      runId: "run_connected",
      sessionId: "ses_runtime_claude",
      workspaceId: "workspace_connected",
      connectionIds: ["connection-1"],
      tools: ["connection_work_source_comment"],
    }
    const broker = createLocalWorkGraphConnectionBroker({
      connections: connectionsStub,
      resolveTeamOwner: (owner) => `org:${owner.organizationId}`,
      resolveBinding: async (sessionId) => (sessionId === binding.sessionId ? binding : undefined),
    })

    await expect(broker({
      version: 1,
      identity: {
        runId: "run_other",
        sessionId: "ses_runtime_claude",
        workspaceId: "workspace_connected",
        connectionId: "connection-1",
      },
      operation: { type: "comment", externalId: "42", body: "Done", idempotencyKey: "comment-once" },
    } as never)).rejects.toThrow("Connection operation is not bound to this Run")
  })

  it("fails closed on pull requests without the Stream-bound receipt pipeline", async () => {
    const binding: WorkGraphConnectionRunBinding = {
      context,
      ownerPartition: "org:acme",
      runId: "run_connected",
      streamId: "stream_connected",
      sessionId: "ses_runtime_claude",
      workspaceId: "workspace_connected",
      connectionIds: ["connection-1"],
      tools: ["connection_code_host_open_pr"],
    }
    const openPullRequest = vi.fn()
    const broker = createLocalWorkGraphConnectionBroker({
      connections: connectionsStub,
      resolveTeamOwner: (owner) => `org:${owner.organizationId}`,
      codeHostConnectors: {
        github: { provider: "github", openPullRequest, repositoryVisibility: async () => "private" } as never,
      },
      // No authorizePullRequest / pullRequestEffects / recordPullRequest.
      resolveBinding: async () => binding,
    })

    await expect(broker({
      version: 1,
      identity: {
        runId: "run_connected",
        sessionId: "ses_runtime_claude",
        workspaceId: "workspace_connected",
        connectionId: "connection-1",
      },
      operation: {
        type: "open_pull_request",
        repository: "acme/site",
        head: "feature",
        base: "main",
        title: "Ship",
        draft: true,
        publicRepository: false,
        idempotencyKey: "pr-once",
      },
    } as never)).rejects.toThrow("Pull request delivery requires a Stream-bound receipt pipeline")
    expect(openPullRequest).not.toHaveBeenCalled()
  })
})
