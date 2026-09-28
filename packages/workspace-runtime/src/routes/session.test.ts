import { afterEach, describe, expect, it } from "bun:test"
import type { GoalCapabilities, RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { CompatEnvelope, CompatEvent } from "@claxedo/agent-sdk-runtime/compat-events"
import type { HarnessSession, NativeGoalOperations, PermissionRequest, RequestAnswer, TransportCapabilities, TurnRequest } from "@claxedo/harness/contract"
import type { Hono } from "hono"
import { createStoreBrokerPorts } from "../broker-ports"
import { workspaceRuntimeBus } from "../bus"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy, type SessionAccessPolicyInput } from "../session-access-policy"
import { fetchDouble } from "../test-support/fetch-double"
import { FakeTransport, type FakeTransportOptions, type FakeTurn } from "../test-support/fake-transport"
import { createFakeWorkspaceApp, type FakeWorkspaceApp, type FakeWorkspaceAppOptions } from "../test-support/fake-workspace-app"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "../workspace/runtime"

const apps: FakeWorkspaceApp[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) {
    for (const transport of app.transports) if (transport instanceof ScriptedTransport) transport.endPending()
    await app.dispose()
  }
})

async function workspaceApp(options: FakeWorkspaceAppOptions = {}) {
  const app = await createFakeWorkspaceApp(options)
  apps.push(app)
  return app
}

function promptText(turn: FakeTurn) {
  const [part] = turn.turn.prompt.parts
  return part?.type === "text" ? part.text : ""
}

type ScriptedTurn = FakeTurn & { signal: AbortSignal }

/**
 * A harness whose reply to each prompt is the script filed under the prompt's
 * text; unscripted prompts finish silently. A request its script asks is
 * withdrawn when the host cancels the turn, and by the test before the host
 * is disposed, because a harness still waiting on an answer is a turn the
 * runtime's disposal waits for.
 */
class ScriptedTransport extends FakeTransport {
  private readonly pending: AbortController
  constructor(scripts: Record<string, (input: ScriptedTurn) => AsyncIterable<AgentRuntimeEvent>>, options: FakeTransportOptions = {}) {
    const pending = new AbortController()
    super({
      ...options,
      turn: async function* (input) {
        const script = scripts[promptText(input)]
        if (script) yield* script({ ...input, signal: pending.signal })
        yield { type: "finish", sessionId: input.session.binding.sessionId }
      },
    })
    this.pending = pending
  }
  endPending() {
    this.pending.abort()
  }
  override async cancel(session: HarnessSession, turn: Parameters<FakeTransport["cancel"]>[1], deadline: Parameters<FakeTransport["cancel"]>[2]) {
    this.pending.abort()
    return super.cancel(session, turn, deadline)
  }
}

function scripted(scripts: Record<string, (input: ScriptedTurn) => AsyncIterable<AgentRuntimeEvent>>, options: FakeTransportOptions = {}) {
  return new ScriptedTransport(scripts, options)
}

const questionInfo = (question: string) => ({
  question, header: question, multiple: true,
  options: [{ label: "Continue", description: "go" }, { label: "Alpha", description: "a" }, { label: "Bravo", description: "b" }],
})

function question(requestId: string, sessionID: string, count = 1): TurnRequest {
  return { kind: "question", requestId, question: { id: requestId, sessionID, questions: Array.from({ length: count }, (_, i) => questionInfo(`q${i}`)) } }
}

function permission(requestId: string, sessionID: string, extra: Partial<PermissionRequest> & { options?: PermissionRequest["options"] } = {}): TurnRequest {
  return {
    kind: "permission", requestId,
    permission: { id: requestId, sessionID, permission: "execute", patterns: [], always: [], metadata: {},
      ...(extra.options ? { options: extra.options.map((option) => ({ id: option.optionId, label: option.name })) } : {}) },
    ...(extra.options ? { options: extra.options } : {}),
  }
}

/** A turn that asks the host one request and records what came back. */
function asking(request: (sessionId: string) => TurnRequest, answers: RequestAnswer[]) {
  return async function* ({ session, broker, signal }: ScriptedTurn): AsyncIterable<AgentRuntimeEvent> {
    answers.push(await broker.ask(request(session.binding.sessionId), { signal }))
  }
}

/** The loopback policy with every authorization observed and some of them refused. */
function observingPolicy(input: { operations?: Array<{ sessionId: string | undefined; operation: string }>; deny?: (operation: string) => boolean } = {}): SessionAccessPolicy {
  const base = managedWorkspaceSessionAccessPolicy()
  return {
    ...base,
    authorize(access: SessionAccessPolicyInput) {
      input.operations?.push({ sessionId: access.sessionId, operation: access.operation })
      if (input.deny?.(access.operation)) return { allowed: false, status: 403, code: "session_private", message: "blocked" }
      return base.authorize(access)
    },
  }
}

const settle = () => Bun.sleep(25)

