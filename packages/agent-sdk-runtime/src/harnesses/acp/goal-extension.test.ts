import { describe, expect, test } from "bun:test"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { WithInternals } from "../../test-utils/class-internals"
import { ACPProcess } from "./process"
import { AcpHarnessAdapter } from "."
import { MemoryRuntimeStore } from "../../stores/memory"
import { createRuntimeEventHub } from "../../runtime-event-hub"
import {
  ACP_GOAL_METHODS,
  goalExtension,
  goalExtensionCapabilities,
  type ACPGoalExtension,
} from "./session"

const required = [ACP_GOAL_METHODS.read, ACP_GOAL_METHODS.start, ACP_GOAL_METHODS.stop]

describe("neutral ACP Goal extension", () => {
  test("missing, malformed, or incomplete metadata remains unsupported", () => {
    expect(goalExtension(undefined)).toBeNull()
    expect(goalExtension({ goal: { version: 2, methods: required, actions: [] } })).toBeNull()
    expect(goalExtension({ goal: { version: 1, methods: [ACP_GOAL_METHODS.read], actions: [] } })).toBeNull()
    expect(goalExtensionCapabilities(null)).toMatchObject({
      implemented: false,
      available: false,
      actions: [],
      recovery: "blocked",
    })
  })

  test("hides an incomplete Pause/Resume pair and retains known optional fields", () => {
    const extension = goalExtension({
      goal: {
        version: 1,
        methods: [...required, ACP_GOAL_METHODS.pause, ACP_GOAL_METHODS.delete],
        actions: ["pause", "delete"],
        optionalFields: ["iteration", "lastReason", "futureCounter"],
      },
    })

    expect(goalExtensionCapabilities(extension)).toEqual({
      implemented: true,
      available: true,
      actions: ["delete"],
      recovery: "reconcile",
      optionalFields: ["iteration", "lastReason"],
    })
  })

  test("maps only negotiated methods and normalizes provider state", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const extension = goalExtension({
      goal: {
        version: 1,
        methods: [
          ...required,
          ACP_GOAL_METHODS.pause,
          ACP_GOAL_METHODS.resume,
        ],
        actions: ["pause", "resume"],
        optionalFields: ["iteration", "lastReason"],
      },
    })!
    const proc = Object.create(ACPProcess.prototype) as WithInternals<ACPProcess, {
      goal: ACPGoalExtension
      agent: { request: (method: string, params: unknown) => Promise<unknown> }
    }>
    proc.goal = extension
    proc.agent = {
      async request(method: string, params: unknown) {
        calls.push({ method, params })
        return {
          goal: {
            sessionId: "provider-id-must-not-leak",
            objective: "Ship verified work",
            status: method === ACP_GOAL_METHODS.pause ? "paused" : "active",
            createdAt: 10,
            updatedAt: 20,
            iteration: 2,
            lastReason: "Provider evidence",
            futureCounter: 99,
          },
        }
      },
    } as never

    expect(await proc.startGoal("agent-session", "local-session", "Ship verified work")).toEqual({
      sessionId: "local-session",
      objective: "Ship verified work",
      status: "active",
      createdAt: 10,
      updatedAt: 20,
      iteration: 2,
      lastReason: "Provider evidence",
    })
    expect(await proc.goalAction("pause", "agent-session", "local-session")).toMatchObject({ status: "paused" })
    expect(() => proc.goalAction("delete", "agent-session", "local-session"))
      .toThrow("action delete was not negotiated")
    expect(calls).toEqual([
      {
        method: ACP_GOAL_METHODS.start,
        params: { sessionId: "agent-session", objective: "Ship verified work" },
      },
      {
        method: ACP_GOAL_METHODS.pause,
        params: { sessionId: "agent-session" },
      },
    ])
  })

  test("the adapter refreshes state after Resume and never substitutes Delete", async () => {
    const store = new MemoryRuntimeStore()
    store.bindSession({
      sessionId: "local-session",
      directory: "/work",
      agentSessionId: "agent-session",
      ownerKey: "process-key",
    })
    const eventHub = createRuntimeEventHub()
    const statuses: string[] = []
    eventHub.subscribeRuntime((event) => {
      if (event.payload.type === "goal-updated") statuses.push(event.payload.goal.status)
    })
    const calls: string[] = []
    const now = Date.now()
    const fakeProcess = {
      alive: true,
      supportsForkSession: () => false,
      dispose() {},
      goalCapabilities: () => ({
        implemented: true,
        available: true,
        actions: ["pause", "resume"],
        recovery: "reconcile",
        optionalFields: ["lastReason"],
      }),
      listenGoal() {},
      listenGoalUpdates() {},
      async goalAction(action: string) {
        if (action === "delete") throw new Error("ACP Goal action delete was not negotiated")
        calls.push(action)
        return {
          sessionId: "local-session",
          objective: "Ship",
          status: "paused",
          createdAt: now,
          updatedAt: now,
        }
      },
      async readGoal() {
        calls.push("read")
        return {
          sessionId: "local-session",
          objective: "Ship",
          status: "active",
          createdAt: now,
          updatedAt: now + 1,
          lastReason: "Provider refreshed state",
        }
      },
    }
    const adapter = new AcpHarnessAdapter({
      binary: "fake-acp",
      harness: "example",
      store,
      eventHub,
    })
    const internal = adapter as unknown as {
      processes: Map<string, unknown>
      sessionProcesses: Map<string, string>
    }
    internal.processes = new Map([[
      "process-key",
      {
        key: "process-key",
        directory: "/work",
        proc: fakeProcess,
        init: null,
        sessionIds: new Set(["local-session"]),
      },
    ]])
    internal.sessionProcesses = new Map([["local-session", "process-key"]])

    expect(adapter.readHarnessCapabilities("/work", { sessionId: "local-session" }).goals).toBe(true)
    expect(await adapter.goals.resume("local-session", "/work")).toMatchObject({
      ok: true,
      goal: { status: "active", lastReason: "Provider refreshed state" },
    })
    expect(calls).toEqual(["resume", "read"])
    expect(statuses).toEqual(["active"])

    expect(await adapter.goals.delete("local-session", "/work")).toMatchObject({
      ok: false,
      message: expect.stringContaining("not negotiated"),
    })
    expect(calls).toEqual(["resume", "read"])
    adapter.dispose()
  })

  test("projects autonomous Goal updates without an ordinary prompt listener", async () => {
    const store = new MemoryRuntimeStore()
    store.bindSession({
      sessionId: "local-session",
      directory: "/work",
      agentSessionId: "agent-session",
      ownerKey: "process-key",
    })
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: string[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event.payload.type))
    const now = Date.now()
    let goalListener: ((goal: {
      sessionId: string
      objective: string
      status: "active" | "complete"
      createdAt: number
      updatedAt: number
      iteration: number
    }) => void) | undefined
    let updateListener: ((update: unknown) => void) | undefined
    const fakeProcess = {
      alive: true,
      permissionPushers: new Map(),
      supportsForkSession: () => false,
      dispose() {},
      listenGoal(_agentSessionId: string, _localSessionId: string, listener: typeof goalListener) {
        goalListener = listener
      },
      listenGoalUpdates(_agentSessionId: string, listener: typeof updateListener) {
        updateListener = listener
      },
      goalCapabilities: () => ({
        implemented: true,
        available: true,
        actions: [],
        recovery: "reconcile",
        optionalFields: ["iteration"],
      }),
      async startGoal() {
        return {
          sessionId: "local-session",
          objective: "Ship autonomously",
          status: "active" as const,
          createdAt: now,
          updatedAt: now,
          iteration: 1,
        }
      },
      async cancel() {},
    }
    const adapter = new AcpHarnessAdapter({
      binary: "fake-acp",
      harness: "example",
      store,
      eventHub,
    })
    const internal = adapter as unknown as {
      processes: Map<string, unknown>
      sessionProcesses: Map<string, string>
    }
    internal.processes = new Map([[
      "process-key",
      {
        key: "process-key",
        directory: "/work",
        proc: fakeProcess,
        init: null,
        sessionIds: new Set(["local-session"]),
      },
    ]])
    internal.sessionProcesses = new Map([["local-session", "process-key"]])

    expect(await adapter.goals.start("local-session", { objective: "Ship autonomously" }, "/work"))
      .toMatchObject({ ok: true, goal: { status: "active" } })
    updateListener?.({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Autonomous evidence" },
    })
    goalListener?.({
      sessionId: "local-session",
      objective: "Ship autonomously",
      status: "complete",
      createdAt: now,
      updatedAt: now + 1,
      iteration: 1,
    })

    expect(JSON.stringify(store.getMessages("local-session"))).toContain("Autonomous evidence")
    expect(runtimeEvents).toContain("text-delta")
    expect(runtimeEvents).toContain("finish")
    expect(store.getSession("local-session")).toMatchObject({ lastTurn: { status: "completed" } })
    adapter.dispose()
  })

  test("deleting a local session removes its Goal listener from a shared ACP process", async () => {
    const store = new MemoryRuntimeStore()
    store.bindSession({
      sessionId: "local-session",
      directory: "/work",
      agentSessionId: "agent-session",
      ownerKey: "process-key",
    })
    const unlistened: string[] = []
    let goalListener: ((goal: RuntimeGoalSnapshot | null) => void) | undefined
    const fakeProcess = {
      alive: true,
      dispose() {},
      goalCapabilities: () => ({
        implemented: true,
        available: true,
        actions: [],
        recovery: "reconcile" as const,
        optionalFields: [],
      }),
      listenGoal(_agentSessionId: string, _localSessionId: string, listener: typeof goalListener) {
        goalListener = listener
      },
      listenGoalUpdates() {},
      unlistenGoal(agentSessionId: string) {
        unlistened.push(agentSessionId)
      },
    }
    const eventHub = createRuntimeEventHub()
    const published: string[] = []
    eventHub.subscribeRuntime((event) => {
      if (event.payload.type === "goal-updated") published.push(event.payload.goal.status)
    })
    const adapter = new AcpHarnessAdapter({
      binary: "fake-acp",
      harness: "example",
      store,
      eventHub,
    })
    const internal = adapter as unknown as {
      processes: Map<string, unknown>
      sessionProcesses: Map<string, string>
      publishGoal: (sessionId: string, directory: string, goal: RuntimeGoalSnapshot | null) => void
    }
    internal.processes = new Map([[
      "process-key",
      {
        key: "process-key",
        directory: "/work",
        proc: fakeProcess,
        init: null,
        sessionIds: new Set(["local-session", "sibling-session"]),
      },
    ]])
    internal.sessionProcesses = new Map([["local-session", "process-key"]])

    // Bind the listener the way an ordinary session activation does, then let
    // the agent report a Goal so the publisher holds dedupe state for it.
    const now = Date.now()
    const goal: RuntimeGoalSnapshot = {
      sessionId: "local-session",
      objective: "Ship",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }
    await adapter.goals.readCapabilities("local-session", "/work")
    goalListener?.(goal)
    goalListener?.(goal)
    expect(published).toEqual(["active"])

    await adapter.deleteSession("local-session", "/work")

    expect(unlistened).toEqual(["agent-session"])
    // Deleting the session drops its dedupe state, so an identical snapshot
    // publishes again instead of being swallowed.
    internal.publishGoal("local-session", "/work", goal)
    expect(published).toEqual(["active", "active"])
    adapter.dispose()
  })

  test("reading Goal state on an idle-reaped session answers from the store without respawning", async () => {
    const store = new MemoryRuntimeStore()
    store.bindSession({
      sessionId: "local-session",
      directory: "/work",
      agentSessionId: "agent-session",
      ownerKey: "process-key",
    })
    const now = Date.now()
    store.setGoal("local-session", {
      sessionId: "local-session",
      objective: "Ship verified work",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    const spawns: string[] = []
    const fakeProcess = {
      alive: true,
      dispose() {},
      listenGoal() {},
      listenGoalUpdates() {},
      goalCapabilities: () => ({
        implemented: true,
        available: true,
        actions: [],
        recovery: "reconcile",
        optionalFields: [],
      }),
      async readGoal() {
        throw new Error("readGoal must not be reached without a live process")
      },
      async stopGoal() {
        return {
          sessionId: "local-session",
          objective: "Ship verified work",
          status: "complete" as const,
          createdAt: now,
          updatedAt: now + 1,
        }
      },
    }
    const adapter = new AcpHarnessAdapter({
      binary: "fake-acp",
      harness: "example",
      store,
    })
    // The session is bound and remembered, but its ACP process was idle-reaped:
    // the entry survives with a null proc, exactly as `invalidateProcess` leaves it.
    const entry = {
      key: "process-key",
      directory: "/work",
      proc: null as unknown,
      init: null,
      sessionIds: new Set(["local-session"]),
    }
    const internal = adapter as unknown as {
      processes: Map<string, unknown>
      sessionProcesses: Map<string, string>
      getOrSpawnProcess: (id: string, directory: string) => Promise<{ proc: unknown; isNew: boolean }>
    }
    internal.processes = new Map([["process-key", entry]])
    internal.sessionProcesses = new Map([["local-session", "process-key"]])
    internal.getOrSpawnProcess = async (id: string) => {
      spawns.push(id)
      entry.proc = fakeProcess
      return { proc: fakeProcess, isNew: true }
    }

    expect(await adapter.goals.readCapabilities("local-session", "/work")).toMatchObject({
      implemented: false,
      available: false,
      unavailableReason: expect.stringContaining("not running"),
    })
    expect(await adapter.goals.read("local-session", "/work")).toMatchObject({
      objective: "Ship verified work",
      status: "active",
    })
    expect(adapter.readHarnessCapabilities("/work", { sessionId: "local-session" }).goals).toBe(false)
    expect(spawns).toEqual([])

    // A real Goal ACTION is still allowed to wake the agent back up.
    expect(await adapter.goals.stop("local-session", "/work")).toMatchObject({
      ok: true,
      goal: { status: "complete" },
    })
    expect(spawns).toEqual(["local-session"])
    adapter.dispose()
  })

  test("one event runtime serves a whole Goal turn and is released when it ends", async () => {
    const store = new MemoryRuntimeStore()
    store.bindSession({
      sessionId: "local-session",
      directory: "/work",
      agentSessionId: "agent-session",
      ownerKey: "process-key",
    })
    const now = Date.now()
    let goalListener: ((goal: RuntimeGoalSnapshot) => void) | undefined
    let updateListener: ((update: unknown) => void) | undefined
    const fakeProcess = {
      alive: true,
      permissionPushers: new Map(),
      dispose() {},
      listenGoal(_agentSessionId: string, _localSessionId: string, listener: typeof goalListener) {
        goalListener = listener
      },
      listenGoalUpdates(_agentSessionId: string, listener: typeof updateListener) {
        updateListener = listener
      },
      goalCapabilities: () => ({
        implemented: true,
        available: true,
        actions: [],
        recovery: "reconcile" as const,
        optionalFields: [],
      }),
      async startGoal() {
        return {
          sessionId: "local-session",
          objective: "Ship",
          status: "active" as const,
          createdAt: now,
          updatedAt: now,
        }
      },
      async cancel() {},
    }
    const adapter = new AcpHarnessAdapter({ binary: "fake-acp", harness: "example", store })
    const internal = adapter as unknown as {
      processes: Map<string, unknown>
      sessionProcesses: Map<string, string>
      goalRuntimes: Map<string, { agentSessionId: string; runtime: unknown }>
      goalProjections: Map<string, { runtime: unknown }>
    }
    internal.processes = new Map([[
      "process-key",
      {
        key: "process-key",
        directory: "/work",
        proc: fakeProcess,
        init: null,
        sessionIds: new Set(["local-session"]),
      },
    ]])
    internal.sessionProcesses = new Map([["local-session", "process-key"]])

    expect(await adapter.goals.start("local-session", { objective: "Ship" }, "/work"))
      .toMatchObject({ ok: true })

    // A bare tool_call_update translates to no events, so no turn projection
    // exists yet — but the translator has already recorded the tool.
    updateListener?.({ sessionUpdate: "tool_call_update", toolCallId: "tool-1" })
    const runtime = internal.goalRuntimes.get("local-session")?.runtime
    expect(runtime).toBeDefined()
    expect(internal.goalProjections.has("local-session")).toBe(false)

    updateListener?.({ sessionUpdate: "tool_call_update", toolCallId: "tool-1" })
    expect(internal.goalRuntimes.get("local-session")?.runtime).toBe(runtime)

    // The first translated event starts the projection, and it adopts the very
    // runtime that has been accumulating state — not a replacement.
    updateListener?.({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Evidence" },
    })
    expect(internal.goalProjections.get("local-session")?.runtime).toBe(runtime)
    expect(internal.goalRuntimes.get("local-session")?.runtime).toBe(runtime)

    goalListener?.({
      sessionId: "local-session",
      objective: "Ship",
      status: "complete",
      createdAt: now,
      updatedAt: now + 1,
    })
    expect(internal.goalRuntimes.has("local-session")).toBe(false)
    expect(internal.goalProjections.has("local-session")).toBe(false)
    adapter.dispose()
  })
})
