import { describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeStore } from "../store"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"
import { Hono } from "hono"
import { fetchDouble } from "../test-support/fetch-double"
import type {
  AgentMessage,
  AgentRuntime,
  AgentRuntimeStreamEvent,
  AgentSession,
  PromptInput,
  RuntimeDirectory,
  SessionConfig,
  SessionConfigUpdate,
} from "@claxedo/agent-sdk-runtime"
import { AgentRuntimeGoalError } from "@claxedo/agent-sdk-runtime"
import type {
  AgentHarnessAdapter,
  AgentMessagePage,
  AgentMessagePageInput,
} from "@claxedo/agent-sdk-runtime/adapters"
import {
  buildAssistantMessage,
  buildSession,
  buildUserMessage,
  permissionAsked,
  permissionReplied,
  messagePartUpdated,
  messageUpdated,
  sessionError,
  sessionIdle,
  sessionStatus,
  sessionUpdated,
  type CompatEvent,
} from "../compat-events"
import { createRuntimeEventHub } from "../runtime-event-hub"
import { workspaceRuntimeBus, type WorkspaceRuntimeEvent } from "../bus"
import { createSessionRoutes as createRawSessionRoutes } from "./session-core"
import { SessionRoutes as createRawSessionRoutesFacade } from "./session"
import type { SessionAccessPolicy } from "../session-access-policy"

function createSessionRoutes(options: Parameters<typeof createRawSessionRoutes>[0]) {
  return createRawSessionRoutes({
    resolveExecutionBinding: (_c, directory, sessionId) => ({
      sessionId,
      workspaceId: "workspace-test",
      directory: directory ?? "",
      connectionId: "native:codex",
      upstreamSessionId: sessionId,
    }),
    ...options,
  })
}

function SessionRoutes(
  getAdapter: Parameters<typeof createRawSessionRoutesFacade>[0],
  options: Parameters<typeof createRawSessionRoutesFacade>[1] = {},
) {
  return createRawSessionRoutesFacade(getAdapter, {
    resolveExecutionBinding: ({ directory, sessionId }) => ({
      sessionId,
      workspaceId: "workspace-test",
      directory,
      connectionId: "native:codex",
      upstreamSessionId: sessionId,
    }),
    ...options,
  }).routes
}

