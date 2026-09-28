import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { assistantMessageIdForTurn } from "@claxedo/agent-runtime-contract"
import type { AgentPermissionMode, AgentPermissionModeState, SessionHarness } from "@claxedo/agent-runtime-contract"
import type { AgentSession } from "@claxedo/agent-sdk-runtime"
import type { ConfigOperations } from "@claxedo/harness/contract"
import type { AgentRuntime } from "../host/runtime"
import type { RuntimeEventEnvelope } from "../projection/runtime-event-hub"
import {
  managedWorkspaceSessionAccessPolicy,
  type SessionAccessPolicy,
  type SessionAccessPolicyInput,
  type SessionReservationDecision,
  type SessionTurnGrantDecision,
  type SessionTurnOrigin,
} from "../session-access-policy"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, type HostFixture } from "../test-support/host-fixture"
import type { EmbeddedRelayHostIdentity } from "../workspace-host-service-auth"
import { SessionRoutes } from "./session"

const DIRECTORY = process.cwd()
const CODEX: SessionHarness = { id: "codex", access: "native" }
const MODES: readonly AgentPermissionMode[] = [
  { id: "read-only", name: "Read only", level: "ask" },
  { id: "workspace-write", name: "Workspace write", level: "auto" },
  { id: "untrusted", name: "Untrusted" },
  { id: "full-access", name: "Full access", level: "full" },
]

const NO_MODE_SURFACE: AgentPermissionModeState = { modes: [], unsupported: "codex exposes no permission modes", appliesFrom: "next-turn" }

const hosts: HostFixture[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const host of hosts.splice(0)) await host.dispose()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

type ModeSurface = {
  draft: () => Promise<AgentPermissionModeState>
  session: (sessionId: string) => Promise<AgentPermissionModeState>
}

/**
 * The permission-mode surface of the scripted harness. `none` composes a
 * transport with no config operations at all, the shape of a harness that
 * cannot be told about modes.
 */
function modeOperations(surface: ModeSurface, calls: { modes: Array<{ sessionId: string; modeId: string }> }): ConfigOperations {
  return {
    read: async () => { throw new Error("the fixture's config is runtime-owned") },
    update: async () => { throw new Error("the fixture's config is runtime-owned") },
    options: async () => ({ options: [] }),
    permissionModes: (target) => "draft" in target ? surface.draft() : surface.session(target.session.binding.sessionId),
    setPermissionMode: async (session, modeId) => {
      calls.modes.push({ sessionId: session.binding.sessionId, modeId })
      return { modes: [...MODES], currentModeId: modeId, appliesFrom: "next-turn" }
    },
  }
}

/**
 * A real runtime host over one scripted Codex harness, with the session
 * routes composed over it the way the workspace host composes them: the
 * store's sessions, messages and subagent rows, and the runtime's subagent
 * admission for host-owned children.
 */
