import { mkdtempSync } from "fs"
import { removeTestTempDir } from "./harnesses/shared/test-temp-dir"
import { tmpdir } from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { AgentRuntimeTurnConflictError, createAgentRuntime } from "./runtime"
import type { AgentHarnessFactory, AgentRuntimeAbortResult } from "./runtime"
import { AgentRuntimeStaleTurnError, type AgentHarnessAdapter } from "./adapters"
import { claude, pi } from "./harnesses"
import { createMemoryRuntimeStore } from "./stores/memory"
import { createSqliteRuntimeStore } from "./stores/sqlite"
import { createConvexRuntimeStore } from "./stores/convex"
import { buildAssistantMessage, buildSession, messagePartUpdated, messageUpdated, permissionAsked, questionAsked, sessionError, sessionIdle, sessionUpdated, sessionUsage } from "./compat-events"
import type { AgentMessage, SessionConfig } from "./index"
import { storeRows } from "./test-utils/store-internals"

async function collectUntilFinish<T extends { payload: { type: string } }>(events: AsyncIterable<T>) {
  const out: T[] = []
  for await (const event of events) {
    out.push(event)
    if (event.payload.type === "finish" || event.payload.type === "session.error") return out
  }
  return out
}

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "agent-runtime-"))
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Session rows are `unknown` on the store port — the runtime owns their shape — so narrow on read. */
function lastTurnOf(rows: { getSession(id: string): unknown }, id: string) {
  return (rows.getSession(id) as { lastTurn?: { status?: string; error?: string } } | null)?.lastTurn
}

function testHarness(options: {
  sendMessage?: AgentHarnessAdapter["sendMessage"]
  abort?: (id: string) => Promise<AgentRuntimeAbortResult>
  runtimeConfigCalls?: string[]
  commitsStreamEvents?: boolean
} = {}): AgentHarnessFactory {
  const adapter: AgentHarnessAdapter = {
    ...(options.commitsStreamEvents ? { commitsStreamEvents: true as const } : {}),
    ...(options.runtimeConfigCalls
      ? {
          adapterCapabilities: ["runtime-config"] as const,
          setModel(model: string) {
            options.runtimeConfigCalls?.push(`setModel:${model}`)
          },
          setAuth() {},
          async applyConfig() {},
        }
      : {}),
    async listSessions() {
      return []
    },
    async getSession() {
      return null
    },
    async createSession() {
      options.runtimeConfigCalls?.push("createSession")
      return { id: "ses_test" }
    },
    async updateSession() {
      return null
    },
    async getSessionConfig() {
      return { harness: { id: "pi", access: "native" } }
    },
    async updateSessionConfig(_id, update) {
      return {
        harness: update.harness ?? { id: "pi", access: "native" },
        ...(update.model ? { model: update.model } : {}),
        variant: update.variant ?? null,
        agent: update.agent ?? null,
      }
    },
    async deleteSession() {},
    readHarnessCapabilities() {
      return {} as never
    },
    sendMessage: options.sendMessage ?? (async function* () {}),
    async getMessages() {
      return []
    },
    dispose() {},
    ...(options.abort ? { abort: options.abort } : {}),
  }
  return {
    id: "pi",
    access: "native",
    create: () => adapter,
  } as unknown as AgentHarnessFactory
}

function handoffHarness(input: {
  id: "pi" | "claude"
  prompts?: string[]
  handoffs?: string[]
  handoffSystems?: string[]
  messages?: AgentMessage[]
  turnError?: string
  configError?: string
  onAdapter?: (adapter: AgentHarnessAdapter) => void
}): AgentHarnessFactory {
  let config: SessionConfig = { harness: { id: input.id, access: "native" }, variant: null, agent: null }
  const adapter: AgentHarnessAdapter = {
    async listSessions() { return [] },
    async getSession(id) { return { id } },
    async createSession(_directory, _title, id = "ses_handoff") { return { id } },
    async createHandoffSession(_directory, _title, id, options) {
      input.handoffs?.push(id)
      input.handoffSystems?.push(options.system)
      return { id, agentSessionId: `${input.id}-native-thread` }
    },
    async updateSession() { return null },
    async getSessionConfig() { return config },
    async updateSessionConfig(_id, update) {
      if (input.configError) throw new Error(input.configError)
      config = {
        harness: update.harness ?? config.harness,
        ...(update.model === undefined ? config.model ? { model: config.model } : {} : update.model ? { model: update.model } : {}),
        variant: update.variant === undefined ? config.variant ?? null : update.variant,
        agent: update.agent === undefined ? config.agent ?? null : update.agent,
        ...(update.handoff === undefined
          ? config.handoff !== undefined ? { handoff: config.handoff } : {}
          : { handoff: update.handoff }),
      }
      return config
    },
    async deleteSession() {},
    readHarnessCapabilities() { return {} as never },
    async *sendMessage(id, prompt) {
      input.prompts?.push(prompt.system ?? "")
      if (input.turnError) throw new Error(input.turnError)
      yield messagePartUpdated({ id: `${id}-part`, sessionID: id, messageID: prompt.assistantMessageId, type: "text", text: `reply from ${input.id}` })
      yield { type: "finish", sessionId: id }
    },
    async getMessages() { return input.messages ?? [] },
    dispose() {},
  }
  input.onAdapter?.(adapter)
  return { id: input.id, access: "native", create: () => adapter } as unknown as AgentHarnessFactory
}