describe("message pages", () => {
  it("serves a page request from the workspace store, never from the harness history", async () => {
    const wa = await workspaceApp({
      transport: () => new FakeTransport({
        history: { messages: async () => { throw new Error("harness history must not run") }, todos: async () => [] },
      }),
    })
    await wa.createSession("session-1")
    expect((await wa.json("/session/session-1/message", { messageID: "message-1", parts: [{ type: "text", text: "hi" }] })).status).toBe(200)

    const response = await wa.app.request(wa.url("/session/session-1/message", { limit: "25" }))

    expect(response.status).toBe(200)
    const page = await response.json() as Array<{ info: { id: string; role: string } }>
    expect(page.map((message) => message.info.id)).toEqual(["message-1", "message-1_r"])
    expect(response.headers.get("x-max-event-ordinal")).toBe(String(wa.store().getSessionMaxSeq("session-1")))
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

describe("session Goal routes", () => {
  const goal: RuntimeGoalSnapshot = { sessionId: "s1", objective: "Ship universal Goal support", status: "active", createdAt: 1, updatedAt: 2 }
  const capabilities: GoalCapabilities = { implemented: true, available: true, actions: ["pause", "resume", "delete"], recovery: "reconcile", optionalFields: [] }

  class GoalTransport extends FakeTransport {
    constructor(readonly calls: string[], overrides: Partial<NativeGoalOperations> = {}, private readonly declared: GoalCapabilities = capabilities) {
      super()
      this.goals = {
        read: async () => { calls.push("read"); return null },
        start: async (_session, objective) => { calls.push(`start:${objective}`); return { ok: true, goal } },
        pause: async () => { calls.push("pause"); return { ok: true, goal: { ...goal, status: "paused" } } },
        resume: async () => { calls.push("resume"); return { ok: true, goal } },
        stop: async () => { calls.push("stop"); return { ok: true, goal: { ...goal, status: "paused" } } },
        delete: async () => { calls.push("delete"); return { ok: true, goal: null } },
        ...overrides,
      }
    }
    readonly goals: NativeGoalOperations
    override async capabilities(): Promise<TransportCapabilities> {
      return { ...await super.capabilities(), goals: this.declared }
    }
  }

  it("routes every Goal operation through the session's harness Goal resource", async () => {
    const calls: string[] = []
    const guarded: Array<{ sessionId: string | undefined; operation: string }> = []
    const wa = await workspaceApp({
      transport: () => new GoalTransport(calls, { read: async () => { calls.push("read"); return goal } }),
      sessionAccessPolicy: observingPolicy({ operations: guarded }),
    })
    await wa.createSession("s1")
    calls.length = 0
    guarded.length = 0
    const base = "/session/s1/goal"

    const responses = [
      await wa.app.request(wa.url(`${base}/capabilities`)),
      await wa.app.request(wa.url(base)),
      await wa.json(base, { objective: goal.objective }),
      await wa.json(`${base}/pause`, {}),
      await wa.json(`${base}/resume`, {}),
      await wa.json(`${base}/stop`, {}),
      await wa.app.request(wa.url(base), { method: "DELETE" }),
    ]

    expect(responses.map((response) => response.status)).toEqual([200, 200, 409, 200, 200, 200, 200])
    // A start reads first: the harness already holds a Goal, so it is refused as existing.
    expect(calls).toEqual(["read", "read", "pause", "resume", "stop", "delete"])
    expect(guarded.map((row) => row.operation)).toEqual([
      "goal_capabilities", "goal_read", "goal_start", "goal_pause", "goal_resume", "goal_stop", "goal_delete",
    ])
    expect(await responses[0].json()).toEqual(capabilities)
    expect(await responses[1].json()).toEqual(goal)
    expect(await responses[2].json()).toEqual({ error: { code: "goal_already_exists", message: "Session s1 already has a Goal" } })
    expect(await responses[6].json()).toEqual({ ok: true, goal: null })
  })

  it("starts a Goal on a session that holds none", async () => {
    const calls: string[] = []
    const wa = await workspaceApp({ transport: () => new GoalTransport(calls) })
    await wa.createSession("s1")
    calls.length = 0

    const response = await wa.json("/session/s1/goal", { objective: goal.objective })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ ok: true, goal })
    expect(calls).toEqual(["read", `start:${goal.objective}`])
  })

  it("admits Goal work before composing a harness", async () => {
    const wa = await workspaceApp({
      transport: () => new GoalTransport([]),
      sessionAccessPolicy: observingPolicy({ deny: (operation) => operation === "goal_start" }),
    })

    const response = await wa.json("/session/s1/goal", { objective: "Blocked" })

    expect(response.status).toBe(403)
    expect(wa.transports).toHaveLength(0)
  })

  it("returns explicit typed failures for unknown sessions and Goal lifecycle errors", async () => {
    const wa = await workspaceApp({
      transport: () => new GoalTransport([], { pause: async () => ({ ok: false, status: "unsupported", message: "Pause is unavailable" }) }),
    })
    await wa.createSession("s1")

    const missing = await wa.app.request(wa.url("/session/nope/goal"))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: { code: "goal_session_not_found", message: "Session nope not found" } })

    const invalid = await wa.json("/session/s1/goal", { objective: "" })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({
      error: { code: "goal_invalid_objective", message: "Goal objective must contain between 1 and 4,000 characters" },
    })

    const unsupported = await wa.json("/session/s1/goal/pause", {})
    expect(unsupported.status).toBe(409)
    expect(await unsupported.json()).toEqual({ ok: false, status: "unsupported", message: "Pause is unavailable" })
  })

  const openView = (wa: FakeWorkspaceApp) => wa.app.request(wa.url("/session/s1", { view: "open" }))

  it("opens a session with its Goal's capabilities and Goal, derived once", async () => {
    const calls: string[] = []
    const guarded: Array<{ sessionId: string | undefined; operation: string }> = []
    const wa = await workspaceApp({
      transport: () => new GoalTransport(calls, { read: async () => { calls.push("read"); return goal } }),
      sessionAccessPolicy: observingPolicy({ operations: guarded }),
    })
    await wa.createSession("s1")
    calls.length = 0
    guarded.length = 0

    const response = await openView(wa)

    expect(response.status).toBe(200)
    expect((await response.json()).goal).toEqual({ value: { capabilities, goal } })
    expect(calls).toEqual(["read"])
    expect(guarded.map((row) => row.operation)).toEqual(["session_meta_read"])
  })

  it("opens a session without a Goal read when the harness does not implement Goals", async () => {
    const calls: string[] = []
    const unavailable: GoalCapabilities = { implemented: false, available: false, unavailableReason: "Harness has no Goal support", actions: [], recovery: "blocked", optionalFields: [] }
    const wa = await workspaceApp({ transport: () => new GoalTransport(calls, {}, unavailable) })
    await wa.createSession("s1")
    calls.length = 0

    const response = await openView(wa)

    expect(response.status).toBe(200)
    expect((await response.json()).goal).toEqual({ value: { capabilities: unavailable, goal: null } })
    expect(calls).toEqual([])
  })

  it("opens a session whose Goal cannot be read, with the Goal's refusal in its place", async () => {
    const blocked = await workspaceApp({
      transport: () => new GoalTransport([]),
      sessionAccessPolicy: observingPolicy({ deny: (operation) => operation === "session_meta_read" }),
    })
    expect((await openView(blocked)).status).toBe(403)
    expect(blocked.transports).toHaveLength(0)

    const failing = await workspaceApp({ transport: () => new GoalTransport([], { read: async () => { throw new Error("goal store unreadable") } }) })
    await failing.createSession("s1")
    const failed = await openView(failing)
    expect(failed.status).toBe(200)
    const opened = await failed.json()
    expect(opened).not.toHaveProperty("session")
    expect(opened.goal).toEqual({ error: { status: 500, message: "Internal Server Error" } })
  })
})