function adapter(input: {
  // The adapter interface hands these a `RuntimeDirectory` (`string |
  // undefined`), so the doubles must accept one too.
  onPrompt?: (prompt: PromptInput, directory: RuntimeDirectory) => void
  sendMessage?: (id: string, prompt: PromptInput, directory: RuntimeDirectory) => AsyncIterable<AgentRuntimeStreamEvent>
  getMessages?: (id: string, directory: RuntimeDirectory) => Promise<AgentMessage[]> | AgentMessage[]
  getMessagePage?: (
    id: string,
    page: AgentMessagePageInput,
    directory: RuntimeDirectory,
  ) => Promise<AgentMessagePage>
}): AgentHarnessAdapter {
  return {
    instructionChannel: "turn-system-prompt",
    getSession: async (binding) => buildSession({ id: binding.sessionId, directory: binding.directory, title: "Demo" }),
    createSession: async () => ({ id: "s1" }),
    updateSession: async (binding, updates) => buildSession({ id: binding.sessionId, directory: binding.directory, title: updates.title ?? "Demo" }),
    getSessionConfig: async () => ({
      harness: { id: "codex", access: "native" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: "fast",
      agent: "plan",
    }),
    updateSessionConfig: async (_binding, patch) => ({
      harness: patch.harness ?? { id: "codex", access: "native" },
      ...(patch.model ? { model: patch.model } : {}),
      variant: patch.variant ?? null,
      agent: patch.agent ?? null,
    } satisfies SessionConfig),
    deleteSession: async () => {},
    readHarnessCapabilities: () => ({
      harness: "codex",
      abort: true,
      reconnect: false,
      replay: true,
      permissions: true,
      questions: true,
      todos: true,
      commands: true,
      fork: true,
      revert: true,
      unrevert: true,
      configOptions: false,
      subagents: true,
      effortLevels: NO_HARNESS_EFFORT,
      instructionChannel: "turn-system-prompt",
      goals: false,
    }),
    executeTurn(binding, prompt) {
      input.onPrompt?.(prompt, binding.directory)
      return input.sendMessage?.(binding.sessionId, prompt, binding.directory) ?? (async function* () {})()
    },
    getMessages: async (binding) => input.getMessages?.(binding.sessionId, binding.directory) ?? [],
    ...(input.getMessagePage ? {
      getMessagePage: (binding, page) => input.getMessagePage!(binding.sessionId, page, binding.directory),
    } : {}),
    cancelTurn: async () => ({ execution: "terminal" as const, cleanup: "verified_clear" as const }),
    revert: async () => {},
    unrevert: async () => {},
    forkSession: async () => ({ id: "forked" }),

    executeCommand: async () => {},
    listCommands: async () => [],
    listAgents: async () => [],
    getTodos: async () => [],
    listPermissions: async () => [],
    respondPermission: async () => {},
    replyQuestion: async () => {},
    rejectQuestion: async () => {},
    applyConfig: async () => {},
    probeConfigOptions: async () => ({ options: [] }),
    dispose: () => {},
  }
}

describe("SessionRoutes message paging bridge", () => {
  it("passes a page request to the workspace authority before the adapter", async () => {
    const directory = process.cwd()
    const message = { info: { id: "message-1", sessionID: "session-1", role: "user" }, parts: [] } as AgentMessage
    const calls: Array<{ directory: string; sessionId: string; page: AgentMessagePageInput }> = []
    const fixture = adapter({
      getMessagePage: async () => {
        throw new Error("adapter page must not run")
      },
    })
    let authorityAdapter: AgentHarnessAdapter | undefined
    const app = SessionRoutes(
      () => fixture,
      {
        getMessagePage(input) {
          authorityAdapter = input.adapter
          calls.push({ directory: input.directory, sessionId: input.sessionId, page: input.page })
          return { messages: [message], nextCursor: "workspace-cursor" }
        },
      },
    )

    const response = await app.request(
      `http://localhost/session/session-1/message?directory=${encodeURIComponent(directory)}&limit=25&before=opaque%3Acursor`,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([message])
    expect(response.headers.get("x-next-cursor")).toBe("workspace-cursor")
    expect(calls).toEqual([{
      directory,
      sessionId: "session-1",
      page: { limit: 25, before: "opaque:cursor" },
    }])
    expect(authorityAdapter).toBe(fixture)
  })
})

describe("session Goal routes", () => {
  const directory = process.cwd()
  const goal = {
    sessionId: "s1",
    objective: "Ship universal Goal support",
    status: "active" as const,
    createdAt: 1,
    updatedAt: 2,
  }
  const capabilities = {
    implemented: true,
    available: true,
    actions: ["pause", "resume", "delete"],
    recovery: "reconcile",
    optionalFields: [],
  }

  function goalRuntime(
    calls: string[],
    overrides: Partial<AgentRuntime["goals"]> = {},
  ): AgentRuntime {
    return {
      goals: {
        capabilities: async () => {
          calls.push("capabilities")
          return capabilities
        },
        read: async () => {
          calls.push("read")
          return goal
        },
        start: async (input: { objective: string }) => {
          calls.push(`start:${input.objective}`)
          return { ok: true, goal }
        },
        pause: async () => {
          calls.push("pause")
          return { ok: true, goal: { ...goal, status: "paused" as const } }
        },
        resume: async () => {
          calls.push("resume")
          return { ok: true, goal }
        },
        stop: async () => {
          calls.push("stop")
          return { ok: true, goal: { ...goal, status: "paused" as const } }
        },
        delete: async () => {
          calls.push("delete")
          return { ok: true, goal: null }
        },
        ...overrides,
      },
    } as unknown as AgentRuntime
  }

  it("routes every Goal operation through the dedicated runtime resource", async () => {
    const calls: string[] = []
    const guarded: string[] = []
    const runtime = goalRuntime(calls)
    const app = SessionRoutes(() => adapter({}), {
      beforeSessionOperation({ operation }) {
        guarded.push(operation)
      },
      resolveRuntime: () => runtime,
    })
    const base = "http://localhost/session/s1/goal"
    const url = (suffix = "") => `${base}${suffix}?directory=${encodeURIComponent(directory)}`

    const responses = [
      await app.request(url("/state")),
      await app.request(url("/capabilities")),
      await app.request(url()),
      await app.request(url(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: goal.objective }),
      }),
      await app.request(url("/pause"), { method: "POST" }),
      await app.request(url("/resume"), { method: "POST" }),
      await app.request(url("/stop"), { method: "POST" }),
      await app.request(url(), { method: "DELETE" }),
    ]

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 201, 200, 200, 200, 200])
    expect(calls).toEqual([
      "capabilities",
      "read",
      "capabilities",
      "read",
      `start:${goal.objective}`,
      "pause",
      "resume",
      "stop",
      "delete",
    ])
    expect(guarded).toEqual([
      "goal_state",
      "goal_capabilities",
      "goal_read",
      "goal_start",
      "goal_pause",
      "goal_resume",
      "goal_stop",
      "goal_delete",
    ])
    expect(await responses[0].json()).toEqual({ capabilities, goal })
    expect(await responses[2].json()).toEqual(goal)
    expect(await responses[7].json()).toEqual({ ok: true, goal: null })
  })

  it("admits Goal work before resolving its runtime", async () => {
    let runtimeResolutions = 0
    const app = SessionRoutes(() => adapter({}), {
      beforeSessionOperation({ operation }) {
        return operation === "goal_start" ? new Response("blocked", { status: 403 }) : undefined
      },
      resolveRuntime: () => {
        runtimeResolutions++
        return goalRuntime([])
      },
    })

    const response = await app.request(
      `http://localhost/session/s1/goal?directory=${encodeURIComponent(directory)}`,
      { method: "POST", body: JSON.stringify({ objective: "Blocked" }) },
    )

    expect(response.status).toBe(403)
    expect(runtimeResolutions).toBe(0)
  })

  it("returns explicit typed failures for missing runtimes and Goal lifecycle errors", async () => {
    const missing = SessionRoutes(() => adapter({}))
    const missingResponse = await missing.request(
      `http://localhost/session/s1/goal?directory=${encodeURIComponent(directory)}`,
    )
    expect(missingResponse.status).toBe(503)
    expect(await missingResponse.json()).toEqual({
      error: { code: "goal_runtime_unavailable", message: "Goal runtime is unavailable" },
    })

    const runtime = goalRuntime([], {
      start: async () => {
        throw new AgentRuntimeGoalError("goal_invalid_objective", "Goal objective must contain between 1 and 4,000 characters")
      },
      pause: async () => ({ ok: false, status: "unsupported", message: "Pause is unavailable" }),
    })
    const app = SessionRoutes(() => adapter({}), { resolveRuntime: () => runtime })
    const base = "http://localhost/session/s1/goal"
    const url = (suffix = "") => `${base}${suffix}?directory=${encodeURIComponent(directory)}`

    const invalid = await app.request(url(), { method: "POST", body: JSON.stringify({ objective: "" }) })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({
      error: {
        code: "goal_invalid_objective",
        message: "Goal objective must contain between 1 and 4,000 characters",
      },
    })

    const unsupported = await app.request(url("/pause"), { method: "POST" })
    expect(unsupported.status).toBe(409)
    expect(await unsupported.json()).toEqual({
      ok: false,
      status: "unsupported",
      message: "Pause is unavailable",
    })
  })

  it("answers the combined Goal read with capabilities and Goal from one request", async () => {
    const calls: string[] = []
    const guarded: string[] = []
    const app = SessionRoutes(() => adapter({}), {
      beforeSessionOperation({ operation }) {
        guarded.push(operation)
      },
      resolveRuntime: () => goalRuntime(calls),
    })

    const response = await app.request(
      `http://localhost/session/s1/goal/state?directory=${encodeURIComponent(directory)}`,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      capabilities: {
        implemented: true,
        available: true,
        actions: ["pause", "resume", "delete"],
        recovery: "reconcile",
        optionalFields: [],
      },
      goal: goal,
    })
    // Capabilities are derived once and the Goal read reuses that answer, so
    // the combined route costs the runtime what two separate reads would
    // cost, minus the second round-trip.
    expect(calls).toEqual(["capabilities", "read"])
    expect(guarded).toEqual(["goal_state"])
  })

  it("skips the Goal read when the harness does not implement Goals", async () => {
    const calls: string[] = []
    const app = SessionRoutes(() => adapter({}), {
      resolveRuntime: () => goalRuntime(calls, {
        capabilities: async () => {
          calls.push("capabilities")
          return {
            implemented: false,
            available: false,
            unavailableReason: "Harness has no Goal support",
            actions: [],
            recovery: "blocked",
            optionalFields: [],
          }
        },
      }),
    })

    const response = await app.request(
      `http://localhost/session/s1/goal/state?directory=${encodeURIComponent(directory)}`,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      capabilities: {
        implemented: false,
        available: false,
        unavailableReason: "Harness has no Goal support",
        actions: [],
        recovery: "blocked",
        optionalFields: [],
      },
      goal: null,
    })
    expect(calls).toEqual(["capabilities"])
  })

  it("runs the combined Goal read through the same guard and error scaffold", async () => {
    const missing = SessionRoutes(() => adapter({}))
    const missingResponse = await missing.request(
      `http://localhost/session/s1/goal/state?directory=${encodeURIComponent(directory)}`,
    )
    expect(missingResponse.status).toBe(503)
    expect(await missingResponse.json()).toEqual({
      error: { code: "goal_runtime_unavailable", message: "Goal runtime is unavailable" },
    })

    let runtimeResolutions = 0
    const blocked = SessionRoutes(() => adapter({}), {
      beforeSessionOperation({ operation }) {
        return operation === "goal_state" ? new Response("blocked", { status: 403 }) : undefined
      },
      resolveRuntime: () => {
        runtimeResolutions++
        return goalRuntime([])
      },
    })
    const blockedResponse = await blocked.request(
      `http://localhost/session/s1/goal/state?directory=${encodeURIComponent(directory)}`,
    )
    expect(blockedResponse.status).toBe(403)
    expect(runtimeResolutions).toBe(0)

    const failing = SessionRoutes(() => adapter({}), {
      resolveRuntime: () => goalRuntime([], {
        capabilities: async () => {
          throw new AgentRuntimeGoalError("goal_session_not_found", "Session not found")
        },
      }),
    })
    const failingResponse = await failing.request(
      `http://localhost/session/s1/goal/state?directory=${encodeURIComponent(directory)}`,
    )
    expect(failingResponse.status).toBe(404)
    expect(await failingResponse.json()).toEqual({
      error: { code: "goal_session_not_found", message: "Session not found" },
    })
  })
})

