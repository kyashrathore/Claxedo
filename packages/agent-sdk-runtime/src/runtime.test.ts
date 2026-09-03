import { mkdtempSync } from "fs"
import { removeTestTempDir } from "./harnesses/shared/test-temp-dir"
import { tmpdir } from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { createAgentRuntime } from "./runtime"
import type { AgentHarnessFactory, AgentRuntimeAbortResult } from "./runtime"
import { AgentRuntimeStaleTurnError } from "./adapters"
import type { AgentGoalResource, AgentHarnessAdapter } from "./adapter-contract"
import { goalCapabilities } from "./capabilities"
import { agentRuntimeEvent, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { RuntimeEventHub } from "./runtime-event-hub"
import { claude, pi } from "./harnesses"
import { createMemoryRuntimeStore } from "./stores/memory"
import { createSqliteRuntimeStore } from "./stores/sqlite"
import { createConvexRuntimeStore } from "./stores/convex"
import { buildAssistantMessage, buildSession, messagePartUpdated, messageUpdated, permissionAsked, questionAsked, sessionError, sessionIdle, sessionUpdated, sessionUsage } from "./compat-events"
import type { AgentMessage, AgentRuntimeStreamEvent, SessionConfig } from "./index"
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

function failingStream(message: string): AsyncIterable<AgentRuntimeStreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => { throw new Error(message) },
      }
    },
  }
}

/** Session rows are `unknown` on the store port — the runtime owns their shape — so narrow on read. */
function lastTurnOf(rows: { getSession(id: string): unknown }, id: string) {
  return (rows.getSession(id) as { lastTurn?: { status?: string; error?: string } } | null)?.lastTurn
}