describe("session prompt route", () => {
  it("serves experimental session summaries", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s1", { title: "First" })
    expect((await wa.json("/session/s1/message", { parts: [{ type: "text", text: "hi" }] })).status).toBe(200)
    const store = wa.store()
    store.bindSession({ sessionId: "s2", workspaceId: wa.workspaceId, directory: wa.directory, connectionId: "fake", upstreamSessionId: "s2", agentSessionId: "s2", title: "Second", createdAt: 20, updatedAt: 30 })
    store.bindSession({ sessionId: "s-child", workspaceId: wa.workspaceId, directory: wa.directory, connectionId: "fake", upstreamSessionId: "s-child", agentSessionId: "s-child", title: "Child", parentSessionId: "s2", createdAt: 25, updatedAt: 35 })

    const res = await wa.app.request(wa.url("/experimental/session", { roots: "true", limit: "5" }))

    expect(res.status).toBe(200)
    const rows = await res.json() as Array<Record<string, unknown>>
    expect(rows.map((row) => row.id)).toEqual(["s1", "s2"])
    expect(rows[0]).toEqual({
      id: "s1", title: "First", directory: wa.directory, status: "idle",
      time: { created: expect.any(Number), updated: expect.any(Number) },
      lastTurn: { status: "completed", completedAt: expect.any(Number), assistantMessageId: expect.any(String) },
    })
    expect(rows[1]).toEqual({ id: "s2", title: "Second", time: { created: 20, updated: 30 }, directory: wa.directory })

    const all = await wa.app.request(wa.url("/experimental/session"))
    const child = (await all.json() as Array<Record<string, unknown>>).find((row) => row.id === "s-child")
    expect(child).toEqual({ id: "s-child", title: "Child", time: { created: 25, updated: 35 }, directory: wa.directory, parentID: "s2" })
  })

  it("excludes archived sessions by default and includes them with ?archived=true", async () => {
    const wa = await workspaceApp()
    await wa.createSession("active-1", { title: "Active" })
    await wa.createSession("archived-1", { title: "Archived" })
    expect((await wa.json("/session/archived-1", { time: { archived: 200 } }, { method: "PATCH" })).status).toBe(200)

    const res1 = await wa.app.request(wa.url("/experimental/session"))
    expect(res1.status).toBe(200)
    const list1 = await res1.json() as Array<{ id: string }>
    expect(list1.map((s) => s.id)).toEqual(["active-1"])

    const res2 = await wa.app.request(wa.url("/experimental/session", { archived: "true" }))
    expect(res2.status).toBe(200)
    const list2 = await res2.json() as Array<{ id: string; time: { archived?: number } }>
    expect(list2.map((s) => s.id).sort()).toEqual(["active-1", "archived-1"])
    expect(list2.find((s) => s.id === "archived-1")!.time.archived).toBe(200)
  })

  it("preserves a canonical archived timestamp of zero", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s-epoch", { title: "Epoch Archive" })
    expect((await wa.json("/session/s-epoch", { time: { archived: 0 } }, { method: "PATCH" })).status).toBe(200)

    const res = await wa.app.request(wa.url("/session"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([expect.objectContaining({
      id: "s-epoch",
      title: "Epoch Archive",
      directory: wa.directory,
      time: { created: expect.any(Number), updated: expect.any(Number), archived: 0 },
    })])
  })

  it("preserves project identity fields in canonical session rows", async () => {
    const wa = await workspaceApp()
    await wa.createSession("parent_1")
    wa.store().bindSession({
      sessionId: "s-project", workspaceId: wa.workspaceId, directory: wa.directory, connectionId: "fake", upstreamSessionId: "s-project",
      agentSessionId: "s-project", title: "Project Session", parentSessionId: "parent_1", createdAt: 10, updatedAt: 10,
    })

    const res = await wa.app.request(wa.url("/session"))
    expect(res.status).toBe(200)
    const row = (await res.json() as Array<Record<string, unknown>>).find((session) => session.id === "s-project")
    expect(row).toEqual(expect.objectContaining({
      id: "s-project", title: "Project Session", directory: wa.directory, workspaceId: wa.workspaceId, parentID: "parent_1",
      time: { created: 10, updated: 10 },
    }))
  })

  it("uses the request directory when normalizing created sessions without a directory", async () => {
    const wa = await workspaceApp()

    const res = await wa.json("/session", { title: "Created" }, { params: { connectionId: "fake" } })

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ id: expect.stringMatching(/^ses_/), directory: wa.directory })
  })

  it("registers a managed session before admitting its first prompt", async () => {
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
        allowed: true, turnId: input.turnId, leaseId: "lease_1", fencingToken: 1, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
      }),
      renewTurn: async (input) => ({
        allowed: true, turnId: input.turnId, leaseId: input.leaseId, fencingToken: input.fencingToken, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
      }),
      releaseTurn: async () => ({ released: true }),
    }
    const wa = await workspaceApp({
      auth: { machineOwnerUserId: "local", accounts: { user_1: { openai: { baseUrl: "https://fixture.example", placeholder: "user-1-key", authMode: "api-key" } } } },
      sessionAccessPolicy: policy,
      before: (app: Hono) => {
        app.use("*", async (c, next) => {
          c.set("relayHostAuth" as never, { workspace_id: "ws_1", org_id: "org_1", role: "editor", actor_id: "actor_1", user_id: "user_1", actor_kind: "human" } as never)
          await next()
        })
      },
    })

    expect((await wa.json("/session", { id: "ses_managed_create", title: "Managed" }, {
      params: { connectionId: "fake" },
      headers: { authorization: "Bearer signed-rht", "x-claxedo-session-registration-operation": "op_managed_create" },
    })).status).toBe(201)
    expect(registered).toEqual(new Set(["ses_managed_create"]))

    expect((await wa.json("/session/ses_managed_create/prompt_async", { messageID: "msg_managed_1", parts: [{ type: "text", text: "hello" }] }, {
      headers: { authorization: "Bearer signed-rht" },
    })).status).toBe(204)
    await settle()
    expect(wa.transport().turns.map((turn) => turn.turn.userMessageId)).toEqual(["msg_managed_1"])
  })

  it("starts the harness with the model selected at create", async () => {
    const wa = await workspaceApp()

    const res = await wa.json("/session", { title: "Created", model: { providerID: "connection:example", modelID: "gpt-5.5" } }, { params: { connectionId: "fake" } })

    expect(res.status).toBe(201)
    expect(wa.transport().starts.map((start) => start.config.model)).toEqual([{ providerID: "connection:example", modelID: "gpt-5.5" }])
  })

  it("resolves a detail route's directory from the session when the request names none", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s1", { title: "Demo" })

    const res = await wa.app.request("http://localhost/session/s1")

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: "s1", title: "Demo", directory: wa.directory })
  })

  it("returns structured session not-found errors", async () => {
    const wa = await workspaceApp()

    for (const request of [
      new Request(wa.url("/session/missing")),
      new Request(wa.url("/session/missing"), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Missing" }) }),
    ]) {
      const res = await wa.app.request(request)
      expect(res.status).toBe(404)
      await expect(res.json()).resolves.toEqual({ error: { code: "session_not_found", message: "Session not found" } })
    }
  })

  it("reads session status from the host-owned inventory", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const wa = await workspaceApp({
      fakeTransport: { turn: async function* ({ session }) { await gate; yield { type: "finish", sessionId: session.binding.sessionId } } },
    })
    await wa.createSession("status-session")
    const pending = wa.json("/session/status-session/message", { parts: [{ type: "text", text: "hi" }] })
    await settle()

    const response = await wa.app.request(wa.url("/session/status"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ "status-session": { type: "busy" } })
    expect(wa.transport().starts).toHaveLength(1)
    release()
    await pending

    expect(await (await wa.app.request(wa.url("/session/status"))).json()).toEqual({})
  })

  it("returns the final JSON reply and forwards prompt fields", async () => {
    const seen: CompatEnvelope[] = []
    const wa = await workspaceApp({
      onCompatEvent: (event) => seen.push(event),
      fakeTransport: { turn: async function* ({ session }) {
        yield { type: "text-delta", delta: "done" }
        yield { type: "finish", sessionId: session.binding.sessionId }
      } },
    })
    await wa.createSession("s1", { title: "Demo" })
    seen.length = 0

    const res = await wa.json("/session/s1/message", {
      messageID: "msg-user",
      agent: "plan",
      model: { providerID: "openai", modelID: "gpt-5.4" },
      parts: [{ type: "text", text: "hello" }],
      tools: { bash: true },
      format: { type: "json_schema", schema: { type: "object" } },
      system: "sys",
      variant: "fast",
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const [turn] = wa.transport().turns
    expect(turn?.session.directory).toBe(wa.directory)
    expect(turn?.turn).toMatchObject({
      userMessageId: "msg-user",
      assistantMessageId: "msg-user_r",
      prompt: { agent: "plan", tools: { bash: true }, format: { type: "json_schema" }, parts: [{ type: "text", text: "hello" }] },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      system: "sys",
      effort: "fast",
    })
    expect(await res.json()).toMatchObject({
      info: { id: "msg-user_r", role: "assistant", agent: "plan", parentID: "msg-user" },
      parts: [{ type: "text", text: "done" }],
    })
    expect(seen.map((row) => row.payload.type)).toEqual([
      "session.status",
      "message.updated",
      "message.part.updated",
      "message.updated",
      "message.part.updated",
      "message.part.delta",
      "message.completed",
      "session.idle",
    ])
    expect(seen[1]?.payload).toMatchObject({
      type: "message.updated",
      properties: { info: { id: "msg-user", role: "user", agent: "plan", model: { providerID: "openai", modelID: "gpt-5.4" }, tools: { bash: true }, system: "sys", variant: "fast" } },
    })
    expect(seen[2]?.payload).toMatchObject({
      type: "message.part.updated",
      properties: { part: { messageID: "msg-user", type: "text", text: "hello" } },
    })
  })

  it("returns a synthetic error reply when the harness turn throws", async () => {
    const seen: string[] = []
    const wa = await workspaceApp({
      onCompatEvent: (event) => seen.push(event.payload.type),
      fakeTransport: { turn: async function* () { throw new Error("adapter unavailable") } },
    })
    await wa.createSession("s1")

    const res = await wa.json("/session/s1/message", { messageID: "msg-user", parts: [{ type: "text", text: "hello" }] })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      info: { role: "assistant", error: { data: { message: "adapter unavailable" } } },
      parts: [],
    })
    expect(seen).toContain("session.error")
  })

  it("defaults message model fields from session config when the request omits them", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s1", { model: { providerID: "openai", modelID: "gpt-5.4" }, variant: "fast", agent: "plan" })

    const res = await wa.json("/session/s1/message", { messageID: "msg-user", parts: [{ type: "text", text: "hello" }] })

    expect(res.status).toBe(200)
    expect(wa.transport().turns[0]?.turn).toMatchObject({
      userMessageId: "msg-user",
      prompt: { agent: "plan" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      effort: "fast",
    })
  })

  it("returns a synthetic error reply when no final assistant message exists", async () => {
    const wa = await workspaceApp({ fakeTransport: { turn: async function* () { yield { type: "error", error: "boom" } } } })
    await wa.createSession("s1")

    const res = await wa.json("/session/s1/message", { messageID: "msg-user", parts: [{ type: "text", text: "hello" }] })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      info: { role: "assistant", error: { name: "UnknownError", data: { message: "boom" } } },
      parts: [],
    })
  })

  it("updates session via PATCH", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s1", { title: "Demo" })

    const res = await wa.json("/session/s1", { title: "Updated Title" }, { method: "PATCH" })

    expect(res.status).toBe(200)
    const body = await res.json() as { id: string; title: string }
    expect(body.id).toBe("s1")
    expect(body.title).toBe("Updated Title")
    expect((await wa.app.request(wa.url("/session/s1"))).json()).resolves.toMatchObject({ title: "Updated Title" })
  })

  it("returns 404 for PATCH on non-existent session", async () => {
    const wa = await workspaceApp()

    const res = await wa.json("/session/missing", { title: "Nope" }, { method: "PATCH" })

    expect(res.status).toBe(404)
  })

  it("gets session config", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s1", { model: { providerID: "openai", modelID: "gpt-5.4" }, variant: "fast", agent: "plan" })

    const res = await wa.app.request(wa.url("/session/s1/config"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      harness: { id: "fake", access: "connection" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
      variant: "fast",
      agent: "plan",
    })
  })

  it("returns harness capabilities for a draft and for a live session", async () => {
    class VaryingTransport extends FakeTransport {
      override async capabilities(input?: { directory: string; sessionId?: string }): Promise<TransportCapabilities> {
        return {
          ...await super.capabilities(),
          requests: { permissions: true, questions: !input?.sessionId, elicitation: false },
          subagents: true,
        }
      }
    }
    const wa = await workspaceApp({ transport: () => new VaryingTransport({ commands: { list: async () => [] } }) })
    await wa.createSession("s1")

    const global = await wa.app.request(wa.url("/session/capabilities"))
    const session = await wa.app.request(wa.url("/session/s1/capabilities"))

    expect(global.status).toBe(200)
    expect(await global.json()).toMatchObject({
      harness: "fake", commands: true, questions: true, configOptions: false, subagents: true,
      effortLevels: { status: "unsupported" }, instructionChannel: "turn-system-prompt",
    })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      harness: "fake", commands: true, questions: false, configOptions: false, subagents: true, prompt: true,
      effortLevels: { status: "unsupported" }, instructionChannel: "turn-system-prompt",
    })
  })

  it("lists the harness's declared commands on the draft command route", async () => {
    const commands = [{ name: "review", description: "Review current changes" }]
    const wa = await workspaceApp({ transport: () => new FakeTransport({ commands: { list: async () => commands } }) })

    const res = await wa.app.request(wa.url("/command"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(commands.map((command) => ({ ...command, origin: "transport" })))
  })

  it("patches session config", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s1")

    const res = await wa.json("/session/s1/config", {
      model: { providerID: "connection:example", modelID: "sonnet" },
      variant: "max",
      agent: "build",
    }, { method: "PATCH" })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      harness: { id: "fake", access: "connection" },
      model: { providerID: "connection:example", modelID: "sonnet" },
      variant: "max",
      agent: "build",
    })
  })

  it("does not accept runtime-owned handoff state from a client config patch", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s1")

    const res = await wa.json("/session/s1/config", {
      handoff: { from: { id: "claude", access: "native" }, pending: true, transcript: "client-authored transcript" },
    }, { method: "PATCH" })

    expect(res.status).toBe(200)
    const config = { harness: { id: "fake", access: "connection" }, variant: null, agent: null }
    expect(await res.json()).toEqual(config)
    expect(await (await wa.app.request(wa.url("/session/s1/config"))).json()).toEqual(config)
  })

  it("allows session config patches to set model for the same harness", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s1", { model: { providerID: "codex", modelID: "default" }, agent: "build" })

    const patch = { harness: { id: "fake", access: "connection" }, model: { providerID: "codex", modelID: "gpt-5" }, variant: null, agent: "build" }
    const res = await wa.json("/session/s1/config", patch, { method: "PATCH" })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(patch)
  })

  it("keeps session config durable across a reopened workspace", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s-codex")
    const patch = { harness: { id: "fake", access: "connection" }, model: { providerID: "openai", modelID: "gpt-5.4" }, variant: null, agent: "build" }
    const update = await wa.json("/session/s-codex/config", patch, { method: "PATCH" })
    expect(update.status).toBe(200)
    expect(await update.json()).toEqual(patch)
    await wa.dispose({ keepRoot: true })
    apps.splice(apps.indexOf(wa), 1)

    const reopened = await workspaceApp({ root: wa.root })
    const read = await reopened.app.request(reopened.url("/session/s-codex/config"))

    expect(read.status).toBe(200)
    expect(await read.json()).toEqual(patch)
  })

  it("refuses a session config switch to a harness this runtime cannot run, leaving the session untouched", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s1")

    const res = await wa.json("/session/s1/config", {
      harness: { id: "example", access: "connection" },
      model: { providerID: "connection:example", modelID: "sonnet" },
    }, { method: "PATCH" })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: { code: "workspace_harness_not_configured", message: 'Connection "example" is not configured on this runtime' },
    })
    expect(await (await wa.app.request(wa.url("/session/s1/config"))).json()).toEqual({ harness: { id: "fake", access: "connection" }, variant: null, agent: null })
    expect(wa.transport().closed).toEqual([])
  })

  it("hands a session over to another configured harness through the runtime's handoff", async () => {
    const other = new FakeTransport({ upstreamSessionId: () => "upstream-other" })
    const wa = await workspaceApp({ connections: [{ connectionId: "other", transport: () => other }] })
    await wa.createSession("s1")
    expect((await wa.json("/session/s1/message", { parts: [{ type: "text", text: "hi" }] })).status).toBe(200)

    const patch = { harness: { id: "other", access: "connection" }, model: { providerID: "connection:other", modelID: "default" } }
    const res = await wa.json("/session/s1/config", patch, { method: "PATCH" })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ...patch,
      handoff: { from: { id: "fake", access: "connection" }, pending: true, transcript: expect.stringContaining("User:\nhi") },
    })
    expect(other.starts.map((start) => start.sessionId)).toEqual(["s1"])
    // The left harness is kept until a turn succeeds on the new one.
    expect(wa.transport().closed).toEqual([])
    expect((await wa.json("/session/s1/message", { parts: [{ type: "text", text: "again" }] })).status).toBe(200)
    expect(other.turns).toHaveLength(1)
    expect(wa.transport().closed.map((session) => session.binding.sessionId)).toEqual(["s1"])
  })

  it("returns 204 for prompt_async", async () => {
    const wa = await workspaceApp()
    await wa.createSession("s1")

    const res = await wa.json("/session/s1/prompt_async", { parts: [{ type: "text", text: "hello" }] })

    expect(res.status).toBe(204)
    await settle()
    expect(wa.transport().turns).toHaveLength(1)
  })

  it("deduplicates exact prompt_async retries while replaying an unsubmitted retry", async () => {
    const wa = await workspaceApp()
    const turnsFor = (sessionId: string) => wa.transport().turns.filter((turn) => turn.session.binding.sessionId === sessionId)
    const request = (sessionId: string, retry = false) => wa.json(`/session/${sessionId}/prompt_async`,
      { messageID: `msg-${sessionId}`, parts: [{ type: "text", text: "hello" }] },
      { headers: retry ? { "x-claxedo-idempotency-retry": "1" } : {} })

    await wa.createSession("live")
    expect((await request("live")).status).toBe(204)
    expect((await request("live", true)).status).toBe(204)
    await settle()
    expect(turnsFor("live")).toHaveLength(1)

    // The message is already in the transcript, so the retry has nothing left to submit.
    expect((await request("live", true)).status).toBe(204)
    await settle()
    expect(turnsFor("live")).toHaveLength(1)

    await wa.createSession("concurrent")
    const first = request("concurrent", true)
    await Bun.sleep(0)
    const second = request("concurrent", true)
    expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([204, 204])
    await settle()
    expect(turnsFor("concurrent")).toHaveLength(1)

    await wa.createSession("prepared")
    expect((await request("prepared", true)).status).toBe(204)
    await settle()
    expect(turnsFor("prepared")).toHaveLength(1)
  })

  it("returns typed unsupported operation failures from harness capabilities", async () => {
    const answers: RequestAnswer[] = []
    const wa = await workspaceApp({
      transport: () => scripted({
        question: asking((sessionId) => question("q1", sessionId), answers),
        permission: asking((sessionId) => permission("p1", sessionId), answers),
      }, { capabilities: { requests: { permissions: false, questions: false, elicitation: false } } }),
    })
    await wa.createSession("s1")
    expect((await wa.json("/session/s1/prompt_async", { parts: [{ type: "text", text: "question" }] })).status).toBe(204)
    await settle()

    const refusal = (operation: string, capability: string) => ({
      ok: false,
      error: { code: "unsupported_operation", operation, capability, harness: "fake", transport: "fake", reason: "capability_disabled", message: `fake does not support ${operation}` },
    })
    const fork = await wa.json("/session/s1/fork", { messageId: "m1" })
    expect(fork.status).toBe(409)
    await expect(fork.json()).resolves.toEqual(refusal("fork", "fork"))
    for (const path of ["/question/q1/reply", "/question/q1/reject"]) {
      const res = await wa.json(path, { answers: [["Continue"]] }, { params: { sessionId: "s1" } })
      expect(res.status, path).toBe(409)
      await expect(res.json()).resolves.toEqual(refusal("question_response", "questions"))
    }
    expect(answers).toEqual([])

    await wa.createSession("s2")
    expect((await wa.json("/session/s2/prompt_async", { parts: [{ type: "text", text: "permission" }] })).status).toBe(204)
    await settle()
    const permissionRes = await wa.json("/session/s2/permissions/p1", { response: "once" })
    expect(permissionRes.status).toBe(409)
    await expect(permissionRes.json()).resolves.toEqual(refusal("permission_response", "permissions"))
    expect(answers).toEqual([])

    const command = await wa.json("/session/s1/command", { command: "review" })
    expect(command.status).toBe(501)
    await expect(command.json()).resolves.toEqual({
      ok: false,
      error: { code: "unsupported_operation", operation: "command", reason: "not_implemented", message: "command is not implemented" },
    })
  })

  async function withControlPlaneEnv<T>(handler: Parameters<typeof fetchDouble>[0], run: () => Promise<T>) {
    const prevUrl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const prevWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    const original = globalThis.fetch
    process.env.CLAXEDO_CONTROL_PLANE_URL = "http://control.test"
    process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_runtime"
    globalThis.fetch = fetchDouble(handler)
    try {
      return await run()
    } finally {
      globalThis.fetch = original
      process.env.CLAXEDO_CONTROL_PLANE_URL = prevUrl
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = prevWorkspaceId
    }
  }

  it("does not sync created sessions to the control plane from workspace runtime", async () => {
    const seen: string[] = []
    await withControlPlaneEnv(async (input) => {
      seen.push(typeof input === "string" ? input : input instanceof Request ? input.url : String(input))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }, async () => {
      const wa = await workspaceApp()
      const res = await wa.json("/session", { title: "Created" }, { params: { connectionId: "fake" } })
      expect(res.status).toBe(201)
      await settle()
      expect(seen).toEqual([])
    })
  })

  it("does not sync session messages to the control plane on passive reads", async () => {
    const seen: string[] = []
    await withControlPlaneEnv(async (input) => {
      seen.push(typeof input === "string" ? input : input instanceof Request ? input.url : String(input))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }, async () => {
      const wa = await workspaceApp()
      await wa.createSession("s1")
      expect((await wa.json("/session/s1/message", { messageID: "msg-1", parts: [{ type: "text", text: "hello" }] })).status).toBe(200)
      seen.length = 0
      const res = await wa.app.request(wa.url("/session/s1/message"))
      expect(res.status).toBe(200)
      expect((await res.json() as unknown[]).length).toBeGreaterThan(0)
      await settle()
      expect(seen).toHaveLength(0)
    })
  })

  it("does not sync full session messages to the control plane after prompt completion", async () => {
    const seen: string[] = []
    await withControlPlaneEnv(async (input) => {
      seen.push(typeof input === "string" ? input : input instanceof Request ? input.url : String(input))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }, async () => {
      const wa = await workspaceApp()
      await wa.createSession("s1")
      const res = await wa.json("/session/s1/message", { parts: [{ type: "text", text: "hello" }] })
      expect(res.status).toBe(200)
      await settle()
      expect(seen).toEqual([])
    })
  })

  it("publishes session.updated on the hub only — the workspace stream carries it once", async () => {
    const bus: string[] = []
    const hubEvents: CompatEvent[] = []
    const wa = await workspaceApp({
      onCompatEvent: (event) => hubEvents.push(event.payload),
      fakeTransport: { turn: async function* ({ session }) {
        yield { type: "session-title", title: "Prompt-derived title" }
        yield { type: "finish", sessionId: session.binding.sessionId }
      } },
    })
    await wa.createSession("s1")
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => { bus.push(event.type) })
    try {
      const res = await wa.json("/session/s1/message", { parts: [] })

      expect(res.status).toBe(200)
      const titled = hubEvents.filter((event) => event.type === "session.updated" && event.properties.info.title === "Prompt-derived title")
      expect(titled).toHaveLength(1)
      expect(bus.filter((type) => type.startsWith("session."))).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it("does not contact the control plane before returning local responses", async () => {
    let calls = 0
    await withControlPlaneEnv(async () => {
      calls++
      await new Promise(() => {})
      return new Response("unreachable")
    }, async () => {
      const wa = await workspaceApp()
      const result = await Promise.race([
        wa.json("/session", { title: "Created" }, { params: { connectionId: "fake" } }),
        Bun.sleep(1_000).then(() => "timed out" as const),
      ])
      expect(result).not.toBe("timed out")
      expect((result as Response).status).toBe(201)
      await settle()
      expect(calls).toBe(0)
    })
  })

  it("publishes initial user parts for prompt_async", async () => {
    const seen: CompatEvent[] = []
    const wa = await workspaceApp({ onCompatEvent: (event) => seen.push(event.payload) })
    await wa.createSession("s1", { title: "Demo" })
    seen.length = 0

    const res = await wa.json("/session/s1/prompt_async", { messageID: "msg-user", parts: [{ type: "text", text: "hello" }] })

    expect(res.status).toBe(204)
    await settle()
    expect(seen.map((row) => row.type).filter((type) => type !== "harness.health")).toEqual([
      "session.status",
      "message.updated",
      "message.part.updated",
      "message.updated",
      "message.part.updated",
      "message.part.delta",
      "message.completed",
      "session.idle",
    ])
    expect(seen[2]).toMatchObject({
      type: "message.part.updated",
      properties: { part: { messageID: "msg-user", type: "text", text: "hello" } },
    })
  })

  it("publishes question reply with the pending question session id", async () => {
    const answers: RequestAnswer[] = []
    const seen: CompatEvent[] = []
    const wa = await workspaceApp({
      onCompatEvent: (event) => seen.push(event.payload),
      transport: () => scripted({ question: asking((sessionId) => question("q1", sessionId, 2), answers) }, { capabilities: { requests: { permissions: false, questions: true, elicitation: false } } }),
    })
    await wa.createSession("s1")
    expect((await wa.json("/session/s1/prompt_async", { parts: [{ type: "text", text: "question" }] })).status).toBe(204)
    await settle()
    expect(await (await wa.app.request(wa.url("/question"))).json()).toMatchObject([{ id: "q1", sessionID: "s1" }])
    seen.length = 0

    const res = await wa.json("/question/q1/reply", { answers: [["Continue"], ["Alpha", "Bravo"]] })

    expect(res.status).toBe(200)
    await settle()
    expect(answers).toEqual([{ kind: "answers", answers: [["Continue"], ["Alpha", "Bravo"]] }])
    expect(seen.filter((event) => event.type.startsWith("question."))).toEqual([{
      id: "question.replied:s1:q1",
      type: "question.replied",
      properties: { sessionID: "s1", requestID: "q1", answers: [["Continue"], ["Alpha", "Bravo"]] },
    }])
  })

  it("rejects scalar and compatibility question replies before the harness sees an answer", async () => {
    const answers: RequestAnswer[] = []
    const wa = await workspaceApp({
      transport: () => scripted({ question: asking((sessionId) => question("q1", sessionId), answers) }, { capabilities: { requests: { permissions: false, questions: true, elicitation: false } } }),
    })
    await wa.createSession("s1")
    expect((await wa.json("/session/s1/prompt_async", { parts: [{ type: "text", text: "question" }] })).status).toBe(204)
    await settle()

    for (const body of [{ answer: "Continue" }, { answers: ["Continue"] }, {}]) {
      const response = await wa.json("/question/q1/reply", body)
      expect(response.status).toBe(400)
    }
    await settle()
    expect(answers).toEqual([])
    expect(await (await wa.app.request(wa.url("/question"))).json()).toMatchObject([{ id: "q1" }])
  })

  it("publishes question reject with the pending question session id", async () => {
    const answers: RequestAnswer[] = []
    const seen: CompatEvent[] = []
    const wa = await workspaceApp({
      onCompatEvent: (event) => seen.push(event.payload),
      transport: () => scripted({ question: asking((sessionId) => question("q1", sessionId), answers) }, { capabilities: { requests: { permissions: false, questions: true, elicitation: false } } }),
    })
    await wa.createSession("s1")
    expect((await wa.json("/session/s1/prompt_async", { parts: [{ type: "text", text: "question" }] })).status).toBe(204)
    await settle()
    seen.length = 0

    const res = await wa.json("/question/q1/reject", {})

    expect(res.status).toBe(200)
    await settle()
    expect(answers).toEqual([{ kind: "rejected" }])
    expect(seen.filter((event) => event.type.startsWith("question."))).toEqual([{
      id: "question.rejected:s1:q1",
      type: "question.rejected",
      properties: { sessionID: "s1", requestID: "q1" },
    }])
  })

  // `?sessionId=` is optional on the question routes, so gating admission on it
  // let any caller reach the answer by simply leaving it off.
  it("admits question replies and rejections on the pending question's session when sessionId is omitted", async () => {
    for (const path of ["/question/q1/reply", "/question/q1/reject"]) {
      const answers: RequestAnswer[] = []
      const admissions: Array<{ sessionId: string | undefined; operation: string }> = []
      const wa = await workspaceApp({
        transport: () => scripted({ question: asking((sessionId) => question("q1", sessionId), answers) }, { capabilities: { requests: { permissions: false, questions: true, elicitation: false } } }),
        sessionAccessPolicy: observingPolicy({ operations: admissions, deny: (operation) => operation === "question_response" }),
      })
      await wa.createSession("s1")
      expect((await wa.json("/session/s1/prompt_async", { parts: [{ type: "text", text: "question" }] })).status).toBe(204)
      await settle()
      admissions.length = 0

      const res = await wa.json(path, { answers: [["Continue"]] })

      expect(res.status, path).toBe(403)
      await expect(res.json()).resolves.toMatchObject({ error: { code: "session_private" } })
      expect(admissions, path).toEqual([{ sessionId: "s1", operation: "question_response" }])
      await settle()
      expect(answers, path).toEqual([])
    }
  })

  it("admits question replies on the authoritative session when the supplied session matches", async () => {
    const answers: RequestAnswer[] = []
    const admissions: Array<{ sessionId: string | undefined; operation: string }> = []
    const wa = await workspaceApp({
      transport: () => scripted({ question: asking((sessionId) => question("q1", sessionId), answers) }, { capabilities: { requests: { permissions: false, questions: true, elicitation: false } } }),
      sessionAccessPolicy: observingPolicy({ operations: admissions }),
    })
    await wa.createSession("s9")
    expect((await wa.json("/session/s9/prompt_async", { parts: [{ type: "text", text: "question" }] })).status).toBe(204)
    await settle()
    admissions.length = 0

    const res = await wa.json("/question/q1/reply", { answers: [["Continue"]] }, { params: { sessionId: "s9" } })

    expect(res.status).toBe(200)
    expect(admissions).toEqual([{ sessionId: "s9", operation: "question_response" }])
    await settle()
    expect(answers).toEqual([{ kind: "answers", answers: [["Continue"]] }])
  })

  it("rejects cross-session question replies and rejections before authorization or mutation", async () => {
    for (const path of ["/question/q1/reply", "/question/q1/reject"]) {
      const answers: RequestAnswer[] = []
      const admissions: Array<{ sessionId: string | undefined; operation: string }> = []
      const wa = await workspaceApp({
        transport: () => scripted({ question: asking((sessionId) => question("q1", sessionId), answers) }, { capabilities: { requests: { permissions: false, questions: true, elicitation: false } } }),
        sessionAccessPolicy: observingPolicy({ operations: admissions }),
      })
      await wa.createSession("session_owner")
      expect((await wa.json("/session/session_owner/prompt_async", { parts: [{ type: "text", text: "question" }] })).status).toBe(204)
      await settle()
      admissions.length = 0

      const response = await wa.json(path, { answers: [["Continue"]] }, { params: { sessionId: "session_attacker" } })

      expect(response.status, path).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ error: { code: "interaction_session_mismatch" } })
      expect(admissions, path).toEqual([])
      await settle()
      expect(answers, path).toEqual([])
    }
  })

  it("rejects a permission response when the permission belongs to another session", async () => {
    const answers: RequestAnswer[] = []
    const admissions: Array<{ sessionId: string | undefined; operation: string }> = []
    const wa = await workspaceApp({
      transport: () => scripted({ permission: asking((sessionId) => permission("permission_1", sessionId), answers) }, { capabilities: { requests: { permissions: true, questions: false, elicitation: false } } }),
      sessionAccessPolicy: observingPolicy({ operations: admissions }),
    })
    await wa.createSession("session_owner")
    expect((await wa.json("/session/session_owner/prompt_async", { parts: [{ type: "text", text: "permission" }] })).status).toBe(204)
    await settle()
    admissions.length = 0

    const response = await wa.json("/session/session_attacker/permissions/permission_1", { response: "once" })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "interaction_session_mismatch" } })
    expect(admissions).toEqual([])
    await settle()
    expect(answers).toEqual([])
  })

  // A refused reply must leave the question where it was: still pending, the
  // harness still waiting.
  it("keeps a rejected question reply away from the harness", async () => {
    const answers: RequestAnswer[] = []
    const wa = await workspaceApp({
      transport: () => scripted({ question: asking((sessionId) => question("q1", sessionId), answers) }, { capabilities: { requests: { permissions: false, questions: true, elicitation: false } } }),
      sessionAccessPolicy: observingPolicy({ deny: (operation) => operation === "question_response" }),
    })
    await wa.createSession("s9")
    expect((await wa.json("/session/s9/prompt_async", { parts: [{ type: "text", text: "question" }] })).status).toBe(204)
    await settle()

    const explicit = await wa.json("/question/q1/reply", { answers: [["x"]] }, { params: { sessionId: "s9" } })

    expect(explicit.status).toBe(403)
    await settle()
    expect(answers).toEqual([])
    expect(await (await wa.app.request(wa.url("/question"))).json()).toMatchObject([{ id: "q1", sessionID: "s9" }])
  })
})

