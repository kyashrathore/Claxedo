import { describe, expect, test } from "bun:test"
import { NO_HARNESS_EFFORT, type RecoveryFacts } from "@claxedo/agent-runtime-contract"
import type { AgentMessage, AgentPermissionMode, AgentPermissionModeState, AgentSession, SessionConfig } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { MemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { Hono } from "hono"
import { buildSession } from "../compat-events"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../runtime-event-hub"
import {
  managedWorkspaceSessionAccessPolicy,
  type SessionAccessPolicy,
  type SessionAccessPolicyInput,
  type SessionReservationDecision,
  type SessionTurnOrigin,
} from "../session-access-policy"
import type { EmbeddedRelayHostIdentity } from "../workspace-host-service-auth"
import { SessionRoutes } from "./session"

const DIRECTORY = process.cwd()
const MODES: readonly AgentPermissionMode[] = [
  { id: "read-only", name: "Read only", level: "ask" },
  { id: "workspace-write", name: "Workspace write", level: "auto" },
  { id: "untrusted", name: "Untrusted" },
  { id: "full-access", name: "Full access", level: "full" },
]

const NO_MODE_SURFACE: AgentPermissionModeState = { modes: [], unsupported: "codex exposes no permission modes", appliesFrom: "next-turn" }

function fixture(input: {
  parentMode?: string
  policy?: SessionAccessPolicy
  identity?: EmbeddedRelayHostIdentity
  /**
   * Compose the host the way the workspace runtime does, over an agent
   * runtime. Only that shape can be fenced, so it is the only one a managed
   * policy admits a background turn on.
   */
  withRuntime?: boolean
} = {}) {
  const store = new MemoryRuntimeStore()
  const origins = new Map<string, SessionTurnOrigin>()
  const calls = {
    created: [] as string[],
    models: [] as string[],
    projected: [] as unknown[],
    modes: [] as Array<{ sessionId: string; modeId: string }>,
    aborted: [] as string[],
    archived: [] as string[],
    deleted: [] as string[],
    prompts: [] as Array<{ sessionId: string; messageID?: string; text: string; author?: unknown }>,
  }
  const messages = new Map<string, AgentMessage[]>()
  const config: SessionConfig = { harness: { id: "codex", access: "native" }, variant: null, agent: null }
  let counter = 0
  const adapter: AgentHarnessAdapter & { adapterCapabilities: readonly ["runtime-config"]; setModel(model: string): void } = {
    adapterCapabilities: ["runtime-config"],
    setModel(model) { calls.models.push(model) },
    instructionChannel: "turn-system-prompt",
    getSession: async (binding) => store.getSession(binding.sessionId) ?? null,
    createSession: async (_directory, _title, id) => {
      const sessionId = id ?? `ses_created_${++counter}`
      calls.created.push(sessionId)
      return { id: sessionId }
    },
    updateSession: async (binding, updates) => {
      if (updates.time?.archived !== undefined) calls.archived.push(binding.sessionId)
      return store.updateSession(binding.sessionId, updates)
    },
    getSessionConfig: async (binding) => store.getSessionConfig(binding.sessionId) ?? config,
    updateSessionConfig: async (binding, patch) => store.updateSessionConfig(binding.sessionId, patch) ?? config,
    deleteSession: async (binding) => {
      calls.deleted.push(binding.sessionId)
      store.deleteSession(binding.sessionId)
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
      fork: false,
      revert: false,
      unrevert: false,
      configOptions: false,
      subagents: true,
      effortLevels: NO_HARNESS_EFFORT,
      instructionChannel: "turn-system-prompt",
      goals: false,
    }),
    executeTurn: (binding, prompt) => {
      calls.prompts.push({
        sessionId: binding.sessionId,
        messageID: prompt.userMessageId,
        text: prompt.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
        author: prompt.author,
      })
      return (async function* () {})()
    },
    getMessages: async (binding) => messages.get(binding.sessionId) ?? [],
    executeCommand: async () => {},
    listCommands: async () => [],
    listAgents: async () => [],
    getTodos: async () => [],
    listPermissions: async () => [],
    respondPermission: async () => {},
    listQuestions: async () => [],
    replyQuestion: async () => {},
    rejectQuestion: async () => {},
    applyConfig: async () => {},
    probeConfigOptions: async () => ({ options: [] }),
    listDraftPermissionModes: async () => ({ modes: [...MODES], appliesFrom: "next-turn" }),
    listPermissionModes: async () => ({ modes: [...MODES], currentModeId: input.parentMode ?? "read-only", appliesFrom: "next-turn" }),
    setPermissionMode: async (binding, modeId) => {
      calls.modes.push({ sessionId: binding.sessionId, modeId })
      return { modes: [...MODES], currentModeId: modeId, appliesFrom: "next-turn" }
    },
    dispose: () => {},
  }
  const eventHub = createRuntimeEventHub()
  const runtimeEvents: RuntimeEventEnvelope[] = []
  eventHub.subscribeRuntime((event) => {
    runtimeEvents.push(event)
  })
  const admissions: Array<{ sessionId: string; fencingToken?: number }> = []
  const recoveryFacts: RecoveryFacts = {
    execution: { value: "terminal", source: "fixture", observedAt: 1, generation: "lease_1" },
    cleanup: { value: "verified_clear", source: "fixture", observedAt: 1, generation: "lease_1" },
    persistence: { value: "committed", source: "fixture", observedAt: 1, generation: "lease_1" },
  }
  const recovery = {
    inspect: (sessionId: string) => ({
      sessionId,
      target: { scope: "turn" as const, workspaceId: "workspace-test", sessionId, turnId: "msg_active", ownerGeneration: "lease_1" },
      facts: recoveryFacts,
      health: { status: "ok" as const },
      failures: [],
      operations: [],
      queued: 0,
    }),
    submit: async (request: { requestId: string; target: { sessionId: string } }) => {
      calls.aborted.push(request.target.sessionId)
      return {
        kind: "operation" as const,
        operation: {
          operationId: `op_${calls.aborted.length}`, requestId: request.requestId, target: request.target as never,
          action: "cancel_turn" as const, scopeRevision: "lease_1", attempt: 1, state: "succeeded" as const,
          phase: "graceful_cancel" as const, phaseDeadlineAt: 2, facts: recoveryFacts, cleanupErrors: [],
          nextActions: [], receipt: "durable" as const, createdAt: 1, updatedAt: 1,
        },
      }
    },
    read: () => undefined,
  }
  const runtime = {
    recovery,
    turns: {
      whenIdle: async () => ({ abandon() {} }),
      start: async (turn: { sessionId: string; messageId: string; parts: unknown[]; admission?: { fencingToken(): number }; onAdmitted?: () => void }) => {
        calls.prompts.push({
          sessionId: turn.sessionId,
          messageID: turn.messageId,
          text: (turn.parts as Array<{ type: string; text?: string }>).map((part) => (part.type === "text" ? part.text ?? "" : "")).join(""),
        })
        admissions.push({ sessionId: turn.sessionId, ...(turn.admission ? { fencingToken: turn.admission.fencingToken() } : {}) })
        turn.onAdmitted?.()
        return {
          sessionId: turn.sessionId,
          userMessageId: turn.messageId,
          assistantMessageId: "reply",
          delivery: "start",
          prompt: { userMessageId: turn.messageId, assistantMessageId: "reply", parts: turn.parts, agent: "build", model: { providerID: "test", modelID: "fixture" } },
        }
      },
    },
    events: { list: async () => [], subscribe: () => (async function* () {})() },
  }
  const { routes: sessionRoutes } = SessionRoutes(() => adapter, {
    eventHub,
    ...(input.policy ? { sessionAccessPolicy: input.policy } : {}),
    ...(input.withRuntime ? { resolveRuntime: () => runtime as never } : {}),
    resolveRecoveryOwner: () => recovery as never,
    afterCreateSession: ({ session }) => { calls.projected.push(session) },
    resolveExecutionBinding: ({ directory, sessionId }) => ({
      sessionId,
      workspaceId: "workspace-test",
      directory,
      connectionId: "native:codex",
      upstreamSessionId: sessionId,
    }),
    createSession: async (_c, directory, title, id, create) => {
      const session = await adapter.createSession(directory, title, id)
      store.bindSession({
        sessionId: session.id,
        directory,
        ...(title ? { title } : {}),
        ...(create?.parentID ? { parentSessionId: create.parentID } : {}),
        agentSessionId: session.id,
      })
      store.updateSessionConfig(session.id, {
        ...config,
        ...(create?.permissionCeiling ? { permissionCeiling: create.permissionCeiling } : {}),
        ...(create?.instructions ? { instructions: create.instructions } : {}),
        ...(create?.group ? { group: create.group } : {}),
      })
      return session
    },
    listSessions: async (_c, directory) => store.listSessions(directory),
    getSession: ({ sessionId }) => store.getSession(sessionId) ?? null,
    getMessages: ({ sessionId }) => messages.get(sessionId) ?? [],
    listSubagents: ({ parentSessionId }) => store.listSubagents(parentSessionId),
    afterDeleteSession: ({ sessionId }) => {
      store.deleteSession(sessionId)
    },
    childSessions: {
      admission: { admit: (row) => store.admit(row), markPublished: (parent, id) => store.markPublished(parent, id) },
      secret: () => "route-test-secret",
      pendingWakes: () => [],
      origins: {
        record: (parent, key, origin) => {
          if (!origins.has(`${parent}\0${key}`)) origins.set(`${parent}\0${key}`, origin)
        },
        read: (parent, key) => origins.get(`${parent}\0${key}`),
      },
    },
  })
  const app = new Hono()
  if (input.identity) {
    const identity = input.identity
    app.use("*", async (c, next) => {
      const actor = c.req.header("x-test-actor")
      ;(c as unknown as { set(name: string, value: unknown): void })
        .set("relayHostAuth", actor ? { ...identity, actor_id: actor, actor_public_id: actor } : identity)
      await next()
    })
  }
  app.route("/", sessionRoutes)
  const seedParent = (id: string, session: Partial<AgentSession> = {}) => {
    store.bindSession({ sessionId: id, directory: DIRECTORY, agentSessionId: id, title: "Parent", ...(session.parentID ? { parentSessionId: session.parentID } : {}) })
    store.updateSessionConfig(id, config)
  }
  const create = (body: Record<string, unknown>, headers: Record<string, string> = {}) => app.request(`http://localhost/session?directory=${encodeURIComponent(DIRECTORY)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer owner-grant", ...headers },
    body: JSON.stringify(body),
  })
  return { app, store, origins, calls, admissions, runtimeEvents, seedParent, create, messages, adapter }
}

describe("POST /session with parentID", () => {
  test("publishes the persisted child relationship to the control-plane projection", async () => {
    const item = fixture()
    item.seedParent("parent")
    const response = await item.create({ parentID: "parent", title: "Child" })
    expect(response.status).toBe(201)
    expect(item.calls.projected).toEqual([expect.objectContaining({ parentID: "parent", title: "Child", time: expect.any(Object) })])
  })

  test("a child starts under the variant, instructions and group its create named", async () => {
    const item = fixture()
    item.seedParent("parent")
    const group = {
      implementation: {
        harness: { id: "codex", access: "native" },
        model: { providerID: "openai", modelID: "gpt-5-codex" },
        effort: "high",
      },
    }

    const response = await item.create({
      parentID: "parent",
      title: "Implement",
      variant: "high",
      instructions: "Only touch the runtime package.",
      group,
      harness: { id: "codex", access: "native" },
      model: { providerID: "openai", id: "gpt-5-codex" },
    })
    expect(response.status).toBe(201)
    const child = await response.json() as { id: string; parentID: string }
    expect(child.parentID).toBe("parent")

    const config = await item.app.request(`http://localhost/session/${child.id}/config?directory=${encodeURIComponent(DIRECTORY)}`)
    expect(await config.json()).toMatchObject({
      variant: "high",
      instructions: "Only touch the runtime package.",
      group,
      model: { providerID: "openai", modelID: "gpt-5-codex" },
    })
    expect(item.store.getSessionConfig("parent")?.variant).toBeNull()
    expect(item.store.getSessionConfig("parent")?.instructions).toBeUndefined()
  })

  test("refuses a child whose group names a slot the contract does not have", async () => {
    const item = fixture()
    item.seedParent("parent")
    const response = await item.create({ parentID: "parent", group: { archivist: {} } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_group_invalid" } })
    expect(item.calls.created).toEqual([])
  })

  test("refuses a ceiling when the target cannot enforce permission modes", async () => {
    const item = fixture()
    item.seedParent("parent")
    item.adapter.setPermissionMode = undefined
    const response = await item.create({ parentID: "parent" })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "permission_ceiling_unsupported" } })
    expect(item.calls.created).toEqual([])
  })

  for (
    const [surface, hideModeSurface] of [
      ["no permission-mode methods at all", (adapter: AgentHarnessAdapter) => {
        adapter.listPermissionModes = undefined
        adapter.listDraftPermissionModes = undefined
        adapter.setPermissionMode = undefined
      }],
      ["a state that says it has no mode surface", (adapter: AgentHarnessAdapter) => {
        adapter.listPermissionModes = async () => NO_MODE_SURFACE
      }],
    ] as const
  ) {
    test(`a parent whose harness reports ${surface} restricts its child to nothing`, async () => {
      const item = fixture()
      item.seedParent("parent")
      hideModeSurface(item.adapter)

      const response = await item.create({ parentID: "parent" })
      expect(response.status).toBe(201)
      const child = await response.json() as { id: string; permissionMode?: string }
      expect(child.permissionMode).toBeUndefined()
      expect(item.calls.modes).toEqual([])
      expect(item.store.getSessionConfig(child.id)?.permissionCeiling).toBeUndefined()
    })
  }

  test("a declared ceiling still caps a child under a parent whose harness has no mode surface", async () => {
    const item = fixture()
    item.seedParent("parent")
    item.adapter.listPermissionModes = async () => NO_MODE_SURFACE

    const child = await (await item.create({ parentID: "parent", permissionCeiling: "ask" })).json() as { id: string; permissionMode?: string }
    expect(child.permissionMode).toBe("read-only")
    expect(item.calls.modes).toEqual([{ sessionId: child.id, modeId: "read-only" }])
    expect(item.store.getSessionConfig(child.id)?.permissionCeiling).toBe("ask")

    const widened = await item.app.request(`http://localhost/session/${child.id}/permission-mode?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ modeId: "full-access" }),
    })
    expect(widened.status).toBe(403)
    expect(await widened.json()).toMatchObject({ error: { code: "permission_ceiling_exceeded", ceiling: "ask" } })
    expect(item.calls.modes).toHaveLength(1)
  })

  test("refuses a ceiling when no target mode fits instead of using the harness default", async () => {
    const item = fixture()
    item.seedParent("parent")
    item.adapter.listDraftPermissionModes = async () => ({ modes: [MODES[3]], appliesFrom: "next-turn" })
    const response = await item.create({ parentID: "parent" })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "permission_ceiling_unsupported" } })
    expect(item.calls.created).toEqual([])
  })

  test("creates a host-owned child under the parent, admits it pending, and keeps it out of the root list", async () => {
    const item = fixture()
    item.seedParent("parent")

    const response = await item.create({ parentID: "parent", title: "Consult on the plan", role: "reviewer" })
    expect(response.status).toBe(201)
    const created = await response.json() as { id: string; parentID: string; subagentKey: string; permissionMode?: string }
    expect(created.parentID).toBe("parent")
    expect(created.subagentKey).toMatch(/^subagent_/)
    expect(item.store.getSession(created.id)?.parentID).toBe("parent")

    const subagents = await (await item.app.request(`http://localhost/session/parent/subagents?directory=${encodeURIComponent(DIRECTORY)}`)).json() as unknown[]
    expect(subagents).toMatchObject([{
      subagentKey: created.subagentKey,
      status: "pending",
      providerKind: "claxedo",
      childSessionId: created.id,
      label: "Consult on the plan",
      subagentType: "reviewer",
    }])
    expect(item.runtimeEvents).toMatchObject([{ sessionId: "parent", payload: { type: "subagent-updated", subagentKey: created.subagentKey, status: "pending" } }])

    for (const route of ["/session", "/experimental/session"]) {
      const roots = await (await item.app.request(`http://localhost${route}?directory=${encodeURIComponent(DIRECTORY)}&roots=true`)).json() as Array<{ id: string }>
      expect(roots.map((row) => row.id), route).toEqual(["parent"])
      const all = await (await item.app.request(`http://localhost${route}?directory=${encodeURIComponent(DIRECTORY)}`)).json() as Array<{ id: string }>
      expect(all.map((row) => row.id).sort(), route).toEqual(["parent", created.id].sort())
    }
  })

  test("refuses a child of a child and a fifth active child", async () => {
    const item = fixture()
    item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent" })).json() as { id: string }

    const recursion = await item.create({ parentID: child.id })
    expect(recursion.status).toBe(409)
    expect(await recursion.json()).toMatchObject({ error: { code: "subagent_recursion_denied" } })

    for (let index = 0; index < 3; index += 1) expect((await item.create({ parentID: "parent" })).status).toBe(201)
    const capped = await item.create({ parentID: "parent" })
    expect(capped.status).toBe(409)
    expect(await capped.json()).toMatchObject({ error: { code: "subagent_child_cap_reached" } })
    expect(item.calls.created).toHaveLength(4)
  })

  test("a retried clientRequestId returns the same child instead of creating another", async () => {
    const item = fixture()
    item.seedParent("parent")
    const first = await (await item.create({ parentID: "parent", clientRequestId: "req-1" })).json() as { id: string; subagentKey: string }
    const retry = await item.create({ parentID: "parent", clientRequestId: "req-1" })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ id: first.id, parentID: "parent", subagentKey: first.subagentKey })
    expect(item.calls.created).toEqual([first.id])
    expect(first.id).toMatch(/^ses_[0-9a-f]{32}$/)

    item.seedParent("other")
    const foreign = await item.create({ parentID: "other", clientRequestId: "req-1" })
    expect(foreign.status).toBe(201)
    expect(((await foreign.json()) as { id: string }).id).not.toBe(first.id)
  })

  test("a retry still returns its child when all four child slots are occupied", async () => {
    const item = fixture()
    item.seedParent("parent")
    const first = await (await item.create({ parentID: "parent", clientRequestId: "retry-at-cap" })).json() as { id: string }
    for (let i = 0; i < 3; i++) expect((await item.create({ parentID: "parent" })).status).toBe(201)
    const retry = await item.create({ parentID: "parent", clientRequestId: "retry-at-cap" })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ id: first.id })
    expect(item.calls.created).toHaveLength(4)
  })

  test("concurrent creates respect the four-child cap and deduplicate retries", async () => {
    const item = fixture()
    item.seedParent("parent")
    const retries = await Promise.all(Array.from({ length: 3 }, () => item.create({ parentID: "parent", clientRequestId: "same" })))
    expect(retries.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 200, 201])
    expect(item.calls.created).toHaveLength(1)
    const creates = await Promise.all(Array.from({ length: 5 }, () => item.create({ parentID: "parent" })))
    expect(creates.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 201, 201, 409, 409])
    expect(item.calls.created).toHaveLength(4)
  })

  test("a child may equal or narrow the parent's permission mode, never widen it", async () => {
    const item = fixture({ parentMode: "read-only" })
    item.seedParent("parent")

    const widened = await item.create({ parentID: "parent", permissionMode: "workspace-write" })
    expect(widened.status).toBe(403)
    expect(await widened.json()).toMatchObject({
      error: { code: "permission_ceiling_exceeded", ceiling: "ask", requested: { modeId: "workspace-write", level: "auto" } },
    })
    expect(item.calls.created).toHaveLength(0)

    const clamped = await (await item.create({ parentID: "parent" })).json() as { id: string; permissionMode: string }
    expect(clamped.permissionMode).toBe("read-only")
    expect(item.calls.modes).toEqual([{ sessionId: clamped.id, modeId: "read-only" }])

    const unranked = await (await item.create({ parentID: "parent", permissionMode: "untrusted" })).json() as { permissionMode: string }
    expect(unranked.permissionMode).toBe("untrusted")
  })

  test("an explicit permissionCeiling caps a parentless create the same way", async () => {
    const item = fixture()
    const widened = await item.create({ permissionCeiling: "auto", permissionMode: "full-access" })
    expect(widened.status).toBe(403)
    expect(await widened.json()).toMatchObject({ error: { code: "permission_ceiling_exceeded", ceiling: "auto" } })

    const clamped = await (await item.create({ permissionCeiling: "auto" })).json() as { id: string; permissionMode: string; parentID?: string }
    expect(clamped.permissionMode).toBe("workspace-write")
    expect(clamped.parentID).toBeUndefined()
    expect(item.calls.modes).toEqual([{ sessionId: clamped.id, modeId: "workspace-write" }])

    const unknown = await item.create({ permissionMode: "nope" })
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ error: { code: "unknown_permission_mode" } })
  })

  test("archiving or deleting the parent cancels each child's turn through its own recovery owner", async () => {
    const item = fixture()
    item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent" })).json() as { id: string }

    const archived = await item.app.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: { archived: 42 } }),
    })
    expect(archived.status).toBe(200)
    expect(item.calls.aborted).toEqual([child.id])
    expect(item.calls.archived).toEqual(["parent", child.id])
    expect(item.store.getSession(child.id)?.time?.archived).toBe(42)

    const deleted = await item.app.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`, { method: "DELETE" })
    expect(deleted.status).toBe(200)
    expect(item.calls.deleted).toEqual([child.id, "parent"])
    expect(item.store.getSession(child.id)).toBeFalsy()
  })

  test("a child's finished turn wakes the idle parent through the prompt path with the child's summary", async () => {
    const item = fixture()
    item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent", title: "Consult" })).json() as { id: string; subagentKey: string }
    item.messages.set(child.id, [{
      info: { id: "child-reply", role: "assistant", sessionID: child.id },
      parts: [{ id: "p1", sessionID: child.id, messageID: "child-reply", type: "text", text: "Ship it." }],
    }])

    const prompted = await item.app.request(`http://localhost/session/${child.id}/message?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageID: "child-turn", parts: [{ type: "text", text: "Review the plan" }] }),
    })
    expect(prompted.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(item.calls.prompts).toMatchObject([
      { sessionId: child.id, messageID: "child-turn", text: "Review the plan" },
      {
        sessionId: "parent",
        messageID: "msg_wake_" + child.id + "_child-reply",
        text: 'Subagent "Consult" (codex) completed.\n\nShip it.',
      },
    ])
    expect(item.store.listSubagents("parent")).toMatchObject([{ subagentKey: child.subagentKey, status: "completed", wake: "delivered" }])
    expect(item.runtimeEvents.map((event) => event.payload).filter((payload) => payload.type === "subagent-updated").map((payload) => payload.status ?? payload.wake))
      .toEqual(["pending", "running", "completed", "delivered"])
  })

  test("a parent that does not exist is a 404 and a missing host is a 501", async () => {
    const item = fixture()
    const missing = await item.create({ parentID: "ghost" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "parent_session_not_found" } })

    const { routes: bare } = SessionRoutes(() => ({ ...({} as AgentHarnessAdapter) }), {})
    const unsupported = await bare.request(`http://localhost/session?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentID: "parent" }),
    })
    expect(unsupported.status).toBe(501)
    expect(await unsupported.json()).toMatchObject({ error: { code: "child_sessions_unsupported" } })
  })
})

export { buildSession }

const OWNER: EmbeddedRelayHostIdentity = {
  principal_kind: "user",
  actor_id: "actor_owner",
  actor_kind: "human",
  actor_public_id: "actor_owner",
  actor_name: "workspace owner",
  org_id: "org_1",
  workspace_id: "ws_1",
  role: "owner",
}

/** The remote flavour's shape: every authority call is answered by the control plane, reservation included. */
function managedPolicy(input: {
  reserve?: (input: SessionAccessPolicyInput & { sessionId: string; parentSessionId: string }) => Promise<SessionReservationDecision>
  parentWriteAllowed?: () => boolean
  /** Session ids the plane already holds a reservation for, by operation. */
  held?: Record<string, string>
  /** Whether the plane still admits a turn for this actor; absent means it admits none. */
  turnAllowed?: (input: { sessionId: string; actorId: string }) => boolean
  /** Off for the desktop daemon shape, where an unstamped request is the machine's own user. */
  requireActor?: boolean
} = {}) {
  const held = new Map(Object.entries(input.held ?? {}))
  /** Who the plane recorded as the creator; a session it never registered is nobody's. */
  const creators = new Map<string, string>()
  const calls = {
    reserved: [] as Array<SessionAccessPolicyInput & { sessionId: string; parentSessionId: string }>,
    registered: [] as Array<{ sessionId: string; registrationOperationId: string; actorId?: string }>,
    /** Stands for the plane's producer row: one per admitted turn, carrying who it was admitted for. */
    producers: [] as Array<{ sessionId: string; turnId: string; actorId: string; fencingToken: number }>,
  }
  const policy = managedWorkspaceSessionAccessPolicy({
    requireActor: input.requireActor ?? true,
    authority: {
      authorizeSessionStart: async (request) => held.get(request.registrationOperationId) === request.sessionId,
      authorizeSessionRead: async (request) => (creators.get(request.sessionId) ?? request.actor.actorId) === request.actor.actorId,
      authorizeSessionWrite: async (request) =>
        (request.sessionId !== "parent" || (input.parentWriteAllowed?.() ?? true))
        && (creators.get(request.sessionId) ?? request.actor.actorId) === request.actor.actorId,
      authorizeSessionStream: async () => ({ allowed: false, status: 503, code: "unused", message: "unused" }),
      registerSession: async (input) => {
        calls.registered.push({ sessionId: input.sessionId, registrationOperationId: input.registrationOperationId!, actorId: input.actor.actorId })
        creators.set(input.sessionId, input.actor.actorId)
        return true
      },
      acquireTurn: async (request) => {
        if (!input.turnAllowed?.({ sessionId: request.sessionId, actorId: request.actor.actorId })) {
          return { allowed: false, status: 403, code: "session_private", message: "Turn authority was revoked" }
        }
        const fencingToken = calls.producers.length + 1
        calls.producers.push({ sessionId: request.sessionId, turnId: request.turnId, actorId: request.actor.actorId, fencingToken })
        return {
          allowed: true,
          turnId: request.turnId,
          leaseId: `lease_${request.turnId}`,
          fencingToken,
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }
      },
      renewTurn: async (request) => ({
        allowed: true,
        turnId: request.turnId,
        leaseId: request.leaseId,
        fencingToken: request.fencingToken,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
      releaseTurn: async () => ({ released: true }),
    },
  })
  policy.reserveSession = async (request) => {
    calls.reserved.push(request)
    const decision = input.reserve
      ? await input.reserve(request)
      : { allowed: true as const, operationId: `session_registration_${request.sessionId}` }
    if (decision.allowed) held.set(decision.operationId, request.sessionId)
    return decision
  }
  return { policy, calls }
}

describe("a child created in-process under managed registration", () => {
  test("a readable parent cannot create a completion wake without current turn authority", async () => {
    let writable = false
    const { policy, calls } = managedPolicy({ parentWriteAllowed: () => writable })
    const item = fixture({ policy, identity: OWNER })
    item.seedParent("parent")

    expect((await item.create({ parentID: "parent", title: "Reader's child" })).status).toBe(403)
    expect(calls.reserved).toEqual([])
    expect(calls.registered).toEqual([])
    expect(item.calls.created).toEqual([])
    expect(item.calls.models).toEqual([])

    writable = true
    expect((await item.create({ parentID: "parent", title: "Writer's child" })).status).toBe(201)
    expect(item.calls.created).toHaveLength(1)
  })

  test("a completion wake runs as the actor that created the child and is admitted as that actor's turn", async () => {
    const { policy, calls } = managedPolicy({ turnAllowed: () => true })
    const item = fixture({ policy, identity: OWNER, withRuntime: true })
    item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent", title: "Consult" })).json() as { id: string; subagentKey: string }
    expect(item.origins.get(`parent\0${child.subagentKey}`)).toEqual({
      provenance: "relay-replayed",
      actor: { actorId: "actor_owner", actorKind: "human" },
      authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" },
    })
    item.messages.set(child.id, [{
      info: { id: "child-reply", role: "assistant", sessionID: child.id },
      parts: [{ id: "p1", sessionID: child.id, messageID: "child-reply", type: "text", text: "Ship it." }],
    }])

    expect((await item.app.request(`http://localhost/session/${child.id}/message?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer owner-grant" },
      body: JSON.stringify({ messageID: "child-turn", parts: [{ type: "text", text: "Review the plan" }] }),
    })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const wakeTurnId = `msg_wake_${child.id}_child-reply`
    expect(item.calls.prompts.map((prompt) => prompt.messageID)).toContain(wakeTurnId)
    const producer = { sessionId: "parent", turnId: wakeTurnId, actorId: "actor_owner" }
    expect(calls.producers).toContainEqual(expect.objectContaining(producer))
    // The turn runs behind the fence it was admitted under, not merely after it.
    expect(item.admissions).toContainEqual({
      sessionId: "parent",
      fencingToken: calls.producers.find((entry) => entry.turnId === wakeTurnId)!.fencingToken,
    })
    expect(item.store.listSubagents("parent")).toMatchObject([{ subagentKey: child.subagentKey, wake: "delivered" }])
  })

  test("a child row from before origins were recorded gets no wake: nothing names who it would run as", async () => {
    const { policy, calls } = managedPolicy({ turnAllowed: () => true })
    const item = fixture({ policy, identity: OWNER, withRuntime: true })
    item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent", title: "Consult" })).json() as { id: string; subagentKey: string }
    item.messages.set(child.id, [{
      info: { id: "child-reply", role: "assistant", sessionID: child.id },
      parts: [{ id: "p1", sessionID: child.id, messageID: "child-reply", type: "text", text: "Ship it." }],
    }])
    // A row admitted by an earlier build: the child and its parent link are
    // durable, the identity behind them was never written.
    item.origins.clear()

    expect((await item.app.request(`http://localhost/session/${child.id}/message?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer owner-grant" },
      body: JSON.stringify({ messageID: "child-turn", parts: [{ type: "text", text: "Review the plan" }] }),
    })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(item.calls.prompts.map((prompt) => prompt.sessionId)).toEqual([child.id])
    expect(calls.producers.map((producer) => producer.sessionId)).toEqual([child.id])
    expect(item.store.listSubagents("parent")).toMatchObject([{ subagentKey: child.subagentKey, status: "completed", wake: "pending" }])
  })

  test("the machine's own user creates a child over loopback and its wake runs as that, unleased", async () => {
    // The daemon shape: managed composition, `requireActor` off, and a request
    // the relay never stamped. The same runtime answers both arms, so the row
    // has to remember which one asked rather than what the host was built as.
    const { policy, calls } = managedPolicy({ turnAllowed: () => true, requireActor: false })
    const item = fixture({ policy, withRuntime: true })
    item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent", title: "Consult" })).json() as { id: string; subagentKey: string }
    expect(item.origins.get(`parent\0${child.subagentKey}`)).toEqual({ provenance: "loopback-direct" })
    item.messages.set(child.id, [{
      info: { id: "child-reply", role: "assistant", sessionID: child.id },
      parts: [{ id: "p1", sessionID: child.id, messageID: "child-reply", type: "text", text: "Ship it." }],
    }])

    expect((await item.app.request(`http://localhost/session/${child.id}/message?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageID: "child-turn", parts: [{ type: "text", text: "Review the plan" }] }),
    })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(item.calls.prompts.map((prompt) => prompt.messageID)).toContain(`msg_wake_${child.id}_child-reply`)
    // No actor means no lease and no producer row, which is what this machine's
    // own prompts do on this same runtime.
    expect(calls.producers).toEqual([])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "delivered" }])
  })

  test("reserves itself as the stamped owner, registers under the operation the authority minted, and answers the reserved id", async () => {
    const { policy, calls } = managedPolicy()
    const item = fixture({ policy, identity: OWNER })
    item.seedParent("parent")

    const response = await item.create({ parentID: "parent", title: "Reviewer", role: "reviewer" })
    expect(response.status).toBe(201)
    const child = await response.json() as { id: string; parentID: string; subagentKey: string }
    expect(child.id).toMatch(/^ses_[0-9a-f-]{36}$/)
    expect(child.parentID).toBe("parent")
    expect(calls.reserved).toEqual([expect.objectContaining({
      operation: "session_create",
      sessionId: child.id,
      parentSessionId: "parent",
      sessionTitle: "Reviewer",
      credential: "Bearer owner-grant",
      actor: { actorId: "actor_owner", actorKind: "human" },
      authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" },
    })])
    expect(calls.registered).toEqual([{ sessionId: child.id, registrationOperationId: `session_registration_${child.id}`, actorId: "actor_owner" }])
    expect(item.calls.created).toEqual([child.id])
    expect(item.store.getSession(child.id)?.parentID).toBe("parent")
  })

  test("a retried clientRequestId reserves the derived id, so the retry finds the same child", async () => {
    const { policy, calls } = managedPolicy()
    const item = fixture({ policy, identity: OWNER })
    item.seedParent("parent")

    const first = await (await item.create({ parentID: "parent", clientRequestId: "req-1" })).json() as { id: string }
    expect(first.id).toMatch(/^ses_[0-9a-f]{32}$/)
    expect(calls.reserved.map((call) => call.sessionId)).toEqual([first.id])
    const retry = await item.create({ parentID: "parent", clientRequestId: "req-1" })
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { id: string }).id).toBe(first.id)
    expect(calls.reserved).toHaveLength(1)
    expect(item.calls.created).toEqual([first.id])
  })

  test("another member deriving the same child id from the shared parent is refused the child", async () => {
    const { policy, calls } = managedPolicy()
    const item = fixture({ policy, identity: OWNER })
    item.seedParent("parent")

    const first = await (await item.create({ parentID: "parent", clientRequestId: "req-1" })).json() as { id: string; subagentKey: string }
    const other = await item.create({ parentID: "parent", clientRequestId: "req-1", model: { providerID: "openai", modelID: "foreign-model" } }, { "x-test-actor": "actor_other" })

    expect(other.status).toBe(403)
    expect(await other.text()).not.toContain(first.subagentKey)
    expect(item.calls.models).toEqual([])
    expect(calls.reserved).toHaveLength(1)
    expect(item.calls.created).toEqual([first.id])
  })

  test("a child create that brings its own reservation is registered under it and reserves nothing", async () => {
    const { policy, calls } = managedPolicy({ held: { op_caller_1: "ses_reserved_by_caller" } })
    const item = fixture({ policy, identity: OWNER })
    item.seedParent("parent")

    const response = await item.create(
      { parentID: "parent", id: "ses_reserved_by_caller" },
      { "x-claxedo-session-registration-operation": "op_caller_1" },
    )
    expect(response.status).toBe(201)
    expect(calls.reserved).toEqual([])
    expect(calls.registered).toEqual([{ sessionId: "ses_reserved_by_caller", registrationOperationId: "op_caller_1", actorId: "actor_owner" }])
  })

  test("without a verified actor the create is refused before anything is reserved", async () => {
    const { policy, calls } = managedPolicy()
    const item = fixture({ policy })
    item.seedParent("parent")

    const response = await item.create({ parentID: "parent" })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "session_actor_required" } })
    expect(calls.reserved).toEqual([])
    expect(item.calls.created).toEqual([])
  })

  test("an ordinary create still needs the caller's own reservation, owner or not", async () => {
    const { policy, calls } = managedPolicy()
    const item = fixture({ policy, identity: OWNER })

    const response = await item.create({ title: "Root" })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_reservation_required" } })
    expect(calls.reserved).toEqual([])
    expect(item.calls.created).toEqual([])
  })

  test("a refused reservation is answered as the authority's own refusal and creates nothing", async () => {
    const { policy, calls } = managedPolicy({
      reserve: async () => ({ allowed: false, status: 403, code: "session_private", message: "The owner cannot open the parent" }),
    })
    const item = fixture({ policy, identity: OWNER })
    item.seedParent("parent")

    const response = await item.create({ parentID: "parent" })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "session_private", message: "The owner cannot open the parent" } })
    expect(calls.reserved).toHaveLength(1)
    expect(calls.registered).toEqual([])
    expect(item.calls.created).toEqual([])
  })

  test("a policy without a reservation member keeps requiring the caller's own", async () => {
    const { policy, calls } = managedPolicy()
    delete policy.reserveSession
    const item = fixture({ policy, identity: OWNER })
    item.seedParent("parent")

    const response = await item.create({ parentID: "parent" })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_reservation_required" } })
    expect(calls.registered).toEqual([])
    expect(item.calls.created).toEqual([])
  })
})