describe("createAgentRuntime", () => {
  test("resolves a target harness lazily for conversation handoff", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const handoffs: string[] = []
    const resolutions: string[] = []
    let targetAdapter: AgentHarnessAdapter | undefined
    handoffHarness({
      id: "claude",
      handoffs,
      onAdapter(adapter) {
        targetAdapter = adapter
      },
    })
    const runtime = createAgentRuntime({
      store,
      harnesses: [handoffHarness({ id: "pi" })],
      resolveHarness: async (harness) => {
        resolutions.push(`${harness.id}:${harness.access}`)
        if (!targetAdapter) throw new Error("target adapter was not created")
        return targetAdapter
      },
    })
    const session = await runtime.sessions.create({
      id: "ses_lazy",
      directory: "/repo",
      harness: { id: "pi", access: "native" },
    })

    await runtime.sessions.updateConfig(
      session.id,
      { harness: { id: "claude", access: "native" } },
      "/repo",
    )

    expect(resolutions).toEqual(["claude:native"])
    expect(handoffs).toEqual(["ses_lazy"])
    expect(rows.getSessionConfig(session.id)?.harness).toEqual({ id: "claude", access: "native" })
    runtime.dispose()
  })

  test("continues across harnesses in a fresh native thread with the completed transcript", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const prompts: string[] = []
    const handoffs: string[] = []
    const handoffSystems: string[] = []
    const runtime = createAgentRuntime({
      store,
      harnesses: [
        handoffHarness({
          id: "pi",
          messages: [
            {
              info: { id: "u1", sessionID: "ses_cross", role: "user" },
              parts: [{ id: "p1", sessionID: "ses_cross", messageID: "u1", type: "text", text: "inspect the bug" }],
            },
            {
              info: { id: "u1_r", sessionID: "ses_cross", role: "assistant", parentID: "u1" },
              parts: [{ id: "p1_r", sessionID: "ses_cross", messageID: "u1_r", type: "text", text: "reply from pi" }],
            },
          ] as AgentMessage[],
        }),
        handoffHarness({ id: "claude", prompts, handoffs, handoffSystems }),
      ],
    })
    const session = await runtime.sessions.create({ id: "ses_cross", directory: "/repo", harness: { id: "pi", access: "native" } })
    await runtime.turns.start({ sessionId: session.id, messageId: "u1", text: "inspect the bug" })
    await tick()

    await runtime.sessions.updateConfig(session.id, {
      harness: { id: "claude", access: "native" },
      model: { providerID: "claude", modelID: "sonnet" },
    }, "/repo")
    const continued = await runtime.turns.start({ sessionId: session.id, messageId: "u2", text: "continue" })

    expect(handoffs).toEqual(["ses_cross"])
    expect(handoffSystems).toHaveLength(1)
    expect(handoffSystems[0]).toContain("User:\ninspect the bug")
    expect(handoffSystems[0]).toContain("Assistant:\nreply from pi")
    expect(rows.getMessages(session.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parts: [expect.objectContaining({
          type: "handoff",
          from: { id: "pi", access: "native" },
          to: { id: "claude", access: "native" },
        })],
      }),
    ]))
    expect(continued.prompt.system).toContain('<session-handoff from="pi">')
    expect(continued.prompt.system).toContain("User:\ninspect the bug")
    expect(continued.prompt.system).toContain("Assistant:\nreply from pi")
    expect(continued.prompt.system).not.toContain("User:\ncontinue")
    await tick()
    expect(rows.getSessionConfig(session.id)?.handoff).toBeNull()
    expect(rows.getSessionConfig(session.id)?.harness).toEqual({ id: "claude", access: "native" })
    expect(prompts).toHaveLength(1)
    runtime.dispose()
  })

  test("snapshots canonical source-adapter history for a discovered session", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const prompts: string[] = []
    const runtime = createAgentRuntime({
      store,
      harnesses: [
        handoffHarness({
          id: "pi",
          messages: [
            {
              info: { id: "u-existing", sessionID: "ses_discovered", role: "user" },
              parts: [{ id: "p-user", sessionID: "ses_discovered", messageID: "u-existing", type: "text", text: "my dog is Tommy" }],
            },
            {
              info: { id: "a-existing", sessionID: "ses_discovered", role: "assistant", parentID: "u-existing" },
              parts: [{ id: "p-assistant", sessionID: "ses_discovered", messageID: "a-existing", type: "text", text: "I will remember that." }],
            },
          ] as AgentMessage[],
        }),
        handoffHarness({ id: "claude", prompts }),
      ],
    })
    const session = await runtime.sessions.create({ id: "ses_discovered", directory: "/repo", harness: { id: "pi", access: "native" } })

    await runtime.sessions.updateConfig(session.id, { harness: { id: "claude", access: "native" } }, "/repo")
    expect(rows.getMessages(session.id)).toEqual([
      expect.objectContaining({ parts: [expect.objectContaining({ type: "handoff" })] }),
    ])
    const pending = rows.getSessionConfig(session.id)?.handoff
    expect(pending).toMatchObject({
      from: { id: "pi", access: "native" },
      pending: true,
    })
    expect(pending?.transcript).toContain("User:\nmy dog is Tommy")

    const continued = await runtime.turns.start({ sessionId: session.id, messageId: "u-next", text: "what is my dog's name?" })

    expect(continued.prompt.system).toContain("Assistant:\nI will remember that.")
    await tick()
    expect(prompts).toHaveLength(1)
    runtime.dispose()
  })

  test("keeps a pending handoff when the first target-harness turn fails", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [handoffHarness({ id: "pi" }), handoffHarness({ id: "claude", turnError: "target failed" })],
    })
    const session = await runtime.sessions.create({ id: "ses_retry", directory: "/repo", harness: { id: "pi", access: "native" } })
    await runtime.turns.start({ sessionId: session.id, messageId: "u1", text: "inspect" })
    await tick()
    await runtime.sessions.updateConfig(session.id, { harness: { id: "claude", access: "native" } }, "/repo")

    await runtime.turns.start({ sessionId: session.id, messageId: "u2", text: "continue" })
    await tick()

    const pending = rows.getSessionConfig(session.id)?.handoff
    expect(pending).toMatchObject({
      from: { id: "pi", access: "native" },
      pending: true,
    })
    expect(pending?.transcript).toContain('<session-handoff from="pi">')
    runtime.dispose()
  })

  test("does not carry a source-harness model into the target harness", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [handoffHarness({ id: "pi" }), handoffHarness({ id: "claude" })],
    })
    const session = await runtime.sessions.create({
      id: "ses_model_boundary",
      directory: "/repo",
      harness: { id: "pi", access: "native" },
      model: { providerID: "openai", modelID: "gpt-5.5" },
    })

    await runtime.sessions.updateConfig(session.id, { harness: { id: "claude", access: "native" } }, "/repo")

    expect(rows.getSessionConfig(session.id)?.model).toBeUndefined()
    runtime.dispose()
  })

  test("restores the source binding when target-harness configuration fails", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [handoffHarness({ id: "pi" }), handoffHarness({ id: "claude", configError: "configuration failed" })],
    })
    const session = await runtime.sessions.create({ id: "ses_rollback", directory: "/repo", harness: { id: "pi", access: "native" } })

    await expect(runtime.sessions.updateConfig(
      session.id,
      { harness: { id: "claude", access: "native" } },
      "/repo",
    )).rejects.toThrow("configuration failed")

    expect(rows.getAgentSessionId(session.id)).toBe("ses_rollback")
    expect(rows.getSessionConfig(session.id)?.harness).toEqual({ id: "pi", access: "native" })
    expect(rows.getSessionConfig(session.id)?.handoff).toBeNull()
    runtime.dispose()
  })

  test("creates a session, starts a turn, and publishes events", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [pi()],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
      model: { providerID: "pi", modelID: "virtual" },
      title: "Facade",
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({
      sessionId: session.id,
      messageId: "msg_1",
      text: "exec: printf hello",
    })

    const published = await events
    expect(published.map((event) => event.payload.type)).toContain("finish")
    const opening = published.flatMap((event) => {
      if (event.payload.type === "session.status" && event.payload.properties.status.type === "busy") return ["busy"]
      if (event.payload.type !== "message.updated") return []
      if (event.payload.properties.info.id === "msg_1") return ["user"]
      if (event.payload.properties.info.id === "msg_1_r") return ["assistant"]
      return []
    })
    expect(opening.slice(0, 3)).toEqual(["busy", "user", "assistant"])
    expect(opening.filter((event) => event === "busy")).toHaveLength(1)
    const userMessages = published.filter((event) =>
      event.payload.type === "message.updated" && event.payload.properties.info.role === "user"
    )
    expect(userMessages).toHaveLength(1)
    await tick()
    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: null,
      lastTurn: { status: "completed", assistantMessageId: "msg_1_r" },
    })
    await expect(runtime.events.list(session.id)).resolves.toMatchObject([
      { info: { role: "user" } },
      { info: { role: "assistant" } },
    ])
    runtime.dispose()
  })

  test("carries a turn permission mode into the harness prompt", async () => {
    const modes: Array<string | undefined> = []
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* (_id, input) {
          modes.push(input.permissionMode)
        },
      })],
    })
    const session = await runtime.sessions.create({ directory: undefined, harness: { id: "pi", access: "native" } })

    await runtime.turns.start({ sessionId: session.id, text: "hello", permissionMode: "agent-full-access" })
    await tick()

    expect(modes).toEqual(["agent-full-access"])
    runtime.dispose()
  })

  test("leaves an operator ACP model at its own default when no model is selected", async () => {
    const models: Array<{ providerID: string; modelID: string }> = []
    const base = testHarness({
      sendMessage: async function* (_id, input) {
        models.push(input.model)
      },
    })
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [{ ...base, id: "openclaw", access: "acp" } as AgentHarnessFactory],
    })
    const session = await runtime.sessions.create({
      directory: "/workspace",
      harness: { id: "openclaw", access: "acp" },
    })

    const turn = await runtime.turns.start({ sessionId: session.id, text: "hello" })
    await tick()

    expect(turn.prompt.model).toEqual({ providerID: "acp:openclaw", modelID: "default" })
    expect(models).toEqual([{ providerID: "acp:openclaw", modelID: "default" }])
    runtime.dispose()
  })

  test("applies the selected runtime model before creating a session", async () => {
    const calls: string[] = []
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({ runtimeConfigCalls: calls })],
    })

    await runtime.sessions.create({
      directory: "/workspace",
      harness: { id: "pi", access: "native" },
      model: { providerID: "pi", modelID: "gpt-5.5" },
    })

    expect(calls).toEqual(["setModel:gpt-5.5", "createSession"])
    runtime.dispose()
  })

  test("commits streamed compatibility events to replay before publishing", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield messagePartUpdated({
            id: "part_1",
            sessionID: id,
            messageID: "msg_1_r",
            type: "text",
            text: "streamed reply",
          })
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await events
    await tick()

    expect(rows.getMessages(session.id)).toMatchObject([
      { info: { id: "msg_1", role: "user" } },
      {
        info: { id: "msg_1_r", role: "assistant" },
        parts: [{ id: "part_1", text: "streamed reply" }],
      },
    ])
    runtime.dispose()
  })

  test("aliases emitted assistant ids back to the submitted assistant id", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          // ACP providers can publish the authoritative usage observation
          // before assistant metadata establishes the provider-id alias.
          yield sessionUsage({
            sessionID: id,
            messageID: "actual-assistant",
            contextSize: 12,
            contextUsed: 12,
            observation: {
              kind: "cumulative",
              tokens: { input: 7, output: 5, reasoning: null, cache: { read: null, write: null } },
            },
          })
          yield messageUpdated(buildAssistantMessage({
            id: "actual-assistant",
            sessionID: id,
            parentID: "msg_1",
            agent: "build",
            model: { providerID: "pi", modelID: "virtual" },
            directory: "",
          }))
          yield messagePartUpdated({
            id: "part_1",
            sessionID: id,
            messageID: "actual-assistant",
            type: "text",
            text: "aliased reply",
          })
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    const published = await events
    await tick()

    expect(rows.getMessages(session.id)).toMatchObject([
      { info: { id: "msg_1", role: "user" } },
      {
        info: { id: "msg_1_r", role: "assistant" },
        parts: [{ id: "part_1", text: "aliased reply" }],
      },
    ])
    expect(rows.getMessages(session.id)).toHaveLength(2)
    expect(published.find((event) => event.payload.type === "session.usage")?.payload).toMatchObject({
      properties: { sessionID: session.id, messageID: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("aliases assistant parts even when they arrive before assistant metadata", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield messagePartUpdated({
            id: "part_1",
            sessionID: id,
            messageID: "actual-assistant",
            type: "text",
            text: "part-first reply",
          })
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await events
    await tick()

    expect(rows.getMessages(session.id)).toMatchObject([
      { info: { id: "msg_1", role: "user" } },
      {
        info: { id: "msg_1_r", role: "assistant" },
        parts: [{ id: "part_1", text: "part-first reply" }],
      },
    ])
    expect(rows.getMessages(session.id)).toHaveLength(2)
    runtime.dispose()
  })

  test("projects runtime-native text chunks into durable replay", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield { type: "text-delta", delta: "projected reply" }
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await events
    await tick()

    expect(rows.getMessages(session.id)).toMatchObject([
      { info: { id: "msg_1", role: "user" } },
      {
        info: { id: "msg_1_r", role: "assistant" },
        parts: [{ type: "text", text: "projected reply" }],
      },
    ])
    runtime.dispose()
  })

  test("event subscriptions close immediately when returned while idle", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [pi()],
    })
    const iterator = runtime.events.subscribe({ sessionId: "idle" })[Symbol.asyncIterator]()

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    runtime.dispose()
  })

  test("event subscriptions attach identity and stop an already-open subscriber after revocation", async () => {
    const decisions: string[] = []
    let revoked = false
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield sessionUpdated(buildSession({ id, directory: "/repo", title: "Session" }))
          yield { type: "finish", sessionId: id }
        },
      })],
      eventDelivery: ({ identity }) => {
        decisions.push(`${identity.actorKind}:${identity.actorId}:${identity.connectionId}`)
        if (identity.actorId !== "actor_participant") return "terminate"
        return revoked ? "terminate" : "deliver"
      },
    })
    const session = await runtime.sessions.create({
      directory: "/repo",
      harness: { id: "pi", access: "native" },
    })
    const allowed = runtime.events.subscribe({
      sessionId: session.id,
      identity: {
        connectionId: "connection_allowed",
        actorId: "actor_participant",
        actorKind: "human",
        orgId: "org_1",
        workspaceId: "ws_1",
        role: "editor",
      },
    })[Symbol.asyncIterator]()
    const denied = runtime.events.subscribe({
      sessionId: session.id,
      identity: {
        connectionId: "connection_denied",
        actorId: "actor_workspace_only",
        actorKind: "human",
        orgId: "org_1",
        workspaceId: "ws_1",
        role: "editor",
      },
    })[Symbol.asyncIterator]()

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_identity", text: "hello" })
    await expect(allowed.next()).resolves.toMatchObject({ done: false })
    await expect(denied.next()).resolves.toEqual({ done: true, value: undefined })
    revoked = true
    await expect(allowed.next()).resolves.toEqual({ done: true, value: undefined })

    expect(decisions).toContain("human:actor_participant:connection_allowed")
    expect(decisions).toContain("human:actor_workspace_only:connection_denied")
    runtime.dispose()
  })

  test("rejects turn starts before returning when the session is unknown", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [pi(), claude({ access: "native" })],
    })

    await expect(runtime.turns.start({
      sessionId: "missing",
      text: "hello",
    })).rejects.toThrow("Session missing not found")
    runtime.dispose()
  })

  test("rejects incomplete actor attribution before persisting a turn", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({ store, harnesses: [testHarness()] })
    const session = await runtime.sessions.create({ directory: "/repo", harness: { id: "pi", access: "native" } })

    await expect(runtime.turns.start({
      sessionId: session.id,
      text: "hello",
      actorId: "actor_1",
    } as never)).rejects.toThrow("Turn actor id and kind must be provided together")
    expect(rows.getMessages(session.id)).toEqual([])
    runtime.dispose()
  })

  test("leaves permission-mode application to the admitted harness turn", async () => {
    const store = createMemoryRuntimeStore()
    const modes: Array<string | undefined> = []
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (_id, input) {
          modes.push(input.permissionMode)
        },
      })],
    })
    const session = await runtime.sessions.create({ directory: "/repo", harness: { id: "pi", access: "native" } })

    await runtime.turns.start({
      sessionId: session.id,
      text: "hello",
      permissionMode: "plan",
    })
    await tick()

    expect(modes).toEqual(["plan"])
    runtime.dispose()
  })

  test("publishes the authoritative busy status before a slow native harness yields", async () => {
    let release!: () => void
    const harnessReady = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          await harnessReady
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: "/repo",
      harness: { id: "pi", access: "native" },
    })
    const iterator = runtime.events.subscribe({ sessionId: session.id })[Symbol.asyncIterator]()

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    const first = await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ])

    expect(first).not.toBe("timeout")
    expect(first).toMatchObject({
      done: false,
      value: {
        sessionId: session.id,
        directory: "/repo",
        payload: {
          type: "session.status",
          properties: { sessionID: session.id, status: { type: "busy" } },
        },
      },
    })

    release()
    await iterator.return?.()
    runtime.dispose()
  })

  test("atomically rejects a second turn before permission or message state changes", async () => {
    let finish: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      finish = resolve
    })
    const permissionModes: Array<string | undefined> = []
    const admitted: string[] = []
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id, input) {
          permissionModes.push(input.permissionMode)
          await blocked
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })

    await runtime.turns.start({
      sessionId: session.id,
      messageId: "winner",
      text: "first",
      permissionMode: "winner-mode",
      onAdmitted: () => admitted.push("winner"),
    })
    await expect(runtime.turns.start({
      sessionId: session.id,
      messageId: "loser",
      text: "second",
      permissionMode: "loser-mode",
      onAdmitted: () => admitted.push("loser"),
    })).rejects.toBeInstanceOf(AgentRuntimeTurnConflictError)

    expect(admitted).toEqual(["winner"])
    expect(permissionModes).toEqual(["winner-mode"])
    expect((rows.getMessages(session.id) as Array<{ info: { id: string } }>).map((message) => message.info.id))
      .toEqual(["winner", "winner_r"])

    finish?.()
    await tick()
    runtime.dispose()
  })

  test("keeps admission busy after abort until the original turn settles", async () => {
    const finishes: Array<() => void> = []
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          await new Promise<void>((resolve) => finishes.push(resolve))
          yield { type: "finish", sessionId: id }
        },
        abort: async () => ({ ok: true, status: "cancelled" }),
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })

    await runtime.turns.start({ sessionId: session.id, messageId: "first", text: "first" })
    await expect(runtime.turns.abort(session.id)).resolves.toEqual({ ok: true, status: "cancelled" })
    await expect(runtime.turns.start({ sessionId: session.id, messageId: "second", text: "second" }))
      .rejects.toBeInstanceOf(AgentRuntimeTurnConflictError)

    finishes[0]?.()
    await tick()
    await runtime.turns.start({ sessionId: session.id, messageId: "third", text: "third" })

    finishes[1]?.()
    await tick()
    runtime.dispose()
  })

  test("lists sessions created without a directory", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [pi()],
    })

    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
      title: "Central",
    })

    await expect(runtime.sessions.list(undefined)).resolves.toMatchObject([{ id: session.id, title: "Central" }])
    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({ status: null })
    expect((await runtime.sessions.get(session.id))?.lastTurn).toBeUndefined()
    runtime.dispose()
  })

  test("records compat idle as a completed turn outcome", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield sessionIdle(id)
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: null,
      lastTurn: { status: "completed", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("records a durable turn outcome when a committing adapter already emitted terminal events", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        commitsStreamEvents: true,
        sendMessage: async function* (id) {
          yield sessionIdle(id)
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      lastTurn: { status: "completed", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("rejects a committing adapter terminal write after a durable fence takeover", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    let runtimeStore: {
      startTurn(input: unknown): unknown
      appendEvent(input: unknown): unknown
    } | undefined
    let admissionValid = true
    let commitError: unknown
    const base = testHarness({
      commitsStreamEvents: true,
      sendMessage: async function* (id, _prompt, _directory, writeContext) {
        runtimeStore?.startTurn({
          sessionId: id,
          assistantMessageId: "replacement_r",
          agent: "build",
          model: { providerID: "test", modelID: "replacement" },
          parts: [],
          fencingToken: 2,
        })
        admissionValid = false
        try {
          runtimeStore?.appendEvent({
            sessionId: id,
            payload: sessionIdle(id),
            fencingToken: writeContext?.fencingToken,
          })
        } catch (error) {
          commitError = error
        }
      },
    }) as unknown as {
      id: "pi"
      access: "native"
      create(context: { store: typeof runtimeStore }): AgentHarnessAdapter
    }
    const harness = {
      id: base.id,
      access: base.access,
      create(context: { store: NonNullable<typeof runtimeStore> }) {
        runtimeStore = context.store
        return base.create(context)
      },
    } as unknown as AgentHarnessFactory
    const runtime = createAgentRuntime({ store, harnesses: [harness] })
    const session = await runtime.sessions.create({
      id: "ses_fenced",
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })

    await runtime.turns.start({
      sessionId: session.id,
      messageId: "user_1",
      text: "hello",
      admission: {
        valid: () => admissionValid,
        fencingToken: () => 1,
      },
    })
    await tick()

    expect(commitError).toBeInstanceOf(AgentRuntimeStaleTurnError)
    expect(rows.getSession(session.id)).toMatchObject({
      status: "busy",
    })
    expect((rows.getMessages(session.id) as Array<{ info: { id: string } }>).map((message) => message.info.id))
      .toContain("replacement_r")
    expect(lastTurnOf(rows, session.id)).toBeUndefined()
    runtime.dispose()
  })

  test("auto-titles placeholder sessions on first idle", async () => {
    const store = createMemoryRuntimeStore()
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield sessionIdle(id)
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
      title: "New session - 2026-07-08T09:09:30.378Z",
    })

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "Please fix the terminal pane" })
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      title: "fix the terminal pane",
      lastTurn: { status: "completed", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("records compat errors as failed turn outcomes", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          yield sessionError("protocol down", id)
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    const received = await events
    const terminalIndex = received.findIndex((event) => event.payload.type === "session.error")
    const messageErrorIndex = received.findIndex((event) =>
      event.payload.type === "message.updated" &&
      event.payload.properties.info.role === "assistant" &&
      !!event.payload.properties.info.error
    )
    expect(messageErrorIndex).toBeGreaterThan(-1)
    expect(messageErrorIndex).toBeLessThan(terminalIndex)
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: "error",
      lastTurn: { status: "failed", error: "protocol down", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("records thrown adapter errors as failed turn outcomes", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* () {
          throw new Error("adapter exploded")
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    const received = await events
    const terminalIndex = received.findIndex((event) => event.payload.type === "session.error")
    const messageErrorIndex = received.findIndex((event) =>
      event.payload.type === "message.updated" &&
      event.payload.properties.info.role === "assistant" &&
      !!event.payload.properties.info.error
    )
    expect(messageErrorIndex).toBeGreaterThan(-1)
    expect(messageErrorIndex).toBeLessThan(terminalIndex)
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: "error",
      lastTurn: { status: "failed", error: "adapter exploded", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("keeps a cancelled outcome when a late stream completion arrives", async () => {
    let release: (() => void) | undefined
    const streamDone = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          await streamDone
          yield { type: "finish", sessionId: id }
        },
        abort: async () => ({ ok: true, status: "cancelled" }),
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "hello" })
    await expect(runtime.turns.abort(session.id)).resolves.toMatchObject({ ok: true, status: "cancelled" })
    release?.()
    await tick()

    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: null,
      lastTurn: { status: "cancelled", reason: "abort", assistantMessageId: "msg_1_r" },
    })
    runtime.dispose()
  })

  test("removes pending interactions when deleting a session", () => {
    const store = storeRows(createMemoryRuntimeStore())
    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      agentSessionId: "ses_1",
    })
    store.appendEvent({
      sessionId: "ses_1",
      payload: permissionAsked({
        id: "perm_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["*"],
        always: [],
        metadata: {},
      }),
    })
    store.appendEvent({
      sessionId: "ses_1",
      payload: questionAsked({
        id: "question_1",
        sessionID: "ses_1",
        questions: [{
          question: "What should the new service be called?",
          header: "Name?",
          options: [{ label: "api", description: "Public HTTP surface" }],
        }],
      }),
    })

    expect(store.listPermissions("/repo")).toHaveLength(1)
    expect(store.listQuestions("/repo")).toHaveLength(1)

    store.deleteSession("ses_1")

    expect(store.listPermissions("/repo")).toEqual([])
    expect(store.listQuestions("/repo")).toEqual([])
  })

  test("preserves message parts across later message metadata updates", async () => {
    const store = storeRows(createMemoryRuntimeStore())
    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      agentSessionId: "ses_1",
    })
    const info = buildAssistantMessage({
      id: "msg_1",
      sessionID: "ses_1",
      parentID: "user_1",
      agent: "build",
      model: { providerID: "pi", modelID: "virtual" },
      directory: "/repo",
    })

    store.appendEvent({ sessionId: "ses_1", payload: messageUpdated(info) })
    store.appendEvent({
      sessionId: "ses_1",
      payload: messagePartUpdated({
        id: "part_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "hello",
      }),
    })
    store.appendEvent({
      sessionId: "ses_1",
      payload: messageUpdated({ ...info, time: { ...info.time, completed: Date.now() } }),
    })

    expect(store.getMessages("ses_1")).toMatchObject([
      {
        info: { id: "msg_1" },
        parts: [{ id: "part_1", text: "hello" }],
      },
    ])
  })

  test("persists session.updated into the store projection", () => {
    const store = storeRows(createMemoryRuntimeStore())
    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      title: "Old",
      agentSessionId: "ses_1",
    })

    store.appendEvent({
      sessionId: "ses_1",
      payload: sessionUpdated(buildSession({
        id: "ses_1",
        directory: "/repo",
        title: "Generated title",
      })),
    })

    expect(store.getSession("ses_1")).toMatchObject({ title: "Generated title" })
  })

  test("persists sessions with the sqlite store subpath", async () => {
    const root = tempRoot()
    try {
      const first = createAgentRuntime({
        store: createSqliteRuntimeStore({ root }),
        harnesses: [pi()],
      })
      const session = await first.sessions.create({
        directory: undefined,
        harness: { id: "pi", access: "native" },
        title: "Durable",
      })
      const events = collectUntilFinish(first.events.subscribe({ sessionId: session.id }))
      await first.turns.start({ sessionId: session.id, messageId: "msg_1", text: "exec: printf durable" })
      await events
      await tick()
      first.dispose()

      const second = createAgentRuntime({
        store: createSqliteRuntimeStore({ root }),
        harnesses: [pi()],
      })
      await expect(second.sessions.get(session.id)).resolves.toMatchObject({ id: session.id, title: "Durable" })
      await expect(second.sessions.list(undefined)).resolves.toMatchObject([{
        id: session.id,
        title: "Durable",
        status: null,
        lastTurn: { status: "completed", assistantMessageId: "msg_1_r" },
      }])
      second.dispose()
    } finally {
      removeTestTempDir(root)
    }
  })

  test("persists failed turn outcomes with the sqlite store subpath", async () => {
    const root = tempRoot()
    try {
      const first = createAgentRuntime({
        store: createSqliteRuntimeStore({ root }),
        harnesses: [testHarness({
          sendMessage: async function* () {
            throw new Error("sqlite failure")
          },
        })],
      })
      const session = await first.sessions.create({
        directory: undefined,
        harness: { id: "pi", access: "native" },
        title: "Failed durable",
      })
      const events = collectUntilFinish(first.events.subscribe({ sessionId: session.id }))
      await first.turns.start({ sessionId: session.id, messageId: "msg_1", text: "fail" })
      await events
      await tick()
      first.dispose()

      const second = createAgentRuntime({
        store: createSqliteRuntimeStore({ root }),
        harnesses: [testHarness()],
      })
      await expect(second.sessions.get(session.id)).resolves.toMatchObject({
        id: session.id,
        title: "Failed durable",
        status: "error",
        lastTurn: { status: "failed", error: "sqlite failure", assistantMessageId: "msg_1_r" },
      })
      second.dispose()
    } finally {
      removeTestTempDir(root)
    }
  })

  test("sqlite store coalesces event bursts into a single snapshot write", async () => {
    const root = tempRoot()
    try {
      const store = storeRows(createSqliteRuntimeStore({ root }))
      const internals = store as unknown as {
        persist(): void
        bindSession(input: { sessionId: string; directory: string; agentSessionId: string }): void
        appendEvent(input: { sessionId: string; payload: unknown }): unknown
        close(): void
      }
      let persistCount = 0
      const originalPersist = internals.persist.bind(internals)
      internals.persist = () => {
        persistCount++
        originalPersist()
      }
      internals.bindSession({ sessionId: "ses_1", directory: "/repo", agentSessionId: "ses_1" })
      for (let i = 0; i < 100; i++) {
        internals.appendEvent({
          sessionId: "ses_1",
          payload: sessionUpdated(buildSession({
            id: "ses_1",
            directory: "/repo",
            title: `Streamed ${i}`,
          })),
        })
      }
      expect(persistCount).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(persistCount).toBe(1)
      internals.close()
      expect(persistCount).toBe(1)

      const reopened = createSqliteRuntimeStore({ root }) as unknown as {
        getSession(id: string): { title: string | null } | null
        close(): void
      }
      expect(reopened.getSession("ses_1")).toMatchObject({ title: "Streamed 99" })
      reopened.close()
    } finally {
      removeTestTempDir(root)
    }
  })

  test("keeps convex isolated behind its subpath", () => {
    expect(() => createConvexRuntimeStore()).toThrow("requires a Convex client, authority, or projection callbacks")
    expect(() => createConvexRuntimeStore({ client: {} })).toThrow("client-backed persistence is not implemented")
    expect(createConvexRuntimeStore({ projection: {} })).toBeTruthy()
  })

  test("surfaces convex projection failures from flush", async () => {
    const store = storeRows(createConvexRuntimeStore({
      projection: {
        syncSession: async () => {
          throw new Error("projection down")
        },
      },
    }))

    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      agentSessionId: "ses_1",
    })

    await expect(store.flush()).rejects.toThrow("projection down")
  })

  test("syncs sessions and messages through a hosted Convex authority", async () => {
    const calls: Array<{ method: string; args: unknown }> = []
    const store = storeRows(createConvexRuntimeStore({
      auth: { token: "signed" },
      workspaceId: "ws_1",
      authority: {
        openWorkspace: async (_auth, args) => calls.push({ method: "openWorkspace", args }),
        upsertSessionVisibility: async (_auth, args) => calls.push({ method: "upsertSessionVisibility", args }),
        syncSessionMessages: async (_auth, args) => calls.push({ method: "syncSessionMessages", args }),
      },
    }))

    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      title: "Review",
      agentSessionId: "ses_1",
    })
    store.startTurn({
      sessionId: "ses_1",
      userMessageId: "msg_user",
      assistantMessageId: "msg_assistant",
      agent: "build",
      model: { providerID: "pi", modelID: "virtual" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.appendEvent({
      sessionId: "ses_1",
      payload: messagePartUpdated({
        id: "part_1",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "text",
        text: "done",
      }),
    })
    await store.flush()

    expect(calls.map((call) => call.method)).toEqual([
      "openWorkspace",
      "upsertSessionVisibility",
      "openWorkspace",
      "upsertSessionVisibility",
      "openWorkspace",
      "syncSessionMessages",
      "openWorkspace",
      "syncSessionMessages",
    ])
    expect(calls[1]?.args).toMatchObject({
      workspaceId: "ws_1",
      sessions: [{ sessionId: "ses_1", title: "Review" }],
    })
    expect(calls.at(-1)?.args).toMatchObject({
      workspaceId: "ws_1",
      sessionId: "ses_1",
      messages: [
        { info: { id: "msg_user", role: "user" }, parts: [{ text: "hello" }] },
        { info: { id: "msg_assistant", role: "assistant" }, parts: [{ text: "done" }] },
      ],
    })
  })

  test("syncs turn outcomes through convex session projection", async () => {
    const sessions: unknown[] = []
    const store = storeRows(createConvexRuntimeStore({
      projection: {
        syncSession: (session) => {
          sessions.push(session)
        },
      },
    }))

    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      title: "Review",
      agentSessionId: "ses_1",
    })
    store.startTurn({
      sessionId: "ses_1",
      userMessageId: "msg_user",
      assistantMessageId: "msg_assistant",
      agent: "build",
      model: { providerID: "pi", modelID: "virtual" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.finishTurn({
      sessionId: "ses_1",
      assistantMessageId: "msg_assistant",
      outcome: { status: "completed", completedAt: 123 },
    })
    await store.flush()

    expect(sessions.at(-1)).toMatchObject({
      id: "ses_1",
      lastTurn: { status: "completed", completedAt: 123, assistantMessageId: "msg_assistant" },
    })
  })

  test("records failed turn errors on the active assistant message", () => {
    const store = storeRows(createMemoryRuntimeStore())
    store.bindSession({
      sessionId: "ses_1",
      directory: "/repo",
      title: "Review",
      agentSessionId: "ses_1",
    })
    store.startTurn({
      sessionId: "ses_1",
      userMessageId: "msg_user",
      assistantMessageId: "msg_assistant",
      agent: "build",
      model: { providerID: "codex-app-server", modelID: "gpt-5.5" },
      parts: [{ type: "text", text: "hello" }],
    })
    const finished = store.finishTurn({
      sessionId: "ses_1",
      assistantMessageId: "msg_assistant",
      outcome: { status: "failed", completedAt: 123, error: "Codex authentication failed" },
    })

    expect(finished?.events.map((event) => event.type)).toEqual(["message.updated", "session.error"])

    expect(store.getMessages("ses_1")[1]).toMatchObject({
      info: {
        id: "msg_assistant",
        error: { data: { message: "Codex authentication failed", firstTurnErrorClass: "credential" } },
        time: { completed: 123 },
      },
    })
  })

  test("memory store starts the same active assistant turn exactly once", () => {
    const store = storeRows(createMemoryRuntimeStore())
    store.bindSession({
      sessionId: "ses_once",
      directory: "/repo",
      agentSessionId: "agent_once",
    })
    const input = {
      sessionId: "ses_once",
      agentSessionId: "agent_once",
      userMessageId: "msg_once",
      assistantMessageId: "msg_once_r",
      agent: "build",
      model: { providerID: "claude-sdk", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    }

    const first = store.startTurn(input)
    const replay = store.startTurn(input)
    if (!first || !replay) throw new Error("memory store did not return its committed turn start")

    expect(replay).toMatchObject({
      sessionId: first.sessionId,
      seq: first.seq,
      createdAt: first.createdAt,
      agentSessionId: first.agentSessionId,
      events: [],
    })
    expect(store.getMessages("ses_once")).toHaveLength(2)
  })

  test("keeps the specific runtime error after a generic error status", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* () {
          yield { type: "session-status", status: "error" }
          yield { type: "error", error: "Codex authentication failed with 401 Unauthorized" }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: "/repo",
      harness: { id: "pi", access: "native" },
      model: { providerID: "pi", modelID: "virtual" },
    })

    await runtime.turns.start({
      sessionId: session.id,
      text: "hello",
      model: { providerID: "pi", modelID: "virtual" },
    })
    while (!lastTurnOf(rows, session.id)) await tick()

    expect(lastTurnOf(rows, session.id)).toMatchObject({
      status: "failed",
      error: "Codex authentication failed with 401 Unauthorized",
    })
  })
})
