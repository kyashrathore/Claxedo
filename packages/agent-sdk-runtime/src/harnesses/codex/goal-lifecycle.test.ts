import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { createRuntimeEventHub } from "../../runtime-event-hub"
import { fakeRuntimeStore } from "../../test-utils/fake-runtime-store"
import { committedStartTurn } from "../../test-utils/fake-runtime-store"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import { removeTestTempDir } from "../shared/test-temp-dir"
import { installFakeCodexAppServer } from "../../test-utils/fake-codex-app-server"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import type {
  ActiveTurn,
  JsonRecord,
  SdkRuntimeDriverHost,
  SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import type { CodexAppServerProcess } from "./app-server-process"
import { CodexGoalController, type CodexGoalControllerHost } from "./goal"
import type { CodexActiveThread } from "./protocol"
import { CodexHarnessAdapter } from "./index"
import type { PromptInput } from "../../index"

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) removeTestTempDir(directory)
})

function store(turns: { started: number; children: number }): AgentRuntimeStoreWithRecovery {
  const sessions = new Map<string, { id: string; directory: string }>()
  const agentSessionIds = new Map<string, string>()
  return fakeRuntimeStore({
    bindSession(input) {
      if (input.parentSessionId) turns.children++
      sessions.set(input.sessionId, { id: input.sessionId, directory: input.directory })
      agentSessionIds.set(input.sessionId, input.agentSessionId)
    },
    getSession: (id) => sessions.get(id) ?? null,
    getAgentSessionId: (id) => agentSessionIds.get(id),
    deleteSession(id) {
      sessions.delete(id)
      agentSessionIds.delete(id)
    },
    startTurn(input) {
      turns.started++
      return committedStartTurn(input)
    },
  })
}

const THREAD_ID = "thread-1"

/**
 * Drives `CodexGoalController` against a scripted app-server so a test can feed
 * exact provider frames in exact order, which the process-level fake cannot.
 */
function goalControllerHarness() {
  const directory = path.resolve(os.tmpdir(), "codex-goal-controller")
  const published: Array<{ sessionId: string; directory: string; goal: RuntimeGoalSnapshot | null }> = []
  const projected: Array<{ threadId: string; method: string; payload: JsonRecord }> = []
  const providerTurns: Array<Promise<boolean>> = []
  const activeThreads = new Map<string, CodexActiveThread>()
  let goal: JsonRecord | null = null
  const proc = {
    alive: true,
    async request(method: string, params: unknown) {
      const input = (params ?? {}) as { objective?: string; status?: string }
      if (method === "thread/goal/set") {
        goal = {
          threadId: THREAD_ID,
          objective: input.objective ?? (goal?.objective as string | undefined) ?? "",
          status: input.status ?? "active",
          createdAt: 1,
          updatedAt: 2,
        }
        return { goal }
      }
      if (method === "thread/goal/get") return { goal }
      if (method === "thread/goal/clear") {
        const cleared = goal !== null
        goal = null
        return { cleared }
      }
      return {}
    },
  }
  const appServer = proc as unknown as CodexAppServerProcess
  const unusedSubagent: SdkRuntimeTurnInput["observeSubagent"] = async () => {
    throw new Error("subagent observation is not exercised by this test")
  }
  const lifecycle = createSessionTurnLifecycle<ActiveTurn>()
  /** Stands in for the adapter's provider-id reverse index. */
  const sessionByThread = new Map<string, { sessionId: string; directory: string }>()
  const driverHost: SdkRuntimeDriverHost = {
    lifecycle: () => lifecycle,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession: () => {},
    getAgentSessionId: () => THREAD_ID,
    getSessionForAgentSession: (agentSessionId) => sessionByThread.get(agentSessionId) ?? null,
    getSessionConfig: () => null,
    publishGoal: (input) => published.push(input),
    runProviderTurn: (binding, execute) => {
      const turn = execute({
        sessionId: binding.sessionId,
        getAgentSessionId: () => THREAD_ID,
        input: prompt(),
        directory: binding.directory,
        abort: new AbortController(),
        ingest: () => {},
        associateChild: () => {},
        observeSubagent: unusedSubagent,
        rebindAgentSession: () => {},
        model: "default",
      }).then(() => true)
      providerTurns.push(turn)
      return turn
    },
  }
  const host: CodexGoalControllerHost = {
    driverHost,
    ensureProcess: async () => appServer,
    liveProcess: () => appServer,
    lease: () => ({ release: () => {} }),
    activeThreads,
    projectThreadNotification: async (_input, threadId, method, params) => {
      projected.push({ threadId, method, payload: params })
    },
  }
  return {
    directory,
    published,
    projected,
    activeThreads,
    sessionByThread,
    activeThread: (sessionId: string): CodexActiveThread => ({
      sessionId,
      agentSessionId: THREAD_ID,
      directory,
      process: appServer,
      project: () => {},
      observeSubagent: unusedSubagent,
    }),
    host,
    settle: () => Promise.all(providerTurns),
  }
}