it("publishes a successful session deletion once, on the hub the workspace stream serves, naming a subsession's parent", async () => {
  const wa = await workspaceApp()
  await wa.createSession("parent-1")
  wa.store().bindSession({
    sessionId: "s1", workspaceId: wa.workspaceId, directory: wa.directory, connectionId: "fake", upstreamSessionId: "s1",
    agentSessionId: "s1", title: "child", parentSessionId: "parent-1",
  })
  wa.store().recordSessionOwner("s1", { kind: "machine-owner" })
  wa.store().updateSessionConfig("s1", { harness: { id: "fake", access: "connection" } })
  const events: unknown[] = []
  wa.eventHub.subscribeGlobal((event) => { if ((event.payload as { type?: string }).type === "session.deleted") events.push(event) })
  const bus: string[] = []
  const unsubscribe = workspaceRuntimeBus.subscribe((event) => { bus.push(event.type) })
  try {
    const response = await wa.app.request(wa.url("/session/s1"), { method: "DELETE" })
    expect(response.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ directory: wa.directory, payload: { type: "session.deleted", properties: { info: { id: "s1", directory: wa.directory, parentID: "parent-1" } } } })
    expect(bus.filter((type) => type.startsWith("session."))).toEqual([])
    expect(wa.transport().closed.map((session) => session.binding.sessionId)).toEqual(["s1"])
  } finally { unsubscribe() }
})

