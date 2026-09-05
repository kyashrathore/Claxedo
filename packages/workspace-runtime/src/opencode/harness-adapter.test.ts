import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import { OpenCodeSdkHarnessAdapter } from "./harness-adapter"
import type { ProjectedEvent } from "./event-pump"
import type { OpenCodeRuntime } from "./runtime"

function workspace() {
  return realpathSync(mkdtempSync(join(tmpdir(), "claxedo-sdk-adapter-")))
}

function binding(directory: string, sessionId: string): AgentExecutionBinding {
  return { workspaceId: "ws_1", directory, sessionId, connectionId: "native:opencode", upstreamSessionId: sessionId }
}

function runtime() {
  const listeners = new Set<(event: ProjectedEvent) => void>()
  const sessions = {
    list: mock(async (scope: { directory: string }) => ({
      sessions: [{ id: "ses_1", title: "SDK", directory: scope.directory, createdAt: 1, updatedAt: 2 }],
    })),
    get: mock(async (scope: { directory: string }, id: string) => ({
      id,
      title: "SDK",
      directory: scope.directory,
      createdAt: 1,
      updatedAt: 2,
    })),
    create: mock(async (scope: { directory: string }, input: { id?: string; title?: string }) => ({
      id: input.id ?? "ses_created",
      title: input.title,
      directory: scope.directory,
      createdAt: 1,
      updatedAt: 1,
    })),
    rename: mock(async () => {}),
    remove: mock(async () => {}),
    switchAgent: mock(async () => {}),
    switchModel: mock(async () => {}),
    prompt: mock(async (scope: { directory: string }, sessionID: string) => {
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({
            id: "evt_1",
            type: "session.text.delta",
            directory: scope.directory,
            hintOnly: true,
            data: { sessionID, assistantMessageID: "msg_a", ordinal: 0, delta: "hello" },
          })
          listener({
            id: "evt_2",
            type: "session.execution.succeeded",
            durable: { aggregateID: sessionID, seq: 2 },
            hintOnly: false,
            data: { sessionID },
          })
        }
      })
      return { id: "msg_u", sessionID, createdAt: 1, text: "hi" }
    }),
    messages: mock(async () => ({ messages: [] })),
    interrupt: mock(async () => {}),
    fork: mock(async (scope: { directory: string }) => ({
      id: "ses_fork",
      directory: scope.directory,
      createdAt: 1,
      updatedAt: 1,
    })),
    command: mock(async () => {}),
  }
  const mcp = new Map<string, unknown>()
  const configuration = {
    mcpStatus: mock(async () => Object.fromEntries([...mcp.keys()].map((name) => [name, "connected"]))),
    addMcp: mock(async (_scope: unknown, name: string, config: unknown) => {
      mcp.set(name, config)
      return Object.fromEntries([...mcp.keys()].map((key) => [key, "connected"]))
    }),
    removeMcp: mock(async (_scope: unknown, name: string) => { mcp.delete(name) }),
  }
  const value = {
    sessions,
    catalog: { commands: mock(async () => []), agents: mock(async () => []), models: mock(async () => []) },
    interactions: { permissions: mock(async () => []), forms: mock(async () => []) },
    configuration,
    events: {
      start() {},
      ready: async () => {},
      subscribe(listener: (event: ProjectedEvent) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      checkpoint: () => undefined,
    },
    host: { status: () => ({ lifecycle: "ready", events: "healthy" }) },
    close: async () => {},
  } as unknown as OpenCodeRuntime
  return { value, sessions, configuration, mcp }
}

function adapterFor(fake: ReturnType<typeof runtime>, directory: string) {
  return new OpenCodeSdkHarnessAdapter({ runtime: fake.value, workspaceID: "ws_1", directory })
}