async function installFakeCodex() {
  const fake = await installFakeCodexAppServer()
  tempDirs.push(fake.directory)
  return fake
}

async function waitForRequest(log: string, method: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(log) && fs.readFileSync(log, "utf8").includes(`"method":"${method}"`)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${method}`)
}

function prompt(): PromptInput {
  return {
    parts: [{ type: "text", text: "Keep working" }],
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    agent: "build",
    model: { providerID: "codex", modelID: "default" },
  }
}

describe("Codex Goal lifecycle", () => {
  test("resumes a durable thread before reconciling Goal after process restart", async () => {
    const fake = await installFakeCodex()
    const turns = { started: 0, children: 0 }
    const runtimeStore = store(turns)
    const first = new CodexHarnessAdapter({
      binary: fake.binary,
      store: runtimeStore,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    const session = await first.createSession(fake.directory, undefined, "session-recovery")
    await first.goals!.start(session.id, { objective: "Survive app-server restart" }, fake.directory)
    first.dispose()

    const second = new CodexHarnessAdapter({
      binary: fake.binary,
      store: runtimeStore,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    expect(await second.goals!.read(session.id, fake.directory)).toMatchObject({
      sessionId: session.id,
      objective: "Survive app-server restart",
      status: "active",
    })
    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(requests.slice(-3).map((request) => request.method)).toEqual([
      "thread/goal/get",
      "thread/resume",
      "thread/goal/get",
    ])
    second.dispose()
  })

  test("recovers durable threads for Goal mutations and clears Goal before session deletion", async () => {
    const fake = await installFakeCodex()
    const runtimeStore = store({ started: 0, children: 0 })
    const first = new CodexHarnessAdapter({
      binary: fake.binary,
      store: runtimeStore,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    const session = await first.createSession(fake.directory, undefined, "session-delete")
    await first.goals!.start(session.id, { objective: "Stop before delete" }, fake.directory)
    first.dispose()

    const second = new CodexHarnessAdapter({
      binary: fake.binary,
      store: runtimeStore,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    expect(await second.goals!.pause(session.id, fake.directory)).toMatchObject({ ok: true, goal: { status: "paused" } })
    second.dispose()

    const third = new CodexHarnessAdapter({
      binary: fake.binary,
      store: runtimeStore,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    expect(await third.goals!.read(session.id, fake.directory)).toMatchObject({ status: "paused" })
    await third.deleteSession(session.id, fake.directory)

    expect(fs.existsSync(fake.goalFile)).toBe(false)
    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((request) => request.method.startsWith("thread/goal") || request.method === "thread/resume")
    expect(requests.slice(-7).map((request) => request.method)).toEqual([
      "thread/goal/set",
      "thread/resume",
      "thread/goal/set",
      "thread/goal/get",
      "thread/resume",
      "thread/goal/get",
      "thread/goal/clear",
    ])
    third.dispose()
  })

  test("deletes a session without spawning an app-server when the Codex binary is broken", async () => {
    const fake = await installFakeCodex()
    const runtimeStore = store({ started: 0, children: 0 })
    const live = new CodexHarnessAdapter({
      binary: fake.binary,
      store: runtimeStore,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    const session = await live.createSession(fake.directory, undefined, "session-broken-binary")
    await live.goals!.start(session.id, { objective: "Outlive the binary" }, fake.directory)
    live.dispose()
    const requestsBeforeDelete = fs.readFileSync(fake.log, "utf8")

    const broken = new CodexHarnessAdapter({
      binary: path.join(fake.directory, "codex-that-does-not-exist"),
      store: runtimeStore,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    await broken.deleteSession(session.id, fake.directory)

    expect(runtimeStore.getSession(session.id)).toBeNull()
    // No process was spawned to clean the Goal up, so the provider Goal
    // survives — deletion of local state must not depend on it.
    expect(fs.readFileSync(fake.log, "utf8")).toBe(requestsBeforeDelete)
    expect(fs.existsSync(fake.goalFile)).toBe(true)
    broken.dispose()
  })

  test("uses structured Goal operations and publishes each accepted state once", async () => {
    const fake = await installFakeCodex()
    const eventHub = createRuntimeEventHub()
    const events: unknown[] = []
    eventHub.subscribeRuntime((event) => events.push(event.payload))
    const turns = { started: 0, children: 0 }
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      store: store(turns),
      eventHub,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    const session = await adapter.createSession(fake.directory, undefined, "session-1")
    const goals = adapter.goals!

    expect(adapter.readHarnessCapabilities().goals).toBe(true)
    expect(await goals.readCapabilities(session.id, fake.directory)).toMatchObject({
      implemented: true,
      available: true,
      actions: ["pause", "resume", "delete"],
    })
    expect(await goals.read(session.id, fake.directory)).toBeNull()
    expect(await goals.start(session.id, { objective: "Ship safely" }, fake.directory)).toMatchObject({
      ok: true,
      goal: { sessionId: session.id, objective: "Ship safely", status: "active", tokenBudget: 1000 },
    })
    for (let attempt = 0; attempt < 100 && !events.some((event) => (event as { type?: string }).type === "finish"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(turns).toEqual({ started: 2, children: 1 })
    expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "Working" }))
    expect(events.filter((event) => (event as { type?: string }).type === "finish")).toHaveLength(1)
    const turn = (async () => {
      for await (const _event of adapter.sendMessage(session.id, prompt(), fake.directory)) {}
    })()
    await waitForRequest(fake.log, "turn/start")
    expect(await goals.stop(session.id, fake.directory)).toMatchObject({ ok: true, goal: { status: "paused" } })
    await turn
    expect(await goals.resume(session.id, fake.directory)).toMatchObject({ ok: true, goal: { status: "active" } })
    expect(await goals.delete(session.id, fake.directory)).toEqual({ ok: true, goal: null })

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(requests.filter((request) => request.method.startsWith("thread/goal") || request.method.startsWith("turn/"))).toEqual([
      { method: "thread/goal/get" },
      { method: "thread/goal/set" },
      { method: "turn/start" },
      { method: "thread/goal/set", status: "paused" },
      { method: "turn/interrupt" },
      { method: "thread/goal/set", status: "active" },
      { method: "thread/goal/clear" },
    ])
    expect(events.filter((event) => (event as { type?: string }).type?.startsWith("goal-") === true)).toMatchObject([
      { type: "goal-updated", sessionId: session.id, goal: { status: "active" } },
      { type: "goal-updated", sessionId: session.id, goal: { status: "paused" } },
      { type: "goal-updated", sessionId: session.id, goal: { status: "active" } },
      { type: "goal-cleared", sessionId: session.id },
    ])
    adapter.dispose()
  })

  test("routes remaining frames after a mid-turn provider pause and ends the Goal turn", async () => {
    const fake = await installFakeCodex()
    const eventHub = createRuntimeEventHub()
    const events: unknown[] = []
    eventHub.subscribeRuntime((event) => events.push(event.payload))
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      store: store({ started: 0, children: 0 }),
      eventHub,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    const session = await adapter.createSession(fake.directory, undefined, "session-pause-frames")
    await adapter.goals!.start(session.id, { objective: "provider-pauses mid-turn" }, fake.directory)
    for (let attempt = 0; attempt < 200 && !events.some((event) => (event as { type?: string }).type === "finish"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "After pause" }))
    expect(events.filter((event) => (event as { type?: string }).type === "finish")).toHaveLength(1)
    expect(await adapter.goals!.read(session.id, fake.directory)).toMatchObject({ status: "paused" })
    adapter.dispose()
  })

  test("a child agent finishing does not end the parent Goal turn", async () => {
    const harness = goalControllerHarness()
    const controller = new CodexGoalController(harness.host)
    expect(await controller.resource.start("session-child-frames", { objective: "Ship" }, harness.directory))
      .toMatchObject({ ok: true, goal: { status: "active" } })

    controller.handleProcessMessage({
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: { id: "goal-turn-1", status: "inProgress" } },
    })
    controller.handleProcessMessage({
      method: "thread/started",
      params: { thread: { id: "child-1", parentThreadId: THREAD_ID, status: { type: "active" } } },
    })
    controller.handleProcessMessage({
      method: "turn/completed",
      params: { threadId: "child-1", turn: { id: "child-turn-1", status: "completed" } },
    })
    controller.handleProcessMessage({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "goal-turn-1", itemId: "item-1", delta: "after the child" },
    })
    controller.handleProcessMessage({
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: { id: "goal-turn-1", status: "completed" } },
    })
    await harness.settle()

    expect(harness.projected.map((event) => event.method)).toEqual([
      "turn/started",
      "thread/started",
      "turn/completed",
      "item/agentMessage/delta",
      "turn/completed",
    ])
  })

  test("reconciles Goal routing for a live thread no goals call has armed", async () => {
    const harness = goalControllerHarness()
    const controller = new CodexGoalController(harness.host)
    // A restarted driver holds no Goal binding: the thread it resumed for a
    // turn is the only thing that still identifies the session.
    harness.activeThreads.set(THREAD_ID, harness.activeThread("session-restarted"))

    controller.handleProcessMessage({
      method: "thread/goal/updated",
      params: {
        threadId: THREAD_ID,
        goal: { threadId: THREAD_ID, objective: "Survive restart", status: "active", createdAt: 1, updatedAt: 2 },
      },
    })

    expect(harness.published).toEqual([{
      sessionId: "session-restarted",
      directory: harness.directory,
      goal: expect.objectContaining({
        sessionId: "session-restarted",
        objective: "Survive restart",
        status: "active",
      }),
    }])
  })

  test("reconciles Goal routing for a thread whose turn already ended", async () => {
    const harness = goalControllerHarness()
    const controller = new CodexGoalController(harness.host)
    // An ACTIVE Goal outlives its turns: the turn that resumed the thread has
    // ended, so only the runtime's session index still identifies the session.
    harness.sessionByThread.set(THREAD_ID, { sessionId: "session-restarted", directory: harness.directory })

    controller.handleProcessMessage({
      method: "thread/goal/updated",
      params: {
        threadId: THREAD_ID,
        goal: { threadId: THREAD_ID, objective: "Survive restart", status: "active", createdAt: 1, updatedAt: 2 },
      },
    })
    // The Goal's next autonomous turn must project through the same binding.
    controller.handleProcessMessage({
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: { id: "goal-turn-1" } },
    })
    controller.handleProcessMessage({
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: { id: "goal-turn-1", status: "completed" } },
    })
    await harness.settle()

    expect(harness.published).toEqual([{
      sessionId: "session-restarted",
      directory: harness.directory,
      goal: expect.objectContaining({
        sessionId: "session-restarted",
        objective: "Survive restart",
        status: "active",
      }),
    }])
    expect(harness.projected.map((event) => event.method)).toEqual(["turn/started", "turn/completed"])
  })

  test("pause interrupts an in-flight Goal turn instead of stranding it busy", async () => {
    const fake = await installFakeCodex()
    const eventHub = createRuntimeEventHub()
    const events: unknown[] = []
    eventHub.subscribeRuntime((event) => events.push(event.payload))
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      store: store({ started: 0, children: 0 }),
      eventHub,
      codexHome: path.join(fake.directory, "codex-home"),
    })
    const session = await adapter.createSession(fake.directory, undefined, "session-pause-interrupt")
    await adapter.goals!.start(session.id, { objective: "hold-turn until interrupted" }, fake.directory)
    for (let attempt = 0; attempt < 200 && !events.some((event) => (event as { type?: string; delta?: string }).delta === "Working"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "Working" }))
    expect(await adapter.goals!.pause(session.id, fake.directory)).toMatchObject({ ok: true, goal: { status: "paused" } })
    // Pause interrupts and awaits the in-flight Goal turn, so the session must
    // already be idle — a stranded turn would report "cancelled" here instead.
    expect(await adapter.abort(session.id, fake.directory)).toEqual({ ok: true, status: "already_idle" })
    adapter.dispose()
  })
})
