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
