import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { AgentGoalMutationResult, GoalCapabilities, SessionHarness, AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { NativeGoalOperations } from "@claxedo/harness/contract"
import { CredentialSelectionError } from "@claxedo/harness/registry"
import type { SessionAccessPolicy } from "../session-access-policy"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, type HostFixture } from "../test-support/host-fixture"
import { testLaunch } from "../test-support/host-composition"
import { createSessionRoutes } from "./session-core"
import type { SessionLifecycleEvent } from "./session-route-options"

type Journal = string[]

const CODEX: SessionHarness = { id: "codex", access: "native" }
const WORKSPACE = "/workspace"
const GOALS: GoalCapabilities = { implemented: true, available: true, actions: [], recovery: "reconcile", optionalFields: [] }

const hosts: HostFixture[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
})

/**
 * A real runtime host over one scripted Codex harness, journaling what the
 * harness is asked to do. `failTurnStart` makes the harness unreadable once a
 * session has started, so the first turn fails before the runtime starts it.
 */
function harness(journal: Journal, input: {
  failTurnStart?: Error
  goal?: (objective: string) => Promise<AgentGoalMutationResult>
} = {}) {
  let unreadable = false
  const goals: NativeGoalOperations = {
    read: async () => null,
    start: async (session, objective) => {
      journal.push(`goal:${session.binding.sessionId}:${objective}`)
      return input.goal ? input.goal(objective) : { ok: true, goal: { sessionId: session.binding.sessionId, objective, status: "active", createdAt: 1, updatedAt: 1 } }
    },
    pause: async () => ({ ok: false, status: "unsupported", message: "fixture" }),
    resume: async () => ({ ok: false, status: "unsupported", message: "fixture" }),
    stop: async () => ({ ok: false, status: "unsupported", message: "fixture" }),
    delete: async () => ({ ok: false, status: "unsupported", message: "fixture" }),
  }
  const transport = new FakeTransport({
    kind: "codex-app-server",
    capabilities: { goals: GOALS },
    goals,
    beforeCapabilities: async () => {
      if (unreadable && input.failTurnStart) throw input.failTurnStart
    },
    onStart: (start) => {
      journal.push(`create:${start.sessionId}`)
      unreadable = true
    },
    onClose: (session) => { journal.push(`delete:${session.binding.sessionId}`) },
    turn: async function* ({ session, turn }) {
      journal.push(`turn:${session.binding.sessionId}:${turn.prompt.userMessageId}`)
      yield { type: "finish", sessionId: session.binding.sessionId }
    },
  })
  const host = createHostFixture({ transports: { codex: transport }, workspaceId: "ws_1", launch: testLaunch("ws_1", ["actor_1"]) })
  hosts.push(host)
  return host
}

function routes(journal: Journal, host: HostFixture, input: {
  policy?: SessionAccessPolicy
  relayed?: boolean
  announced?: SessionLifecycleEvent[]
  published?: AgentEventEnvelope[]
} = {}) {
  const lifecycle = (event: SessionLifecycleEvent) => {
    const admitted = event.phase === "created" && event.sessionID
      ? host.store.getMessages(event.sessionID).filter((message) => message.info.role === "user").map((message) => message.info.id)
      : []
    journal.push(admitted.length ? `lifecycle:${event.phase}:${admitted.join(",")}` : `lifecycle:${event.phase}`)
    input.announced?.push(event)
  }
  const app = createSessionRoutes({
    sessionIdWorkspace: () => undefined,
    runtime: async () => host.runtime,
    defaultHarness: () => CODEX,
    requestedSessionHarness: () => undefined,
    resolveDirectory: () => WORKSPACE,
    resolveWorkspaceId: () => "ws_1",
    getSession: (_c, _directory, sessionId) => host.store.getSession(sessionId) ?? null,
    publishGlobal: (event) => { input.published?.push(event) },
    publishSessionLifecycle: lifecycle,
    afterMessageCheckpoint: (_c, _directory, sessionId) => { journal.push(`checkpoint:${sessionId}`) },
    ...(input.policy ? { sessionAccessPolicy: input.policy } : {}),
  })
  if (!input.relayed) return app
  return new Hono()
    .use("*", async (context, next) => {
      ;(context as unknown as { set(name: string, value: unknown): void }).set("relayHostAuth", {
        actor_id: "actor_1",
        user_id: "actor_1",
        actor_kind: "human",
        org_id: "org_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        role: "editor",
      })
      await next()
    })
    .route("/", app)
}