it("publishes the canonical permission reply event when a permission is answered", async () => {
  const answers: RequestAnswer[] = []
  const published: CompatEvent[] = []
  const wa = await workspaceApp({
    onCompatEvent: (event) => published.push(event.payload),
    transport: () => scripted({ permission: asking((sessionId) => permission("permission_1", sessionId), answers) }, { capabilities: { requests: { permissions: true, questions: false, elicitation: false } } }),
  })
  await wa.createSession("session_owner")
  expect((await wa.json("/session/session_owner/prompt_async", { parts: [{ type: "text", text: "permission" }] })).status).toBe(204)
  await settle()
  published.length = 0

  const response = await wa.json("/session/session_owner/permissions/permission_1", { response: "once" })

  expect(response.status).toBe(200)
  const reply: CompatEvent = {
    id: "permission.replied:session_owner:permission_1",
    type: "permission.replied",
    properties: { sessionID: "session_owner", requestID: "permission_1", reply: "once" },
  }
  expect(await response.json()).toMatchObject({ ok: true })
  await settle()
  expect(published.filter((event) => event.type === "permission.replied")).toEqual([reply])
  expect(answers).toEqual([{ kind: "permission", decision: "allow_once" }])
})

it("requires an offered provider option and forwards its opaque ID to the harness", async () => {
  const answers: RequestAnswer[] = []
  const options = [{ optionId: "provider/session-policy", kind: "allow_once" as const, name: "Use for this session" }]
  const wa = await workspaceApp({
    transport: () => scripted({ permission: asking((sessionId) => permission("permission-provider", sessionId, { options }), answers) }, { capabilities: { requests: { permissions: true, questions: false, elicitation: false } } }),
  })
  await wa.createSession("session_owner")
  expect((await wa.json("/session/session_owner/prompt_async", { parts: [{ type: "text", text: "permission" }] })).status).toBe(204)
  await settle()
  expect(await (await wa.app.request(wa.url("/permission"))).json()).toMatchObject([{ id: "permission-provider", options: [{ id: "provider/session-policy", label: "Use for this session" }] }])

  const request = (body: unknown) => wa.json("/session/session_owner/permissions/permission-provider", body)
  for (const body of [{ response: "once" }, { optionId: "not-offered" }, { optionId: "provider/session-policy", response: "always" }]) {
    expect((await request(body)).status).toBe(400)
  }
  await settle()
  expect(answers).toEqual([])
  const response = await request({ optionId: "provider/session-policy" })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true })
  await settle()
  expect(answers).toEqual([{ kind: "permission", decision: "allow_once", optionId: "provider/session-policy" }])
})

