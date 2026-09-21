import path from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { removeTestTempDir } from "./test-temp-dir"
import { createSqliteRuntimeStore } from "../../stores/sqlite"
import { describe, expect, test } from "bun:test"
import { executeTestTurn, executionBinding } from "../../test-utils/execution-binding"
import type { WithInternals } from "../../test-utils/class-internals"
import { SdkRuntimeAdapter, type SdkRuntimeDriver, type SdkRuntimeDriverHost } from "./sdk-runtime-adapter"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import { createCodexAppServerDriver } from "../codex/driver"
import type { CodexGoalController } from "../codex/goal"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { runtimeSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeStreamEvent } from "../../index"
import { eventSessionId, type CompatEnvelope } from "../../compat-events"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../../runtime-event-hub"

function minimalSdkRuntimeDriver(): SdkRuntimeDriver {
  return {
    type: "codex",
    instructionChannel: "thread-start",
    interactions: { permissions: true, questions: true },
    applyConfig() {},
    createAgentSession: async () => ({ id: "thread-1" }),
    deleteAgentSession() {},
    createRuntime() {
      const snapshot = () => runtimeSnapshot({ harness: "codex", threadId: "thread-1", adapterState: {} })
      return {
        ingest: () => ({ state: {}, events: [], snapshot: snapshot() }),
        snapshot,
      }
    },
    runTurn: async () => {},
    readRuntimeHealth: () => ({ status: "ok" }),
    configOptions: async () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "default", selectOptions: [{ id: "default", name: "Default" }] }],
    peekConfigOptions: () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "default", selectOptions: [{ id: "default", name: "Default" }] }],
  }
}

/** A native Goal driver that holds nothing — the state a process restart leaves. */
function nativeGoalStub(): NonNullable<SdkRuntimeDriver["nativeGoal"]> {
  return {
    capabilities: () => ({
      implemented: true,
      available: true,
      actions: [],
      recovery: "blocked",
      optionalFields: [],
    }),
    read: async () => null,
    run: async () => {},
    stop: async () => null,
  }
}