describe("permission mode changes retain session ceilings", () => {
  for (const child of [false, true]) {
    test(`${child ? "child" : "parentless"} session rejects widening after creation`, async () => {
      const item = fixture()
      item.seedParent("parent")
      const response = await item.create(child ? { parentID: "parent" } : { permissionCeiling: "ask" })
      expect(response.status).toBe(201)
      const session = await response.json() as { id: string }
      const change = (modeId: string) => item.app.request(`http://localhost/session/${session.id}/permission-mode?directory=${encodeURIComponent(DIRECTORY)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ modeId }),
      })
      const before = item.calls.modes.length
      const denied = await change("full-access")
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({ error: { code: "permission_ceiling_exceeded", ceiling: "ask" } })
      expect(item.calls.modes).toHaveLength(before)
      expect((await change("read-only")).status).toBe(200)
      expect(item.store.getSessionConfig(session.id)?.permissionCeiling).toBe("ask")
    })
  }
})


describe("prompt permission overrides respect child ceilings", () => {
  for (const endpoint of ["message", "prompt_async"]) {
    test(endpoint, async () => {
      const item = fixture()
      item.seedParent("parent")
      const child = await (await item.create({ parentID: "parent" })).json() as { id: string }
      const response = await item.app.request(`http://localhost/session/${child.id}/${endpoint}?directory=${encodeURIComponent(DIRECTORY)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionMode: "full-access", parts: [{ type: "text", text: "restricted turn" }] }),
      })
      expect(response.status).toBe(403)
      expect(item.calls.prompts).toEqual([])
      expect(item.calls.modes).toEqual([{ sessionId: child.id, modeId: "read-only" }])
    })
  }
})