it("settles each offered provider option with the kind the harness offered it as", async () => {
  const answers: RequestAnswer[] = []
  const published: CompatEvent[] = []
  const options = [
    { optionId: "provider/once", kind: "allow_once" as const, name: "Allow once" },
    { optionId: "provider/always", kind: "allow_always" as const, name: "Always allow" },
    { optionId: "provider/reject", kind: "reject_once" as const, name: "Reject" },
    { optionId: "provider/never", kind: "reject_always" as const, name: "Reject always" },
  ]
  const ask = (requestId: string) => asking((sessionId) => permission(requestId, sessionId, { options }), answers)
  const wa = await workspaceApp({
    onCompatEvent: (event) => published.push(event.payload),
    transport: () => scripted({ always: ask("permission-always"), reject: ask("permission-reject"), never: ask("permission-never") },
      { capabilities: { requests: { permissions: true, questions: false, elicitation: false } } }),
  })
  await wa.createSession("session_owner")

  for (const choice of ["always", "reject", "never"]) {
    expect((await wa.json("/session/session_owner/prompt_async", { parts: [{ type: "text", text: choice }] })).status).toBe(204)
    await settle()
    const response = await wa.json(`/session/session_owner/permissions/permission-${choice}`, { optionId: `provider/${choice}` })
    expect(response.status).toBe(200)
    await settle()
  }

  expect(answers).toEqual([
    { kind: "permission", decision: "allow_always", optionId: "provider/always" },
    { kind: "permission", decision: "deny", optionId: "provider/reject" },
    { kind: "permission", decision: "reject_always", optionId: "provider/never" },
  ])
  expect(published.filter((event) => event.type === "permission.replied")).toMatchObject([
    { properties: { requestID: "permission-always", reply: "always" } },
    { properties: { requestID: "permission-reject", reply: "reject" } },
    { properties: { requestID: "permission-never", reply: "reject" } },
  ])
})