function projectedGoal() {
  return {
    sessionId: "session-1",
    objective: "Ship safely",
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("SdkRuntimeAdapter", () => {
  test("a host-owned MCP child observation only binds the parent tool edge", async () => {
    const directory = path.resolve("/repo")
    const store = createMemoryRuntimeStore()
    const childConfig = { harness: { id: "claude", access: "native" }, model: { providerID: "claude", modelID: "child-model" }, variant: null, agent: null } as const
    const adapter = new SdkRuntimeAdapter({
      store,
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        runTurn: async (input) => {
          await input.observeSubagent({ observation: {
            observationId: "mcp-result", subagentKey: "host-child", toolCallId: "spawn-call", toolCallRole: "spawn",
            providerKind: "claxedo", providerId: "child", childSessionId: "child", status: "completed", transcript: { kind: "live" },
          } })
        },
      }),
    })
    try {
      await adapter.createSession(directory, "parent", "parent")
      // The host mints every claxedo row before create_subagent answers; a
      // tool edge for a row the host never created is not a binding.
      await store.admit!({
        parentSessionId: "parent",
        observation: {
          observationId: "host:create:child", subagentKey: "host-child", mode: "background", status: "pending",
          label: "claude subagent", providerKind: "claxedo", providerId: "child", childSessionId: "child", transcript: { kind: "live" },
        },
        allocateKey: () => "host-child",
      })
      store.bindSession({ sessionId: "child", parentSessionId: "parent", directory, agentSessionId: "claude-child-thread" })
      store.updateSessionConfig("child", childConfig)
      for await (const _event of executeTestTurn(adapter, "parent", {
        parts: [], userMessageId: "parent-user", assistantMessageId: "parent-answer", agent: "build",
        model: { providerID: "codex", modelID: "parent-model" },
      }, directory)) {}
      expect(store.getAgentSessionId("child")).toBe("claude-child-thread")
      expect(store.getSessionConfig("child")).toEqual(childConfig)
      expect(store.getMessages("child")).toEqual([])
      expect(store.listSubagents!("parent")[0]).toMatchObject({ childSessionId: "child", toolCallEdges: [{ toolCallId: "spawn-call", role: "spawn" }] })
    } finally {
      await adapter.dispose()
    }
  })

  test.each(["prompt", "goal"] as const)("disposal awaits the full committing %s producer after its driver stops", async (kind) => {
    const root = mkdtempSync(path.join(tmpdir(), "sdk-shutdown-"))
    const store = createSqliteRuntimeStore({ root })
    let closed = 0
    const close = store.close?.bind(store)
    store.close = () => { closed++; close?.() }
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let start!: () => void
    const started = new Promise<void>((resolve) => { start = resolve })
    const adapter = new SdkRuntimeAdapter({
      createStore: () => store,
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        runTurn: async () => { start(); await held; throw new Error("driver shutdown tail") },
        nativeGoal: {
          ...nativeGoalStub(),
          run: async (_turn, _objective, onGoal) => {
            onGoal({ sessionId: "session-1", objective: "goal", status: "active", createdAt: 1, updatedAt: 1 })
            start()
            await held
            throw new Error("driver shutdown tail")
          },
        },
      }),
    })
    let consume = Promise.resolve()
    try {
      await adapter.createSession(root, undefined, "session-1")
      if (kind === "goal") await adapter.goals!.start("session-1", { objective: "goal" }, root)
      else consume = (async () => { for await (const _event of executeTestTurn(adapter, "session-1", {
        parts: [], userMessageId: "user-1", assistantMessageId: "assistant-1", agent: "build",
        model: { providerID: "codex", modelID: "test" },
      }, root)) {} })()
      await started
      const shutdown = adapter.dispose()
      expect(adapter.dispose()).toBe(shutdown)
      expect(closed).toBe(0)
      release()
      await consume
      await shutdown
      expect(closed).toBe(1)
      const reopened = createSqliteRuntimeStore({ root })
      try { expect(JSON.stringify(reopened.getMessages("session-1"))).toContain("driver shutdown tail") }
      finally { reopened.close?.() }
    } finally {
      release()
      await consume
      await adapter.dispose()
      removeTestTempDir(root)
    }
  })

  test("disables native Goal continuation before aborting its active turn", async () => {
    const order: string[] = []
    let publishActive: ((goal: ReturnType<typeof activeGoal>) => void) | undefined
    const activeGoal = () => ({
      sessionId: "session-1",
      objective: "Ship safely",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    })
    const adapter = new SdkRuntimeAdapter({
      store: createMemoryRuntimeStore(),
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        nativeGoal: {
          capabilities: () => ({
            implemented: true,
            available: true,
            actions: [],
            recovery: "blocked",
            optionalFields: [],
          }),
          read: async () => activeGoal(),
          run: async (input, _objective, onGoal) => {
            publishActive = onGoal
            onGoal(activeGoal())
            await new Promise<void>((resolve) => {
              input.abort.signal.addEventListener("abort", () => {
                order.push("abort")
                resolve()
              }, { once: true })
            })
          },
          stop: async () => {
            order.push("stop")
            return { ...activeGoal(), status: "paused", updatedAt: 2 }
          },
          delete: async () => true,
        },
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"), undefined, "session-1")
    const started = await adapter.goals?.start(session.id, { objective: "Ship safely" }, path.resolve("/repo"))
    expect(started).toMatchObject({ ok: true, goal: { status: "active" } })
    expect(publishActive).toBeDefined()

    await expect(adapter.goals?.stop(session.id, path.resolve("/repo"))).resolves.toMatchObject({
      ok: true,
      goal: { status: "paused" },
    })
    expect(order).toEqual(["stop", "abort"])
    await adapter.dispose()
  })

  test("refuses to delete a live native Goal the provider would re-emit", async () => {
    const adapter = new SdkRuntimeAdapter({
      store: createMemoryRuntimeStore(),
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        nativeGoal: {
          ...nativeGoalStub(),
          read: async () => projectedGoal(),
        },
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"), undefined, "session-1")

    await expect(adapter.goals?.delete(session.id, path.resolve("/repo"))).resolves.toMatchObject({
      ok: false,
      status: "unsupported",
    })
    await adapter.dispose()
  })

  // A native Goal lives in a provider process: after a restart the driver has
  // nothing to stop while the store still projects the Goal as `blocked`.
  // Clearing that projection is the only way it can leave the session.
  test.each(["stop", "delete"] as const)("%s clears a native Goal the driver lost across a restart", async (action) => {
    const store = createMemoryRuntimeStore()
    const eventHub = createRuntimeEventHub()
    const runtime: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtime.push(event))
    const adapter = new SdkRuntimeAdapter({
      store,
      eventHub,
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        nativeGoal: nativeGoalStub(),
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"), undefined, "session-1")
    store.setGoal!(session.id, projectedGoal())

    await expect(adapter.goals?.read(session.id, path.resolve("/repo"))).resolves.toMatchObject({
      objective: "Ship safely",
      status: "blocked",
    })
    await expect(adapter.goals?.[action](session.id, path.resolve("/repo"))).resolves.toEqual({
      ok: true,
      goal: null,
    })
    expect(store.getGoal!(session.id)).toBeNull()
    expect(runtime.map((event) => event.payload.type)).toContain("goal-cleared")
    await expect(adapter.goals?.read(session.id, path.resolve("/repo"))).resolves.toBeNull()
    // Nothing left to clear reports the absence rather than a second success.
    await expect(adapter.goals?.[action](session.id, path.resolve("/repo"))).resolves.toMatchObject({
      ok: false,
      status: "not_found",
    })
    await adapter.dispose()
  })

  test("deletes a live native Goal through a driver that can clear it at the provider", async () => {
    const order: string[] = []
    let live: ReturnType<typeof projectedGoal> | null = projectedGoal()
    const adapter = new SdkRuntimeAdapter({
      store: createMemoryRuntimeStore(),
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        nativeGoal: {
          ...nativeGoalStub(),
          capabilities: () => ({
            implemented: true,
            available: true,
            actions: ["delete"],
            recovery: "blocked",
            optionalFields: [],
          }),
          read: async () => live,
          stop: async () => {
            order.push("stop")
            return live && { ...live, status: "paused" as const }
          },
          delete: async () => {
            order.push("delete")
            live = null
            return true
          },
        },
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"), undefined, "session-1")

    await expect(adapter.goals?.delete(session.id, path.resolve("/repo"))).resolves.toEqual({
      ok: true,
      goal: null,
    })
    // Continuation is disabled before the provider clears the Goal: deleting
    // first would let the next iteration re-report a Goal that is already gone.
    expect(order).toEqual(["stop", "delete"])
    await expect(adapter.goals?.read(session.id, path.resolve("/repo"))).resolves.toBeNull()
    await adapter.dispose()
  })

  test("exposes one Goal resource per adapter rather than rebuilding it per access", async () => {
    const adapter = new SdkRuntimeAdapter({
      store: createMemoryRuntimeStore(),
      driver: () => ({ ...minimalSdkRuntimeDriver(), nativeGoal: nativeGoalStub() }),
    })

    expect(adapter.goals).toBeDefined()
    expect(adapter.goals).toBe(adapter.goals)
    await adapter.dispose()
  })

  test("forgets a deleted session's Goal publication so a reused id is not deduped away", async () => {
    const eventHub = createRuntimeEventHub()
    const runtime: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtime.push(event))
    let host: SdkRuntimeDriverHost | undefined
    const adapter = new SdkRuntimeAdapter({
      store: createMemoryRuntimeStore(),
      eventHub,
      driver: (driverHost) => {
        host = driverHost
        return { ...minimalSdkRuntimeDriver(), nativeGoal: nativeGoalStub() }
      },
    })
    const directory = path.resolve("/repo")
    const goalUpdates = () => runtime.filter((event) => event.payload.type === "goal-updated")
    await adapter.createSession(directory, undefined, "session-1")

    host!.publishGoal({ sessionId: "session-1", directory, goal: projectedGoal() })
    host!.publishGoal({ sessionId: "session-1", directory, goal: projectedGoal() })
    // One accepted state publishes once, however often the driver reports it.
    expect(goalUpdates()).toHaveLength(1)

    await adapter.deleteSession(executionBinding("session-1", directory, "native:codex"))
    await adapter.createSession(directory, undefined, "session-1")
    host!.publishGoal({ sessionId: "session-1", directory, goal: projectedGoal() })

    // The dedupe entry is per session, so a session recreated under the same id
    // must publish its Goal again instead of having it swallowed forever.
    expect(goalUpdates()).toHaveLength(2)
    await adapter.dispose()
  })

  test("provider Goal turns persist one user request and attach continuations to it", async () => {
    const store = createMemoryRuntimeStore()
    let host!: SdkRuntimeDriverHost
    const adapter = new SdkRuntimeAdapter({ store, driver: (value) => {
      host = value
      return minimalSdkRuntimeDriver()
    } })
    const directory = path.resolve("/repo")
    const session = await adapter.createSession(directory)
    expect(await host.runProviderTurn({ sessionId: session.id, directory, userMessage: {
      id: "goal-request", text: "Ship verified work",
    } }, async () => {})).toBe(true)
    const original = store.getMessages(session.id).find((message) => message.info.role === "user")!
    expect(original.parts).toMatchObject([{ type: "text", text: "Ship verified work" }])
    expect(await host.runProviderTurn({ sessionId: session.id, directory }, async () => {})).toBe(true)
    const messages = store.getMessages(session.id)
    expect(messages.filter((message) => message.info.role === "user")).toEqual([original])
    expect(messages.filter((message) => message.info.role === "assistant").map((message) => message.info.parentID)).toEqual(["goal-request", "goal-request"])
    await adapter.dispose()
  })

  test("restores the accepted permission mode before a provider turn in a new adapter", async () => {
    const order: string[] = []
    const store = createMemoryRuntimeStore()
    const driver = () => ({
      ...minimalSdkRuntimeDriver(),
      setPermissionMode: async (_sessionId: string, modeId: string) => {
        order.push(`mode:${modeId}`)
        return { modes: [], currentModeId: modeId, appliesFrom: "next-turn" as const }
      },
      runTurn: async () => { order.push("turn") },
    })
    const adapter = new SdkRuntimeAdapter({ store, driver })
    const directory = path.resolve("/repo")
    const session = await adapter.createSession(directory)
    const prompt = {
      parts: [{ type: "text" as const, text: "go" }],
      assistantMessageId: "assistant",
      agent: "general",
      model: { providerID: "codex", modelID: "test" },
    }
    for await (const _event of executeTestTurn(adapter, session.id, { ...prompt, permissionMode: "read-only" }, directory)) {}
    expect(store.getSessionConfig(session.id)?.permissionMode).toBe("read-only")
    await adapter.dispose()
    const restored = new SdkRuntimeAdapter({ store, driver })
    for await (const _event of executeTestTurn(restored, session.id, { ...prompt, assistantMessageId: "next" }, directory)) {}
    expect(order).toEqual(["mode:read-only", "turn", "mode:read-only", "turn"])
    await restored.dispose()
  })

  test("admits revisioned subagent observations and reuses one opaque child target across interaction edges", async () => {
    const store = createMemoryRuntimeStore()
    const eventHub = createRuntimeEventHub()
    const compat: CompatEnvelope[] = []
    eventHub.subscribeGlobal((event) => compat.push(event))
    const runtime: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtime.push(event))
    const adapter = new SdkRuntimeAdapter({
      store,
      eventHub,
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        createRuntime: () => ({
          ingest: (raw: { payload?: { text?: string } }) => ({
            events: raw.payload?.text ? [{ type: "text-delta", delta: raw.payload.text }] : [],
            snapshot: { harness: "codex", threadId: "thread-1", adapterState: {} },
          }),
          snapshot: () => ({ harness: "codex", threadId: "thread-1", adapterState: {} }),
        }) as never,
        runTurn: async (input) => {
          await input.observeSubagent({
            observation: {
              observationId: "spawn",
              stableCorrelationId: "provider-child",
              toolCallId: "spawn-call",
              toolCallRole: "spawn",
              providerId: "provider-child",
              providerKind: "test",
              status: "running",
              transcript: { kind: "live" },
            },
            correlationKeys: ["provider-child"],
          })
          await input.observeSubagent({
            observation: {
              observationId: "interaction",
              stableCorrelationId: "provider-child",
              toolCallId: "send-call",
              toolCallRole: "interaction",
              providerId: "provider-child",
              providerKind: "test",
              status: "completed",
              transcript: { kind: "live" },
            },
            correlationKeys: ["provider-child"],
          })
          input.ingest(
            { source: "test", payload: { text: "child-only" } },
            { dir: "in", method: "child" },
            { kind: "child", correlationKey: "provider-child" },
          )
        },
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"))
    for await (const _event of executeTestTurn(adapter, session.id, {
      parts: [{ type: "text", text: "delegate" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "general",
      model: { providerID: "codex", modelID: "test" },
    }, path.resolve("/repo"))) {}

    const lifecycle = runtime.filter((event) => event.payload.type === "subagent-updated")
    expect(lifecycle.map((event) => event.payload.type === "subagent-updated" ? event.payload.revision : 0)).toEqual([1, 2])
    expect(new Set(lifecycle.map((event) => event.payload.type === "subagent-updated" ? event.payload.subagentKey : undefined)).size).toBe(1)
    expect(lifecycle.map((event) => event.payload.type === "subagent-updated" ? event.payload.childSessionId : undefined)).toEqual([
      expect.any(String),
      expect.any(String),
    ])
    const child = (store.listSessions(path.resolve("/repo")) as Array<{ id: string; parentID?: string; agent_session_id?: string }>)
      .find((item) => item.parentID === session.id)!
    expect(child.id).not.toBe("provider-child")
    expect(child.agent_session_id).toBe("provider-child")
    expect(compat.length).toBeGreaterThan(0)
    expect(compat.every((event) => eventSessionId(event.payload) === child.id)).toBe(true)
    const rowIndex = compat.findIndex((event) => event.payload.type === "message.updated" && event.payload.properties.info.role === "assistant")
    const deltaIndex = compat.findIndex((event) => event.payload.type === "message.part.delta")
    expect(rowIndex).toBeGreaterThanOrEqual(0)
    expect(deltaIndex).toBeGreaterThan(rowIndex)
    expect(compat.some((event) => event.payload.type === "message.completed")).toBe(true)

    expect(JSON.stringify(store.getMessages(session.id))).not.toContain("child-only")
    expect(JSON.stringify(store.getMessages(child.id))).toContain("child-only")
    await adapter.dispose()
  })

  test("routes child compat output to the child store without yielding it in the parent stream", async () => {
    const store = createMemoryRuntimeStore()
    const eventHub = createRuntimeEventHub()
    const compat: CompatEnvelope[] = []
    eventHub.subscribeGlobal((event) => compat.push(event))
    const runtime: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtime.push(event))
    const adapter = new SdkRuntimeAdapter({
      store,
      eventHub,
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        createRuntime: () => ({
          ingest: () => ({
            events: [{ type: "text-delta", delta: "child-only text" }],
            snapshot: { harness: "codex", threadId: "thread-1", adapterState: {} },
          }),
          snapshot: () => ({ harness: "codex", threadId: "thread-1", adapterState: {} }),
        }) as never,
        runTurn: async (input) => {
          input.associateChild("child-thread", {
            sessionId: "child-session",
            getAgentSessionId: () => "provider-child-thread",
            assistantMessageId: "child-assistant",
            created: 100,
            input: {
              userMessageId: "child-user",
              agent: "general",
              model: { providerID: "codex", modelID: "test" },
            },
          })
          input.ingest(
            { type: "child-update" } as never,
            { dir: "in", method: "test" },
            { kind: "child", correlationKey: "child-thread" },
          )
        },
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"))
    store.bindSession({
      sessionId: "child-session",
      directory: path.resolve("/repo"),
      agentSessionId: "provider-child-thread",
    })
    const yielded: AgentRuntimeStreamEvent[] = []

    for await (const event of executeTestTurn(adapter, session.id, {
      parts: [{ type: "text", text: "delegate" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "general",
      model: { providerID: "codex", modelID: "test" },
    }, path.resolve("/repo"))) yielded.push(event)

    expect(JSON.stringify(yielded)).not.toContain("child-only text")
    expect(compat.every((event) => eventSessionId(event.payload) === "child-session")).toBe(true)
    const livePart = compat.find((event) => event.payload.type === "message.part.updated")
    expect(livePart?.payload.properties).toMatchObject({ part: { messageID: "child-assistant", sessionID: "child-session" } })
    expect(compat.filter((event) => event.payload.type === "message.part.delta")).toHaveLength(1)

    expect(JSON.stringify(store.getMessages(session.id))).not.toContain("child-only text")
    expect(JSON.stringify(store.getMessages("child-session"))).toContain("child-only text")
    expect(runtime).toContainEqual(expect.objectContaining({
      sessionId: "child-session",
      agentSessionId: "provider-child-thread",
      payload: { type: "text-delta", delta: "child-only text" },
    }))
    await adapter.dispose()
  })

  test("adopts a requested deterministic Session without creating a second agent thread", async () => {
    let created = 0
    const adapter = new SdkRuntimeAdapter({
      store: createMemoryRuntimeStore(),
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        createAgentSession: async () => ({ id: `thread-${++created}` }),
      }),
    })

    await expect(adapter.createSession(path.resolve("/repo"), "Stable", "ses_wgrun_run_1"))
      .resolves.toEqual({ id: "ses_wgrun_run_1" })
    await expect(adapter.createSession(path.resolve("/repo"), "Stable retry", "ses_wgrun_run_1"))
      .resolves.toEqual({ id: "ses_wgrun_run_1" })
    expect(created).toBe(1)
    await adapter.dispose()
  })

  test("requires a workspace directory at cwd-dependent boundaries", async () => {
    const item = new SdkRuntimeAdapter({
      store: createMemoryRuntimeStore(),
      driver: () => minimalSdkRuntimeDriver(),
    })

    await expect(item.listPermissions(undefined as never)).rejects.toThrow("workspace directory is required")
    await item.dispose()
  })

  test("process death clears pending permissions, questions, active turns, and threads", () => {
    const host = {
      lifecycle: () => lifecycle,
      pendingPermissions: new Map<string, { resolve: (decision: string) => void }>(),
      pendingQuestions: new Map<string, { reject: () => void }>(),
      bindSession() {},
    }
    const abort = new AbortController()
    const decisions: string[] = []
    let rejected = false
    const lifecycle = createSessionTurnLifecycle()
    lifecycle.set("s1", { abort })
    host.pendingPermissions = new Map([["perm-1", { resolve: (decision) => decisions.push(decision) }]])
    host.pendingQuestions = new Map([["question-1", { reject: () => { rejected = true } }]])
    const driver = createCodexAppServerDriver(host as never) as WithInternals<SdkRuntimeDriver, {
      activeThreads: Map<string, unknown>
      failInteractiveState: (err: Error) => void
    }>
    driver.activeThreads.set("thread-1", {})

    driver.failInteractiveState(new Error("process exited"))

    expect(abort.signal.aborted).toBe(true)
    expect(decisions).toEqual(["deny"])
    expect(rejected).toBe(true)
    expect(lifecycle.activeTurns.size).toBe(0)
    expect(host.pendingPermissions.size).toBe(0)
    expect(host.pendingQuestions.size).toBe(0)
    expect(driver.activeThreads.size).toBe(0)
    expect(driver.readRuntimeHealth(path.resolve("/work"))).toEqual({
      status: "degraded",
      reason: "harness_process_lost",
      message: "process exited",
    })
  })

  test("Codex drops a provisional autonomous Goal queue when provider-turn admission is busy", async () => {
    const host = {
      lifecycle: () => createSessionTurnLifecycle(),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
      getAgentSessionId: () => "thread-1",
      updatePermissionState() {},
      getSessionConfig: () => null,
      publishGoal() {},
      runProviderTurn: async () => false,
    }
    const driver = createCodexAppServerDriver(host as never) as WithInternals<SdkRuntimeDriver, {
      goalController: WithInternals<CodexGoalController, {
        bindings: Map<string, { sessionId: string; directory: string }>
        statusByThread: Map<string, string>
        turnQueues: Map<string, unknown>
      }>
    }>
    const goalController = driver.goalController
    goalController.bindings.set("thread-1", { sessionId: "session-1", directory: path.resolve("/repo") })
    goalController.statusByThread.set("thread-1", "active")

    goalController.handleProcessMessage({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "goal-turn-1" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(goalController.turnQueues.size).toBe(0)
    await driver.dispose?.()
  })

  test("explicit abort persists an interruption sentinel without emitting a session error", async () => {
    const store = createMemoryRuntimeStore()
    let started: (() => void) | undefined
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const adapter = new SdkRuntimeAdapter({
      store,
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        runTurn: async (input) => {
          started?.()
          await new Promise((_, reject) => {
            input.abort.signal.addEventListener(
              "abort",
              () => reject(new Error("Codex turn aborted")),
              { once: true },
            )
          })
        },
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"))
    const events: AgentRuntimeStreamEvent[] = []
    const turn = (async () => {
      for await (const event of executeTestTurn(adapter, session.id, {
        parts: [{ type: "text", text: "hello" }],
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        agent: "build",
        model: { providerID: "codex-app-server", modelID: "gpt-test" },
      }, path.resolve("/repo"))) events.push(event)
    })()

    await running
    await expect(adapter.abort(executionBinding(session.id, path.resolve("/repo")))).resolves.toEqual({ ok: true, status: "cancelled" })
    await turn

    expect(events.map((event) => event.type)).not.toContain("session.error")
    const messages = store.getMessages(session.id) as Array<{ info: { id: string; error?: unknown } }>
    expect(messages.find((message) => message.info.id === "assistant-1")?.info.error).toEqual({
      name: "MessageAbortedError",
      data: { message: "Aborted by user" },
    })
    await adapter.dispose()
  })

  test("native lifecycle cancellation settles pending permissions and questions without the abort API", async () => {
    const store = createMemoryRuntimeStore()
    let host!: SdkRuntimeDriverHost
    let ready!: () => void
    const pending = new Promise<void>((resolve) => { ready = resolve })
    const settlements: string[] = []
    const adapter = new SdkRuntimeAdapter({ store, driver: (owner) => {
      host = owner
      return { ...minimalSdkRuntimeDriver(), runTurn: async (input) => {
        await new Promise<void>((resolve) => {
          host.pendingPermissions.set("permission", { sessionId: input.sessionId, agentSessionId: input.getAgentSessionId(), method: "approval", params: {}, resolve: (decision) => { settlements.push(decision) } })
          host.pendingQuestions.set("question", { sessionId: input.sessionId, agentSessionId: input.getAgentSessionId(), questions: [], resolve() {}, reject: () => { settlements.push("question-rejected"); resolve() } })
          ready()
        })
      } }
    } })
    const session = await adapter.createSession(path.resolve("/repo"))
    const turn = (async () => {
      for await (const _ of executeTestTurn(adapter, session.id, { parts: [{ type: "text", text: "work" }], userMessageId: "user", assistantMessageId: "assistant", agent: "build", model: { providerID: "codex-app-server", modelID: "gpt-test" } }, path.resolve("/repo"))) {}
    })()
    await pending
    expect(host.lifecycle().abort(session.id)).toBe(true)
    await turn
    expect(settlements).toEqual(["deny", "question-rejected"])
    expect(host.pendingPermissions.size).toBe(0)
    expect(host.pendingQuestions.size).toBe(0)
    await adapter.dispose()
  })

  test("does not acknowledge an abort until the adapter busy lock is retired", async () => {
    let started: (() => void) | undefined
    let releaseFirst: (() => void) | undefined
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const firstRun = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let turns = 0
    const adapter = new SdkRuntimeAdapter({
      store: createMemoryRuntimeStore(),
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        runTurn: async () => {
          turns += 1
          if (turns !== 1) return
          started?.()
          await firstRun
        },
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"))
    const prompt = (messageId: string) => ({
      parts: [{ type: "text" as const, text: messageId }],
      userMessageId: messageId,
      assistantMessageId: `${messageId}-assistant`,
      agent: "build",
      model: { providerID: "codex-app-server", modelID: "gpt-test" },
    })
    const first = (async () => {
      for await (const _event of executeTestTurn(adapter, session.id, prompt("first"), path.resolve("/repo"))) {}
    })()

    await running
    let abortSettled = false
    const abort = adapter.abort(executionBinding(session.id, path.resolve("/repo"))).then((result) => {
      abortSettled = true
      return result
    })
    await Bun.sleep(0)

    expect(abortSettled).toBe(false)
    releaseFirst?.()
    await expect(abort).resolves.toEqual({ ok: true, status: "cancelled" })
    await first

    const replacementEvents: AgentRuntimeStreamEvent[] = []
    for await (const event of executeTestTurn(adapter, session.id, prompt("replacement"), path.resolve("/repo"))) {
      replacementEvents.push(event)
    }
    expect(replacementEvents.map((event) => event.type)).not.toContain("session.error")
    expect(turns).toBe(2)
    await adapter.dispose()
  })

  test("dispose aborts and closes active turns", async () => {
    const store = createMemoryRuntimeStore()
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "native-1" })
    let host!: SdkRuntimeDriverHost
    const item = new SdkRuntimeAdapter({
      store,
      driver: (input) => {
        host = input
        return minimalSdkRuntimeDriver()
      },
    })
    const abort = new AbortController()
    let closed = false
    let rejected = false
    let denied = false
    host.lifecycle().set("s1", { abort, close: () => { closed = true } })
    host.pendingPermissions.set("perm-1", {
      sessionId: "s1",
      agentSessionId: "native-1",
      method: "permission",
      params: {},
      resolve: () => { denied = true },
    })
    host.pendingQuestions.set("question-1", {
      sessionId: "s1",
      agentSessionId: "native-1",
      questions: [],
      resolve() {},
      reject: () => { rejected = true },
    })

    await item.dispose()

    expect(abort.signal.aborted).toBe(true)
    expect(closed).toBe(true)
    expect(denied).toBe(true)
    expect(rejected).toBe(true)
    expect(host.lifecycle().activeTurns.size).toBe(0)
    expect(host.pendingPermissions.size).toBe(0)
    expect(host.pendingQuestions.size).toBe(0)
  })

  test("per-session config updates do not mutate the adapter-wide model", async () => {
    const store = createMemoryRuntimeStore()
    const item = new SdkRuntimeAdapter({ store, driver: () => minimalSdkRuntimeDriver() })
    const session = await item.createSession(path.resolve("/work"))

    const accepted = await item.updateSessionConfig(executionBinding(session.id, path.resolve("/work"), "native:codex"), {
      harness: { id: "codex", access: "native" },
      model: { providerID: "codex", modelID: "session-model" },
    })

    expect(accepted.model).toEqual({ providerID: "codex", modelID: "session-model" })
    expect(store.getSessionConfig(session.id)).toEqual({
      harness: { id: "codex", access: "native" },
      variant: null,
      agent: null,
    })
    await item.dispose()
  })
})

describe("SdkRuntimeAdapter busy lock", () => {
  /** The busy lock follows turn lifetime rather than consumer iteration lifetime. */
  function lockProbeAdapter(events: unknown[]) {
    const adapter = new SdkRuntimeAdapter({
      store: createMemoryRuntimeStore(),
      driver: () => minimalSdkRuntimeDriver(),
    })
    const internals = adapter as unknown as {
      _sendMessage: (id: string, input: unknown, directory: string) => AsyncIterable<unknown>
    }
    internals._sendMessage = async function* () {
      for (const event of events) yield event
    }
    return adapter
  }

  const prompt = { parts: [{ type: "text", text: "hi" }], agent: "build", model: { providerID: "p", modelID: "m" } }

  test("releases the lock at the terminal event, before the generator finishes", async () => {
    const adapter = lockProbeAdapter([
      { type: "session.status", properties: { sessionID: "s1" } },
      { type: "session.idle", properties: { sessionID: "s1" } },
      // Stands in for the consumer's post-terminal work (commit, auto-title).
      { type: "session.updated", properties: { sessionID: "s1" } },
    ])
    const lifecycle = (adapter as unknown as { lifecycle: () => ReturnType<typeof createSessionTurnLifecycle> }).lifecycle()

    const seen: boolean[] = []
    for await (const _ of executeTestTurn(adapter, "s1", prompt as never, path.resolve("/repo"))) {
      // Busy state as observed by a would-be second prompt at each yield.
      seen.push(lifecycle.busySessions.has("s1"))
    }

    // Busy through the pre-terminal event, free from the terminal event onward.
    expect(seen).toEqual([true, false, false])
  })

  test("a second prompt is accepted once the turn has settled", async () => {
    const adapter = lockProbeAdapter([{ type: "session.idle", properties: { sessionID: "s1" } }])
    const lifecycle = (adapter as unknown as { lifecycle: () => ReturnType<typeof createSessionTurnLifecycle> }).lifecycle()

    for await (const _ of executeTestTurn(adapter, "s1", prompt as never, path.resolve("/repo"))) {
      // Terminal emission releases admission during stream consumption.
      const leaveReplacement = lifecycle.enter("s1")
      expect(leaveReplacement).not.toBeNull()
      leaveReplacement?.()
    }
  })

  test("double release is a no-op, so the finally backstop cannot strand a session", async () => {
    // A turn that throws before emitting a terminal event must still release —
    // and one that emitted a terminal event releases twice. Neither may leave
    // the session marked busy.
    const adapter = lockProbeAdapter([{ type: "session.idle", properties: { sessionID: "s1" } }])
    const lifecycle = (adapter as unknown as { lifecycle: () => ReturnType<typeof createSessionTurnLifecycle> }).lifecycle()

    for await (const _ of executeTestTurn(adapter, "s1", prompt as never, path.resolve("/repo"))) { /* drain */ }
    expect(lifecycle.busySessions.has("s1")).toBe(false)
    expect(lifecycle.enter("s1")).not.toBeNull()
  })

  test("a stale release cannot unlock a replacement turn generation", () => {
    const lifecycle = createSessionTurnLifecycle()
    const releaseFirst = lifecycle.enter("s1")
    expect(releaseFirst).not.toBeNull()
    releaseFirst?.()

    const releaseReplacement = lifecycle.enter("s1")
    expect(releaseReplacement).not.toBeNull()
    releaseFirst?.()

    expect(lifecycle.busySessions.has("s1")).toBe(true)
    expect(lifecycle.enter("s1")).toBeNull()
    releaseReplacement?.()
    expect(lifecycle.busySessions.has("s1")).toBe(false)
  })

  test("yields the provider error instead of a placeholder session.error", async () => {
    const store = createMemoryRuntimeStore()
    const adapter = new SdkRuntimeAdapter({
      store,
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        createRuntime: () => ({
          ingest: () => ({
            events: [
              { type: "session-status", status: "error" },
              { type: "error", error: "You've reached your Codex rate limit. It will reset in about 5 hours." },
            ],
            snapshot: { harness: "codex", threadId: "thread-1", adapterState: {} },
          }),
          snapshot: () => ({ harness: "codex", threadId: "thread-1", adapterState: {} }),
        }) as never,
        runTurn: async (input) => {
          input.ingest(
            { source: "codex.app-server", method: "thread/status/changed", payload: {} },
            { dir: "in", method: "thread/status/changed" },
          )
        },
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"))
    const events: AgentRuntimeStreamEvent[] = []
    for await (const event of executeTestTurn(adapter, session.id, {
      parts: [{ type: "text", text: "go" }],
      assistantMessageId: "assistant",
      agent: "general",
      model: { providerID: "codex", modelID: "test" },
    }, path.resolve("/repo"))) {
      events.push(event)
    }

    const errors = events.filter((event) => event.type === "session.error")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      type: "session.error",
      properties: {
        error: {
          data: { message: "You've reached your Codex rate limit. It will reset in about 5 hours." },
        },
      },
    })
    await adapter.dispose()
  })
})