describe("OpenCodeSdkHarnessAdapter", () => {
  test("only the typed SDK missing-session error becomes a missing session", async () => {
    const fake = runtime()
    const directory = workspace()
    const adapter = adapterFor(fake, directory)
    fake.sessions.get.mockRejectedValueOnce({ _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found" })
    expect(await adapter.getSession(binding(directory, "ses_missing"))).toBeNull()
    fake.sessions.get.mockRejectedValueOnce(new Error("configuration not found"))
    await expect(adapter.getSession(binding(directory, "ses_missing"))).rejects.toThrow("configuration not found")
  })

  test("uses typed session ports for lifecycle operations", async () => {
    const fake = runtime()
    const directory = workspace()
    const adapter = adapterFor(fake, directory)

    expect(await adapter.listSessions(directory)).toEqual([
      { id: "ses_1", title: "SDK", directory, time: { created: 1, updated: 2 } },
    ])
    expect(await adapter.createSession(directory, "Created", "ses_fixed")).toEqual({ id: "ses_fixed" })
    await adapter.updateSession(binding(directory, "ses_fixed"), { title: "Renamed" })
    await adapter.deleteSession(binding(directory, "ses_fixed"))

    expect(fake.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceID: "ws_1", directory }), {
      id: "ses_fixed",
      title: "Created",
    })
    expect(fake.sessions.rename).toHaveBeenCalledWith(expect.anything(), "ses_fixed", "Renamed")
    expect(fake.sessions.remove).toHaveBeenCalled()
  })

  test("leaves session config durable in the runtime store and applies it per turn", () => {
    const fake = runtime()
    const adapter = adapterFor(fake, workspace())
    expect(adapter.sessionConfigOwner).toBe("runtime")
    expect(adapter.readHarnessCapabilities()).toMatchObject({ harness: "opencode", configOptions: false, permissions: true })
  })

  test("subscribes before admission and emits canonical runtime events", async () => {
    const fake = runtime()
    const directory = workspace()
    const adapter = adapterFor(fake, directory)
    const events = []
    for await (const event of adapter.executeTurn(binding(directory, "ses_1"), {
      parts: [{ type: "text", text: "hi" }],
      assistantMessageId: "caller-assistant-id",
      userMessageId: "caller-user-id",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    })) events.push(event)

    expect(fake.sessions.switchAgent).toHaveBeenCalledWith(expect.anything(), "ses_1", "build")
    expect(fake.sessions.switchModel).toHaveBeenCalledWith(expect.anything(), "ses_1", {
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    })
    expect(events).toEqual([
      { type: "text-delta", delta: "hello", harness: "opencode" },
      { type: "finish", sessionId: "ses_1", harness: "opencode" },
    ])
  })

  test("rejects prompt content without a V2 mapping instead of fabricating it", async () => {
    const fake = runtime()
    const directory = workspace()
    const adapter = adapterFor(fake, directory)
    const events = []
    for await (const event of adapter.executeTurn(binding(directory, "ses_1"), {
      parts: [{ type: "agent", name: "reviewer" }],
      assistantMessageId: "msg_a",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    })) events.push(event)

    expect(fake.sessions.prompt).not.toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({ type: "error", harness: "opencode" })])
  })

  test("reconciles the runtime snapshot's MCP servers into the SDK registry", async () => {
    const fake = runtime()
    const directory = workspace()
    const adapter = adapterFor(fake, directory)
    const harness = { id: "opencode", access: "native" as const }

    await adapter.applyConfig({ mcp: { docs: { transport: "remote", url: "https://mcp.example" } }, auth: {}, harness, launch: {} })
    expect([...fake.mcp.keys()]).toEqual(["docs"])
    expect(fake.configuration.addMcp).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceID: "ws_1", directory }),
      "docs",
      { transport: "remote", url: "https://mcp.example" },
    )

    // A server the next snapshot no longer names is removed; a renamed one is re-added.
    await adapter.applyConfig({ mcp: { files: { transport: "stdio", command: "mcp-files" } }, auth: {}, harness, launch: {} })
    expect([...fake.mcp.keys()]).toEqual(["files"])
    expect(fake.configuration.removeMcp).toHaveBeenCalledWith(expect.anything(), "docs")
  })
})