it("answers and declines an elicitation-only harness's requests through the question routes", async () => {
  const answers: RequestAnswer[] = []
  const published: CompatEvent[] = []
  const elicitation = (requestId: string): TurnRequest => ({
    kind: "elicitation", requestId, mode: "form", message: "Name the branch",
    schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  })
  const wa = await workspaceApp({
    onCompatEvent: (event) => published.push(event.payload),
    transport: () => scripted({ form: asking(() => elicitation("elicit-form"), answers), decline: asking(() => elicitation("elicit-decline"), answers) },
      { capabilities: { requests: { permissions: false, questions: false, elicitation: true } } }),
  })
  await wa.createSession("s1")

  expect((await wa.json("/session/s1/prompt_async", { parts: [{ type: "text", text: "form" }] })).status).toBe(204)
  await settle()
  expect(await (await wa.app.request(wa.url("/question"))).json()).toMatchObject([{ id: "elicit-form", sessionID: "s1" }])
  expect((await wa.json("/question/elicit-form/reply", { answers: [[JSON.stringify({ name: "main" })]] })).status).toBe(200)
  await settle()

  expect((await wa.json("/session/s1/prompt_async", { parts: [{ type: "text", text: "decline" }] })).status).toBe(204)
  await settle()
  expect((await wa.json("/question/elicit-decline/reject", {})).status).toBe(200)
  await settle()

  expect(answers).toEqual([{ kind: "form", values: { name: "main" } }, { kind: "rejected" }])
  expect(published.filter((event) => event.type === "question.replied" || event.type === "question.rejected")).toEqual([
    { id: "question.replied:s1:elicit-form", type: "question.replied", properties: { sessionID: "s1", requestID: "elicit-form", answers: [[JSON.stringify({ name: "main" })]] } },
    { id: "question.rejected:s1:elicit-decline", type: "question.rejected", properties: { sessionID: "s1", requestID: "elicit-decline" } },
  ])
  expect(await (await wa.app.request(wa.url("/session/s1/capabilities"))).json()).toMatchObject({ questions: true })
})

