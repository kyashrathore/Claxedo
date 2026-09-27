import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { NO_HARNESS_EFFORT, type AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import type { AgentRuntime, AgentRuntimeTurnStartInput, RuntimeDirectory } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { sessionIdle } from "../compat-events"
import type { SessionAccessPolicy } from "../session-access-policy"
import { createSessionRoutes, type SessionLifecycleEvent } from "./session-core"

type Journal = string[]

type Titles = Map<string, string>

function adapter(journal: Journal, overrides: Partial<AgentHarnessAdapter> = {}, titles: Titles = new Map()): AgentHarnessAdapter {
  let created: string | undefined
  return {
    instructionChannel: "turn-system-prompt",
    getSession: async (binding) => created === binding.sessionId
      ? { id: binding.sessionId, title: titles.get(binding.sessionId) ?? "", time: { created: 1, updated: 1 } }
      : null,
    createSession: async (_directory, _title, id) => {
      created = id ?? "session_1"
      journal.push(`create:${created}`)
      return { id: created }
    },
    updateSession: async (binding) => ({ id: binding.sessionId }),
    getSessionConfig: async () => ({
      harness: { id: "codex", access: "native" },
      model: { providerID: "test", modelID: "fixture" },
      agent: "build",
      variant: null,
    }),
    updateSessionConfig: async (_binding, patch) => ({ harness: patch.harness ?? { id: "codex", access: "native" }, agent: null, variant: null }),
    deleteSession: async (binding) => {
      journal.push(`delete:${binding.sessionId}`)
      created = undefined
    },
    readHarnessCapabilities: () => ({
      harness: "codex",
      abort: true,
      reconnect: false,
      replay: true,
      permissions: true,
      questions: true,
      todos: true,
      commands: false,
      fork: false,
      revert: false,
      unrevert: false,
      configOptions: false,
      subagents: false,
      effortLevels: NO_HARNESS_EFFORT,
      instructionChannel: "turn-system-prompt",
      goals: false,
    }),
    executeTurn: () => (async function* () {})(),
    getMessages: async () => [],
    cancelTurn: async () => ({ execution: "terminal" as const, cleanup: "verified_clear" as const }),
    dispose: () => {},
    ...overrides,
  }
}

function runtime(journal: Journal, input: {
  refuse?: Error
  goal?: (objective: string) => Promise<unknown>
  titles?: Titles
} = {}) {
  return {
    turns: {
      start: async (turn: AgentRuntimeTurnStartInput) => {
        journal.push(`turn:${turn.sessionId}:${turn.messageId}`)
        if (input.refuse) throw input.refuse
        input.titles?.set(turn.sessionId, "hello")
        return {
          sessionId: turn.sessionId,
          userMessageId: turn.messageId,
          assistantMessageId: "assistant_1",
          directory: undefined,
          delivery: "start",
          prompt: {
            parts: turn.parts,
            userMessageId: turn.messageId,
            assistantMessageId: "assistant_1",
            agent: "build",
            model: { providerID: "test", modelID: "fixture" },
          },
        }
      },
    },
    events: {
      subscribe: () => (async function* () {
        yield { sessionId: "session_1", directory: undefined, payload: sessionIdle("session_1") }
      })(),
      list: async () => [],
    },
    goals: {
      start: async ({ sessionId, objective }: { sessionId: string; objective: string }) => {
        journal.push(`goal:${sessionId}:${objective}`)
        return input.goal ? input.goal(objective) : { ok: true, goal: { objective, status: "active" } }
      },
    },
  } as unknown as AgentRuntime
}

function binding(_c: unknown, directory: RuntimeDirectory, sessionId: string): AgentExecutionBinding {
  return { sessionId, workspaceId: "ws_1", directory: directory ?? "", connectionId: "native:codex", upstreamSessionId: sessionId }
}

function routes(journal: Journal, input: {
  adapter?: AgentHarnessAdapter
  runtime?: AgentRuntime
  policy?: SessionAccessPolicy
  relayed?: boolean
  announced?: SessionLifecycleEvent[]
} = {}) {
  const lifecycle = (event: SessionLifecycleEvent) => {
    journal.push(`lifecycle:${event.phase}`)
    input.announced?.push(event)
  }
  const app = createSessionRoutes({
    resolveAdapter: () => input.adapter ?? adapter(journal),
    ...(input.runtime ? { resolveRuntime: () => input.runtime } : {}),
    resolveDirectory: () => "/workspace",
    resolveExecutionBinding: binding,
    publishGlobal: () => {},
    publishSessionLifecycle: lifecycle,
    afterDeleteSession: (_c, _directory, sessionId) => { journal.push(`after-delete:${sessionId}`) },
    afterMessageCheckpoint: (_c, _directory, sessionId) => { journal.push(`checkpoint:${sessionId}`) },
    ...(input.policy ? { sessionAccessPolicy: input.policy } : {}),
  })
  if (!input.relayed) return app
  return new Hono()
    .use("*", async (context, next) => {
      ;(context as any).set("relayHostAuth", {
        actor_id: "actor_1",
        actor_kind: "human",
        org_id: "org_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        role: "editor",
      } as never)
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
    const response = await create(routes(journal, { runtime: runtime(journal) }), { title: "First", prompt: FIRST })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "session_1", prompt: { delivery: "start" } })
    expect(journal.slice(0, 3)).toEqual(["lifecycle:creating", "create:session_1", "turn:session_1:msg_1"])
    expect(journal.indexOf("lifecycle:created")).toBeGreaterThan(journal.indexOf("turn:session_1:msg_1"))
  })

  test("answers and announces the session as admission left it, titled from its first prompt", async () => {
    const journal: Journal = []
    const titles: Titles = new Map()
    const announced: SessionLifecycleEvent[] = []
    const app = routes(journal, { adapter: adapter(journal, {}, titles), runtime: runtime(journal, { titles }), announced })
    const response = await create(app, { prompt: FIRST })

    expect(await response.json()).toMatchObject({ id: "session_1", title: "hello" })
    expect(announced.find((event) => event.phase === "created")?.info).toMatchObject({ id: "session_1", title: "hello" })
  })

  test("admits the prompt on a harness with no runtime owner", async () => {
    const journal: Journal = []
    let ran!: (userMessageId: string | undefined) => void
    const turn = new Promise<string | undefined>((resolve) => { ran = resolve })
    const harness = adapter(journal, {
      executeTurn: (_binding, prompt) => (async function* () { ran(prompt.userMessageId) })(),
    })
    const response = await create(routes(journal, { adapter: harness }), { prompt: FIRST })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "session_1", prompt: { delivery: "start" } })
    expect(await turn).toBe("msg_1")
  })

  test("a promptless create starts no turn and answers without a delivery", async () => {
    const journal: Journal = []
    const response = await create(routes(journal, { runtime: runtime(journal) }), { title: "First" })

    expect(response.status).toBe(201)
    const created = await response.json() as Record<string, unknown>
    expect(created.id).toBe("session_1")
    expect("prompt" in created).toBe(false)
    expect("goal" in created).toBe(false)
    expect(journal).toEqual(["lifecycle:creating", "create:session_1", "lifecycle:created"])
  })

  test("refuses a delivery, a child's prompt, and a prompt beside a goal before the harness is asked to create anything", async () => {
    const journal: Journal = []
    const app = routes(journal, { runtime: runtime(journal) })

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

  test("a runtime that fails to start the turn leaves no session, after the turn's own cleanup ran", async () => {
    const journal: Journal = []
    const response = await create(routes(journal, { runtime: runtime(journal, { refuse: new Error("harness failed to boot") }) }), { prompt: FIRST })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: "session_create_failed", message: "harness failed to boot" } })
    expect(journal).toEqual([
      "lifecycle:creating",
      "create:session_1",
      "turn:session_1:msg_1",
      "checkpoint:session_1",
      "delete:session_1",
      "after-delete:session_1",
      "lifecycle:failed",
    ])
  })

  test("a harness that refuses the turn leaves no session and answers the coded refusal", async () => {
    const journal: Journal = []
    const refusing = adapter(journal, {
      getSessionConfig: async () => { throw new Error("config store offline") },
    })
    const response = await create(routes(journal, { adapter: refusing }), { prompt: FIRST })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "session_configuration_unavailable" } })
    expect(journal).toEqual(["lifecycle:creating", "create:session_1", "delete:session_1", "after-delete:session_1", "lifecycle:failed"])
  })

  test("a creator the policy lets create but not prompt keeps no session", async () => {
    const journal: Journal = []
    const refusing = policy({
      authorize: async (input) => input.operation === "prompt"
        ? { allowed: false, status: 403, code: "session_prompt_denied", message: "Follow only" }
        : { allowed: true },
    })
    const response = await create(routes(journal, { runtime: runtime(journal), policy: refusing }), { prompt: FIRST })

    expect(response.status).toBe(403)
    expect(journal).toEqual(["lifecycle:creating", "create:session_1", "delete:session_1", "after-delete:session_1", "lifecycle:failed"])
  })
})