/**
 * What a refused background turn must not have done. Both cases reach
 * `startHostTurn` through recovery, which is the path that runs with no
 * request behind it.
 */
describe("a background turn a managed host refuses", () => {
  function wakeOnlyHost(input: {
    origin?: SessionTurnOrigin
    runtime?: unknown
    failResolution?: "adapter" | "runtime"
    requireActor?: boolean
    /** Holds the offer inside its origin read, where disposal would land. */
    beforeOrigin?: () => Promise<void>
    beforeAcquire?: () => Promise<void>
  }) {
    const store = new MemoryRuntimeStore()
    store.bindSession({ sessionId: "parent", directory: DIRECTORY, agentSessionId: "parent" })
    for (const [observationId, observation] of [
      ["create", { status: "pending", providerKind: "claxedo", providerId: "child", childSessionId: "child", transcript: { kind: "live" } }],
      ["finished", { status: "completed", wake: "pending" }],
    ] as const) {
      store.admit({ parentSessionId: "parent", observation: { observationId, subagentKey: "subagent_wake", ...observation }, allocateKey: () => "unused" })
      store.markPublished("parent", observationId)
    }
    const { policy, calls } = managedPolicy({ turnAllowed: () => true, ...(input.requireActor === false ? { requireActor: false } : {}) })
    const resolved = { adapters: 0, runtimes: 0 }
    const released: boolean[] = []
    const host = SessionRoutes(
      () => {
        resolved.adapters += 1
        if (input.failResolution === "adapter") throw new Error("adapter setup failed")
        return {} as never
      },
      {
        sessionAccessPolicy: {
          ...policy,
          acquireTurn: async (turn) => {
            await input.beforeAcquire?.()
            return policy.acquireTurn!(turn)
          },
          releaseTurn: async (turn) => {
            released.push(true)
            return policy.releaseTurn!(turn)
          },
        },
        resolveRuntime: () => {
          resolved.runtimes += 1
          if (input.failResolution === "runtime") throw new Error("runtime setup failed")
          return input.runtime as never
        },
        listSubagents: ({ parentSessionId }) => store.listSubagents(parentSessionId),
        getSession: ({ sessionId }) => (sessionId === "parent" ? store.getSession("parent") : { id: "child", parentID: "parent", directory: DIRECTORY, time: { created: 1, updated: 1 } }),
        getMessages: () => [{ info: { id: "child-reply", role: "assistant" as const, sessionID: "child" }, parts: [] }],
        childSessions: {
          admission: { admit: (row) => store.admit(row), markPublished: (parent, id) => store.markPublished(parent, id) },
          secret: () => "wake-only-secret",
          pendingWakes: () => [{ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY }],
          origins: {
            record: () => {},
            read: async () => {
              await input.beforeOrigin?.()
              return input.origin
            },
          },
        },
      },
    )
    return { host, store, calls, resolved, released }
  }

  test("disposal stops wake admission and waits for the offer already choosing one", async () => {
    // The teardown shape: a child settles as the workspace begins closing. The
    // offer is mid-read when dispose starts, and must neither reach the
    // provider after that nor still be running when dispose returns.
    let releaseRead = () => {}
    const reading = new Promise<void>((resolve) => { releaseRead = resolve })
    const item = wakeOnlyHost({
      origin: { provenance: "loopback-direct" },
      runtime: { turns: {} },
      requireActor: false,
      beforeOrigin: () => reading,
    })

    const offered = item.host.routes.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const disposed = item.host.dispose()
    releaseRead()
    await Promise.all([offered, disposed])

    expect(item.resolved).toEqual({ adapters: 0, runtimes: 0 })
    expect(item.calls.producers).toEqual([])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
  })

  test("a wake offered after disposal is refused before it asks for a provider", async () => {
    const item = wakeOnlyHost({ origin: { provenance: "loopback-direct" }, runtime: { turns: {} }, requireActor: false })
    await item.host.dispose()

    await item.host.routes.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(item.resolved).toEqual({ adapters: 0, runtimes: 0 })
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
  })

  test("a lease arriving during disposal is released before provider acquisition", async () => {
    let entered!: () => void, release!: () => void
    const acquiring = new Promise<void>(resolve => { entered = resolve })
    const waiting = new Promise<void>(resolve => { release = resolve })
    const item = wakeOnlyHost({
      origin: {
        provenance: "relay-replayed",
        actor: { actorId: "owner", actorKind: "human" },
        authority: { managed: true, workspaceId: "workspace", orgId: "org", role: "editor" },
      },
      beforeAcquire: async () => { entered(); await waiting },
    })
    const offered = item.host.routes.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`)
    await acquiring
    let finished = false
    const closing = item.host.dispose().then(() => { finished = true })
    expect(finished).toBe(false)
    release()
    await Promise.all([offered, closing])
    expect(item.resolved).toEqual({ adapters: 0, runtimes: 0 })
    expect(item.calls.producers).toHaveLength(1)
    expect(item.released).toEqual([true])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
  })

  test("a wake with no identity resolves no adapter and no runtime, so nothing is created for a turn that will not run", async () => {
    const item = wakeOnlyHost({ runtime: { turns: {} } })

    await item.host.routes.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(item.resolved).toEqual({ adapters: 0, runtimes: 0 })
    expect(item.calls.producers).toEqual([])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
    await item.host.dispose()
  })

  test("a loopback origin is asked again at wake, and a host that requires verified actors refuses it", async () => {
    // The row remembers a machine-user admission. That is not a standing
    // permission: the policy in front of the runtime now is what decides, and
    // one that admits only verified actors has nobody to attribute this to.
    const strict = wakeOnlyHost({ origin: { provenance: "loopback-direct" }, runtime: { turns: {} } })

    await strict.host.routes.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(strict.calls.producers).toEqual([])
    expect(strict.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
    await strict.host.dispose()

    // The same row on the daemon shape it was recorded under is admitted.
    const daemon = wakeOnlyHost({ origin: { provenance: "loopback-direct" }, runtime: { turns: {} }, requireActor: false })
    await daemon.host.routes.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(daemon.resolved.runtimes).toBeGreaterThan(0)
    expect(daemon.calls.producers).toEqual([])
    await daemon.host.dispose()
  })

  test("an identified wake on a host with no runtime releases its lease instead of running unfenced", async () => {
    const item = wakeOnlyHost({
      origin: { provenance: "relay-replayed", actor: { actorId: "actor_owner", actorKind: "human" }, authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" } },
      runtime: undefined,
    })

    await item.host.routes.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The authority admitted the turn, so the fence exists; with nothing to
    // fence it is handed back rather than left open behind an adapter-only run.
    expect(item.calls.producers).toMatchObject([{ sessionId: "parent" }])
    expect(item.released).toEqual([true])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
    await item.host.dispose()
  })

  test("provider setup failure returns the acquired wake lease to the authority", async () => {
    for (const failResolution of ["adapter", "runtime"] as const) {
      const item = wakeOnlyHost({
        origin: { provenance: "relay-replayed", actor: { actorId: "actor_owner", actorKind: "human" }, authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" } },
        failResolution,
      })
      try {
        await item.host.routes.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(item.calls.producers).toHaveLength(1)
        expect(item.released).toEqual([true])
        expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
      } finally {
        await item.host.dispose()
      }
    }
  })
})
