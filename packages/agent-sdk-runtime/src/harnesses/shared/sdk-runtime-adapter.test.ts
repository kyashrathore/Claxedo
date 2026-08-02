import { describe, expect, test } from "bun:test"
import type { WithInternals } from "../../test-utils/class-internals"
import { SdkRuntimeAdapter, type SdkRuntimeDriver } from "./sdk-runtime-adapter"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import { createCodexAppServerDriver } from "../codex/driver"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { runtimeSnapshot } from "@claxedo/agent-event-runtime"
import { storeRows } from "../../test-utils/store-internals"

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
  test("adopts a requested deterministic Session without creating a second agent thread", async () => {
    let created = 0
    const adapter = new SdkRuntimeAdapter({
      store: storeRows(createMemoryRuntimeStore()),
      driver: () => ({
        ...minimalSdkRuntimeDriver(),
        createAgentSession: async () => `thread-${++created}`,
      }),
    })

    await expect(adapter.createSession("/repo", "Stable", "ses_wgrun_run_1"))
      .resolves.toEqual({ id: "ses_wgrun_run_1" })
    await expect(adapter.createSession("/repo", "Stable retry", "ses_wgrun_run_1"))
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
    const session = await adapter.createSession("/repo")
    const events = []

    for await (const event of adapter.sendMessage(session.id, {
      parts: [{ type: "text", text: `Please fix ${type} native title` }],
      assistantMessageId: "assistant-1",
      agent: "build",
      model: { providerID: `${type}-native`, modelID: "test" },
    }, "/repo")) events.push(event)

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
    expect(driver.readRuntimeHealth("/work")).toEqual({
      status: "degraded",
      reason: "harness_process_lost",
      message: "process exited",
    })
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
    }, "/work")

    expect(item.currentModel).toBe("")
    expect(await item.getSessionConfig("s2", "/work")).toEqual({
      harness: { id: "codex", access: "native" },
      variant: null,
      agent: null,
    })
  })
})

describe("SdkRuntimeAdapter busy lock", () => {
  /**
   * The lock must be released when the TURN settles, not when the generator
   * finishes. Between those two moments the consumer still commits events and
   * awaits an auto-title round-trip — ~515ms measured on a real failing run —
   * and a prompt arriving in that window used to be refused with "Session is
   * already processing a message" for a turn that had been over for half a
   * second. One Tier R run missed the release by a single millisecond.
   */
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
    for await (const _ of adapter.sendMessage("s1", prompt as never, "/repo")) {
      // Busy state as observed by a would-be second prompt at each yield.
      seen.push(lifecycle.busySessions.has("s1"))
    }

    // Busy through the pre-terminal event, free from the terminal event onward.
    expect(seen).toEqual([true, false, false])
  })

  test("a second prompt is accepted once the turn has settled", async () => {
    const adapter = lockProbeAdapter([{ type: "session.idle", properties: { sessionID: "s1" } }])
    const lifecycle = (adapter as unknown as { lifecycle: () => ReturnType<typeof createSessionTurnLifecycle> }).lifecycle()

    for await (const _ of adapter.sendMessage("s1", prompt as never, "/repo")) {
      // The window that used to refuse: mid-drain, after the terminal event.
      expect(lifecycle.enter("s1")).not.toBeNull()
      lifecycle.busySessions.delete("s1")
    }
  })

  test("double release is a no-op, so the finally backstop cannot strand a session", async () => {
    // A turn that throws before emitting a terminal event must still release —
    // and one that emitted a terminal event releases twice. Neither may leave
    // the session marked busy.
    const adapter = lockProbeAdapter([{ type: "session.idle", properties: { sessionID: "s1" } }])
    const lifecycle = (adapter as unknown as { lifecycle: () => ReturnType<typeof createSessionTurnLifecycle> }).lifecycle()

    for await (const _ of adapter.sendMessage("s1", prompt as never, "/repo")) { /* drain */ }
    expect(lifecycle.busySessions.has("s1")).toBe(false)
    expect(lifecycle.enter("s1")).not.toBeNull()
  })
})