describe("a managed create that carries the session's first prompt", () => {
  const reserved = { "x-claxedo-session-registration-operation": "op_1" }

  test("registers the reserved session, then takes the turn lease under the prompt's message id", async () => {
    const journal: Journal = []
    const app = routes(journal, { runtime: runtime(journal), policy: managedPolicy(journal), relayed: true })
    const response = await create(app, { id: "ses_1", prompt: FIRST }, reserved)

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "ses_1", prompt: { delivery: "start" } })
    expect(journal.slice(0, 5)).toEqual([
      "lifecycle:creating",
      "create:ses_1",
      "register:ses_1",
      "lease:ses_1:msg_1",
      "turn:ses_1:msg_1",
    ])
    expect(journal.indexOf("lifecycle:created")).toBeGreaterThan(journal.indexOf("turn:ses_1:msg_1"))
  })

  test("a refused turn lease compensates the registered session with the authority", async () => {
    const journal: Journal = []
    const refusing = managedPolicy(journal, {
      acquireTurn: async () => ({ allowed: false, status: 409, code: "session_turn_in_progress", message: "busy" }),
    })
    const app = routes(journal, { runtime: runtime(journal), policy: refusing, relayed: true })
    const response = await create(app, { id: "ses_1", prompt: FIRST }, reserved)

    expect(response.status).toBe(409)
    expect(journal).toEqual([
      "lifecycle:creating",
      "create:ses_1",
      "register:ses_1",
      "compensate:begin",
      "delete:ses_1",
      "after-delete:ses_1",
      "compensate:complete",
      "lifecycle:failed",
    ])
  })
})

describe("a create that carries the session's first goal", () => {
  test("starts the goal on the new session and answers with it", async () => {
    const journal: Journal = []
    const response = await create(routes(journal, { runtime: runtime(journal) }), { goal: { objective: "ship it" } })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "session_1", goal: { ok: true, goal: { objective: "ship it" } } })
    expect(journal).toEqual(["lifecycle:creating", "create:session_1", "goal:session_1:ship it", "lifecycle:created"])
  })

  test("a goal the runtime cannot start leaves no session", async () => {
    const journal: Journal = []
    const failing = runtime(journal, { goal: async () => ({ ok: false, status: "failed", message: "goal engine down" }) })
    const response = await create(routes(journal, { runtime: failing }), { goal: { objective: "ship it" } })

    expect(response.status).toBe(502)
    expect(journal).toEqual([
      "lifecycle:creating",
      "create:session_1",
      "goal:session_1:ship it",
      "delete:session_1",
      "after-delete:session_1",
      "lifecycle:failed",
    ])
  })
})
