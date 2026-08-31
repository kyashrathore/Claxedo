import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { createRuntimeEventHub } from "../../runtime-event-hub"
import { fakeRuntimeStore } from "../../test-utils/fake-runtime-store"
import { committedStartTurn } from "../../test-utils/fake-runtime-store"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import { removeTestTempDir } from "../shared/test-temp-dir"
import { installFakeCodexAppServer } from "../../test-utils/fake-codex-app-server"
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
    startTurn(input) {
      turns.started++
      return committedStartTurn(input)
    },
  })
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
    await third.deleteSession(session.id, fake.directory)

    expect(fs.existsSync(fake.goalFile)).toBe(false)
    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((request) => request.method.startsWith("thread/goal") || request.method === "thread/resume")
    expect(requests.slice(-6).map((request) => request.method)).toEqual([
      "thread/goal/set",
      "thread/resume",
      "thread/goal/set",
      "thread/goal/clear",
      "thread/resume",
      "thread/goal/clear",
    ])
    third.dispose()
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