function fixture(input: {
  parentMode?: string
  policy?: SessionAccessPolicy
  identity?: EmbeddedRelayHostIdentity
  modes?: "none"
} = {}) {
  const origins = new Map<string, SessionTurnOrigin>()
  const seeded = new Set<string>()
  const calls = {
    created: [] as string[],
    projected: [] as unknown[],
    modes: [] as Array<{ sessionId: string; modeId: string }>,
    aborted: [] as string[],
    deleted: [] as string[],
    prompts: [] as Array<{ sessionId: string; messageID?: string; text: string; author?: unknown }>,
  }
  const surface: ModeSurface = {
    draft: async () => ({ modes: [...MODES], appliesFrom: "next-turn" }),
    session: async () => ({ modes: [...MODES], currentModeId: input.parentMode ?? "read-only", appliesFrom: "next-turn" }),
  }
  const replies = new Map<string, string>()
  const held = new Map<string, () => void>()
  const holding = new Set<string>()
  const transport = new FakeTransport({
    kind: "codex-app-server",
    onStart: (start) => { if (!seeded.has(start.sessionId)) calls.created.push(start.sessionId) },
    onClose: (session) => { calls.deleted.push(session.binding.sessionId) },
    ...(input.modes === "none" ? {} : { config: modeOperations(surface, calls) }),
    turn: async function* ({ session, turn }) {
      const sessionId = session.binding.sessionId
      calls.prompts.push({
        sessionId,
        messageID: turn.prompt.userMessageId,
        text: turn.prompt.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
        ...(turn.prompt.author ? { author: turn.prompt.author } : {}),
      })
      if (holding.has(sessionId)) await new Promise<void>((resolve) => { held.set(sessionId, resolve) })
      const reply = replies.get(sessionId)
      if (reply) yield { type: "text-delta", delta: reply }
      yield { type: "finish", sessionId }
    },
    cancel: async ({ session }) => {
      calls.aborted.push(session.binding.sessionId)
      held.get(session.binding.sessionId)?.()
      return { execution: "terminal", cleanup: "verified_clear" }
    },
  })
  const host = createHostFixture({ transports: { codex: transport }, workspaceId: "workspace-test" })
  hosts.push(host)
  const { store, runtime } = host
  const runtimeEvents: RuntimeEventEnvelope[] = []
  host.eventHub.subscribeRuntime((event) => { runtimeEvents.push(event) })
  const routes = SessionRoutes(async () => runtime, {
    eventHub: host.eventHub,
    ...(input.policy ? { sessionAccessPolicy: input.policy } : {}),
    requestedSessionHarness: (requested) => requested ?? CODEX,
    resolveRecoveryOwner: () => runtime.recovery,
    resolveWorkspaceId: () => "workspace-test",
    afterCreateSession: ({ session }) => { calls.projected.push(session) },
    listSessions: async (_c, directory) => store.listSessions(directory),
    getSession: ({ sessionId }) => store.getSession(sessionId) ?? null,
    getMessages: ({ sessionId }) => store.getMessages(sessionId),
    listSubagents: ({ parentSessionId }) => store.listSubagents(parentSessionId),
    afterUpdateSession: ({ sessionId, updates }) => { store.updateSession(sessionId, updates) },
    childSessions: {
      admit: (parentSessionId, observation) => runtime.subagents.admit(parentSessionId, observation),
      secret: () => "route-test-secret",
      pendingWakes: () => store.listPendingSubagentWakes(),
      origins: {
        record: (parent, key, origin) => {
          if (!origins.has(`${parent}\0${key}`)) origins.set(`${parent}\0${key}`, origin)
        },
        read: (parent, key) => origins.get(`${parent}\0${key}`),
      },
    },
  })
  cleanups.push(() => routes.dispose())
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
  app.route("/", routes.routes)
  const seedParent = async (id: string) => {
    seeded.add(id)
    await runtime.sessions.create({ ...sessionCreate({ id, workspaceId: "workspace-test", directory: DIRECTORY, harness: CODEX }), title: "Parent" })
  }
  const create = (body: Record<string, unknown>, headers: Record<string, string> = {}) => app.request(`http://localhost/session?directory=${encodeURIComponent(DIRECTORY)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer owner-grant", ...headers },
    body: JSON.stringify(body),
  })
  const prompt = (sessionId: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request(`http://localhost/session/${sessionId}/message?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  const hold = (sessionId: string) => { holding.add(sessionId) }
  return { app, store, runtime, origins, calls, runtimeEvents, seedParent, create, prompt, replies, surface, hold }
}

/** The id the parent's completion wake carries: the child's turn's assistant message names it. */
const wakeTurnFor = (childId: string, childTurn: string) => `msg_wake_${childId}_${assistantMessageIdForTurn(childTurn)}`

describe("POST /session with parentID", () => {
  test("publishes the persisted child relationship to the control-plane projection", async () => {
    const item = fixture()
    await item.seedParent("parent")
    const response = await item.create({ parentID: "parent", title: "Child" })
    expect(response.status).toBe(201)
    expect(item.calls.projected).toEqual([expect.objectContaining({ parentID: "parent", title: "Child", time: expect.any(Object) })])
  })

  test("a child starts under the variant, instructions and group its create named", async () => {
    const item = fixture()
    await item.seedParent("parent")
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
    await item.seedParent("parent")
    const response = await item.create({ parentID: "parent", group: { archivist: {} } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_group_invalid" } })
    expect(item.calls.created).toEqual([])
  })

  test("refuses a ceiling when the target cannot enforce permission modes", async () => {
    const item = fixture()
    await item.seedParent("parent")
    item.surface.draft = async () => NO_MODE_SURFACE
    const response = await item.create({ parentID: "parent" })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "permission_ceiling_unsupported" } })
    expect(item.calls.created).toEqual([])
  })

  for (const surface of ["no permission-mode operations at all", "a state that says it has no mode surface"] as const) {
    test(`a parent whose harness reports ${surface} restricts its child to nothing`, async () => {
      const item = surface === "no permission-mode operations at all" ? fixture({ modes: "none" }) : fixture()
      if (surface === "a state that says it has no mode surface") item.surface.session = async () => NO_MODE_SURFACE
      await item.seedParent("parent")

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
    await item.seedParent("parent")
    const sessionModes = item.surface.session
    item.surface.session = async (sessionId) => sessionId === "parent" ? NO_MODE_SURFACE : await sessionModes(sessionId)

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
    await item.seedParent("parent")
    item.surface.draft = async () => ({ modes: [MODES[3]], appliesFrom: "next-turn" })
    const response = await item.create({ parentID: "parent" })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "permission_ceiling_unsupported" } })
    expect(item.calls.created).toEqual([])
  })

  test("creates a host-owned child under the parent, admits it pending, and keeps it out of the root list", async () => {
    const item = fixture()
    await item.seedParent("parent")

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
    expect(item.runtimeEvents.filter((event) => event.payload.type === "subagent-updated"))
      .toMatchObject([{ sessionId: "parent", payload: { type: "subagent-updated", subagentKey: created.subagentKey, status: "pending" } }])

    for (const route of ["/session", "/experimental/session"]) {
      const roots = await (await item.app.request(`http://localhost${route}?directory=${encodeURIComponent(DIRECTORY)}&roots=true`)).json() as Array<{ id: string }>
      expect(roots.map((row) => row.id), route).toEqual(["parent"])
      const all = await (await item.app.request(`http://localhost${route}?directory=${encodeURIComponent(DIRECTORY)}`)).json() as Array<{ id: string }>
      expect(all.map((row) => row.id).sort(), route).toEqual(["parent", created.id].sort())
    }
  })

  test("refuses a child of a child and a fifth active child", async () => {
    const item = fixture()
    await item.seedParent("parent")
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
    await item.seedParent("parent")
    const first = await (await item.create({ parentID: "parent", clientRequestId: "req-1" })).json() as { id: string; subagentKey: string }
    const retry = await item.create({ parentID: "parent", clientRequestId: "req-1" })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ id: first.id, parentID: "parent", subagentKey: first.subagentKey })
    expect(item.calls.created).toEqual([first.id])
    expect(first.id).toMatch(/^ses_[0-9a-f]{32}$/)

    await item.seedParent("other")
    const foreign = await item.create({ parentID: "other", clientRequestId: "req-1" })
    expect(foreign.status).toBe(201)
    expect(((await foreign.json()) as { id: string }).id).not.toBe(first.id)
  })

  test("a retry still returns its child when all four child slots are occupied", async () => {
    const item = fixture()
    await item.seedParent("parent")
    const first = await (await item.create({ parentID: "parent", clientRequestId: "retry-at-cap" })).json() as { id: string }
    for (let i = 0; i < 3; i++) expect((await item.create({ parentID: "parent" })).status).toBe(201)
    const retry = await item.create({ parentID: "parent", clientRequestId: "retry-at-cap" })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ id: first.id })
    expect(item.calls.created).toHaveLength(4)
  })

  test("concurrent creates respect the four-child cap and deduplicate retries", async () => {
    const item = fixture()
    await item.seedParent("parent")
    const retries = await Promise.all(Array.from({ length: 3 }, () => item.create({ parentID: "parent", clientRequestId: "same" })))
    expect(retries.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 200, 201])
    expect(item.calls.created).toHaveLength(1)
    const creates = await Promise.all(Array.from({ length: 5 }, () => item.create({ parentID: "parent" })))
    expect(creates.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 201, 201, 409, 409])
    expect(item.calls.created).toHaveLength(4)
  })

  test("a child may equal or narrow the parent's permission mode, never widen it", async () => {
    const item = fixture({ parentMode: "read-only" })
    await item.seedParent("parent")

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
    await item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent" })).json() as { id: string }
    item.hold(child.id)
    await item.runtime.turns.start({ sessionId: child.id, parts: [{ type: "text", text: "work" }], origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false } })
    for (let attempt = 0; attempt < 200 && item.calls.prompts.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))

    const archived = await item.app.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: { archived: 42 } }),
    })
    expect(archived.status).toBe(200)
    expect(item.calls.aborted).toEqual([child.id])
    expect(item.store.getSession("parent")?.time?.archived).toBe(42)
    expect(item.store.getSession(child.id)?.time?.archived).toBe(42)

    const deleted = await item.app.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`, { method: "DELETE" })
    expect(deleted.status).toBe(200)
    expect(item.calls.deleted).toEqual([child.id, "parent"])
    expect(item.store.getSession(child.id)).toBeFalsy()
  })

  test("archiving a session cancels its own running turn before the archive lands", async () => {
    const item = fixture()
    await item.seedParent("parent")
    item.hold("parent")
    await item.runtime.turns.start({ sessionId: "parent", parts: [{ type: "text", text: "work" }], origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false } })
    for (let attempt = 0; attempt < 200 && item.calls.prompts.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))

    const archived = await item.app.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: { archived: 42 } }),
    })
    expect(archived.status).toBe(200)
    expect(item.calls.aborted).toEqual(["parent"])
    await item.runtime.turns.whenIdle("parent")
    expect(item.store.getSession("parent")).toMatchObject({ status: "idle", time: { archived: 42 } })
  })

  test("a child's finished turn wakes the idle parent through the prompt path with the child's summary", async () => {
    const item = fixture()
    await item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent", title: "Consult" })).json() as { id: string; subagentKey: string }
    item.replies.set(child.id, "Ship it.")

    expect((await item.prompt(child.id, { messageID: "child-turn", parts: [{ type: "text", text: "Review the plan" }] })).status).toBe(200)
    await settle()

    expect(item.calls.prompts).toMatchObject([
      { sessionId: child.id, messageID: "child-turn", text: "Review the plan" },
      {
        sessionId: "parent",
        messageID: wakeTurnFor(child.id, "child-turn"),
        text: 'Subagent "Consult" (codex) completed.\n\nShip it.',
      },
    ])
    expect(item.store.listSubagents("parent")).toMatchObject([{ subagentKey: child.subagentKey, status: "completed", wake: "delivered" }])
    expect(item.runtimeEvents.map((event) => event.payload).flatMap((payload) => payload.type === "subagent-updated" ? [payload.status ?? payload.wake] : []))
      .toEqual(["pending", "running", "completed", "delivered"])
  })

  test("a parent that does not exist is a 404 and a missing host is a 501", async () => {
    const item = fixture()
    const missing = await item.create({ parentID: "ghost" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "parent_session_not_found" } })

    const bare = SessionRoutes(async () => item.runtime, { requestedSessionHarness: (requested) => requested ?? CODEX })
    cleanups.push(() => bare.dispose())
    const unsupported = await bare.routes.request(`http://localhost/session?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentID: "parent" }),
    })
    expect(unsupported.status).toBe(501)
    expect(await unsupported.json()).toMatchObject({ error: { code: "child_sessions_unsupported" } })
  })
})

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
  /** A plane that mints deferred turn grants; absent means the policy has no `grantTurn` at all. */
  grant?: (input: Parameters<NonNullable<SessionAccessPolicy["grantTurn"]>>[0]) => SessionTurnGrantDecision
} = {}) {
  const held = new Map(Object.entries(input.held ?? {}))
  /** Who the plane recorded as the creator; a session it never registered is nobody's. */
  const creators = new Map<string, string>()
  const calls = {
    reserved: [] as Array<SessionAccessPolicyInput & { sessionId: string; parentSessionId: string }>,
    registered: [] as Array<{ sessionId: string; registrationOperationId: string; actorId?: string }>,
    /** Stands for the plane's producer row: one per admitted turn, carrying who it was admitted for. */
    producers: [] as Array<{ sessionId: string; turnId: string; actorId: string; fencingToken: number }>,
    granted: [] as Array<Parameters<NonNullable<SessionAccessPolicy["grantTurn"]>>[0]>,
    acquired: [] as Array<Parameters<NonNullable<SessionAccessPolicy["acquireTurn"]>>[0]>,
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
        calls.acquired.push(request)
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
  const grant = input.grant
  if (grant) {
    policy.grantTurn = (request) => {
      calls.granted.push(request)
      return grant(request)
    }
  }
  return { policy, calls }
}

const CHILD_GRANT = "eyJ.child-completion-grant.sig"
describe("a child created in-process under managed registration", () => {
  test("a readable parent cannot create a completion wake without current turn authority", async () => {
    let writable = false
    const { policy, calls } = managedPolicy({ parentWriteAllowed: () => writable })
    const item = fixture({ policy, identity: OWNER })
    await item.seedParent("parent")

    expect((await item.create({ parentID: "parent", title: "Reader's child" })).status).toBe(403)
    expect(calls.reserved).toEqual([])
    expect(calls.registered).toEqual([])
    expect(item.calls.created).toEqual([])

    writable = true
    expect((await item.create({ parentID: "parent", title: "Writer's child" })).status).toBe(201)
    expect(item.calls.created).toHaveLength(1)
  })

  test("a completion wake runs as the actor that created the child and is admitted as that actor's turn", async () => {
    const { policy, calls } = managedPolicy({ turnAllowed: () => true })
    const item = fixture({ policy, identity: OWNER })
    await item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent", title: "Consult" })).json() as { id: string; subagentKey: string }
    expect(item.origins.get(`parent\0${child.subagentKey}`)).toEqual({
      provenance: "relay-replayed",
      actor: { actorId: "actor_owner", actorKind: "human" },
      authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" },
    })
    item.replies.set(child.id, "Ship it.")

    expect((await item.prompt(child.id, { messageID: "child-turn", parts: [{ type: "text", text: "Review the plan" }] }, { authorization: "Bearer owner-grant" })).status).toBe(200)
    await settle()

    const wakeTurnId = wakeTurnFor(child.id, "child-turn")
    expect(item.calls.prompts.map((prompt) => prompt.messageID)).toContain(wakeTurnId)
    const producer = calls.producers.find((entry) => entry.turnId === wakeTurnId)
    expect(producer).toMatchObject({ sessionId: "parent", actorId: "actor_owner" })
    // The turn runs behind the fence it was admitted under, not merely after it.
    expect(item.store.getSessionFencingToken("parent")).toBe(producer!.fencingToken)
    expect(item.store.listSubagents("parent")).toMatchObject([{ subagentKey: child.subagentKey, wake: "delivered" }])
  })

  test("a child row with no recorded origin gets no wake: nothing names who it would run as", async () => {
    const { policy, calls } = managedPolicy({ turnAllowed: () => true })
    const item = fixture({ policy, identity: OWNER })
    await item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent", title: "Consult" })).json() as { id: string; subagentKey: string }
    item.replies.set(child.id, "Ship it.")
    item.origins.clear()

    expect((await item.prompt(child.id, { messageID: "child-turn", parts: [{ type: "text", text: "Review the plan" }] }, { authorization: "Bearer owner-grant" })).status).toBe(200)
    await settle()

    expect(item.calls.prompts.map((prompt) => prompt.sessionId)).toEqual([child.id])
    expect(calls.producers.map((producer) => producer.sessionId)).toEqual([child.id])
    expect(item.store.listSubagents("parent")).toMatchObject([{ subagentKey: child.subagentKey, status: "completed", wake: "pending" }])
  })

  test("a relayed create on a plane that mints grants takes a child-completion grant with the live credential, before the child has a row", async () => {
    let subagentsAtMint: unknown[] | undefined
    const { policy, calls } = managedPolicy({
      turnAllowed: () => true,
      grant: () => {
        subagentsAtMint = item.store.listSubagents("parent")
        return { allowed: true, grant: CHILD_GRANT, expiresAt: Date.now() + 60_000 }
      },
    })
    const item = fixture({ policy, identity: OWNER })
    await item.seedParent("parent")

    const child = await (await item.create({ parentID: "parent", title: "Consult" })).json() as { id: string; subagentKey: string }
    expect(calls.granted).toEqual([expect.objectContaining({
      operation: "prompt",
      sessionId: "parent",
      intent: "child_completion",
      subjectSessionId: child.id,
      registrationOperationId: `session_registration_${child.id}`,
      credential: "Bearer owner-grant",
      actor: { actorId: "actor_owner", actorKind: "human" },
      authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" },
    })])
    expect(subagentsAtMint).toEqual([])
    expect(item.origins.get(`parent\0${child.subagentKey}`)).toEqual({
      provenance: "relay-replayed",
      actor: { actorId: "actor_owner", actorKind: "human" },
      authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" },
      grant: CHILD_GRANT,
    })
    expect(JSON.stringify(item.store.listSubagents("parent"))).not.toContain(CHILD_GRANT)

    item.replies.set(child.id, "Ship it.")
    expect((await item.prompt(child.id, { messageID: "child-turn", parts: [{ type: "text", text: "Review the plan" }] }, { authorization: "Bearer owner-grant" })).status).toBe(200)
    await settle()

    const wakeTurnId = wakeTurnFor(child.id, "child-turn")
    const wake = calls.acquired.find((turn) => turn.turnId === wakeTurnId)
    expect(wake).toMatchObject({ sessionId: "parent", grant: CHILD_GRANT, actor: { actorId: "actor_owner", actorKind: "human" } })
    expect(wake).not.toHaveProperty("credential")
    expect(calls.acquired.find((turn) => turn.turnId === "child-turn")).not.toHaveProperty("grant")
    expect(calls.granted).toHaveLength(1)
    expect(item.store.listSubagents("parent")).toMatchObject([{ subagentKey: child.subagentKey, wake: "delivered" }])
  })

  test("a refused or failed grant answers 503 and rolls the child back, leaving no session and no subagent row", async () => {
    const refusals: Array<() => SessionTurnGrantDecision> = [
      () => ({ allowed: false, status: 403, code: "session_private", message: "The parent no longer admits this actor's turn" }),
      () => { throw new Error("grant signer unavailable") },
    ]
    for (const grant of refusals) {
      const { policy, calls } = managedPolicy({ turnAllowed: () => true, grant })
      const item = fixture({ policy, identity: OWNER })
      await item.seedParent("parent")

      const response = await item.create({ parentID: "parent", title: "Consult" })
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: { code: "child_wake_grant_refused" } })
      expect(calls.granted).toHaveLength(1)
      const childId = item.calls.created[0]
      expect(childId).toBeDefined()
      expect(item.calls.deleted).toEqual([childId])
      expect(item.store.getSession(childId)).toBeFalsy()
      expect(item.store.listSubagents("parent")).toEqual([])
      expect(item.origins.size).toBe(0)
      expect(calls.registered).toEqual([])
      expect(calls.producers).toEqual([])
    }
  })

  test("the machine's own user creates a child over loopback and its wake runs as that, unleased", async () => {
    // The daemon shape: managed composition, `requireActor` off, and a request
    // the relay never stamped. The same runtime answers both arms, so the row
    // has to remember which one asked rather than what the host was built as.
    const { policy, calls } = managedPolicy({
      turnAllowed: () => true,
      requireActor: false,
      grant: () => { throw new Error("a loopback create has no actor to mint for") },
    })
    const item = fixture({ policy })
    await item.seedParent("parent")
    const child = await (await item.create({ parentID: "parent", title: "Consult" })).json() as { id: string; subagentKey: string }
    expect(item.origins.get(`parent\0${child.subagentKey}`)).toEqual({ provenance: "loopback-direct" })
    expect(calls.granted).toEqual([])
    item.replies.set(child.id, "Ship it.")

    expect((await item.prompt(child.id, { messageID: "child-turn", parts: [{ type: "text", text: "Review the plan" }] })).status).toBe(200)
    await settle()

    expect(item.calls.prompts.map((prompt) => prompt.messageID)).toContain(wakeTurnFor(child.id, "child-turn"))
    // No actor means no lease and no producer row, which is what this machine's
    // own prompts do on this same runtime.
    expect(calls.producers).toEqual([])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "delivered" }])
  })

  test("reserves itself as the stamped owner, registers under the operation the authority minted, and answers the reserved id", async () => {
    const { policy, calls } = managedPolicy()
    const item = fixture({ policy, identity: OWNER })
    await item.seedParent("parent")

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
    await item.seedParent("parent")

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
    await item.seedParent("parent")

    const first = await (await item.create({ parentID: "parent", clientRequestId: "req-1" })).json() as { id: string; subagentKey: string }
    const other = await item.create({ parentID: "parent", clientRequestId: "req-1", model: { providerID: "openai", modelID: "foreign-model" } }, { "x-test-actor": "actor_other" })

    expect(other.status).toBe(403)
    expect(await other.text()).not.toContain(first.subagentKey)
    expect(item.store.getSessionConfig(first.id)?.model).toBeUndefined()
    expect(calls.reserved).toHaveLength(1)
    expect(item.calls.created).toEqual([first.id])
  })

  test("a child create that brings its own reservation is registered under it and reserves nothing", async () => {
    const { policy, calls } = managedPolicy({ held: { op_caller_1: "ses_reserved_by_caller" } })
    const item = fixture({ policy, identity: OWNER })
    await item.seedParent("parent")

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
    await item.seedParent("parent")

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
    await item.seedParent("parent")

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
    await item.seedParent("parent")

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
      await item.seedParent("parent")
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
      await item.seedParent("parent")
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
 * What a refused background turn must not have done. Every case reaches
 * `startHostTurn` through recovery, which is the path that runs with no
 * request behind it.
 */
describe("a background turn a managed host refuses", () => {
  async function wakeOnlyHost(input: {
    origin?: SessionTurnOrigin
    failResolution?: boolean
    requireActor?: boolean
    /** A policy that mints deferred grants, so a relayed wake is expected to carry one. */
    grantCapable?: boolean
    /** Holds the offer inside its origin read, where disposal would land. */
    beforeOrigin?: () => Promise<void>
    beforeAcquire?: () => Promise<void>
  }) {
    const transport = new FakeTransport({ kind: "codex-app-server" })
    const fixtureHost = createHostFixture({ transports: { codex: transport }, workspaceId: "workspace-test" })
    hosts.push(fixtureHost)
    const { store, runtime } = fixtureHost
    await runtime.sessions.create(sessionCreate({ id: "parent", workspaceId: "workspace-test", directory: DIRECTORY, harness: CODEX }))
    await runtime.subagents.admit("parent", {
      observationId: "create", subagentKey: "subagent_wake", status: "pending", providerKind: "claxedo",
      providerId: "child", childSessionId: "child", transcript: { kind: "live" },
    })
    await runtime.subagents.admit("parent", { observationId: "finished", subagentKey: "subagent_wake", status: "completed", wake: "pending" })
    const { policy, calls } = managedPolicy({
      turnAllowed: () => true,
      ...(input.requireActor === false ? { requireActor: false } : {}),
      ...(input.grantCapable ? { grant: () => { throw new Error("a wake redeems a grant; it never mints one") } } : {}),
    })
    const resolved = { runtimes: 0 }
    const released: boolean[] = []
    const child = { id: "child", parentID: "parent", directory: DIRECTORY, time: { created: 1, updated: 1 } } as AgentSession
    const host = SessionRoutes(
      async (): Promise<AgentRuntime> => {
        resolved.runtimes += 1
        if (input.failResolution) throw new Error("runtime setup failed")
        return runtime
      },
      {
        eventHub: fixtureHost.eventHub,
        requestedSessionHarness: (requested) => requested ?? CODEX,
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
        listSubagents: ({ parentSessionId }) => store.listSubagents(parentSessionId),
        getSession: ({ sessionId }) => (sessionId === "parent" ? store.getSession("parent") ?? null : child),
        getMessages: ({ sessionId }) => sessionId === "child"
          ? [{ info: { id: "child-reply", role: "assistant" as const, sessionID: "child" }, parts: [] }] as never
          : store.getMessages(sessionId),
        childSessions: {
          admit: (parentSessionId, observation) => runtime.subagents.admit(parentSessionId, observation),
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
    return { host, store, calls, resolved, released, transport }
  }

  const offer = (host: { routes: { request: Hono["request"] } }) =>
    host.routes.request(`http://localhost/session/parent?directory=${encodeURIComponent(DIRECTORY)}`)

  test("disposal stops wake admission and waits for the offer already choosing one", async () => {
    // The teardown shape: a child settles as the workspace begins closing. The
    // offer is mid-read when dispose starts, and must neither reach the
    // provider after that nor still be running when dispose returns.
    let releaseRead = () => {}
    const reading = new Promise<void>((resolve) => { releaseRead = resolve })
    const item = await wakeOnlyHost({ origin: { provenance: "loopback-direct" }, requireActor: false, beforeOrigin: () => reading })

    const offered = offer(item.host)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const disposed = item.host.dispose()
    releaseRead()
    await Promise.all([offered, disposed])

    expect(item.resolved).toEqual({ runtimes: 0 })
    expect(item.calls.producers).toEqual([])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
  })

  test("a wake offered after disposal is refused before it asks for a provider", async () => {
    const item = await wakeOnlyHost({ origin: { provenance: "loopback-direct" }, requireActor: false })
    await item.host.dispose()

    await offer(item.host)
    await settle()

    expect(item.resolved).toEqual({ runtimes: 0 })
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
  })

  test("a lease arriving during disposal is released before provider acquisition", async () => {
    let entered!: () => void, release!: () => void
    const acquiring = new Promise<void>(resolve => { entered = resolve })
    const waiting = new Promise<void>(resolve => { release = resolve })
    const item = await wakeOnlyHost({
      origin: {
        provenance: "relay-replayed",
        actor: { actorId: "owner", actorKind: "human" },
        authority: { managed: true, workspaceId: "workspace", orgId: "org", role: "editor" },
      },
      beforeAcquire: async () => { entered(); await waiting },
    })
    const offered = offer(item.host)
    await acquiring
    let finished = false
    const closing = item.host.dispose().then(() => { finished = true })
    expect(finished).toBe(false)
    release()
    await Promise.all([offered, closing])
    expect(item.resolved).toEqual({ runtimes: 0 })
    expect(item.calls.producers).toHaveLength(1)
    expect(item.released).toEqual([true])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
  })

  test("a wake with no identity resolves no runtime, so nothing is created for a turn that will not run", async () => {
    const item = await wakeOnlyHost({})

    await offer(item.host)
    await settle()

    expect(item.resolved).toEqual({ runtimes: 0 })
    expect(item.calls.producers).toEqual([])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
    await item.host.dispose()
  })

  test("a loopback origin is asked again at wake, and a host that requires verified actors refuses it", async () => {
    // The row remembers a machine-user admission. That is not a standing
    // permission: the policy in front of the runtime now is what decides, and
    // one that admits only verified actors has nobody to attribute this to.
    const strict = await wakeOnlyHost({ origin: { provenance: "loopback-direct" } })

    await offer(strict.host)
    await settle()

    expect(strict.calls.producers).toEqual([])
    expect(strict.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
    await strict.host.dispose()

    // The same row on the daemon shape it was recorded under is admitted.
    const daemon = await wakeOnlyHost({ origin: { provenance: "loopback-direct" }, requireActor: false })
    await offer(daemon.host)
    await settle()

    expect(daemon.resolved.runtimes).toBeGreaterThan(0)
    expect(daemon.calls.producers).toEqual([])
    await daemon.host.dispose()
  })

  test("a relayed origin recorded without a grant is declined on a policy that mints them, and the wake stays pending", async () => {
    // A row from before grants were recorded, or one whose mint was skipped.
    // The stored actor string is not proof; on a plane that hands out grants,
    // the grant is the only thing a background turn may present.
    const item = await wakeOnlyHost({
      origin: { provenance: "relay-replayed", actor: { actorId: "actor_owner", actorKind: "human" }, authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" } },
      grantCapable: true,
    })

    await offer(item.host)
    await settle()

    expect(item.calls.acquired).toEqual([])
    expect(item.calls.producers).toEqual([])
    expect(item.resolved).toEqual({ runtimes: 0 })
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
    await item.host.dispose()
  })

  test("a relayed origin that carries a grant presents it to the authority in place of the credential it no longer has", async () => {
    const item = await wakeOnlyHost({
      origin: { provenance: "relay-replayed", actor: { actorId: "actor_owner", actorKind: "human" }, authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" }, grant: CHILD_GRANT },
      grantCapable: true,
    })

    await offer(item.host)
    await settle()

    expect(item.calls.acquired).toEqual([expect.objectContaining({ sessionId: "parent", turnId: "msg_wake_child_child-reply", grant: CHILD_GRANT })])
    expect(item.calls.acquired[0]).not.toHaveProperty("credential")
    expect(item.calls.producers).toMatchObject([{ sessionId: "parent", actorId: "actor_owner" }])
    await item.host.dispose()
  })

  test("provider setup failure returns the acquired wake lease to the authority", async () => {
    const item = await wakeOnlyHost({
      origin: { provenance: "relay-replayed", actor: { actorId: "actor_owner", actorKind: "human" }, authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "owner" } },
      failResolution: true,
    })
    try {
      await offer(item.host)
      await settle()
      expect(item.calls.producers).toHaveLength(1)
      expect(item.released).toEqual([true])
      expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])
    } finally {
      await item.host.dispose()
    }
  })
})
