import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { WithInternals } from "../../test-utils/class-internals"
import { SdkRuntimeAdapter, type SdkRuntimeDriver } from "./sdk-runtime-adapter"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import { createCodexAppServerDriver } from "../codex/driver"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { runtimeSnapshot } from "@claxedo/agent-event-runtime"
import { storeRows } from "../../test-utils/store-internals"
import type { AgentRuntimeStreamEvent } from "../../index"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../../runtime-event-hub"

function minimalSdkRuntimeDriver(): SdkRuntimeDriver {
  return {
    type: "codex",
    setAuth() {},
    applyConfig() {},
    createAgentSession: async () => "thread-1",
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

describe("SdkRuntimeAdapter", () => {
  test("applies the requested permission mode before the provider turn", async () => {
    const order: string[] = []
    const adapter = new SdkRuntimeAdapter({
      store: storeRows(createMemoryRuntimeStore()),
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        setPermissionMode: async (_sessionId, modeId) => {
          order.push(`mode:${modeId}`)
          return { modes: [], appliesFrom: "next-turn" as const }
        },
        runTurn: async () => {
          order.push("turn")
        },
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"))

    for await (const _event of adapter.sendMessage(session.id, {
      parts: [{ type: "text", text: "go" }],
      assistantMessageId: "assistant",
      agent: "general",
      model: { providerID: "codex", modelID: "test" },
      permissionMode: "full-access",
    }, path.resolve("/repo"))) {}

    expect(order).toEqual(["mode:full-access", "turn"])
    adapter.dispose()
  })

  test("admits revisioned subagent observations and reuses one opaque child target across interaction edges", async () => {
    const store = storeRows(createMemoryRuntimeStore())
    const eventHub = createRuntimeEventHub()
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
    for await (const _event of adapter.sendMessage(session.id, {
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
    expect(JSON.stringify(store.getMessages(session.id))).not.toContain("child-only")
    expect(JSON.stringify(store.getMessages(child.id))).toContain("child-only")
    adapter.dispose()
  })

  test("routes child compat output to the child store without yielding it in the parent stream", async () => {
    const store = storeRows(createMemoryRuntimeStore())
    const eventHub = createRuntimeEventHub()
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

    for await (const event of adapter.sendMessage(session.id, {
      parts: [{ type: "text", text: "delegate" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "general",
      model: { providerID: "codex", modelID: "test" },
    }, path.resolve("/repo"))) yielded.push(event)

    expect(JSON.stringify(yielded)).not.toContain("child-only text")
    expect(JSON.stringify(store.getMessages(session.id))).not.toContain("child-only text")
    expect(JSON.stringify(store.getMessages("child-session"))).toContain("child-only text")
    expect(runtime).toContainEqual(expect.objectContaining({
      sessionId: "child-session",
      agentSessionId: "provider-child-thread",
      payload: { type: "text-delta", delta: "child-only text" },
    }))
    adapter.dispose()
  })

  test("adopts a requested deterministic Session without creating a second agent thread", async () => {
    let created = 0
    const adapter = new SdkRuntimeAdapter({
      store: storeRows(createMemoryRuntimeStore()),
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        createAgentSession: async () => `thread-${++created}`,
      }),
    })

    await expect(adapter.createSession(path.resolve("/repo"), "Stable", "ses_wgrun_run_1"))
      .resolves.toEqual({ id: "ses_wgrun_run_1" })
    await expect(adapter.createSession(path.resolve("/repo"), "Stable retry", "ses_wgrun_run_1"))
      .resolves.toEqual({ id: "ses_wgrun_run_1" })
    expect(created).toBe(1)
    adapter.dispose()
  })

  test.each(["claude", "codex", "cursor"] as const)("%s native generates and persists a title after the first turn", async (type) => {
    const store = storeRows(createMemoryRuntimeStore())
    const adapter = new SdkRuntimeAdapter({
      store,
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        type,
        createRuntime: () => ({
          ingest: () => ({
            events: [{ type: "finish", sessionId: "agent-session-1" }],
            snapshot: { harness: type, threadId: "agent-session-1", adapterState: {} },
          }),
          snapshot: () => ({ harness: type, threadId: "agent-session-1", adapterState: {} }),
        }) as never,
        runTurn: async (input) => {
          input.ingest({ type: "completed" } as never, { dir: "in", method: "test", frame: {} })
        },
      }),
    })
    const session = await adapter.createSession(path.resolve("/repo"))
    const events = []

    for await (const event of adapter.sendMessage(session.id, {
      parts: [{ type: "text", text: `Please fix ${type} native title` }],
      assistantMessageId: "assistant-1",
      agent: "build",
      model: { providerID: `${type}-native`, modelID: "test" },
    }, path.resolve("/repo"))) events.push(event)

    expect(store.getSession(session.id)).toMatchObject({ title: `fix ${type} native title` })
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.updated",
      properties: expect.objectContaining({
        info: expect.objectContaining({ title: `fix ${type} native title` }),
      }),
    }))
    adapter.dispose()
  })

  test("requires a workspace directory at cwd-dependent boundaries", async () => {
    const item = Object.create(SdkRuntimeAdapter.prototype) as WithInternals<SdkRuntimeAdapter, {
      pendingPermissions: Map<string, unknown>
      store: {
        listPermissions: () => []
      }
    }>
    item.pendingPermissions = new Map()
    item.store = {
      listPermissions: () => [],
    }

    await expect(item.listPermissions(undefined as never)).rejects.toThrow("workspace directory is required")
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

  test("explicit abort persists an interruption sentinel without emitting a session error", async () => {
    const store = storeRows(createMemoryRuntimeStore())
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
      for await (const event of adapter.sendMessage(session.id, {
        parts: [{ type: "text", text: "hello" }],
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        agent: "build",
        model: { providerID: "codex-app-server", modelID: "gpt-test" },
      }, path.resolve("/repo"))) events.push(event)
    })()

    await running
    await expect(adapter.abort(session.id, path.resolve("/repo"))).resolves.toEqual({ ok: true, status: "cancelled" })
    await turn

    expect(events.map((event) => event.type)).not.toContain("session.error")
    const messages = store.getMessages(session.id) as Array<{ info: { id: string; error?: unknown } }>
    expect(messages.find((message) => message.info.id === "assistant-1")?.info.error).toEqual({
      name: "MessageAbortedError",
      data: { message: "Aborted by user" },
    })
    adapter.dispose()
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
      store: storeRows(createMemoryRuntimeStore()),
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
      for await (const _event of adapter.sendMessage(session.id, prompt("first"), path.resolve("/repo"))) {}
    })()

    await running
    let abortSettled = false
    const abort = adapter.abort(session.id, path.resolve("/repo")).then((result) => {
      abortSettled = true
      return result
    })
    await Bun.sleep(0)

    expect(abortSettled).toBe(false)
    releaseFirst?.()
    await expect(abort).resolves.toEqual({ ok: true, status: "cancelled" })
    await first

    const replacementEvents: AgentRuntimeStreamEvent[] = []
    for await (const event of adapter.sendMessage(session.id, prompt("replacement"), path.resolve("/repo"))) {
      replacementEvents.push(event)
    }
    expect(replacementEvents.map((event) => event.type)).not.toContain("session.error")
    expect(turns).toBe(2)
    adapter.dispose()
  })

  test("dispose aborts and closes active turns", () => {
    const item = Object.create(SdkRuntimeAdapter.prototype) as WithInternals<SdkRuntimeAdapter, {
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      pendingPermissions: Map<string, unknown>
      pendingQuestions: Map<string, { reject: () => void }>
      driver: SdkRuntimeDriver
      dispose: () => void
    }>
    const abort = new AbortController()
    let closed = false
    let rejected = false
    item.turnLifecycle = createSessionTurnLifecycle()
    item.turnLifecycle.set("s1", { abort, close: () => { closed = true } })
    item.pendingPermissions = new Map([["perm-1", {}]])
    item.pendingQuestions = new Map([["question-1", { reject: () => { rejected = true } }]])
    item.driver = {
      ...minimalSdkRuntimeDriver(),
      dispose: () => {},
    }

    item.dispose()

    expect(abort.signal.aborted).toBe(true)
    expect(closed).toBe(true)
    expect(rejected).toBe(true)
    expect(item.turnLifecycle.activeTurns.size).toBe(0)
    expect(item.pendingPermissions.size).toBe(0)
    expect(item.pendingQuestions.size).toBe(0)
  })

  test("per-session config updates do not mutate the adapter-wide model", async () => {
    const item = Object.create(SdkRuntimeAdapter.prototype) as WithInternals<SdkRuntimeAdapter, {
      currentModel: string
      options: {}
      driver: SdkRuntimeDriver
      store: {
        updateSessionConfig: () => unknown
        getSessionConfig: () => unknown
      }
    }>
    item.currentModel = ""
    item.options = {}
    item.driver = minimalSdkRuntimeDriver()
    item.store = {
      updateSessionConfig() {
        return {
          harness: { id: "codex", access: "native" },
          model: { providerID: "codex", modelID: "session-model" },
          variant: null,
          agent: null,
        }
      },
      getSessionConfig() {
        return undefined
      },
    }

    await item.updateSessionConfig("s1", {
      harness: { id: "codex", access: "native" },
      model: { providerID: "codex", modelID: "session-model" },
    }, path.resolve("/work"))

    expect(item.currentModel).toBe("")
    expect(await item.getSessionConfig("s2", path.resolve("/work"))).toEqual({
      harness: { id: "codex", access: "native" },
      variant: null,
      agent: null,
    })
  })
})