function create(app: { request: Hono["request"] }, body: unknown, headers: Record<string, string> = {}) {
  return app.request("http://localhost/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

const FIRST = { messageID: "msg_1", agent: "build", parts: [{ type: "text", text: "hello" }] }

function policy(overrides: Partial<SessionAccessPolicy> = {}): SessionAccessPolicy {
  return {
    sessionAuthority: "local",
    authorize: async () => ({ allowed: true }),
    authorizeSessionStart: async () => ({ allowed: true }),
    authorizeSessionStartStatus: async () => ({ allowed: true }),
    authorizePrefix: async () => ({ allowed: true }),
    filterSessions: async (input) => input.sessionIds,
    ...overrides,
  }
}

function managedPolicy(journal: Journal, overrides: Partial<SessionAccessPolicy> = {}): SessionAccessPolicy {
  const lease = (turnId: string) => ({
    allowed: true as const,
    turnId,
    leaseId: "lease_1",
    fencingToken: 1,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  return policy({
    sessionAuthority: "managed-private",
    authorizeStream: async () => ({ allowed: true, lease: "lease_test", expiresAt: Date.now() + 60_000 }),
    registerSession: async (input) => { journal.push(`register:${input.sessionId}`); return { allowed: true } },
    markRegistrationAmbiguous: async () => ({ allowed: true }),
    beginRegistrationCompensation: async () => { journal.push("compensate:begin"); return { allowed: true } },
    completeRegistrationCompensation: async () => { journal.push("compensate:complete"); return { allowed: true } },
    acquireTurn: async (input) => { journal.push(`lease:${input.sessionId}:${input.turnId}`); return lease(input.turnId) },
    renewTurn: async (input) => lease(input.turnId),
    releaseTurn: async () => ({ released: true }),
    ...overrides,
  })
}

describe("a create that carries the session's first prompt", () => {
  test("admits the prompt on the runtime before the session is announced, and answers with its delivery", async () => {
    const journal: Journal = []
    const host = harness(journal)
    const response = await create(routes(journal, host), { id: "ses_1", title: "First", prompt: FIRST })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "ses_1", prompt: { delivery: "start" } })
    expect(journal.slice(0, 2)).toEqual(["lifecycle:creating", "create:ses_1"])
    expect(journal).toContain("lifecycle:created:msg_1")
    await settle()
    expect(journal).toContain("turn:ses_1:msg_1")
  })

  test("answers and announces the session as admission left it, titled from its first prompt", async () => {
    const journal: Journal = []
    const announced: SessionLifecycleEvent[] = []
    const host = harness(journal)
    const response = await create(routes(journal, host, { announced }), { id: "ses_1", prompt: FIRST })

    expect(response.status).toBe(201)
    const created = await response.json() as { id: string; title: string; titleSource?: string }
    expect(created).toMatchObject({ id: "ses_1", titleSource: "prompt" })
    expect(created.title).toBe(host.store.getSession("ses_1")!.title!)
    expect(announced.find((event) => event.phase === "created")?.info).toMatchObject({ id: "ses_1", title: created.title })
  })

  test("a promptless create starts no turn and answers without a delivery", async () => {
    const journal: Journal = []
    const host = harness(journal)
    const response = await create(routes(journal, host), { id: "ses_1", title: "First" })

    expect(response.status).toBe(201)
    const created = await response.json() as Record<string, unknown>
    expect(created.id).toBe("ses_1")
    expect("prompt" in created).toBe(false)
    expect("goal" in created).toBe(false)
    await settle()
    expect(journal).toEqual(["lifecycle:creating", "create:ses_1", "lifecycle:created"])
  })

  test("refuses a delivery, a child's prompt, and a prompt beside a goal before the harness is asked to create anything", async () => {
    const journal: Journal = []
    const app = routes(journal, harness(journal))

    for (const body of [
      { prompt: { ...FIRST, delivery: "queue" } },
      { prompt: FIRST, goal: { objective: "ship" } },
      { prompt: FIRST, parentID: "ses_parent" },
      { prompt: "hello" },
      { goal: {} },
    ]) {
      const response = await create(app, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: "session_first_input_invalid" } })
    }
    expect(journal).toEqual([])
  })

  test("a runtime that fails to start the turn leaves no session, after the turn's own cleanup ran, and publishes no failure for it", async () => {
    const journal: Journal = []
    const published: AgentEventEnvelope[] = []
    const host = harness(journal, { failTurnStart: new Error("harness failed to boot") })
    const response = await create(routes(journal, host, { published }), { id: "ses_1", prompt: FIRST })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: "session_create_failed", message: "harness failed to boot" } })
    expect(journal).toEqual([
      "lifecycle:creating",
      "create:ses_1",
      "checkpoint:ses_1",
      "delete:ses_1",
      "lifecycle:failed",
    ])
    expect(published).toEqual([])
    expect(host.store.getSession("ses_1")).toBeNull()
  })

  test("a harness that refuses the turn leaves no session and answers the coded refusal", async () => {
    const journal: Journal = []
    const host = harness(journal, { failTurnStart: new CredentialSelectionError("account_unavailable", "The session owner has no account for this harness") })
    const response = await create(routes(journal, host), { id: "ses_1", prompt: FIRST })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: "account_unavailable", message: "The session owner has no account for this harness" } })
    expect(journal).toEqual([
      "lifecycle:creating",
      "create:ses_1",
      "checkpoint:ses_1",
      "delete:ses_1",
      "lifecycle:failed",
    ])
    expect(host.store.getSession("ses_1")).toBeNull()
  })

  test("a creator the policy lets create but not prompt keeps no session", async () => {
    const journal: Journal = []
    const refusing = policy({
      authorize: async (input) => input.operation === "prompt"
        ? { allowed: false, status: 403, code: "session_prompt_denied", message: "Follow only" }
        : { allowed: true },
    })
    const host = harness(journal)
    const response = await create(routes(journal, host, { policy: refusing }), { id: "ses_1", prompt: FIRST })

    expect(response.status).toBe(403)
    expect(journal).toEqual(["lifecycle:creating", "create:ses_1", "delete:ses_1", "lifecycle:failed"])
    expect(host.store.getSession("ses_1")).toBeNull()
  })
})