function testHarness(options: {
  sendMessage?: AgentHarnessAdapter["sendMessage"]
  goals?: AgentGoalResource
  readHarnessCapabilities?: AgentHarnessAdapter["readHarnessCapabilities"]
  abort?: (id: string) => Promise<AgentRuntimeAbortResult>
  runtimeConfigCalls?: string[]
  commitsStreamEvents?: boolean
  onPermissionResponse?: () => void
  onQuestionAnswer?: () => void
  onQuestionReject?: () => void
  sessionConfigReads?: string[]
  onCreate?: (context: { eventHub: RuntimeEventHub }) => void
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
    async getSessionConfig(id) {
      options.sessionConfigReads?.push(id)
      return { harness: { id: "pi", access: "native" }, variant: null, agent: "build" }
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
    readHarnessCapabilities: options.readHarnessCapabilities ?? (() => ({} as never)),
    ...(options.goals ? { goals: options.goals } : {}),
    sendMessage: options.sendMessage ?? (async function* () {}),
    async getMessages() {
      return []
    },
    ...(options.onPermissionResponse
      ? {
          async listPermissions() { return [] },
          async respondPermission() { options.onPermissionResponse?.() },
        }
      : {}),
    ...(options.onQuestionAnswer || options.onQuestionReject
      ? {
          async listQuestions() { return [] },
          async replyQuestion() { options.onQuestionAnswer?.() },
          async rejectQuestion() { options.onQuestionReject?.() },
        }
      : {}),
    dispose() {},
    ...(options.abort ? { abort: options.abort } : {}),
  }
  return {
    id: "pi",
    access: "native",
    create: (context: { eventHub: RuntimeEventHub }) => {
      options.onCreate?.(context)
      return adapter
    },
  } as unknown as AgentHarnessFactory
}

const GOAL_HARNESS_CAPABILITIES = {
  harness: "pi",
  abort: false,
  reconnect: false,
  replay: true,
  permissions: false,
  questions: false,
  todos: false,
  commands: false,
  fork: false,
  revert: false,
  unrevert: false,
  configOptions: false,
  subagents: false,
  goals: true,
} as const

function goalPayloads(events: Array<{ type: string }>) {
  return events.filter((payload) => payload.type === "goal-updated" || payload.type === "goal-cleared")
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
      return { id, agentSessionId: `${input.id}-native-thread`, rollback: async () => {} }
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
  test("runs Goal operations through the dedicated resource without prompt fallback", async () => {
    const calls: string[] = []
    let goal: Awaited<ReturnType<AgentGoalResource["read"]>> = null
    const goals: AgentGoalResource = {
      readCapabilities: () => goalCapabilities({
        implemented: true,
        available: true,
        actions: ["pause", "resume", "delete"],
        recovery: "reconcile",
        optionalFields: [],
      }),
      read: async () => {
        calls.push("read")
        return goal
      },
      start: async (sessionId, input) => {
        calls.push(`start:${input.objective}`)
        goal = { sessionId, objective: input.objective, status: "active", createdAt: 1, updatedAt: 1 }
        return { ok: true, goal }
      },
      pause: async () => {
        calls.push("pause")
        goal = goal ? { ...goal, status: "paused", updatedAt: 2 } : null
        return goal ? { ok: true, goal } : { ok: false, status: "not_found", message: "No Goal" }
      },
      resume: async () => {
        calls.push("resume")
        goal = goal ? { ...goal, status: "active", updatedAt: 3 } : null
        return goal ? { ok: true, goal } : { ok: false, status: "not_found", message: "No Goal" }
      },
      stop: async () => {
        calls.push("stop")
        goal = goal ? { ...goal, status: "paused", updatedAt: 4 } : null
        return goal ? { ok: true, goal } : { ok: false, status: "not_found", message: "No Goal" }
      },
      delete: async () => {
        calls.push("delete")
        goal = null
        return { ok: true, goal: null }
      },
    }
    let messagesSent = 0
    const factory = testHarness({
      goals,
      readHarnessCapabilities: () => ({
        harness: "pi",
        abort: false,
        reconnect: false,
        replay: true,
        permissions: false,
        questions: false,
        todos: false,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: false,
        subagents: false,
        goals: true,
      }),
      sendMessage: async function* () {
        messagesSent += 1
      },
    })
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [factory],
    })
    const session = await runtime.sessions.create({ directory: "/repo", harness: { id: "pi", access: "native" } })

    await expect(runtime.goals.start({ sessionId: session.id, objective: "  Ship safely  " }, "/repo")).resolves.toMatchObject({
      ok: true,
      goal: { objective: "Ship safely", status: "active" },
    })
    await expect(runtime.goals.pause(session.id, "/repo")).resolves.toMatchObject({ ok: true, goal: { status: "paused" } })
    await expect(runtime.goals.resume(session.id, "/repo")).resolves.toMatchObject({ ok: true, goal: { status: "active" } })
    await expect(runtime.goals.stop(session.id, "/repo")).resolves.toMatchObject({ ok: true, goal: { status: "paused" } })
    await expect(runtime.goals.delete(session.id, "/repo")).resolves.toEqual({ ok: true, goal: null })
    expect(calls).toEqual(["read", "start:Ship safely", "pause", "resume", "stop", "delete"])
    expect(messagesSent).toBe(0)
    runtime.dispose()
  })

  test("delivers provider-originated Goal updates to runtime subscribers exactly once", async () => {
    let eventHub: RuntimeEventHub | undefined
    let goal: RuntimeGoalSnapshot | null = null
    const mirrorToHub = (sessionId: string, next: RuntimeGoalSnapshot | null) => {
      eventHub?.publishRuntime({
        directory: "/repo",
        sessionId,
        payload: next
          ? agentRuntimeEvent.goalUpdated({ sessionId, goal: next })
          : agentRuntimeEvent.goalCleared({ sessionId }),
      })
    }
    const unusedMutation = { ok: false, status: "failed", message: "not exercised" } as const
    const goals: AgentGoalResource = {
      readCapabilities: () => goalCapabilities({
        implemented: true,
        available: true,
        actions: ["pause", "resume", "delete"],
        recovery: "reconcile",
        optionalFields: [],
      }),
      read: async () => goal,
      start: async (sessionId, startInput) => {
        goal = { sessionId, objective: startInput.objective, status: "active", createdAt: 1, updatedAt: 1 }
        // Adapters mirror an accepted mutation onto the hub as well; the
        // subscriber must still see that state exactly once.
        mirrorToHub(sessionId, goal)
        return { ok: true, goal }
      },
      pause: async () => unusedMutation,
      resume: async () => unusedMutation,
      stop: async () => unusedMutation,
      delete: async () => ({ ok: true, goal: null }),
    }
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        goals,
        readHarnessCapabilities: () => GOAL_HARNESS_CAPABILITIES,
        onCreate: (context) => { eventHub = context.eventHub },
      })],
    })
    const session = await runtime.sessions.create({ directory: "/repo", harness: { id: "pi", access: "native" } })
    const subscription = runtime.events.subscribe({ sessionId: session.id })

    await runtime.goals.start({ sessionId: session.id, objective: "Ship" }, "/repo")
    // A provider-driven transition never passes through a runtime mutation.
    goal = { ...goal!, status: "paused", updatedAt: 2 }
    mirrorToHub(session.id, goal)
    runtime.dispose()

    const payloads: Array<{ type: string }> = []
    for await (const event of subscription) payloads.push(event.payload)
    expect(goalPayloads(payloads)).toMatchObject([
      { type: "goal-updated", goal: { status: "active", updatedAt: 1 } },
      { type: "goal-updated", goal: { status: "paused", updatedAt: 2 } },
    ])
  })

  test("routes every Goal mutation through one path and never gates stop", async () => {
    const calls: string[] = []
    let goal: RuntimeGoalSnapshot | null = null
    const goals: AgentGoalResource = {
      readCapabilities: () => goalCapabilities({
        implemented: true,
        available: true,
        // A harness that implements Goal but offers no pause/resume/delete.
        actions: [],
        recovery: "blocked",
        optionalFields: [],
      }),
      read: async () => goal,
      start: async (sessionId, startInput) => {
        calls.push("start")
        goal = { sessionId, objective: startInput.objective, status: "active", createdAt: 1, updatedAt: 1 }
        return { ok: true, goal }
      },
      pause: async () => {
        calls.push("pause")
        return { ok: true, goal: goal! }
      },
      resume: async () => {
        calls.push("resume")
        return { ok: true, goal: goal! }
      },
      stop: async () => {
        calls.push("stop")
        goal = { ...goal!, status: "paused", updatedAt: 2 }
        return { ok: true, goal }
      },
      delete: async () => {
        calls.push("delete")
        return { ok: true, goal: null }
      },
    }
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({ goals, readHarnessCapabilities: () => GOAL_HARNESS_CAPABILITIES })],
    })
    const session = await runtime.sessions.create({ directory: "/repo", harness: { id: "pi", access: "native" } })
    const subscription = runtime.events.subscribe({ sessionId: session.id })

    await runtime.goals.start({ sessionId: session.id, objective: "Ship" }, "/repo")
    for (const action of ["pause", "resume", "delete"] as const) {
      await expect(runtime.goals[action](session.id, "/repo"))
        .rejects.toMatchObject({ code: "goal_action_unavailable" })
    }
    await expect(runtime.goals.stop(session.id, "/repo")).resolves.toMatchObject({
      ok: true,
      goal: { status: "paused" },
    })
    expect(calls).toEqual(["start", "stop"])
    runtime.dispose()

    const payloads: Array<{ type: string }> = []
    for await (const event of subscription) payloads.push(event.payload)
    expect(goalPayloads(payloads)).toMatchObject([
      { type: "goal-updated", goal: { status: "active" } },
      { type: "goal-updated", goal: { status: "paused" } },
    ])
  })

  test("serializes concurrent Goal starts per session", async () => {
    let goal: Awaited<ReturnType<AgentGoalResource["read"]>> = null
    let reads = 0
    let starts = 0
    const goals: AgentGoalResource = {
      readCapabilities: () => goalCapabilities({
        implemented: true,
        available: true,
        actions: [],
        recovery: "reconcile",
        optionalFields: [],
      }),
      read: async () => {
        reads += 1
        await tick()
        return goal
      },
      start: async (sessionId, input) => {
        starts += 1
        goal = { sessionId, objective: input.objective, status: "active", createdAt: 1, updatedAt: 1 }
        return { ok: true, goal }
      },
      pause: async () => ({ ok: false, status: "unsupported", message: "unsupported" }),
      resume: async () => ({ ok: false, status: "unsupported", message: "unsupported" }),
      stop: async () => ({ ok: false, status: "not_found", message: "not found" }),
      delete: async () => ({ ok: false, status: "unsupported", message: "unsupported" }),
    }
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        goals,
        readHarnessCapabilities: () => ({
          harness: "pi",
          abort: false,
          reconnect: false,
          replay: true,
          permissions: false,
          questions: false,
          todos: false,
          commands: false,
          fork: false,
          revert: false,
          unrevert: false,
          configOptions: false,
          subagents: false,
          goals: true,
        }),
      })],
    })
    const session = await runtime.sessions.create({ directory: "/repo", harness: { id: "pi", access: "native" } })

    const [first, second] = await Promise.allSettled([
      runtime.goals.start({ sessionId: session.id, objective: "First" }, "/repo"),
      runtime.goals.start({ sessionId: session.id, objective: "Second" }, "/repo"),
    ])

    expect(first).toMatchObject({ status: "fulfilled", value: { ok: true, goal: { objective: "First" } } })
    expect(second).toMatchObject({ status: "rejected", reason: { code: "goal_already_exists" } })
    expect({ reads, starts }).toEqual({ reads: 2, starts: 1 })
    runtime.dispose()
  })

  test("reports unavailable Goal capabilities and existing state without admitting mutations", async () => {
    const mutations: string[] = []
    const existing = {
      sessionId: "ses_test",
      objective: "Preserve the visible Goal",
      status: "paused" as const,
      createdAt: 1,
      updatedAt: 2,
    }
    const unavailableReason = "Cursor SDK requires an explicit cursor-sdk API key"
    const goals: AgentGoalResource = {
      readCapabilities: () => goalCapabilities({
        implemented: true,
        available: false,
        unavailableReason,
        actions: [],
        recovery: "blocked",
        optionalFields: [],
      }),
      read: async () => existing,
      start: async () => {
        mutations.push("start")
        return { ok: true, goal: existing }
      },
      pause: async () => {
        mutations.push("pause")
        return { ok: true, goal: existing }
      },
      resume: async () => {
        mutations.push("resume")
        return { ok: true, goal: existing }
      },
      stop: async () => {
        mutations.push("stop")
        return { ok: true, goal: existing }
      },
      delete: async () => {
        mutations.push("delete")
        return { ok: true, goal: null }
      },
    }
    const factory = testHarness({
      goals,
      readHarnessCapabilities: () => ({
        harness: "cursor",
        abort: false,
        reconnect: false,
        replay: true,
        permissions: false,
        questions: false,
        todos: false,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: false,
        subagents: false,
        goals: true,
      }),
    })
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [factory],
    })
    const session = await runtime.sessions.create({
      id: existing.sessionId,
      directory: "/repo",
      harness: { id: "pi", access: "native" },
    })

    await expect(runtime.goals.capabilities(session.id, "/repo")).resolves.toMatchObject({
      implemented: true,
      available: false,
      unavailableReason,
    })
    await expect(runtime.goals.read(session.id, "/repo")).resolves.toEqual(existing)
    await expect(runtime.goals.start({ sessionId: session.id, objective: "Retry" }, "/repo"))
      .rejects.toMatchObject({ code: "goal_unavailable", message: unavailableReason })
    await expect(runtime.goals.stop(session.id, "/repo"))
      .rejects.toMatchObject({ code: "goal_unavailable", message: unavailableReason })
    expect(mutations).toEqual([])
    runtime.dispose()
  })

  test("rejects invalid, duplicate, unsupported, and cross-directory Goal work before adapter mutation", async () => {
    const calls: string[] = []
    const existing = { sessionId: "ses_test", objective: "Existing", status: "active" as const, createdAt: 1, updatedAt: 1 }
    const goals: AgentGoalResource = {
      readCapabilities: () => goalCapabilities({
        implemented: true,
        available: true,
        actions: ["delete"],
        recovery: "blocked",
        optionalFields: [],
      }),
      read: async () => existing,
      start: async () => {
        calls.push("start")
        return { ok: true, goal: existing }
      },
      pause: async () => {
        calls.push("pause")
        return { ok: true, goal: existing }
      },
      resume: async () => {
        calls.push("resume")
        return { ok: true, goal: existing }
      },
      stop: async () => {
        calls.push("stop")
        return { ok: true, goal: existing }
      },
      delete: async () => {
        calls.push("delete")
        return { ok: true, goal: null }
      },
    }
    const factory = testHarness({
      goals,
      readHarnessCapabilities: () => ({
        harness: "pi",
        abort: false,
        reconnect: false,
        replay: true,
        permissions: false,
        questions: false,
        todos: false,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: false,
        subagents: false,
        goals: true,
      }),
    })
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [factory],
    })
    const session = await runtime.sessions.create({ directory: "/repo", harness: { id: "pi", access: "native" } })

    await expect(runtime.goals.start({ sessionId: session.id, objective: " " }, "/repo")).rejects.toMatchObject({ code: "goal_invalid_objective" })
    await expect(runtime.goals.start({ sessionId: session.id, objective: "x".repeat(4_001) }, "/repo")).rejects.toMatchObject({ code: "goal_invalid_objective" })
    await expect(runtime.goals.start({ sessionId: session.id, objective: "Another" }, "/repo")).rejects.toMatchObject({ code: "goal_already_exists" })
    await expect(runtime.goals.pause(session.id, "/repo")).rejects.toMatchObject({ code: "goal_action_unavailable" })
    await expect(runtime.goals.delete(session.id, "/other")).rejects.toMatchObject({ code: "goal_scope_mismatch" })
    expect(calls).toEqual([])
    runtime.dispose()
  })

  test("resolves one lazy adapter for concurrent callers", async () => {
    let resolutions = 0
    let targetAdapter: AgentHarnessAdapter | undefined
    handoffHarness({ id: "claude", onAdapter: (adapter) => { targetAdapter = adapter } })
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [handoffHarness({ id: "pi" })],
      resolveHarness: async () => {
        resolutions++
        await tick()
        if (!targetAdapter) throw new Error("target adapter was not created")
        return targetAdapter
      },
    })

    await Promise.all([
      runtime.sessions.create({ id: "ses_lazy_a", directory: "/repo", harness: { id: "claude", access: "native" } }),
      runtime.sessions.create({ id: "ses_lazy_b", directory: "/repo", harness: { id: "claude", access: "native" } }),
    ])

    expect(resolutions).toBe(1)
    runtime.dispose()
  })

  test("ends a slow subscription with an explicit overflow notice", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness()],
      subscriberBufferSize: 1,
    })
    const session = await runtime.sessions.create({ directory: undefined, harness: { id: "pi", access: "native" } })
    const iterator = runtime.events.subscribe({ sessionId: session.id })[Symbol.asyncIterator]()

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_overflow", text: "hello" })

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        sessionId: session.id,
        payload: { type: "harness-notice", code: "runtime.subscription_overflow" },
      },
    })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    runtime.dispose()
  })

  test("routes an interaction the aggregated listing missed to a harness that can answer it", async () => {
    let permissionResponses = 0
    let questionAnswers = 0
    let questionRejects = 0
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness({
        onPermissionResponse: () => permissionResponses++,
        onQuestionAnswer: () => questionAnswers++,
        onQuestionReject: () => questionRejects++,
      })],
    })

    // listPermissions/listQuestions answer empty: the listing is a snapshot and
    // the adapter, not the listing, decides whether the id is still pending.
    await runtime.permissions.respond("perm_unlisted", "deny", "/repo")
    await runtime.questions.answer("question_unlisted", "answer", "/repo")
    await runtime.questions.reject("question_unlisted", "/repo")
    expect({ permissionResponses, questionAnswers, questionRejects }).toEqual({
      permissionResponses: 1,
      questionAnswers: 1,
      questionRejects: 1,
    })
    runtime.dispose()
  })

  test("rejects interactions when no registered harness implements the reply", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness()],
    })

    await expect(runtime.permissions.respond("perm_unlisted", "deny", "/repo"))
      .rejects.toThrow("No registered harness supports permissions")
    await expect(runtime.questions.answer("question_unlisted", "answer", "/repo"))
      .rejects.toThrow("No registered harness supports questions")
    await expect(runtime.questions.reject("question_unlisted", "/repo"))
      .rejects.toThrow("No registered harness supports questions")
    runtime.dispose()
  })

  test("routes a listed interaction to the adapter that owns its session", async () => {
    const responders: string[] = []
    const interactionHarness = (id: "pi" | "claude", permission?: { id: string; sessionID: string }) => ({
      id,
      access: "native",
      create: () => ({
        async listSessions() { return [] },
        async getSession(sessionId: string) { return { id: sessionId } },
        async createSession(_directory: string, _title: string, sessionId = `ses_${id}`) { return { id: sessionId } },
        async updateSession() { return null },
        async getSessionConfig() { return { harness: { id, access: "native" }, variant: null, agent: null } },
        async updateSessionConfig() { return { harness: { id, access: "native" }, variant: null, agent: null } },
        async deleteSession() {},
        readHarnessCapabilities() { return {} as never },
        async *sendMessage() {},
        async getMessages() { return [] },
        async listPermissions() { return permission ? [permission] : [] },
        async respondPermission() { responders.push(id) },
        dispose() {},
      }),
    } as unknown as AgentHarnessFactory)

    const store = createMemoryRuntimeStore()
    const runtime = createAgentRuntime({
      store,
      // "pi" is registered first, so a listing-blind fallback would pick it.
      harnesses: [interactionHarness("pi"), interactionHarness("claude", { id: "perm_1", sessionID: "ses_claude" })],
    })
    await runtime.sessions.create({
      id: "ses_claude",
      directory: "/repo",
      harness: { id: "claude", access: "native" },
    })

    await runtime.permissions.respond("perm_1", "deny", "/repo")
    expect(responders).toEqual(["claude"])
    runtime.dispose()
  })

  test("derives a missing runtime config from the owning adapter and persists it once", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const sessionConfigReads: string[] = []
    rows.bindSession({
      sessionId: "ses_missing_config",
      directory: "/repo",
      agentSessionId: "native_missing_config",
    })
    const runtime = createAgentRuntime({ store, harnesses: [testHarness({ sessionConfigReads })] })
    expect(rows.getSessionConfig("ses_missing_config")).toBeFalsy()

    await expect(runtime.config.read("ses_missing_config", "/repo"))
      .resolves.toMatchObject({ harness: { id: "pi", access: "native" }, agent: "build" })
    // Persisted, so the derivation is a one-time repair rather than a per-call fallback.
    expect(rows.getSessionConfig("ses_missing_config")).toMatchObject({ harness: { id: "pi", access: "native" } })

    await expect(runtime.events.list("ses_missing_config", "/repo")).resolves.toEqual([])
    await expect(runtime.turns.start({ sessionId: "ses_missing_config", text: "hello" }))
      .resolves.toMatchObject({ sessionId: "ses_missing_config" })
    expect(sessionConfigReads).toEqual(["ses_missing_config"])
    runtime.dispose()
  })

  test("never derives a runtime config for a session the store has not bound", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const sessionConfigReads: string[] = []
    const runtime = createAgentRuntime({ store, harnesses: [testHarness({ sessionConfigReads })] })

    // A config gap belongs to a session that exists. Deriving for an unknown id
    // would ask the harness about a session nobody bound and write a config row
    // behind it, so the lone-adapter repair must not reach it.
    await expect(runtime.events.list("ses_never_bound", "/repo"))
      .rejects.toThrow("Session ses_never_bound has no runtime config")
    await expect(runtime.config.read("ses_never_bound", "/repo"))
      .rejects.toThrow("Session ses_never_bound has no runtime config")
    expect(sessionConfigReads).toEqual([])
    expect(rows.getSessionConfig("ses_never_bound")).toBeFalsy()
    runtime.dispose()
  })

  test("rejects session operations when no adapter can be named for the session", async () => {
    const store = createMemoryRuntimeStore()
    storeRows(store).bindSession({
      sessionId: "ses_missing_config",
      directory: "/repo",
      agentSessionId: "native_missing_config",
    })
    // Two registered harnesses and no persisted config: naming an owner would be a guess.
    const runtime = createAgentRuntime({
      store,
      harnesses: [handoffHarness({ id: "pi" }), handoffHarness({ id: "claude" })],
    })

    await expect(runtime.config.read("ses_missing_config", "/repo"))
      .rejects.toThrow("Session ses_missing_config has no runtime config")
    await expect(runtime.events.list("ses_missing_config", "/repo"))
      .rejects.toThrow("Session ses_missing_config has no runtime config")
    await expect(runtime.turns.start({ sessionId: "ses_missing_config", text: "hello" }))
      .rejects.toThrow("Session ses_missing_config has no runtime config")
    runtime.dispose()
  })

  test("rejects todo reads when the selected harness does not implement them", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [testHarness()],
    })
    const session = await runtime.sessions.create({
      directory: "/repo",
      harness: { id: "pi", access: "native" },
    })

    await expect(runtime.todos.list(session.id, "/repo"))
      .rejects.toThrow("This harness does not support todos")
    runtime.dispose()
  })

  test("keeps the runtime inventory current after adapter-backed update and delete", async () => {
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [pi()],
    })
    const session = await runtime.sessions.create({
      id: "ses_inventory",
      directory: undefined,
      harness: { id: "pi", access: "native" },
      title: "Before",
    })

    await expect(runtime.sessions.update(session.id, { title: "After" })).resolves.toMatchObject({ title: "After" })
    await expect(runtime.sessions.list(undefined)).resolves.toMatchObject([{ id: session.id, title: "After" }])

    await runtime.sessions.delete(session.id)
    await expect(runtime.sessions.list(undefined)).resolves.toEqual([])
    runtime.dispose()
  })

  test("persists adapter-accepted config updates through both public namespaces", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [handoffHarness({ id: "pi" })],
    })
    const session = await runtime.sessions.create({
      id: "ses_config",
      directory: "/repo",
      harness: { id: "pi", access: "native" },
    })

    await runtime.sessions.updateConfig(session.id, { variant: "high" }, "/repo")
    expect(rows.getSessionConfig(session.id)?.variant).toBe("high")

    await runtime.config.update(session.id, { agent: "review" }, "/repo")
    expect(rows.getSessionConfig(session.id)).toMatchObject({ variant: "high", agent: "review" })
    runtime.dispose()
  })

  test("routes harness changes from config.update through conversation handoff", async () => {
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const handoffs: string[] = []
    const runtime = createAgentRuntime({
      store,
      harnesses: [
        handoffHarness({ id: "pi" }),
        handoffHarness({ id: "claude", handoffs }),
      ],
    })
    const session = await runtime.sessions.create({
      id: "ses_config_handoff",
      directory: "/repo",
      harness: { id: "pi", access: "native" },
    })

    await runtime.config.update(session.id, { harness: { id: "claude", access: "native" } }, "/repo")

    expect(handoffs).toEqual([session.id])
    expect(rows.getSessionConfig(session.id)?.harness).toEqual({ id: "claude", access: "native" })
    expect(rows.getSessionConfig(session.id)?.handoff).toMatchObject({
      from: { id: "pi", access: "native" },
      pending: true,
    })
    runtime.dispose()
  })

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
          yield { type: "finish", sessionId: _id }
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
        yield { type: "finish", sessionId: _id }
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

  test("rejects a concurrent turn before persisting any part of it", async () => {
    let release!: () => void
    const firstTurn = new Promise<void>((resolve) => {
      release = resolve
    })
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id) {
          await firstTurn
          yield { type: "finish", sessionId: id }
        },
      })],
    })
    const session = await runtime.sessions.create({
      directory: "/repo",
      harness: { id: "pi", access: "native" },
    })

    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "first" })
    await expect(runtime.turns.start({
      sessionId: session.id,
      messageId: "msg_2",
      text: "second",
    })).rejects.toThrow("Session is already processing a message")

    expect(rows.getMessages(session.id)).toMatchObject([
      { info: { id: "msg_1", role: "user" } },
      { info: { id: "msg_1_r", role: "assistant" } },
    ])
    expect(rows.getMessages(session.id)).toHaveLength(2)
    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: "busy",
    })
    expect(lastTurnOf(rows, session.id)).toBeUndefined()

    release()
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
        sendMessage: () => failingStream("adapter exploded"),
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

  test("an acknowledged abort releases admission and fences a stuck turn's late events", async () => {
    let releaseFirst: (() => void) | undefined
    const firstTurn = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const store = createMemoryRuntimeStore()
    const rows = storeRows(store)
    const runtime = createAgentRuntime({
      store,
      harnesses: [testHarness({
        sendMessage: async function* (id, prompt) {
          if (prompt.userMessageId === "msg_1") {
            await firstTurn
            yield messagePartUpdated({
              id: "stale-part",
              sessionID: id,
              messageID: prompt.assistantMessageId,
              type: "text",
              text: "stale reply",
            })
            yield { type: "finish", sessionId: id }
            return
          }
          yield messagePartUpdated({
            id: "replacement-part",
            sessionID: id,
            messageID: prompt.assistantMessageId,
            type: "text",
            text: "replacement reply",
          })
          yield { type: "finish", sessionId: id }
        },
        abort: async () => ({ ok: true, status: "cancelled" }),
      })],
    })
    const session = await runtime.sessions.create({
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })

    const abortedEvents = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))
    await runtime.turns.start({ sessionId: session.id, messageId: "msg_1", text: "first" })
    await expect(runtime.turns.abort(session.id)).resolves.toEqual({ ok: true, status: "cancelled" })
    await expect(abortedEvents).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: { type: "finish", sessionId: session.id } }),
    ]))

    const replacementEvents = collectUntilFinish(runtime.events.subscribe({ sessionId: session.id }))
    await expect(runtime.turns.start({
      sessionId: session.id,
      messageId: "msg_2",
      text: "replacement",
    })).resolves.toMatchObject({ userMessageId: "msg_2" })
    await replacementEvents

    releaseFirst?.()
    await tick()

    expect(JSON.stringify(rows.getMessages(session.id))).toContain("replacement reply")
    expect(JSON.stringify(rows.getMessages(session.id))).not.toContain("stale reply")
    await expect(runtime.sessions.get(session.id)).resolves.toMatchObject({
      status: null,
      lastTurn: { status: "completed", assistantMessageId: "msg_2_r" },
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
          sendMessage: () => failingStream("sqlite failure"),
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

  test("sqlite commits each acknowledged mutation without waiting for close", () => {
    const root = tempRoot()
    try {
      const store = storeRows(createSqliteRuntimeStore({ root }))
      store.bindSession({ sessionId: "ses_1", directory: "/repo", agentSessionId: "ses_1" })
      for (let i = 0; i < 100; i++) {
        store.appendEvent({
          sessionId: "ses_1",
          payload: sessionUpdated(buildSession({
            id: "ses_1",
            directory: "/repo",
            title: `Streamed ${i}`,
          })),
        })
      }

      const reopened = createSqliteRuntimeStore({ root }) as unknown as {
        getSession(id: string): { title: string | null } | null
        close(): void
      }
      expect(reopened.getSession("ses_1")).toMatchObject({ title: "Streamed 99" })
      reopened.close()
      store.close()
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
