import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  createFileWorkGraphSessionBindingStore,
  createWorkspaceRuntimeWorkGraphGateway,
} from "./session-gateway"

const profile = {
  environment: { kind: "local_worktree" as const, placement: "shared" as const },
  repository: { baseRevision: "HEAD" },
  harness: "external-agent",
  agent: "build",
  model: { providerId: "external-agent", modelId: "default" },
  effort: "medium",
  tools: [],
  connectionIds: [],
}

describe("workspace-runtime WorkGraph Session gateway", () => {
  it("routes an opaque connection id through the canonical Session surface", async () => {
    const calls: Array<{ method: string; pathname: string; connectionId: string | null; body?: unknown }> = []
    const gateway = createWorkspaceRuntimeWorkGraphGateway({
      resolveHarnessSelection: () => ({ kind: "connection", connectionId: "external-agent" }),
      sessionRequest: async (directory, request) => {
        expect(directory).toBe("/repo")
        const url = new URL(request.url)
        calls.push({
          method: request.method,
          pathname: url.pathname,
          connectionId: url.searchParams.get("connectionId"),
          ...(request.body ? { body: await request.clone().json() } : {}),
        })
        if (url.pathname === "/session") return Response.json({ id: "ses_workgraph_run_1" }, { status: 201 })
        if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 })
        if (url.pathname === "/session/ses_workgraph_run_1") {
          return Response.json({ id: "ses_workgraph_run_1", lastTurn: { status: "completed", completedAt: 1 } })
        }
        if (url.pathname === "/session/ses_workgraph_run_1/message") {
          return Response.json([
            { info: { role: "assistant" }, parts: [{ type: "text", text: "Completed through the connection." }] },
          ])
        }
        throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
      },
    })

    await expect(gateway.admit({
      runId: "run_1",
      sessionId: "ses_workgraph_run_1",
      directory: "/repo",
      title: "Run",
      prompt: "Complete it",
      profile,
    })).resolves.toBe("ses_workgraph_run_1")
    await expect(gateway.result("ses_workgraph_run_1")).resolves.toEqual({
      state: "succeeded",
      summary: "Completed through the connection.",
      artifacts: [],
    })
    expect(calls.every((call) => call.connectionId === "external-agent")).toBe(true)
    expect(calls[0]?.body).toMatchObject({ id: "ses_workgraph_run_1", title: "Run" })
  })

  it("fails closed when a Session has no WorkGraph-owned binding", async () => {
    const gateway = createWorkspaceRuntimeWorkGraphGateway({
      resolveHarnessSelection: () => ({ kind: "connection", connectionId: "external-agent" }),
      sessionRequest: async () => {
        throw new Error("must not discover unbound sessions")
      },
    })
    await expect(gateway.result("external-session")).rejects.toThrow("has no workspace-runtime binding")
    await expect(gateway.cancel("external-session", "cancelled")).rejects.toThrow("has no workspace-runtime binding")
  })

  it("persists only the v2 discriminated runtime selection and rejects the old binding shape", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workgraph-binding-"))
    const file = path.join(directory, "bindings.json")
    try {
      const store = createFileWorkGraphSessionBindingStore(file)
      await store.save({
        runId: "run_1",
        sessionId: "ses_1",
        directory: "/repo",
        selection: { kind: "connection", connectionId: "external-agent" },
      })
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        version: 2,
        bindings: [{ selection: { kind: "connection", connectionId: "external-agent" } }],
      })

      await writeFile(file, JSON.stringify({
        version: 1,
        bindings: [{ runId: "legacy", sessionId: "legacy", directory: "/repo", harness: "opencode" }],
      }))
      const legacy = createFileWorkGraphSessionBindingStore(file)
      await expect(legacy.all()).rejects.toThrow("binding index is malformed")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