describe("a managed create that carries the session's first prompt", () => {
  const reserved = { "x-claxedo-session-registration-operation": "op_1" }

  test("registers the reserved session, then takes the turn lease under the prompt's message id", async () => {
    const journal: Journal = []
    const app = routes(journal, harness(journal), { policy: managedPolicy(journal), relayed: true })
    const response = await create(app, { id: "ses_1", prompt: FIRST }, reserved)

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "ses_1", prompt: { delivery: "start" } })
    expect(journal.slice(0, 4)).toEqual([
      "lifecycle:creating",
      "create:ses_1",
      "register:ses_1",
      "lease:ses_1:msg_1",
    ])
    expect(journal.indexOf("lifecycle:created:msg_1")).toBeGreaterThan(journal.indexOf("lease:ses_1:msg_1"))
  })

  test("a refused turn lease compensates the registered session with the authority", async () => {
    const journal: Journal = []
    const refusing = managedPolicy(journal, {
      acquireTurn: async () => ({ allowed: false, status: 409, code: "session_turn_in_progress", message: "busy" }),
    })
    const app = routes(journal, harness(journal), { policy: refusing, relayed: true })
    const response = await create(app, { id: "ses_1", prompt: FIRST }, reserved)

    expect(response.status).toBe(409)
    expect(journal).toEqual([
      "lifecycle:creating",
      "create:ses_1",
      "register:ses_1",
      "compensate:begin",
      "delete:ses_1",
      "compensate:complete",
      "lifecycle:failed",
    ])
  })

  test("a retry of the create its registration was undone for answers the authority's spent reservation, not a denial", async () => {
    const journal: Journal = []
    let compensated = false
    const refusing = managedPolicy(journal, {
      acquireTurn: async () => ({ allowed: false, status: 409, code: "session_turn_in_progress", message: "busy" }),
      completeRegistrationCompensation: async () => { compensated = true; return { allowed: true } },
      authorizeSessionStart: async () => compensated
        ? { allowed: false, status: 409, code: "session_reservation_spent", message: "The create was undone" }
        : { allowed: true },
    })
    const app = routes(journal, harness(journal), { policy: refusing, relayed: true })
    expect((await create(app, { id: "ses_1", prompt: FIRST }, reserved)).status).toBe(409)
    const retry = await create(app, { id: "ses_1", prompt: FIRST }, reserved)
    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ error: { code: "session_reservation_spent" } })
  })
})

describe("a create that carries the session's first goal", () => {
  test("starts the goal on the new session and answers with it", async () => {
    const journal: Journal = []
    const response = await create(routes(journal, harness(journal)), { id: "ses_1", goal: { objective: "ship it" } })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "ses_1", goal: { ok: true, goal: { objective: "ship it" } } })
    expect(journal).toEqual(["lifecycle:creating", "create:ses_1", "goal:ses_1:ship it", "lifecycle:created"])
  })

  test("a goal the runtime cannot start leaves no session", async () => {
    const journal: Journal = []
    const host = harness(journal, { goal: async () => ({ ok: false, status: "failed", message: "goal engine down" }) })
    const response = await create(routes(journal, host), { id: "ses_1", goal: { objective: "ship it" } })

    expect(response.status).toBe(502)
    expect(journal).toEqual([
      "lifecycle:creating",
      "create:ses_1",
      "goal:ses_1:ship it",
      "delete:ses_1",
      "lifecycle:failed",
    ])
    expect(host.store.getSession("ses_1")).toBeNull()
  })
})

describe("a create that names its session in its path", () => {
  const createAt = (app: { request: Hono["request"] }, sessionId: string, body: unknown) => app.request(`http://localhost/session/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  test("creates that session, the same as a create naming it in its body", async () => {
    const journal: Journal = []
    const host = harness(journal)
    const response = await createAt(routes(journal, host), "ses_path", { title: "Path" })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "ses_path", title: "Path" })
    expect(journal).toContain("create:ses_path")
  })

  test("refuses a body naming another session", async () => {
    const journal: Journal = []
    const host = harness(journal)
    const response = await createAt(routes(journal, host), "ses_path", { id: "ses_other" })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_id_mismatch" } })
    expect(journal).not.toContain("create:ses_other")
  })
})