it("retires a permission a previous owner asked and never settled, so the reopened workspace neither lists nor answers it", async () => {
  const optionId = '{"persist":"session"}'
  const capabilities = { requests: { permissions: true, questions: false, elicitation: false } }
  const wa = await workspaceApp({ fakeTransport: { capabilities } })
  await wa.createSession("permission-session")
  const request = permission("persisted-permission", "permission-session", { options: [{ optionId, kind: "allow_once", name: "Accept for session" }] })
  if (request.kind !== "permission") throw new Error("expected a permission request")
  const pending = { sessionId: "permission-session", request, askedAt: 1, upstreamSessionId: "upstream-permission-session" }
  const ports = createStoreBrokerPorts(wa.store(), { ownerGeneration: "previous-owner", patternEvaluator: async () => {}, publishers: wa.eventHub, reportOwnerFailure: (_sessionId, error) => { throw error },
    retainLeasedTurnFailure: (_sessionId, _turn, error) => { throw error } })
  await ports.publish({ id: "permission.asked:permission-session:persisted-permission", type: "permission.asked", properties: request.permission }, pending)
  expect(wa.store().listPermissions(wa.directory).map((row) => row.id)).toEqual(["persisted-permission"])
  await wa.dispose({ keepRoot: true })
  apps.splice(apps.indexOf(wa), 1)

  const reopened = await workspaceApp({ root: wa.root, fakeTransport: { capabilities } })
  expect(await (await reopened.app.request(reopened.url("/permission"))).json()).toEqual([])
  const response = await reopened.json("/session/permission-session/permissions/persisted-permission", { optionId })
  expect(response.status).toBe(404)
  expect(reopened.store().listPermissions(reopened.directory)).toEqual([])
})

describe("session create ownership", () => {
  it("a host that reads the session index must name its own workspace", () => {
    expect(() => createWorkspaceHost({ placement: loopbackMachineLoginPolicy(), sessionIdWorkspace: () => undefined }))
      .toThrow("sessionIdWorkspace requires a target workspace")
  })

  it("refuses an id another workspace holds before any harness launches", async () => {
    const app = await workspaceApp({ sessionIdWorkspace: (sessionId) => sessionId === "ses_foreign" ? "ws_other" : "ws_fake" })
    const refused = await app.json("/session", { id: "ses_foreign" }, { params: { connectionId: "fake" } })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: "session_create_conflict" } })
    expect(app.transports.flatMap((transport) => transport instanceof FakeTransport ? transport.starts : [])).toEqual([])
    await app.createSession("ses_own")
    expect(app.transport().starts.map((start) => start.sessionId)).toEqual(["ses_own"])
  })
})

describe("archiving a running session", () => {
  it("does not start a prompt queued behind the cancelled turn", async () => {
    const transport = scripted({
      hold: async function* ({ signal }) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      },
    })
    const wa = await workspaceApp({ transport: () => transport })
    await wa.createSession("ses_archive_queue")
    expect((await wa.json("/session/ses_archive_queue/prompt_async", { parts: [{ type: "text", text: "hold" }] })).status).toBe(204)
    for (let attempt = 0; attempt < 200 && transport.turns.length === 0; attempt++) await settle()
    const queued = await wa.json("/session/ses_archive_queue/prompt_async", { messageID: "msg_after_archive", parts: [{ type: "text", text: "queued" }], delivery: "queue" })
    expect(await queued.json()).toEqual({ delivery: "queue" })
    expect((await wa.json("/session/ses_archive_queue", { time: { archived: 77 } }, { method: "PATCH" })).status).toBe(200)
    for (let attempt = 0; attempt < 20; attempt++) await settle()
    expect(transport.turns.map(promptText)).toEqual(["hold"])
    expect(wa.store().getSession("ses_archive_queue")).toMatchObject({ status: "idle", time: { archived: 77 } })
  })
})

describe("archiving between a queued prompt's claim and its admission", () => {
  it("leaves the claimed prompt unstarted and queued", async () => {
    let gate: Promise<void> | undefined
    let reached!: () => void
    const reachedGate = new Promise<void>((resolve) => { reached = resolve })
    let open!: () => void
    class GatedTransport extends ScriptedTransport {
      override async capabilities() {
        if (gate) { reached(); await gate }
        return super.capabilities()
      }
    }
    let finish!: () => void
    const transport = new GatedTransport({
      first: async function* () { await new Promise<void>((resolve) => { finish = resolve }) },
    })
    const wa = await workspaceApp({ transport: () => transport })
    await wa.createSession("ses_archive_gap")
    expect((await wa.json("/session/ses_archive_gap/prompt_async", { parts: [{ type: "text", text: "first" }] })).status).toBe(204)
    for (let attempt = 0; attempt < 200 && transport.turns.length === 0; attempt++) await settle()
    expect(await (await wa.json("/session/ses_archive_gap/prompt_async", { messageID: "msg_gap", parts: [{ type: "text", text: "queued" }], delivery: "queue" })).json())
      .toEqual({ delivery: "queue" })
    gate = new Promise<void>((resolve) => { open = resolve })
    finish()
    await reachedGate
    expect((await wa.json("/session/ses_archive_gap", { time: { archived: 88 } }, { method: "PATCH" })).status).toBe(200)
    open()
    for (let attempt = 0; attempt < 20; attempt++) await settle()
    expect(transport.turns.map(promptText)).toEqual(["first"])
    expect(wa.store().listQueuedPrompts().map((row) => row.messageId)).toEqual(["msg_gap"])
  })
})
