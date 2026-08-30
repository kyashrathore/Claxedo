import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createFileWorkGraphSessionBindingStore, createHarnessWorkGraphGateway } from "./session-gateway"

const profile = {
  environment: { kind: "local_worktree" as const, placement: "shared" as const },
  repository: { baseRevision: "HEAD" },
  harness: "opencode",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: ["terminal"],
  connectionIds: [],
}

describe("mounted WorkGraph Session gateway", () => {
  it("persists harness Session placement so restart compensation can find it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workgraph-session-bindings-"))
    const file = path.join(directory, "bindings.json")
    try {
      await createFileWorkGraphSessionBindingStore(file).save({
        runId: "run_persisted",
        sessionId: "ses_persisted",
        directory: "/repo",
        harness: "opencode",
      })
      const restored = createFileWorkGraphSessionBindingStore(file)
      await expect(restored.findByRun("run_persisted")).resolves.toMatchObject({ sessionId: "ses_persisted" })
      await expect(restored.findBySession("ses_persisted")).resolves.toMatchObject({ harness: "opencode" })
      await restored.deleteByDirectory("/repo")
      await expect(restored.findByRun("run_persisted")).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    "opencode",
    "claude-acp",
    "codex-acp",
    "cursor-acp",
    "claude-sdk",
    "codex-app-server",
    "cursor-sdk",
    "pi",
  ])("routes the %s harness through the same Session runtime", async (harness) => {
    const runtimeSessionId = `ses_runtime_${harness.replaceAll("-", "_")}`
    const calls: Array<{ method: string; path: string; harness: string | null; body?: unknown }> = []
    const gateway = createHarnessWorkGraphGateway({
      sessionRequest: async (_directory, request) => {
        const url = new URL(request.url)
        calls.push({
          method: request.method,
          path: url.pathname,
          harness: url.searchParams.get("harness"),
          ...(request.body ? { body: await request.clone().json() } : {}),
        })
        if (url.pathname === "/session") return Response.json({ id: runtimeSessionId }, { status: 201 })
        if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
        if (url.pathname === `/session/${runtimeSessionId}`) {
          return Response.json({
            id: runtimeSessionId,
            status: "idle",
            lastTurn: { status: "completed", completedAt: 2 },
          })
        }
        if (url.pathname === `/session/${runtimeSessionId}/message`) {
          return Response.json([
            { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "Ship it" }] },
            { info: { id: "assistant", role: "assistant" }, parts: [{ type: "text", text: "Implemented and verified" }] },
          ])
        }
        throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
      },
    })

    await expect(gateway.admit({
      runId: `run_${harness}`,
      sessionId: `ses_workgraph_${harness}`,
      directory: "/repo",
      title: "Item",
      prompt: "Ship it",
      profile: { ...profile, harness },
    })).resolves.toBe(`ses_workgraph_${harness}`)

    expect(calls.slice(0, 2)).toEqual([
      {
        method: "POST",
        path: "/session",
        harness,
        body: {
          title: "Item",
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      },
      {
        method: "POST",
        path: `/session/${runtimeSessionId}/prompt_async`,
        harness,
        body: {
          messageID: `msg_workgraph_run_${harness}`,
          parts: [{ type: "text", text: "Ship it" }],
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5" },
          variant: "high",
        },
      },
    ])
    await expect(gateway.result(`ses_workgraph_${harness}`)).resolves.toEqual({
      state: "succeeded",
      summary: "Implemented and verified",
      artifacts: [],
    })
  })

  it("binds Run tools before prompting and cleans them up on cancellation", async () => {
    const calls: string[] = []
    const contexts: string[] = []
    const gateway = createHarnessWorkGraphGateway({
      executeRun: async (_context, request) => ({
        ok: true,
        operationId: request.operation.operationId,
        cursor: "1" as never,
        value: {},
      }),
      runContexts: {
        bind: async ({ identity }) => { contexts.push(identity.sessionId) },
        release: async (sessionId) => { contexts.push(`released:${sessionId}`) },
      },
      sessionRequest: async (_directory, request) => {
        const pathname = new URL(request.url).pathname
        calls.push(`${request.method} ${pathname}`)
        if (pathname === "/session") return Response.json({ id: "ses_runtime" }, { status: 201 })
        if (pathname === "/api/workgraph/run-binding") return Response.json({ bound: true })
        if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
        if (pathname.endsWith("/abort")) return Response.json({ aborted: true })
        if (pathname.startsWith("/api/workgraph/run-binding/")) return Response.json({ unbound: true })
        throw new Error(`Unexpected request ${pathname}`)
      },
    })
    const context = {
      organizationId: "acme" as never,
      ownerUserId: "local" as never,
      actor: { type: "user" as const, id: "local" as never },
      requestId: "request" as never,
      access: { mode: "owner" as const },
    }

    await gateway.admit({
      runId: "run-tools",
      generation: 9,
      sessionId: "ses_workgraph",
      directory: "/repo",
      workspaceId: "workspace",
      title: "Item",
      prompt: "Ship it",
      profile,
      context,
    })
    expect(calls).toEqual([
      "POST /session",
      "POST /api/workgraph/run-binding",
      "POST /session/ses_runtime/prompt_async",
    ])
    await gateway.cancel("ses_workgraph", "test")
    expect(calls.slice(-2)).toEqual([
      "POST /session/ses_runtime/abort",
      "DELETE /api/workgraph/run-binding/ses_workgraph",
    ])
    expect(contexts).toEqual(["ses_workgraph", "released:ses_workgraph"])
  })

  it("does not synthesize a terminal result when the Session has no persisted turn outcome", async () => {
    const gateway = createHarnessWorkGraphGateway({
      sessionRequest: async (_directory, request) => {
        const pathname = new URL(request.url).pathname
        if (pathname === "/session") return Response.json({ id: "ses_runtime" }, { status: 201 })
        if (pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
        if (pathname === "/session/ses_runtime") return Response.json({ id: "ses_runtime", status: "idle" })
        throw new Error(`Unexpected request ${pathname}`)
      },
    })
    await gateway.admit({
      runId: "run-pending",
      sessionId: "ses_workgraph",
      directory: "/repo",
      title: "Item",
      prompt: "Ship it",
      profile,
    })
    await expect(gateway.result("ses_workgraph")).resolves.toEqual({ state: "pending" })
  })
})