describe("SdkRuntimeAdapter busy lock", () => {
  /** The busy lock follows turn lifetime rather than consumer iteration lifetime. */
  function lockProbeAdapter(events: unknown[]) {
    const adapter = new SdkRuntimeAdapter({
      store: storeRows(createMemoryRuntimeStore()),
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
    for await (const _ of adapter.sendMessage("s1", prompt as never, path.resolve("/repo"))) {
      // Busy state as observed by a would-be second prompt at each yield.
      seen.push(lifecycle.busySessions.has("s1"))
    }

    // Busy through the pre-terminal event, free from the terminal event onward.
    expect(seen).toEqual([true, false, false])
  })

  test("a second prompt is accepted once the turn has settled", async () => {
    const adapter = lockProbeAdapter([{ type: "session.idle", properties: { sessionID: "s1" } }])
    const lifecycle = (adapter as unknown as { lifecycle: () => ReturnType<typeof createSessionTurnLifecycle> }).lifecycle()

    for await (const _ of adapter.sendMessage("s1", prompt as never, path.resolve("/repo"))) {
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

    for await (const _ of adapter.sendMessage("s1", prompt as never, path.resolve("/repo"))) { /* drain */ }
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
    const store = storeRows(createMemoryRuntimeStore())
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
    for await (const event of adapter.sendMessage(session.id, {
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
    adapter.dispose()
  })
})