describe("session prompt route", () => {
  it("serves experimental session summaries", async () => {
    const directory = process.cwd()
    const sessions: AgentSession[] = [
        buildSession({
          id: "s2",
          directory,
          title: "Second",
          created: 20,
          updated: 30,
        }),
        {
          id: "s-child",
          title: "Child",
          directory,
          parentID: "s2",
          time: { created: 25, updated: 35 },
        },
        {
          id: "s1",
          directory,
          title: "First",
          time: { created: 10, updated: 15 },
          status: null,
          lastTurn: { status: "completed", completedAt: 40 },
        },
      ]
    const app = SessionRoutes(() => adapter({}), { listSessions: async () => sessions })

    const res = await app.request(`http://localhost/experimental/session?directory=${encodeURIComponent(directory)}&roots=true&limit=5`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      {
        id: "s2",
        title: "Second",
        projectID: directory,
        time: { created: 20, updated: 30 },
        directory,
      },
      {
        id: "s1",
        title: "First",
        time: { created: 10, updated: 15 },
        directory,
        status: null,
        lastTurn: { status: "completed", completedAt: 40 },
      },
    ])
  })

  it("excludes archived sessions by default and includes them with ?archived=true", async () => {
    const directory = process.cwd()
    const sessions = [
        buildSession({ id: "active-1", directory, title: "Active", created: 10 }),
        {
          id: "archived-1",
          directory,
          title: "Archived",
          time: { created: 8, updated: 8, archived: 200 },
        },
      ]
    const app = SessionRoutes(() => adapter({}), { listSessions: async () => sessions })

    // Default: archived sessions excluded
    const res1 = await app.request(`http://localhost/experimental/session?directory=${encodeURIComponent(directory)}`)
    expect(res1.status).toBe(200)
    const list1 = await res1.json() as Array<{ id: string }>
    expect(list1.map((s) => s.id)).toEqual(["active-1"])

    // With ?archived=true: all sessions included
    const res2 = await app.request(`http://localhost/experimental/session?directory=${encodeURIComponent(directory)}&archived=true`)
    expect(res2.status).toBe(200)
    const list2 = await res2.json() as Array<{ id: string; time: { archived?: number } }>
    expect(list2.map((s) => s.id)).toEqual(["active-1", "archived-1"])
    expect(list2.find((s) => s.id === "archived-1")!.time.archived).toBe(200)
  })

  it("preserves a canonical archived timestamp of zero", async () => {
    const directory = process.cwd()
    const sessions = [{
        id: "s-epoch",
        directory,
        title: "Epoch Archive",
        time: { created: 10, updated: 20, archived: 0 },
      }]
    const app = SessionRoutes(() => adapter({}), { listSessions: async () => sessions })

    const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{
      id: "s-epoch",
      title: "Epoch Archive",
      directory,
      time: {
        created: 10,
        updated: 20,
        archived: 0,
      },
    }])
  })

  it("preserves project identity fields in canonical session rows", async () => {
    const directory = process.cwd()
    const sessions = [{
        id: "s-project",
        directory,
        title: "Project Session",
        time: { created: 10, updated: 10 },
        projectID: "proj_1",
        parentID: "parent_1",
        rootID: "root_1",
        tags: ["review"],
        attachments: [{ kind: "page", targetID: "p1" }],
      }]
    const app = SessionRoutes(() => adapter({}), { listSessions: async () => sessions })

    const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{
      id: "s-project",
      title: "Project Session",
      directory,
      projectID: "proj_1",
      parentID: "parent_1",
      rootID: "root_1",
      tags: ["review"],
      attachments: [{ kind: "page", targetID: "p1" }],
      time: {
        created: 10,
        updated: 10,
      },
    }])
  })

  it("uses the request directory when normalizing created sessions without a directory", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => ({
      ...adapter({}),
      createSession: async () => ({ id: "session-created" }),
    }))

    const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Created" }),
    })

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      id: "session-created",
      directory,
    })
  })

  it("registers a managed session before admitting its first prompt", async () => {
    const directory = process.cwd()
    const registered = new Set<string>()
    const policy: SessionAccessPolicy = {
      sessionAuthority: "managed-private",
      authorizeSessionStartStatus: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup status is not admitted by this fixture" }),
      authorizeSessionStart: (input) => input.registrationOperationId === "op_managed_create" && input.sessionId === "ses_managed_create"
        ? { allowed: true as const }
        : { allowed: false as const, status: 403 as const, code: "session_start_authority_required", message: "Only the reserved creation may start" },
      authorize: async (input) => input.operation !== "prompt" || registered.has(input.sessionId ?? "")
        ? { allowed: true }
        : { allowed: false, status: 403, code: "session_private", message: "private" },
      authorizePrefix: async () => ({ allowed: true }),
      filterSessions: async (input) => input.sessionIds,
      registerSession: async (input) => {
        registered.add(input.sessionId)
        return { allowed: true }
      },
      acquireTurn: async (input) => ({
        allowed: true,
        turnId: input.turnId,
        leaseId: "lease_1",
        fencingToken: 1,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
      renewTurn: async (input) => ({
        allowed: true,
        turnId: input.turnId,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
      releaseTurn: async () => ({ released: true }),
    }
    const routes = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({
          async *sendMessage(id) {
            yield sessionIdle(id)
          },
        }),
        createSession: async () => ({ id: "ses_managed_create" }),
      }),
      resolveDirectory: async () => directory,
      sessionAccessPolicy: policy,
      publishGlobal() {},
    })
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("relayHostAuth" as never, {
        workspace_id: "ws_1",
        org_id: "org_1",
        role: "editor",
        actor_id: "actor_1",
        actor_kind: "human",
      } as never)
      await next()
    })
    app.route("/", routes)

    expect((await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer signed-rht",
        "x-claxedo-session-registration-operation": "op_managed_create",
      },
      body: JSON.stringify({ id: "ses_managed_create", title: "Managed" }),
    })).status).toBe(201)
    expect(registered).toEqual(new Set(["ses_managed_create"]))

    expect((await app.request(`http://localhost/session/ses_managed_create/prompt_async?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer signed-rht" },
      body: JSON.stringify({ messageID: "msg_managed_1", parts: [{ type: "text", text: "hello" }] }),
    })).status).toBe(204)
  })

  it("applies a selected runtime model before creating a session", async () => {
    const directory = process.cwd()
    const calls: string[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      adapterCapabilities: ["runtime-config"] as const,
      setModel(model: string) {
        calls.push(`setModel:${model}`)
      },
      setAuth() {},
      async createSession() {
        calls.push("createSession")
        return { id: "session-created" }
      },
    }))

    const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Created",
        model: { providerID: "connection:example", modelID: "gpt-5.5" },
      }),
    })

    expect(res.status).toBe(201)
    expect(calls).toEqual(["setModel:gpt-5.5", "createSession"])
  })

  it("passes session context into resolveDirectory for detail routes", async () => {
    const directory = process.cwd()
    const calls: Array<{ sessionId?: string }> = []
    const app = createSessionRoutes({
      resolveAdapter: async () => adapter({}),
      resolveDirectory: async (_c, input) => {
        calls.push({ sessionId: input?.sessionId })
        return directory
      },
      publishGlobal() {},
    })

    const res = await app.request("http://localhost/session/s1")
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ sessionId: "s1" }])
  })

  it("returns structured session not-found errors", async () => {
    const directory = process.cwd()
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        getSession: async () => null,
        updateSession: async () => null,
      }),
      resolveDirectory: async () => directory,
      publishGlobal() {},
    })

    for (const request of [
      new Request("http://localhost/session/missing"),
      new Request("http://localhost/session/missing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Missing" }),
      }),
    ]) {
      const res = await app.request(request)
      expect(res.status).toBe(404)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "session_not_found",
          message: "Session not found",
        },
      })
    }
  })

  it("reads session status from the host-owned inventory", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => { throw new Error("inventory reads must not resolve a harness") }, {
      listSessions: async (_c, scope) => {
        expect(scope).toBe(directory)
        return [{ id: "status-session", directory, status: "busy" }]
      },
      getStatus: async (_c, scope) => {
        expect(scope).toBe(directory)
        return { "status-session": { type: "busy" } }
      },
    })
    const response = await app.request(`http://localhost/session/status?directory=${encodeURIComponent(directory)}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ "status-session": { type: "busy" } })
  })

  it("returns the final JSON reply and forwards prompt fields", async () => {
    const directory = process.cwd()
    const seen: Array<{ directory: string; payload: CompatEvent }> = []
    let prompt: PromptInput | undefined
    const eventHub = createRuntimeEventHub()
    const app = SessionRoutes(() =>
      adapter({
        onPrompt(next, dir) {
          prompt = next
          expect(dir).toBe(directory)
        },
        async *sendMessage(id, input, dir) {
          yield messageUpdated(buildUserMessage({
            id: input.userMessageId!,
            sessionID: id,
            agent: input.agent,
            model: input.model,
            ...(input.tools ? { tools: input.tools } : {}),
            ...(input.format ? { format: input.format } : {}),
            ...(input.system ? { system: input.system } : {}),
            ...(input.variant ? { variant: input.variant } : {}),
          }))
          yield messagePartUpdated({
            id: "msg-user-part-0",
            sessionID: id,
            messageID: input.userMessageId!,
            type: "text",
            text: "hello",
          })
          yield messageUpdated(buildAssistantMessage({
            id: input.assistantMessageId,
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory: dir ?? "",
          }))
          yield messageUpdated(buildAssistantMessage({
            id: "asm-final",
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory: dir ?? "",
          }))
          yield sessionIdle(id)
        },
        async getMessages(id, dir) {
          return [{
            info: buildUserMessage({
              id: "msg-user",
              sessionID: id,
              agent: "plan",
              model: { providerID: "openai", modelID: "gpt-5.4" },
              system: "sys",
              variant: "fast",
            }),
            parts: [],
          }, {
            info: buildAssistantMessage({
              id: "asm-final",
              sessionID: id,
              parentID: "msg-user",
              agent: "plan",
              model: { providerID: "openai", modelID: "gpt-5.4" },
              directory: dir ?? "",
              completed: Date.now(),
              variant: "fast",
            }),
            parts: [{ id: "p1", sessionID: id, messageID: "asm-final", type: "text", text: "done" }],
          }]
        },
      }), { eventHub })
    const unsub = eventHub.subscribeGlobal((event) => seen.push(event))

    try {
      const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageID: "msg-user",
          agent: "plan",
          model: { providerID: "openai", modelID: "gpt-5.4" },
          parts: [{ type: "text", text: "hello" }],
          tools: { bash: true },
          format: { type: "json_schema", schema: { type: "object" } },
          system: "sys",
          variant: "fast",
        }),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("application/json")
      expect(prompt).toMatchObject({
        userMessageId: "msg-user",
        agent: "plan",
        model: { providerID: "openai", modelID: "gpt-5.4" },
        tools: { bash: true },
        format: { type: "json_schema" },
        system: "sys",
        variant: "fast",
      })
      expect(await res.json()).toMatchObject({
        info: { id: "asm-final", role: "assistant", agent: "plan", variant: "fast" },
        parts: [{ type: "text", text: "done" }],
      })
      expect(seen.map((row) => row.payload.type)).toEqual([
        "message.updated",
        "message.part.updated",
        "message.updated",
        "message.updated",
        "session.idle",
      ])
      expect(seen[1]?.payload).toMatchObject({
        type: "message.part.updated",
        properties: {
          part: {
            messageID: "msg-user",
            type: "text",
            text: "hello",
          },
        },
      })
    } finally {
      unsub()
    }
  })

  it("returns a synthetic error reply when the sync message stream throws", async () => {
    const directory = process.cwd()
    const seen: string[] = []
    const eventHub = createRuntimeEventHub()
    const app = createSessionRoutes({
      resolveAdapter: () => adapter({
        async *sendMessage() {
          throw new Error("adapter unavailable")
        },
      }),
      resolveDirectory: () => directory,
      publishGlobal: (event) => {
        seen.push(event.payload.type)
        eventHub.publishGlobal(event)
      },
    })

    const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      info: {
        role: "assistant",
        error: { data: { message: "adapter unavailable" } },
      },
      parts: [],
    })
    expect(seen).toContain("session.error")
  })

  it("returns and checkpoints a completed turn when document flushing fails", async () => {
    const directory = process.cwd()
    const checkpoints: unknown[][] = []
    const error = spyOn(console, "error").mockImplementation(() => {})
    const messages = [{
      info: buildAssistantMessage({
        id: "asm-final",
        sessionID: "s1",
        parentID: "msg-user",
        agent: "plan",
        model: { providerID: "openai", modelID: "gpt-5.4" },
        directory,
        completed: Date.now(),
      }),
      parts: [{ id: "p1", sessionID: "s1", messageID: "asm-final", type: "text" as const, text: "done" }],
    }]
    const app = createSessionRoutes({
      resolveAdapter: () => adapter({
        async *sendMessage(id) {
          yield sessionIdle(id)
        },
        getMessages: () => messages,
      }),
      resolveDirectory: () => directory,
      publishGlobal() {},
      flushSessionDocuments: async () => { throw new Error("write-back unavailable") },
      afterMessageCheckpoint: (_c, _directory, _sessionId, next) => { checkpoints.push(next) },
    })

    try {
      const response = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageID: "msg-user", parts: [{ type: "text", text: "hello" }] }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        info: { id: "asm-final", role: "assistant" },
        parts: [{ type: "text", text: "done" }],
      })
      expect(checkpoints).toEqual([messages])
      expect(error).toHaveBeenCalledWith("[runtime-document] end-of-turn write-back failed for s1:", expect.any(Error))
    } finally {
      error.mockRestore()
    }
  })

  it("defaults message model fields from session config when the request omits them", async () => {
    const directory = process.cwd()
    let prompt: PromptInput | undefined
    const app = SessionRoutes(() =>
      adapter({
        onPrompt(next, dir) {
          prompt = next
          expect(dir).toBe(directory)
        },
        async *sendMessage(id, input, dir) {
          yield messageUpdated(buildAssistantMessage({
            id: input.assistantMessageId,
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory: dir ?? "",
            ...(input.variant ? { variant: input.variant } : {}),
          }))
          yield sessionIdle(id)
        },
        async getMessages(id, dir) {
          return [{
            info: buildAssistantMessage({
              id: "asm-final",
              sessionID: id,
              parentID: "msg-user",
              agent: "plan",
              model: { providerID: "openai", modelID: "gpt-5.4" },
              directory: dir ?? "",
              completed: Date.now(),
              variant: "fast",
            }),
            parts: [{ id: "p1", sessionID: id, messageID: "asm-final", type: "text", text: "done" }],
          }]
        },
      }))

    const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(prompt).toMatchObject({
      userMessageId: "msg-user",
      agent: "plan",
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: "fast",
    })
  })

  it("returns a synthetic error reply when no final assistant message exists", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() =>
      adapter({
        async *sendMessage(id, input, dir) {
          yield messageUpdated(buildAssistantMessage({
            id: input.assistantMessageId,
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory: dir ?? "",
          }))
          yield sessionError("boom", id)
        },
        async getMessages() {
          return []
        },
      }))

    const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      info: {
        role: "assistant",
        error: {
          name: "UnknownError",
          data: { message: "boom" },
        },
      },
      parts: [],
    })
  })

  it("updates session via PATCH", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() =>
      adapter({
      }))

    const res = await app.request(`http://localhost/session/s1?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated Title" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { id: string; title: string }
    expect(body.id).toBe("s1")
    expect(body.title).toBe("Updated Title")
  })

  it("returns 404 for PATCH on non-existent session", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => ({
      ...adapter({}),
      updateSession: async () => null,
    }))

    const res = await app.request(`http://localhost/session/missing?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Nope" }),
    })

    expect(res.status).toBe(404)
  })

  it("gets session config", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => adapter({}))

    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      harness: { id: "codex", access: "native" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: "fast",
      agent: "plan",
    })
  })

  it("returns harness capabilities for global and session-specific adapters", async () => {
    const directory = process.cwd()
    const app = createSessionRoutes({
      resolveAdapter: async (_c, input) => ({
        ...adapter({}),
        readHarnessCapabilities: () => ({
          harness: input?.sessionId ? "codex" : "claude",
          abort: true,
          reconnect: false,
          replay: true,
          permissions: true,
          questions: !input?.sessionId,
          todos: true,
          commands: !input?.sessionId,
          fork: true,
          revert: !input?.sessionId,
          unrevert: !input?.sessionId,
          configOptions: !!input?.sessionId,
          subagents: true,
          effortLevels: NO_HARNESS_EFFORT,
          instructionChannel: "turn-system-prompt",
          goals: false,
        }),
      }),
      resolveDirectory: async (_c, input) => input?.sessionId ? `${directory}/session` : directory,
      publishGlobal() {},
    })

    const global = await app.request(`http://localhost/session/capabilities?directory=${encodeURIComponent(directory)}`)
    const session = await app.request(`http://localhost/session/s1/capabilities?directory=${encodeURIComponent(directory)}`)

    expect(global.status).toBe(200)
    expect(await global.json()).toMatchObject({
      harness: "claude",
      commands: true,
      questions: true,
      configOptions: false,
      subagents: true,
      effortLevels: NO_HARNESS_EFFORT,
      instructionChannel: "turn-system-prompt",
    })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      harness: "codex",
      commands: false,
      questions: false,
      configOptions: true,
      subagents: true,
      effortLevels: NO_HARNESS_EFFORT,
      instructionChannel: "turn-system-prompt",
    })
  })

  it("exposes command routes by default and supports central-server opt-out", async () => {
    const directory = process.cwd()
    const commands = [{ name: "review", description: "Review current changes" }]
    const base = {
      resolveDirectory: async () => directory,
      publishGlobal() {},
    }
    const standalone = createSessionRoutes({
      ...base,
      resolveAdapter: async () => ({
        ...adapter({}),
        listCommands: async () => commands,
      }),
    })
    const central = createSessionRoutes({
      ...base,
      exposeCommandRoute: false,
      resolveAdapter: async () => ({
        ...adapter({}),
        listCommands: async () => {
          throw new Error("central server should not resolve workspace-runtime commands")
        },
      }),
    })

    const standaloneRes = await standalone.request(`http://localhost/command?directory=${encodeURIComponent(directory)}`)
    const centralRes = await central.request(`http://localhost/command?directory=${encodeURIComponent(directory)}`)

    expect(standaloneRes.status).toBe(200)
    expect(await standaloneRes.json()).toEqual(commands)
    expect(centralRes.status).toBe(404)
  })

  it("patches session config", async () => {
    const directory = process.cwd()
    const app = SessionRoutes(() => adapter({}))

    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "connection:example", modelID: "sonnet" },
        variant: "max",
        agent: "build",
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      harness: { id: "codex", access: "native" },
      model: { providerID: "connection:example", modelID: "sonnet" },
      variant: "max",
      agent: "build",
    })
  })

  it("does not accept runtime-owned handoff state from a client config patch", async () => {
    const directory = process.cwd()
    const calls: SessionConfigUpdate[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      updateSessionConfig: async (_id, patch) => {
        calls.push(patch)
        return {
          harness: { id: "codex", access: "native" },
          variant: null,
          agent: null,
        }
      },
    }))

    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handoff: {
          from: { id: "claude", access: "native" },
          pending: true,
          transcript: "client-authored transcript",
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(calls).toEqual([{}])
  })

  it("allows session config patches to set model for the same harness", async () => {
    const directory = process.cwd()
    const calls: SessionConfigUpdate[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      getSessionConfig: async () => ({
        harness: { id: "codex", access: "native" },
        model: { providerID: "codex", modelID: "default" },
        variant: null,
        agent: "build",
      }),
      updateSessionConfig: async (_id, patch) => {
        calls.push(patch)
        return {
          harness: patch.harness ?? { id: "codex", access: "native" },
          ...(patch.model ? { model: patch.model } : {}),
          variant: patch.variant ?? null,
          agent: patch.agent ?? null,
        }
      },
      readHarnessCapabilities: () => ({
        harness: "codex",
        abort: true,
        reconnect: false,
        replay: true,
        permissions: true,
        questions: true,
        todos: true,
        commands: true,
        fork: true,
        revert: true,
        unrevert: true,
        configOptions: false,
        subagents: true,
        effortLevels: NO_HARNESS_EFFORT,
        instructionChannel: "turn-system-prompt",
        goals: false,
      }),
    }))

    const patch = {
      harness: { id: "codex", access: "native" },
      model: { providerID: "codex", modelID: "gpt-5" },
      variant: null,
      agent: "build",
    } satisfies SessionConfigUpdate
    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      harness: { id: "codex", access: "native" },
      model: { providerID: "codex", modelID: "gpt-5" },
      variant: null,
      agent: "build",
    })
    expect(calls).toEqual([patch])
  })

  it("can keep session config durable through route-level hooks", async () => {
    const directory = process.cwd()
    const configs = new Map<string, SessionConfig>()
    const app = SessionRoutes(() => adapter({}), {
      getSessionConfig: async ({ adapter, directory, sessionId }) =>
        configs.get(sessionId) ?? await adapter.getSessionConfig({
          sessionId,
          workspaceId: "workspace-test",
          directory,
          connectionId: "native:codex",
          upstreamSessionId: sessionId,
        }),
      updateSessionConfig: async ({ sessionId, update }) => {
        if (!update.harness) throw new Error("test update requires an explicit harness")
        const next = {
          harness: update.harness,
          ...(update.model ? { model: update.model } : {}),
          variant: update.variant ?? null,
          agent: update.agent ?? null,
        } satisfies SessionConfig
        configs.set(sessionId, next)
        return next
      },
    })

    const patch = {
      harness: { id: "codex", access: "native" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: null,
      agent: "build",
    } satisfies SessionConfig
    const update = await app.request(`http://localhost/session/s-codex/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
    const read = await app.request(`http://localhost/session/s-codex/config?directory=${encodeURIComponent(directory)}`)

    expect(update.status).toBe(200)
    expect(read.status).toBe(200)
    expect(await update.json()).toEqual(patch)
    expect(await read.json()).toEqual(patch)
  })

  it("rejects session config harness switches before mutating adapter state", async () => {
    const directory = process.cwd()
    const calls: string[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      updateSessionConfig: async () => {
        calls.push("updateSessionConfig")
        return { harness: { id: "claude", access: "connection" } }
      },
    }))

    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: { id: "example", access: "connection" },
        model: { providerID: "connection:example", modelID: "sonnet" },
      }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      ok: false,
      error: {
        code: "unsupported_operation",
        operation: "harness_switch",
        capability: "session_harness",
        harness: "codex",
        transport: "codex",
        reason: "harness_switch_not_supported",
        message: "codex sessions cannot switch to example through session config patch",
      },
    })
    expect(calls).toEqual([])
  })

  it("delegates session config harness switches to the cross-harness owner", async () => {
    const directory = process.cwd()
    const calls: SessionConfigUpdate[] = []
    const target = {
      harness: { id: "openclaw", access: "connection" },
      model: { providerID: "connection:openclaw", modelID: "default" },
      variant: null,
      agent: null,
    } satisfies SessionConfig
    const app = SessionRoutes(() => adapter({}), {
      switchSessionHarness: async ({ update }) => {
        calls.push(update)
        return target
      },
    })

    const patch = {
      harness: { id: "openclaw", access: "connection" },
      model: { providerID: "connection:openclaw", modelID: "default" },
    } satisfies SessionConfigUpdate
    const res = await app.request(`http://localhost/session/s1/config?directory=${encodeURIComponent(directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(target)
    expect(calls).toEqual([patch])
  })

  it("returns 204 for prompt_async", async () => {
    const directory = process.cwd()
    let seen = false
    const app = SessionRoutes(() =>
      adapter({
        async *sendMessage(id) {
          seen = true
          yield sessionIdle(id)
        },
      }))

    const res = await app.request(`http://localhost/session/s1/prompt_async?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(204)
    await Bun.sleep(0)
    expect(seen).toBe(true)
  })

  it("deduplicates exact prompt_async retries while replaying an unsubmitted retry", async () => {
    const directory = process.cwd()
    let executions = 0
    const make = (messages: AgentMessage[] = [], beforeMessages = async () => {}) => SessionRoutes(() =>
      adapter({
        getMessages: async () => {
          await beforeMessages()
          return messages
        },
        async *sendMessage(id) {
          executions++
          yield sessionIdle(id)
        },
      }))
    const request = (app: ReturnType<typeof make>, retry = false) => app.request(
      `http://localhost/session/s1/prompt_async?directory=${encodeURIComponent(directory)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(retry ? { "x-claxedo-idempotency-retry": "1" } : {}),
        },
        body: JSON.stringify({ messageID: "msg-generic", parts: [{ type: "text", text: "hello" }] }),
      },
    )

    const live = make()
    expect((await request(live)).status).toBe(204)
    expect((await request(live, true)).status).toBe(204)
    await Bun.sleep(0)
    expect(executions).toBe(1)

    const restored = make([{ info: { id: "msg-generic", sessionID: "generic", role: "user" }, parts: [] }])
    expect((await request(restored, true)).status).toBe(204)
    await Bun.sleep(0)
    expect(executions).toBe(1)

    let release!: () => void
    const concurrent = make([], () => new Promise<void>((resolve) => { release = resolve }))
    const first = request(concurrent, true)
    await Bun.sleep(0)
    const second = request(concurrent, true)
    release()
    await Promise.all([first, second])
    await Bun.sleep(0)
    expect(executions).toBe(2)

    const prepared = make()
    expect((await request(prepared, true)).status).toBe(204)
    await Bun.sleep(0)
    expect(executions).toBe(3)
  })

  it("returns typed unsupported operation failures from harness capabilities", async () => {
    const directory = process.cwd()
    const calls: string[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      readHarnessCapabilities: () => ({
        harness: "claude",
        abort: false,
        reconnect: false,
        replay: true,
        permissions: false,
        questions: false,
        todos: true,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: true,
        subagents: true,
        effortLevels: NO_HARNESS_EFFORT,
        instructionChannel: "turn-system-prompt",
        goals: false,
      }),
      revert: async () => {
        calls.push("revert")
      },
      unrevert: async () => {
        calls.push("unrevert")
      },
      forkSession: async () => {
        calls.push("fork")
        return { id: "forked" }
      },
      executeCommand: async () => {
        calls.push("command")
      },
      respondPermission: async () => {
        calls.push("permission")
      },
      replyQuestion: async () => {
        calls.push("question.reply")
      },
      rejectQuestion: async () => {
        calls.push("question.reject")
      },
    }))

    for (const item of [
      { method: "POST", path: "/session/s1/revert", operation: "revert" },
      { method: "POST", path: "/session/s1/unrevert", operation: "unrevert" },
      { method: "POST", path: "/session/s1/fork", operation: "fork", body: { messageId: "m1" } },
      { method: "POST", path: "/session/s1/command", operation: "command", body: { command: "review" } },
      { method: "POST", path: "/session/s1/permissions/p1", operation: "permission_response", body: { response: "once" } },
      { method: "POST", path: "/question/q1/reply", operation: "question_response", body: { answers: [["yes"]] } },
      { method: "POST", path: "/question/q1/reject", operation: "question_response" },
    ]) {
      const url = new URL(`http://localhost${item.path}`)
      url.searchParams.set("directory", directory)
      url.searchParams.set("sessionId", "s1")
      const res = await app.request(url.toString(), {
        method: item.method,
        headers: { "Content-Type": "application/json" },
        ...(item.body ? { body: JSON.stringify(item.body) } : {}),
      })

      expect(res.status, item.path).toBe(409)
      await expect(res.json()).resolves.toEqual({
        ok: false,
        error: {
          code: "unsupported_operation",
          operation: item.operation,
          capability: item.operation === "command"
            ? "commands"
            : item.operation === "permission_response"
            ? "permissions"
            : item.operation === "question_response"
            ? "questions"
            : item.operation,
          harness: "claude",
          transport: "claude",
          reason: "capability_disabled",
          message: `claude does not support ${item.operation}`,
        },
      })
    }
    expect(calls).toEqual([])
  })

  it("keeps supported session operations on the existing success path", async () => {
    const directory = process.cwd()
    const calls: string[] = []
    const app = SessionRoutes(() => ({
      ...adapter({}),
      revert: async () => {
        calls.push("revert")
      },
    }))

    const res = await app.request(`http://localhost/session/s1/revert?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(calls).toEqual(["revert"])
  })

  it("does not sync created sessions to the control plane from workspace runtime", async () => {
    const directory = process.cwd()
    const seen: string[] = []
    const prevUrl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const prevWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    const original = globalThis.fetch
    process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_runtime"
    globalThis.fetch = fetchDouble((async (input) => {
      seen.push(typeof input === "string" ? input : input instanceof Request ? input.url : String(input))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))

    try {
      const app = SessionRoutes(() => ({
        ...adapter({}),
        createSession: async () => ({ id: "session-created" }),
      }))

      const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Created" }),
      })

      expect(res.status).toBe(201)
      await Bun.sleep(25)
      expect(seen).toEqual([])
    } finally {
      globalThis.fetch = original
      process.env.CLAXEDO_CONTROL_PLANE_URL = prevUrl
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = prevWorkspaceId
    }
  })

  it("does not sync session messages to the control plane on passive reads", async () => {
    const directory = process.cwd()
    const seen: Array<{ url: string; body: string | undefined }> = []
    const prevUrl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const prevWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    const original = globalThis.fetch
    process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_runtime"
    globalThis.fetch = fetchDouble((async (input, init) => {
      seen.push({
        url: typeof input === "string" ? input : input instanceof Request ? input.url : String(input),
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))

    try {
      const app = SessionRoutes(() =>
        adapter({
          getMessages: () => [{
            info: { id: "msg-1", sessionID: "s1", role: "user" },
            parts: [{ id: "part-1", sessionID: "s1", messageID: "msg-1", type: "text", text: "hello" }],
          }],
        }),
      )

      const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`)

      expect(res.status).toBe(200)
      await Bun.sleep(25)
      expect(seen).toHaveLength(0)
    } finally {
      globalThis.fetch = original
      process.env.CLAXEDO_CONTROL_PLANE_URL = prevUrl
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = prevWorkspaceId
    }
  })

  it("does not sync full session messages to the control plane after prompt completion", async () => {
    const directory = process.cwd()
    const seen: string[] = []
    const prevUrl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const prevWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    const original = globalThis.fetch
    process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_runtime"
    globalThis.fetch = fetchDouble((async (input) => {
      seen.push(typeof input === "string" ? input : input instanceof Request ? input.url : String(input))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))

    try {
      const app = SessionRoutes(() =>
        adapter({
          getMessages: () => [{
            info: { id: "msg-1", sessionID: "s1", role: "user" },
            parts: [{ id: "part-1", sessionID: "s1", messageID: "msg-1", type: "text", text: "hello" }],
          }],
        }),
      )

      const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
      })

      expect(res.status).toBe(200)
      await Bun.sleep(25)
      expect(seen).toEqual([])
    } finally {
      globalThis.fetch = original
      process.env.CLAXEDO_CONTROL_PLANE_URL = prevUrl
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = prevWorkspaceId
    }
  })

  it("bridges terminal runtime lifecycle events to workspaceRuntimeBus once", async () => {
    const directory = process.cwd()
    const lifecycle: Extract<WorkspaceRuntimeEvent, { type: "agent.lifecycle" }>[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "agent.lifecycle" && event.sessionId === "s1") lifecycle.push(event)
    })

    try {
      const app = SessionRoutes(() =>
        adapter({
          async *sendMessage(id) {
            yield sessionStatus(id, { type: "busy" })
            yield sessionIdle(id)
          },
        }),
      )

      const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [],
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
          variant: "default",
        }),
      })

      expect(res.status).toBe(200)
      expect(lifecycle.map((event) => event.eventType)).toEqual(["Busy", "Idle"])
      expect(lifecycle.map((event) => event.tabId)).toEqual(["s1", "s1"])
      expect(lifecycle.map((event) => event.workspaceId)).toEqual([expect.any(String), expect.any(String)])
    } finally {
      unsubscribe()
    }
  })

  it("publishes session.updated on the hub only — the workspace stream carries it once", async () => {
    const directory = process.cwd()
    const update = sessionUpdated(buildSession({
      id: "s1",
      directory,
      title: "Prompt-derived title",
      created: 10,
      updated: 20,
    }))
    const bus: string[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => { bus.push(event.type) })
    const hub = createRuntimeEventHub()
    const hubEvents: unknown[] = []
    hub.subscribeGlobal((event) => { hubEvents.push(event.payload) })

    try {
      const app = SessionRoutes(() => adapter({
        async *sendMessage() {
          yield update
        },
      }), { eventHub: hub })
      const res = await app.request(`http://localhost/session/s1/message?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [] }),
      })

      expect(res.status).toBe(200)
      expect(hubEvents.filter((event) => (event as { type?: string }).type === "session.updated")).toHaveLength(1)
      expect(bus.filter((type) => type.startsWith("session."))).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it("does not contact the control plane before returning local responses", async () => {
    const directory = process.cwd()
    let calls = 0
    const prevUrl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const prevWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    const original = globalThis.fetch
    process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_runtime"
    globalThis.fetch = fetchDouble((async () => {
      calls++
      await new Promise(() => {})
      return new Response("unreachable")
    }))

    try {
      const app = SessionRoutes(() => ({
        ...adapter({}),
        createSession: async () => ({ id: "session-created" }),
      }))

      const result = await Promise.race([
        app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Created" }),
        }),
        Bun.sleep(25).then(() => "timed out" as const),
      ])

      expect(result).not.toBe("timed out")
      expect((result as Response).status).toBe(201)
      await Bun.sleep(25)
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = original
      process.env.CLAXEDO_CONTROL_PLANE_URL = prevUrl
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = prevWorkspaceId
    }
  })

  it("publishes initial user parts for prompt_async", async () => {
    const directory = process.cwd()
    const seen: CompatEvent[] = []
    const app = createSessionRoutes({
      resolveAdapter: async () =>
        adapter({
          async *sendMessage(id, input, dir) {
            yield messageUpdated(buildUserMessage({
              id: input.userMessageId ?? "msg-user",
              sessionID: id,
              agent: input.agent,
              model: input.model,
            }))
            yield messagePartUpdated({
              id: "msg-user-part-0",
              sessionID: id,
              messageID: input.userMessageId ?? "msg-user",
              type: "text",
              text: "hello",
            })
            yield messageUpdated(buildAssistantMessage({
              id: input.assistantMessageId,
              sessionID: id,
              parentID: input.userMessageId ?? id,
              agent: input.agent,
              model: input.model,
              directory: dir ?? "",
            }))
            yield sessionIdle(id)
          },
        }),
      resolveDirectory: async () => directory,
      publishGlobal(event) {
        seen.push(event.payload)
      },
    })

    const res = await app.request(`http://localhost/session/s1/prompt_async?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageID: "msg-user",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(204)
    await Bun.sleep(0)
    expect(seen.map((row) => row.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "message.updated",
      "session.idle",
    ])
    expect(seen[1]).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          messageID: "msg-user",
          type: "text",
          text: "hello",
        },
      },
    })
  })

  it("publishes question reply with the pending question session id", async () => {
    const directory = process.cwd()
    const seen: CompatEvent[] = []
    const received: string[][][] = []
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        listQuestions: async () => [{ id: "q1", sessionID: "s1", questions: [] }],
        replyQuestion: async (_binding, _questionId, answers) => {
          received.push(answers)
        },
      }),
      resolveDirectory: async () => directory,
      publishGlobal(event) {
        seen.push(event.payload)
      },
    })

    const res = await app.request(`http://localhost/question/q1/reply?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: [["Continue"], ["Alpha", "Bravo"]] }),
    })

    expect(res.status).toBe(200)
    expect(received).toEqual([[["Continue"], ["Alpha", "Bravo"]]])
    expect(seen).toEqual([{
      id: "question.replied:q1",
      type: "question.replied",
      properties: {
        sessionID: "s1",
        requestID: "q1",
        answers: [["Continue"], ["Alpha", "Bravo"]],
      },
    }])
  })

  it("rejects scalar and compatibility question replies before mutating the adapter", async () => {
    const directory = process.cwd()
    let replies = 0
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        listQuestions: async () => [{ id: "q1", sessionID: "s1", questions: [] }],
        replyQuestion: async () => {
          replies += 1
        },
      }),
      resolveDirectory: async () => directory,
      publishGlobal() {},
    })

    for (const body of [{ answer: "Continue" }, { answers: ["Continue"] }, {}]) {
      const response = await app.request(`http://localhost/question/q1/reply?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(replies).toBe(0)
  })

  it("publishes question reject with the pending question session id", async () => {
    const directory = process.cwd()
    const seen: CompatEvent[] = []
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        listQuestions: async () => [{ id: "q1", sessionID: "s1", questions: [] }],
      }),
      resolveDirectory: async () => directory,
      publishGlobal(event) {
        seen.push(event.payload)
      },
    })

    const res = await app.request(`http://localhost/question/q1/reject?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)
    expect(seen).toEqual([{
      id: "question.rejected:q1",
      type: "question.rejected",
      properties: {
        sessionID: "s1",
        requestID: "q1",
      },
    }])
  })

  // `?sessionId=` is optional on the question routes, so gating admission on it
  // let any caller reach replyQuestion/rejectQuestion by simply leaving it off.
  it("admits question replies and rejections on the resolved session when sessionId is omitted", async () => {
    for (const path of ["/question/q1/reply", "/question/q1/reject"]) {
      const directory = process.cwd()
      const admissions: { sessionId: string; operation: string }[] = []
      const calls: string[] = []
      const app = createSessionRoutes({
        resolveAdapter: async () => ({
          ...adapter({}),
          listQuestions: async () => [{ id: "q1", sessionID: "s1", questions: [] }],
          replyQuestion: async () => {
            calls.push("reply")
          },
          rejectQuestion: async () => {
            calls.push("reject")
          },
        }),
        resolveDirectory: async () => directory,
        listQuestions: async () => [{ id: "q1", sessionID: "s1", questions: [] }],
        beforeSessionOperation: (_c, input) => {
          admissions.push(input)
          return new Response(JSON.stringify({ ok: false, error: { code: "session_not_admitted" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          })
        },
        publishGlobal() {},
      })

      const res = await app.request(`http://localhost${path}?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: [["Continue"]] }),
      })

      expect(res.status, path).toBe(403)
      await expect(res.json()).resolves.toEqual({ ok: false, error: { code: "session_not_admitted" } })
      expect(admissions, path).toEqual([{ sessionId: "s1", operation: "question_response" }])
      expect(calls, path).toEqual([])
    }
  })

  // When neither the query param nor the host listing names the session, only
  // the adapter can. Admission still has to happen before the reply lands.
  it("admits question replies on a session only the adapter listing knows", async () => {
    const directory = process.cwd()
    const admissions: { sessionId: string; operation: string }[] = []
    const calls: string[] = []
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        listQuestions: async () => [{ id: "q1", sessionID: "s-from-adapter", questions: [] }],
        replyQuestion: async () => {
          calls.push("reply")
        },
      }),
      resolveDirectory: async () => directory,
      beforeSessionOperation: (_c, input) => {
        admissions.push(input)
        return new Response(JSON.stringify({ ok: false }), { status: 403, headers: { "Content-Type": "application/json" } })
      },
      publishGlobal() {},
    })

    const res = await app.request(`http://localhost/question/q1/reply?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: [["Continue"]] }),
    })

    expect(res.status).toBe(403)
    expect(admissions).toEqual([{ sessionId: "s-from-adapter", operation: "question_response" }])
    expect(calls).toEqual([])
  })

  it("admits question replies on the authoritative session when the supplied session matches", async () => {
    const directory = process.cwd()
    const admissions: { sessionId: string; operation: string }[] = []
    let resolvedAdapters = 0
    const app = createSessionRoutes({
      resolveAdapter: async () => {
        resolvedAdapters += 1
        return adapter({})
      },
      resolveDirectory: async () => directory,
      listQuestions: async () => [{ id: "q1", sessionID: "s9", questions: [] }],
      beforeSessionOperation: (_c, input) => {
        admissions.push(input)
      },
      publishGlobal() {},
    })

    const res = await app.request(
      `http://localhost/question/q1/reply?directory=${encodeURIComponent(directory)}&sessionId=s9`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: [["Continue"]] }),
      },
    )

    expect(res.status).toBe(200)
    expect(admissions).toEqual([{ sessionId: "s9", operation: "question_response" }])
    expect(resolvedAdapters).toBe(1)
  })

  it("rejects cross-session question replies and rejections before authorization or mutation", async () => {
    for (const path of ["/question/q1/reply", "/question/q1/reject"]) {
      const directory = process.cwd()
      const admissions: string[] = []
      const calls: string[] = []
      const app = createSessionRoutes({
        resolveAdapter: async () => ({
          ...adapter({}),
          replyQuestion: async () => {
            calls.push("reply")
          },
          rejectQuestion: async () => {
            calls.push("reject")
          },
        }),
        resolveDirectory: async () => directory,
        listQuestions: async () => [{ id: "q1", sessionID: "session_owner", questions: [] }],
        beforeSessionOperation: (_c, input) => {
          admissions.push(input.sessionId)
        },
        publishGlobal() {},
      })

      const response = await app.request(
        `http://localhost${path}?directory=${encodeURIComponent(directory)}&sessionId=session_attacker`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: [["Continue"]] }),
        },
      )

      expect(response.status, path).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ error: { code: "interaction_session_mismatch" } })
      expect(admissions, path).toEqual([])
      expect(calls, path).toEqual([])
    }
  })

  it("rejects a permission response when the permission belongs to another session", async () => {
    const directory = process.cwd()
    const admissions: string[] = []
    const calls: string[] = []
    const app = createSessionRoutes({
      resolveAdapter: async () => ({
        ...adapter({}),
        respondPermission: async () => {
          calls.push("permission")
        },
      }),
      resolveDirectory: async () => directory,
      listPermissions: async () => [{
        id: "permission_1",
        sessionID: "session_owner",
        permission: "tool",
        patterns: [],
        always: [],
        metadata: {},
      }],
      beforeSessionOperation: (_c, input) => {
        admissions.push(input.sessionId)
      },
      publishGlobal() {},
    })

    const response = await app.request(
      `http://localhost/session/session_attacker/permissions/permission_1?directory=${encodeURIComponent(directory)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "once" }),
      },
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "interaction_session_mismatch" } })
    expect(admissions).toEqual([])
    expect(calls).toEqual([])
  })

  // Resolving an adapter can construct one on the host, so a caller the guard
  // turns away must not reach that when the session is already known.
  it("does not resolve an adapter for a rejected question reply", async () => {
    const directory = process.cwd()
    let resolvedAdapters = 0
    const app = createSessionRoutes({
      resolveAdapter: async () => {
        resolvedAdapters += 1
        return adapter({})
      },
      resolveDirectory: async () => directory,
      listQuestions: async () => [{ id: "q1", sessionID: "s9", questions: [] }],
      beforeSessionOperation: () =>
        new Response(JSON.stringify({ ok: false }), { status: 403, headers: { "Content-Type": "application/json" } }),
      publishGlobal() {},
    })

    const explicit = await app.request(
      `http://localhost/question/q1/reply?directory=${encodeURIComponent(directory)}&sessionId=s9`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: [["x"]] }) },
    )
    expect(explicit.status).toBe(403)
    expect(resolvedAdapters).toBe(0)
  })
})

