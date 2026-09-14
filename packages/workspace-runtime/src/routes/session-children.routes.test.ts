import { describe, expect, test } from "bun:test"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"
import type { AgentMessage, AgentPermissionMode, AgentPermissionModeState, AgentSession, SessionConfig } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { MemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { buildSession } from "../compat-events"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../runtime-event-hub"
import { SessionRoutes } from "./session"

const DIRECTORY = process.cwd()
const MODES: readonly AgentPermissionMode[] = [
  { id: "read-only", name: "Read only", level: "ask" },
  { id: "workspace-write", name: "Workspace write", level: "auto" },
  { id: "untrusted", name: "Untrusted" },
  { id: "full-access", name: "Full access", level: "full" },
]

const NO_MODE_SURFACE: AgentPermissionModeState = { modes: [], unsupported: "codex exposes no permission modes", appliesFrom: "next-turn" }

function fixture(input: { parentMode?: string } = {}) {
  const store = new MemoryRuntimeStore()
  const calls = {
    created: [] as string[],
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
  const adapter: AgentHarnessAdapter = {
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
    abort: async (binding) => {
      calls.aborted.push(binding.sessionId)
      return { ok: true, status: "cancelled" }
    },
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
  const { routes: app } = SessionRoutes(() => adapter, {
    eventHub,
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
    },
  })
  const seedParent = (id: string, session: Partial<AgentSession> = {}) => {
    store.bindSession({ sessionId: id, directory: DIRECTORY, agentSessionId: id, title: "Parent", ...(session.parentID ? { parentSessionId: session.parentID } : {}) })
    store.updateSessionConfig(id, config)
  }
  const create = (body: Record<string, unknown>) => app.request(`http://localhost/session?directory=${encodeURIComponent(DIRECTORY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { app, store, calls, runtimeEvents, seedParent, create, messages, adapter }
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

  test("archiving or deleting the parent cascades to its children on their own adapter", async () => {
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
