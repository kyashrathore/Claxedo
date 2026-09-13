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

function runtime(options: {
  lifecycle?: "cold" | "ready"
  execution?: "auto" | "manual"
  unavailableProvider?: Record<string, string>
} = {}) {
  const listeners = new Set<(event: ProjectedEvent) => void>()
  const emit = (event: ProjectedEvent) => {
    for (const listener of Array.from(listeners)) listener(event)
  }
  const running = new Set<string>()
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
    // A prompt for a session whose execution is already running is promoted
    // into it, so the engine opens no second execution and reports the
    // delivery it recorded — absent means the engine's own default, `steer`.
    prompt: mock(async (
      scope: { directory: string },
      sessionID: string,
      request: { text: string; id?: string; delivery?: "steer" | "queue" },
    ) => {
      const delivery = request.delivery ?? "steer"
      if (!running.has(sessionID)) {
        running.add(sessionID)
        if (options.execution !== "manual") {
          queueMicrotask(() => {
            emit({
              id: "evt_1",
              type: "session.text.delta",
              directory: scope.directory,
              hintOnly: true,
              data: { sessionID, assistantMessageID: "msg_a", ordinal: 0, delta: "hello" },
            })
            running.delete(sessionID)
            emit({
              id: "evt_2",
              type: "session.execution.succeeded",
              durable: { aggregateID: sessionID, seq: 2 },
              hintOnly: false,
              data: { sessionID },
            })
          })
        }
      }
      return { id: request.id ?? "msg_u", sessionID, createdAt: 1, text: request.text, delivery }
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
  const launchWrites: unknown[] = []
  const launchStore = { read: mock(async () => launchWrites.at(-1)), write: mock(async (document: unknown) => { launchWrites.push(document) }) }
  const launch = mock(async () => launchStore)
  const value = {
    sessions,
    catalog: { commands: mock(async () => []), agents: mock(async () => []), models: mock(async () => []) },
    interactions: { permissions: mock(async () => []), forms: mock(async () => []) },
    configuration: {},
    launch,
    events: {
      start() {},
      ready: async () => {},
      subscribe(listener: (event: ProjectedEvent) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      checkpoint: () => undefined,
    },
    host: { status: () => ({ lifecycle: options.lifecycle ?? "ready", events: "healthy" }) },
    providerUnavailableReason: (providerID: string) => options.unavailableProvider?.[providerID],
    close: async () => {},
  } as unknown as OpenCodeRuntime
  return { value, sessions, launch, launchWrites, emit, finish: (sessionID: string) => {
    running.delete(sessionID)
    emit({
      id: "evt_done",
      type: "session.execution.succeeded",
      durable: { aggregateID: sessionID, seq: 9 },
      hintOnly: false,
      data: { sessionID },
    })
  } }
}

function promptInput(text: string, id: string) {
  return {
    parts: [{ type: "text" as const, text }],
    userMessageId: `caller-user-${id}`,
    assistantMessageId: `caller-assistant-${id}`,
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
  }
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!condition()) throw new Error("condition never held")
}

function adapterFor(fake: ReturnType<typeof runtime>, directory: string) {
  return new OpenCodeSdkHarnessAdapter({ runtime: fake.value, workspaceID: "ws_1", directory })
}

describe("OpenCodeSdkHarnessAdapter", () => {
  test("a turn on an account the operator chose and the broker refuses never reaches the engine", async () => {
    const fake = runtime({ unavailableProvider: { anthropic: "auth_failed" } })
    const adapter = adapterFor(fake, "/work")

    const turn = async () => {
      for await (const _event of adapter.executeTurn(binding("/work", "ses_1"), promptInput("go", "1"))) { /* drain */ }
    }

    // Named, and before the prompt: the engine would otherwise run the turn on
    // its own login and bill an account nobody selected.
    await expect(turn()).rejects.toThrow(/credential selected for this workspace cannot be used: auth_failed/)
    expect(fake.sessions.prompt).not.toHaveBeenCalled()
  })

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

  test("hands a prompt for the running turn to it and reports the delivery the engine recorded", async () => {
    const fake = runtime({ execution: "manual" })
    const directory = workspace()
    const adapter = adapterFor(fake, directory)
    const events: unknown[] = []
    const turn = (async () => {
      for await (const event of adapter.executeTurn(binding(directory, "ses_1"), promptInput("start the work", "1"))) {
        events.push(event)
      }
    })()
    await until(() => fake.sessions.prompt.mock.calls.length === 1)

    expect(await adapter.steerTurn(binding(directory, "ses_1"), promptInput("also update the readme", "2")))
      .toEqual({ ok: true })
    expect(fake.sessions.prompt.mock.calls[1]?.[2]).toMatchObject({
      text: "also update the readme",
      id: "caller-user-2",
      delivery: "steer",
    })

    fake.finish("ses_1")
    await turn
    expect(events).toEqual([{ type: "finish", sessionId: "ses_1", harness: "opencode" }])
    expect(await adapter.steerTurn(binding(directory, "ses_1"), promptInput("too late", "3"))).toMatchObject({
      status: "no_active_turn",
    })
    expect(fake.sessions.prompt.mock.calls).toHaveLength(2)
  })

  test("steering a session with no running turn is refused rather than starting one", async () => {
    const fake = runtime({ execution: "manual" })
    const directory = workspace()
    const adapter = adapterFor(fake, directory)

    expect(await adapter.steerTurn(binding(directory, "ses_1"), promptInput("late", "3"))).toEqual({
      ok: false,
      status: "no_active_turn",
      message: "Session ses_1 has no running turn",
    })
    expect(fake.sessions.prompt).not.toHaveBeenCalled()
  })

  test("a prompt the engine records as queued is reported as declined, not as steered", async () => {
    const fake = runtime({ execution: "manual" })
    const directory = workspace()
    const adapter = adapterFor(fake, directory)
    const turn = (async () => {
      for await (const _event of adapter.executeTurn(binding(directory, "ses_1"), promptInput("start the work", "1"))) {
        // drained so the generator reaches its terminal event
      }
    })()
    await until(() => fake.sessions.prompt.mock.calls.length === 1)
    fake.sessions.prompt.mockImplementationOnce(async (_scope, sessionID, request) => ({
      id: request.id ?? "msg_u",
      sessionID,
      createdAt: 1,
      text: request.text,
      delivery: "queue" as const,
    }))

    expect(await adapter.steerTurn(binding(directory, "ses_1"), promptInput("then run the tests", "2"))).toEqual({
      ok: false,
      status: "declined",
      message: "OpenCode queued this prompt behind the running turn",
    })

    fake.finish("ses_1")
    await turn
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

  test("reports what an engine rejection said when the engine throws a plain object", async () => {
    const fake = runtime()
    const directory = workspace()
    fake.sessions.prompt.mockImplementationOnce(async () => {
      throw { name: "ValidationError", data: { message: `Expected a string starting with "msg_"` } }
    })
    const adapter = adapterFor(fake, directory)
    const events = []
    for await (const event of adapter.executeTurn(binding(directory, "ses_1"), {
      parts: [{ type: "text", text: "hi" }],
      assistantMessageId: "msg_a",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    })) events.push(event)

    expect(events).toEqual([{
      type: "error",
      error: `Expected a string starting with "msg_"`,
      harness: "opencode",
    }])
  })

  test("applies the runtime snapshot and Agent Plugins launch document through the launch policy", async () => {
    const fake = runtime()
    const directory = workspace()
    const adapter = adapterFor(fake, directory)
    const harness = { id: "opencode", access: "native" as const }

    await adapter.applyConfig({
      mcp: {
        docs: { type: "remote", url: "https://mcp.example", headers: { authorization: "Bearer t" } },
        files: { type: "stdio", command: "mcp-files", args: ["--root", "."], env: { HOME: "/tmp" }, disabled: true },
      },
      auth: {},
      harness,
      launch: {
        config: {
          skills: ["/plugins/review/skills"],
          mcp: { "review-1234abcd-tools": { type: "local", command: ["node", "tools.js"], cwd: "/plugins/review" } },
        },
      },
    })
    // Configuration only records the document; the first engine operation applies it.
    expect(fake.launch).not.toHaveBeenCalled()
    await adapter.listAgents(directory)
    expect(fake.launch).toHaveBeenCalledWith(expect.objectContaining({ workspaceID: "ws_1", directory }))
    // Snapshot servers are translated to the SDK shape; plugin servers already are.
    expect(fake.launchWrites).toEqual([{
      skills: ["/plugins/review/skills"],
      mcp: {
        docs: { type: "remote", url: "https://mcp.example", headers: { authorization: "Bearer t" } },
        files: { type: "local", command: ["mcp-files", "--root", "."], environment: { HOME: "/tmp" }, disabled: true },
        "review-1234abcd-tools": { type: "local", command: ["node", "tools.js"], cwd: "/plugins/review" },
      },
    }])

    // The next snapshot replaces the document wholesale: nothing lingers from the last write.
    await adapter.applyConfig({ mcp: {}, auth: {}, harness, launch: {} })
    expect(fake.launchWrites).toHaveLength(1)
    await adapter.listCommands(directory)
    expect(fake.launchWrites.at(-1)).toEqual({ skills: [], mcp: {} })

    await expect(adapter.applyConfig({ mcp: { broken: { type: "stdio" } }, auth: {}, harness, launch: {} }))
      .rejects.toThrow("OpenCode MCP server broken")
  })

  test("defers the launch document until the first engine operation", async () => {
    const fake = runtime({ lifecycle: "cold" })
    const directory = workspace()
    const adapter = adapterFor(fake, directory)
    const harness = { id: "opencode", access: "native" as const }

    await adapter.applyConfig({ mcp: {}, auth: {}, harness, launch: { config: { skills: ["/plugins/a/skills"] } } })
    // Configuring a read path must not boot the engine's per-location setup.
    expect(fake.launch).not.toHaveBeenCalled()
    expect(fake.launchWrites).toEqual([])
    expect(adapter.readHarnessCapabilities().harness).toBe("opencode")
    expect(await adapter.getSessionConfig(binding(directory, "ses_1"))).toMatchObject({ harness: { id: "opencode" } })
    expect(fake.launch).not.toHaveBeenCalled()

    // Pending-interaction reads reach the engine but never apply the document:
    // a request can only exist inside a turn that already launched.
    expect(await adapter.listPermissions(directory)).toEqual([])
    expect(await adapter.listQuestions(directory)).toEqual([])
    expect(fake.value.interactions.permissions).toHaveBeenCalledWith(expect.objectContaining({ directory }))
    expect(fake.value.interactions.forms).toHaveBeenCalledWith(expect.objectContaining({ directory }))
    expect(fake.launch).not.toHaveBeenCalled()

    // The first engine operation applies the accepted document exactly once, before it runs.
    await adapter.listAgents(directory)
    expect(fake.launch).toHaveBeenCalledTimes(1)
    expect(fake.launchWrites).toEqual([{ skills: ["/plugins/a/skills"], mcp: {} }])
    await adapter.listCommands(directory)
    await adapter.getSession(binding(directory, "ses_1"))
    expect(fake.launch).toHaveBeenCalledTimes(1)

    // A newer document supersedes the applied one on the next engine operation.
    await adapter.applyConfig({ mcp: {}, auth: {}, harness, launch: { config: { skills: ["/plugins/b/skills"] } } })
    expect(fake.launchWrites).toHaveLength(1)
    await adapter.listAgents(directory)
    expect(fake.launchWrites.at(-1)).toEqual({ skills: ["/plugins/b/skills"], mcp: {} })
    expect(fake.launch).toHaveBeenCalledTimes(2)
  })

  test("a failed deferred launch is retried by the next engine operation", async () => {
    const fake = runtime({ lifecycle: "cold" })
    const directory = workspace()
    const adapter = adapterFor(fake, directory)
    const harness = { id: "opencode", access: "native" as const }
    await adapter.applyConfig({ mcp: {}, auth: {}, harness, launch: {} })
    fake.launch.mockImplementationOnce(async () => { throw new Error("engine boot failed") })
    await expect(adapter.listAgents(directory)).rejects.toThrow("engine boot failed")
    await adapter.listAgents(directory)
    expect(fake.launchWrites).toEqual([{ skills: [], mcp: {} }])
  })
})