it("publishes a successful session deletion once, on the hub the workspace stream serves, naming a subsession's parent", async () => {
  const directory = process.cwd()
  const hub = createRuntimeEventHub()
  const events: unknown[] = []
  hub.subscribeGlobal((event) => { if ((event.payload as { type?: string }).type === "session.deleted") events.push(event) })
  const bus: string[] = []
  const unsubscribe = workspaceRuntimeBus.subscribe((event) => { bus.push(event.type) })
  try {
    const app = SessionRoutes(() => adapter({}), {
      eventHub: hub,
      getSession: async () => ({ ...buildSession({ id: "s1", directory, title: "child" }), parentID: "parent-1" }),
    })
    const response = await app.request(`http://localhost/session/s1?directory=${encodeURIComponent(directory)}`, { method: "DELETE" })
    expect(response.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ directory, payload: { type: "session.deleted", properties: { info: { id: "s1", directory, parentID: "parent-1" } } } })
    expect(bus.filter((type) => type.startsWith("session."))).toEqual([])
  } finally { unsubscribe() }
})

it("returns the canonical permission reply events in the HTTP acknowledgement", async () => {
  const directory = process.cwd()
  const reply: CompatEvent = {
    id: "event_permission_reply",
    type: "permission.replied",
    properties: { sessionID: "session_owner", requestID: "permission_1", reply: "once" },
  }
  const published: CompatEvent[] = []
  const app = createSessionRoutes({
    resolveAdapter: async () => ({ ...adapter({}), respondPermission: async () => ({ events: [reply] }) }),
    resolveDirectory: async () => directory,
    listPermissions: async () => [{ id: "permission_1", sessionID: "session_owner", permission: "execute", patterns: [], always: [], metadata: {} }],
    publishGlobal(event) { published.push(event.payload) },
  })
  const response = await app.request(`http://localhost/session/session_owner/permissions/permission_1?directory=${encodeURIComponent(directory)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response: "once" }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, events: [reply] })
  expect(published).toEqual([reply])
})

it("requires an offered provider option and forwards its opaque ID to the adapter", async () => {
  const calls: unknown[] = []
  const app = createSessionRoutes({
    resolveAdapter: () => ({ ...adapter({}), respondPermission: async (_binding, _id, decision, optionId) => { calls.push({ decision, optionId }) } }),
    resolveDirectory: () => "/work",
    listPermissions: async () => [{ id: "permission-provider", sessionID: "session_owner", permission: "mcp", patterns: [], always: [], metadata: {}, options: [{ id: "provider/session-policy", label: "Use for this session" }] }],
    publishGlobal() {},
  })
  const request = (body: unknown) => app.request("http://localhost/session/session_owner/permissions/permission-provider?directory=%2Fwork", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  for (const body of [{ response: "once" }, { optionId: "not-offered" }, { optionId: "provider/session-policy", response: "always" }]) {
    expect((await request(body)).status).toBe(400)
  }
  expect(calls).toEqual([])
  const response = await request({ optionId: "provider/session-policy" })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, events: [expect.objectContaining({ type: "permission.replied", properties: { sessionID: "session_owner", requestID: "permission-provider", optionId: "provider/session-policy" } })] })
  expect(calls).toEqual([{ decision: "allow_once", optionId: "provider/session-policy" }])
})


it("serves and answers a persisted provider option through public permission routes after reopening the workspace store", async () => {
  const root = mkdtempSync(join(tmpdir(), "permission-route-store-"))
  const optionId = '{"persist":"session"}'
  let store = new RuntimeStore(root)
  try {
    store.bindSession({ sessionId: "permission-session", directory: "/work", agentSessionId: "native-session", createdAt: 1 })
    const permission = { id: "persisted-permission", sessionID: "permission-session", permission: "mcp", patterns: [], always: [], metadata: {}, options: [{ id: optionId, label: "Accept for session" }] }
    store.appendEvent({ sessionId: permission.sessionID, payload: permissionAsked(permission) })
    store.close()
    store = new RuntimeStore(root)
    const selected: string[] = []
    const app = createSessionRoutes({
      resolveAdapter: () => ({ ...adapter({}), respondPermission: async (_binding, id, _decision, choice) => {
        if (choice === undefined) throw new Error("Expected provider option")
        selected.push(choice)
        const event = permissionReplied(permission.sessionID, id, { optionId: choice })
        store.appendEvent({ sessionId: permission.sessionID, payload: event })
        return { events: [event] }
      } }),
      resolveDirectory: () => "/work",
      listPermissions: async () => store.listPermissions("/work"),
      publishGlobal() {},
    })
    const listed = await app.request("http://localhost/permission?directory=%2Fwork")
    expect(await listed.json()).toEqual([permission])
    const respond = (body: unknown) => app.request("http://localhost/session/permission-session/permissions/persisted-permission?directory=%2Fwork", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    expect((await respond({ response: "always" })).status).toBe(400)
    expect(store.listPermissions("/work")).toEqual([permission])
    const response = await respond({ optionId })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, events: [expect.objectContaining({ properties: { sessionID: permission.sessionID, requestID: permission.id, optionId } })] })
    expect(selected).toEqual([optionId])
    store.close()
    store = new RuntimeStore(root)
    expect(store.listPermissions("/work")).toEqual([])
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
