import { describe, expect, test } from "bun:test"
import { createSessionRoutes, type RuntimeSessionBusEvent, type SessionLifecycleEvent } from "./session-core"
import type {
  AgentHarnessFactory,
  AgentMessageRow,
  AgentPermissionRow,
  AgentQuestionRow,
  AgentRuntime,
  AgentRuntimeStreamEvent,
  AgentSessionRow,
  PromptInput,
  RuntimeDirectory,
  SessionConfig,
} from "@claxedo/agent-sdk-runtime"
import {
  AgentMessagePageError,
  type AgentHarnessAdapter,
  type AgentMessagePage,
  type AgentMessagePageInput,
} from "@claxedo/agent-sdk-runtime/adapters"
import { AgentRuntimeTurnConflictError, createAgentRuntime } from "@claxedo/agent-sdk-runtime"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { Hono } from "hono"
import type { SessionAccessPolicy } from "../session-access-policy"
// These fixtures carry only the fields the routes under test read; the cast
// keeps them minimal rather than filling in a full UserMessage/AssistantMessage.
import { messagePartUpdated, messageUpdated, sessionIdle, type CompatEnvelope } from "../compat-events"
import type { Message } from "@opencode-ai/sdk/v2"
import { Hono } from "hono"
import type { SessionAccessPolicy } from "../session-access-policy"

function adapter(input: {
  onDirectory?: (directory: RuntimeDirectory) => void
  events?: AgentRuntimeStreamEvent[]
  messages?: AgentMessageRow[]
  getMessagePage?: (
    id: string,
    page: AgentMessagePageInput,
    directory: RuntimeDirectory,
  ) => Promise<AgentMessagePage>
} = {}): AgentHarnessAdapter {
  return {
    listSessions: async (directory) => {
      input.onDirectory?.(directory)
      return []
    },
    getSession: async (id, directory) => {
      input.onDirectory?.(directory)
      return { id, title: "Hybrid", time: { created: 1, updated: 1 } }
    },
    createSession: async () => ({ id: "session_1" }),
    updateSession: async (id) => ({ id, title: "Hybrid", time: { created: 1, updated: 1 } }),
    getSessionConfig: async (_id, directory) => {
      input.onDirectory?.(directory)
      return {
        harness: { id: "opencode", access: "native" },
        model: { providerID: "test", modelID: "fixture" },
        agent: "build",
        variant: null,
      } satisfies SessionConfig
    },
    updateSessionConfig: async (_id, patch) => ({
      harness: patch.harness ?? { id: "opencode", access: "native" },
      ...(patch.model ? { model: patch.model } : {}),
      agent: patch.agent ?? null,
      variant: patch.variant ?? null,
    }),
    deleteSession: async () => {},
    readHarnessCapabilities: (directory) => {
      input.onDirectory?.(directory)
      return {
        harness: "opencode",
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
      }
    },
    sendMessage: (_id: string, _prompt: PromptInput, directory: RuntimeDirectory) => {
      input.onDirectory?.(directory)
      return (async function* () {
        for (const event of input.events ?? []) yield event
      })()
    },
    getMessages: async (_id, directory) => {
      input.onDirectory?.(directory)
      return input.messages ?? []
    },
    ...(input.getMessagePage ? { getMessagePage: input.getMessagePage } : {}),
    abort: async () => ({ ok: true, status: "cancelled" }),
    revert: async () => {},
    unrevert: async () => {},
    forkSession: async () => ({ id: "forked" }),
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
    probeConfigOptions: async () => [],
    dispose: () => {},
  }
}

function managedRoutes(input: {
  policy: SessionAccessPolicy
  adapter: AgentHarnessAdapter
  listSessions?: () => Promise<AgentSessionRow[]>
  runtime?: AgentRuntime
  publishGlobal?: (event: CompatEnvelope) => void
  afterMessageCheckpoint?: () => void
}) {
  const routes = createSessionRoutes({
    resolveAdapter: () => input.adapter,
    resolveDirectory: () => "/workspace",
    ...(input.listSessions ? { listSessions: input.listSessions } : {}),
    ...(input.runtime ? { resolveRuntime: () => input.runtime } : {}),
    ...(input.afterMessageCheckpoint ? { afterMessageCheckpoint: input.afterMessageCheckpoint } : {}),
    sessionAccessPolicy: input.policy,
    sessionBus: { publish() {}, subscribe: () => () => {} },
    publishGlobal: input.publishGlobal ?? (() => {}),
  })
  const app = new Hono()
  app.use("*", async (context, next) => {
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
  return app.route("/", routes)
}

function managedPolicy(overrides: Partial<SessionAccessPolicy> = {}): SessionAccessPolicy {
  const lease = (turnId: string, leaseId = "turn_lease_test") => ({
    allowed: true as const,
    turnId,
    leaseId,
    fencingToken: 1,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  return {
    sessionAuthority: "managed-private",
    authorize: async () => ({ allowed: true }),
    authorizeStream: async () => ({ allowed: true, lease: "lease_test", expiresAt: Date.now() + 60_000 }),
    authorizePrefix: async () => ({ allowed: true }),
    filterSessions: async (input) => input.sessionIds,
    registerSession: async () => ({ allowed: true }),
    markRegistrationAmbiguous: async () => ({ allowed: true }),
    beginRegistrationCompensation: async () => ({ allowed: true }),
    completeRegistrationCompensation: async () => ({ allowed: true }),
    acquireTurn: async (input) => lease(input.turnId),
    renewTurn: async (input) => lease(input.turnId, input.leaseId),
    releaseTurn: async () => ({ released: true }),
    ...overrides,
  }
}

describe("createSessionRoutes private-session lifecycle", () => {
  test("requires a preassigned session and reservation operation before runtime mutation", async () => {
    let creates = 0
    const fixture = { ...adapter(), getSession: async () => null, createSession: async () => {
      creates += 1
      return { id: "ses_1" }
    } }
    const response = await managedRoutes({ policy: managedPolicy(), adapter: fixture }).request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_reservation_required" } })
    expect(creates).toBe(0)
  })

  test("registers the exact reserved operation before returning create success", async () => {
    const calls: unknown[] = []
    const fixture = { ...adapter(), getSession: async () => null, createSession: async (_directory: string, _title?: string, id?: string) => ({ id: id! }) }
    const policy = managedPolicy({
      registerSession: async (value) => {
        calls.push(value)
        return { allowed: true }
      },
    })
    const response = await managedRoutes({ policy, adapter: fixture }).request("/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claxedo-session-registration-operation": "op_create_1",
      },
      body: JSON.stringify({ id: "ses_1", title: "Private" }),
    })
    expect(response.status).toBe(201)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: "ses_1",
      registrationOperationId: "op_create_1",
      sessionTitle: "Private",
      actor: { actorId: "actor_1", actorKind: "human" },
      authority: { orgId: "org_1", workspaceId: "ws_1", role: "editor" },
    })
  })

  test("marks an unavailable registration ambiguous and preserves runtime state for exact retry", async () => {
    let existing = false
    let creates = 0
    let deletes = 0
    let attempts = 0
    const ambiguous: unknown[] = []
    const fixture = {
      ...adapter(),
      getSession: async (id: string) => existing ? { id, title: "Private", time: { created: 1, updated: 1 } } : null,
      createSession: async (_directory: string, _title?: string, id?: string) => {
        creates += 1
        existing = true
        return { id: id! }
      },
      deleteSession: async () => { deletes += 1; existing = false },
    }
    const policy = managedPolicy({
      registerSession: async () => ++attempts === 1
        ? { allowed: false, status: 503, code: "authority_unavailable", message: "retry" }
        : { allowed: true },
      markRegistrationAmbiguous: async (value) => { ambiguous.push(value); return { allowed: true } },
    })
    const request = () => managedRoutes({ policy, adapter: fixture }).request("/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claxedo-session-registration-operation": "op_create_1",
      },
      body: JSON.stringify({ id: "ses_1", title: "Private" }),
    })

    expect((await request()).status).toBe(503)
    expect(creates).toBe(1)
    expect(deletes).toBe(0)
    expect(ambiguous).toHaveLength(1)
    expect((await request()).status).toBe(201)
    expect(creates).toBe(1)
  })

  test("compensates runtime state after definitive registration denial", async () => {
    const calls: string[] = []
    const fixture = {
      ...adapter(),
      getSession: async () => null,
      createSession: async (_directory: string, _title?: string, id?: string) => ({ id: id! }),
      deleteSession: async () => { calls.push("delete") },
    }
    const policy = managedPolicy({
      registerSession: async () => ({ allowed: false, status: 403, code: "session_private", message: "denied" }),
      beginRegistrationCompensation: async () => { calls.push("begin"); return { allowed: true } },
      completeRegistrationCompensation: async () => { calls.push("complete"); return { allowed: true } },
    })
    const response = await managedRoutes({ policy, adapter: fixture }).request("/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claxedo-session-registration-operation": "op_create_1",
      },
      body: JSON.stringify({ id: "ses_1" }),
    })
    expect(response.status).toBe(403)
    expect(calls).toEqual(["begin", "delete", "complete"])
  })

  test("requires an exact reservation before a managed fork mutates runtime state", async () => {
    let forks = 0
    const fixture = {
      ...adapter(),
      getSession: async () => null,
      forkSession: async () => { forks += 1; return { id: "unexpected" } },
    }
    const response = await managedRoutes({ policy: managedPolicy(), adapter: fixture }).request("/session/ses_parent/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "msg_1" }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_reservation_required" } })
    expect(forks).toBe(0)
  })

  test("forks into the reserved child id and registers the exact operation before success", async () => {
    const calls: unknown[] = []
    const fixture = {
      ...adapter(),
      getSession: async () => null,
      forkSession: async (parentId: string, messageId: string, directory: RuntimeDirectory, childId?: string) => {
        calls.push({ parentId, messageId, directory, childId })
        return { id: childId! }
      },
    }
    const policy = managedPolicy({
      registerSession: async (value) => { calls.push(value); return { allowed: true } },
    })
    const response = await managedRoutes({ policy, adapter: fixture }).request("/session/ses_parent/fork", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claxedo-session-registration-operation": "op_fork_1",
      },
      body: JSON.stringify({ id: "ses_child", messageId: "msg_1" }),
    })
    expect(response.status).toBe(201)
    expect(calls[0]).toEqual({
      parentId: "ses_parent",
      messageId: "msg_1",
      directory: "/workspace",
      childId: "ses_child",
    })
    expect(calls[1]).toMatchObject({
      sessionId: "ses_child",
      registrationOperationId: "op_fork_1",
      actor: { actorId: "actor_1", actorKind: "human" },
    })
    expect(await response.json()).toEqual({ id: "ses_child" })
  })

  test("filters list rows through private-session authority", async () => {
    const policy = managedPolicy({ filterSessions: async () => ["ses_visible"] })
    const response = await managedRoutes({
      policy,
      adapter: adapter(),
      listSessions: async () => [
        { id: "ses_visible", title: "Visible", time: { created: 1, updated: 1 } },
        { id: "ses_private", title: "Private", time: { created: 1, updated: 1 } },
      ],
    }).request("/session")
    expect((await response.json() as Array<{ id: string }>).map((row) => row.id)).toEqual(["ses_visible"])
  })

  test("requires a stable message id before a managed prompt mutates the runtime", async () => {
    let sends = 0
    const fixture = {
      ...adapter(),
      sendMessage: () => {
        sends += 1
        return (async function* () {})()
      },
    }
    const response = await managedRoutes({ policy: managedPolicy(), adapter: fixture }).request(
      "/session/ses_private/message",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_turn_id_required" } })
    expect(sends).toBe(0)
  })

  test("returns a durable admission conflict before a managed prompt mutates the runtime", async () => {
    let sends = 0
    const fixture = {
      ...adapter(),
      sendMessage: () => {
        sends += 1
        return (async function* () {})()
      },
    }
    const response = await managedRoutes({
      policy: managedPolicy({
        acquireTurn: async () => ({
          allowed: false,
          status: 409,
          code: "session_turn_in_progress",
          message: "A durable turn is already active",
        }),
      }),
      adapter: fixture,
    }).request("/session/ses_private/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageID: "msg_2", parts: [{ type: "text", text: "hello" }] }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: "session_turn_in_progress" } })
    expect(sends).toBe(0)
  })
})

describe("createSessionRoutes message paging", () => {
  const first = { info: { id: "message-1", role: "user" }, parts: [] } as AgentMessageRow
  const second = { info: { id: "message-2", role: "assistant" }, parts: [] } as AgentMessageRow

  test("uses the route authority before an adapter page and forwards its opaque cursor", async () => {
    const calls: Array<{ sessionId: string; page: AgentMessagePageInput; directory: RuntimeDirectory }> = []
    let adapterResolutions = 0
    const app = createSessionRoutes({
      resolveAdapter: () => {
        adapterResolutions += 1
        return adapter({
          getMessagePage: async () => {
            throw new Error("adapter page must not run")
          },
        })
      },
      resolveDirectory: () => "/workspace",
      getMessagePage: (_c, directory, sessionId, page) => {
        calls.push({ sessionId, page, directory })
        return { messages: [first, second], nextCursor: "journal:opaque/next" }
      },
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })

    const response = await app.request("http://localhost/session/session-1/message?limit=2&before=journal%3Aopaque%2Fbefore")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([first, second])
    expect(response.headers.get("access-control-expose-headers")).toBe("X-Next-Cursor")
    expect(response.headers.get("x-next-cursor")).toBe("journal:opaque/next")
    expect(calls).toEqual([{
      sessionId: "session-1",
      page: { limit: 2, before: "journal:opaque/before" },
      directory: "/workspace",
    }])
    expect(adapterResolutions).toBe(1)
  })

  test("uses an optional adapter page when the route authority has no page", async () => {
    const calls: Array<{ id: string; page: AgentMessagePageInput; directory: RuntimeDirectory }> = []
    const app = routes({
      adapter: adapter({
        getMessagePage: async (id, page, directory) => {
          calls.push({ id, page, directory })
          return { messages: [second] }
        },
      }),
    })

    const response = await app.request("http://localhost/session/session-1/message?limit=1")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([second])
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(calls).toEqual([{ id: "session-1", page: { limit: 1 }, directory: undefined }])
  })

  test("forwards the authoritative latest-turn view without a numeric limit", async () => {
    const calls: AgentMessagePageInput[] = []
    const app = routes({
      adapter: adapter({
        getMessagePage: async (_id, page) => {
          calls.push(page)
          return { messages: [first, second], nextCursor: "before-user" }
        },
      }),
    })

    const response = await app.request("http://localhost/session/session-1/message?view=latest-turn")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([first, second])
    expect(response.headers.get("x-next-cursor")).toBe("before-user")
    expect(calls).toEqual([{ view: "latest-turn" }])
  })

  test("returns unsupported instead of violating a bounded request with full history", async () => {
    let routeFullReads = 0
    let adapterFullReads = 0
    const fixture = adapter({ messages: [first, second] })
    fixture.getMessages = async () => {
      adapterFullReads += 1
      return [first, second]
    }
    const app = createSessionRoutes({
      resolveAdapter: () => fixture,
      resolveDirectory: () => "/workspace",
      getMessages: () => {
        routeFullReads += 1
        return [first, second]
      },
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })
    const response = await app.request("http://localhost/session/session-1/message?limit=1")

    expect(response.status).toBe(501)
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(routeFullReads).toBe(0)
    expect(adapterFullReads).toBe(0)
  })

  test("preserves full history for legacy requests without paging parameters", async () => {
    let pageReads = 0
    const response = await routes({
      adapter: adapter({
        messages: [first, second],
        getMessagePage: async () => {
          pageReads += 1
          return { messages: [second] }
        },
      }),
    }).request("http://localhost/session/session-1/message")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([first, second])
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(pageReads).toBe(0)
  })

  test("keeps snapshot reads full and ignores paging parameters", async () => {
    let pageCalls = 0
    const snapshot = { messages: [first, second], maxEventOrdinal: 14 }
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveDirectory: () => "/workspace",
      getMessageSnapshot: () => snapshot,
      getMessagePage: () => {
        pageCalls += 1
        return { messages: [second], nextCursor: "must-not-leak" }
      },
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })

    const response = await app.request("http://localhost/session/session-1/message?snapshot=1&limit=invalid&before=")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ...snapshot,
      session: {
        id: "session-1",
        title: "Hybrid",
        time: { created: 1, updated: 1 },
      },
    })
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(pageCalls).toBe(0)
  })

  test("rejects malformed page inputs before resolving a producer", async () => {
    let adapterResolutions = 0
    const app = createSessionRoutes({
      resolveAdapter: () => {
        adapterResolutions += 1
        return adapter()
      },
      resolveDirectory: () => "/workspace",
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })

    for (const query of [
      "limit=0",
      "limit=1.5",
      "limit=501",
      "before=cursor",
      "limit=1&before=",
      "view=unknown",
      "view=latest-turn&limit=1",
      "view=latest-turn&before=cursor",
    ]) {
      const response = await app.request(`http://localhost/session/session-1/message?${query}`)
      expect(response.status).toBe(400)
    }
    expect(adapterResolutions).toBe(0)
  })

  test("maps typed route and adapter page errors to their explicit HTTP status", async () => {
    const routeErrorApp = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveDirectory: () => "/workspace",
      getMessagePage: () => { throw new AgentMessagePageError(404, "session was not found") },
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })
    const adapterErrorApp = routes({
      adapter: adapter({
        getMessagePage: async () => { throw new AgentMessagePageError(400, "cursor is invalid") },
      }),
    })

    const [missing, invalid] = await Promise.all([
      routeErrorApp.request("http://localhost/session/missing/message?limit=1"),
      adapterErrorApp.request("http://localhost/session/session-1/message?limit=1&before=opaque"),
    ])

    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain("session was not found")
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toContain("cursor is invalid")
  })

  test("does not trust an invalid status from an adapter page error", async () => {
    const app = routes({
      adapter: adapter({
        getMessagePage: async () => { throw new AgentMessagePageError(200, "invalid producer status") },
      }),
    })

    const response = await app.request("http://localhost/session/session-1/message?limit=1")

    expect(response.status).toBe(502)
  })
})

function routes(input: {
  adapter: AgentHarnessAdapter
  events?: CompatEnvelope[]
  busEvents?: RuntimeSessionBusEvent[]
  lifecycle?: SessionLifecycleEvent[]
  getMessages?: (directory: RuntimeDirectory, sessionId: string) => Promise<AgentMessageRow[] | undefined> | AgentMessageRow[] | undefined
  getMessageSnapshot?: (directory: RuntimeDirectory, sessionId: string) => Promise<{ messages: AgentMessageRow[]; maxEventOrdinal?: number } | undefined> | { messages: AgentMessageRow[]; maxEventOrdinal?: number } | undefined
  getSession?: (directory: RuntimeDirectory, sessionId: string) => Promise<AgentSessionRow | null> | AgentSessionRow | null
  sessionAccessPolicy?: SessionAccessPolicy
  afterCreateSession?: (directory: RuntimeDirectory, session: unknown) => Promise<void> | void
}) {
  return createSessionRoutes({
    resolveAdapter: () => input.adapter,
    resolveDirectory: () => undefined,
    sessionBus: {
      publish: (event) => input.busEvents?.push(event),
      subscribe: () => () => {},
    },
    publishGlobal: (event) => input.events?.push(event),
    publishSessionLifecycle: (event) => input.lifecycle?.push(event),
    getMessages: input.getMessages ? (_c, directory, sessionId) => input.getMessages?.(directory, sessionId) : undefined,
    getMessageSnapshot: input.getMessageSnapshot
      ? (_c, directory, sessionId) => input.getMessageSnapshot?.(directory, sessionId)
      : undefined,
    getSession: input.getSession
      ? (_c, directory, sessionId) => input.getSession?.(directory, sessionId) ?? null
      : undefined,
    sessionAccessPolicy: input.sessionAccessPolicy,
    afterCreateSession: input.afterCreateSession
      ? (_c, directory, session) => input.afterCreateSession?.(directory, session)
      : undefined,
  })
}

function registrationPolicy(
  registerSession: NonNullable<SessionAccessPolicy["registerSession"]>,
): SessionAccessPolicy {
  return {
    sessionAuthority: "managed-private",
    authorize: async () => ({ allowed: true }),
    authorizePrefix: async () => ({ allowed: true }),
    filterSessions: async (input) => input.sessionIds,
    registerSession,
  }
}

describe("createSessionRoutes directory-less sessions", () => {
  test("persists the complete config before publishing a created session", async () => {
    const calls: string[] = []
    const lifecycle: SessionLifecycleEvent[] = []
    const item = adapter()
    const app = routes({
      lifecycle,
      adapter: {
        ...item,
        createSession: async () => {
          calls.push("create")
          return { id: "session_configured" }
        },
        updateSessionConfig: async (id, update) => {
          calls.push(`config:${id}:${update.model?.providerID}:${update.model?.modelID}`)
          return {
            harness: update.harness ?? { id: "claude", access: "native" },
            ...(update.model ? { model: update.model } : {}),
            agent: update.agent ?? null,
            variant: update.variant ?? null,
          }
        },
      },
    })

    const res = await app.request("http://localhost/session", {
      method: "POST",
      body: JSON.stringify({
        model: { providerID: "claude-sdk", id: "sonnet", variant: "high" },
        agent: "build",
      }),
    })

    expect(res.status).toBe(201)
    expect(calls).toEqual(["create", "config:session_configured:claude-sdk:sonnet"])
    expect(lifecycle.map((event) => event.phase)).toEqual(["creating", "created"])
  })

  test("rolls back a session whose initial config cannot be persisted", async () => {
    const calls: string[] = []
    const lifecycle: SessionLifecycleEvent[] = []
    const item = adapter()
    const app = routes({
      lifecycle,
      adapter: {
        ...item,
        createSession: async () => ({ id: "session_rejected" }),
        updateSessionConfig: async () => {
          calls.push("config")
          throw new Error("config unavailable")
        },
        deleteSession: async (id) => {
          calls.push(`delete:${id}`)
        },
      },
    })

    const res = await app.request("http://localhost/session", {
      method: "POST",
      body: JSON.stringify({
        model: { providerID: "claude-sdk", id: "sonnet" },
      }),
    })

    expect(res.status).toBe(500)
    expect(calls).toEqual(["config", "delete:session_rejected"])
    expect(lifecycle.map((event) => event.phase)).toEqual(["creating", "failed"])
    expect(await res.json()).toMatchObject({ error: { message: "config unavailable" } })
  })

  test("rolls back an explicit registration denial so the same requested id can retry", async () => {
    const persisted = new Set<string>()
    const calls: string[] = []
    let attempts = 0
    const item = adapter()
    const app = routes({
      adapter: {
        ...item,
        createSession: async (_directory, _title, id = "generated") => {
          if (persisted.has(id)) throw new Error("session already exists")
          persisted.add(id)
          calls.push(`create:${id}`)
          return { id }
        },
        deleteSession: async (id) => {
          calls.push(`delete:${id}`)
          persisted.delete(id)
        },
      },
      sessionAccessPolicy: registrationPolicy(async () => {
        attempts += 1
        return attempts === 1
          ? { allowed: false, status: 403, code: "session_private", message: "Registration denied" }
          : { allowed: true }
      }),
    })

    const request = () => app.request("http://localhost/session", {
      method: "POST",
      body: JSON.stringify({ id: "session_stable" }),
    })
    expect((await request()).status).toBe(403)
    expect((await request()).status).toBe(201)
    expect(calls).toEqual([
      "create:session_stable",
      "delete:session_stable",
      "create:session_stable",
    ])
  })

  test("reconciles a timeout after registration commit before compensating", async () => {
    const calls: string[] = []
    let registrations = 0
    const item = adapter()
    const app = routes({
      adapter: {
        ...item,
        createSession: async () => ({ id: "session_committed" }),
        deleteSession: async (id) => { calls.push(`delete:${id}`) },
      },
      sessionAccessPolicy: registrationPolicy(async () => {
        registrations += 1
        if (registrations === 1) throw new Error("authority response timed out after commit")
        return { allowed: true }
      }),
    })

    const response = await app.request("http://localhost/session", { method: "POST", body: "{}" })

    expect(response.status).toBe(201)
    expect(registrations).toBe(2)
    expect(calls).toEqual([])
  })

  test("registers and projects a forked child before returning it", async () => {
    const calls: string[] = []
    const item = adapter()
    const app = routes({
      adapter: {
        ...item,
        forkSession: async () => {
          calls.push("fork")
          return { id: "session_child" }
        },
      },
      sessionAccessPolicy: registrationPolicy(async (input) => {
        calls.push(`register:${input.sessionId}`)
        return { allowed: true }
      }),
      afterCreateSession: async (_directory, session) => {
        calls.push(`project:${(session as { id: string }).id}`)
      },
    })

    const response = await app.request("http://localhost/session/session_parent/fork", {
      method: "POST",
      body: JSON.stringify({ messageId: "message_1" }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: "session_child" })
    expect(calls).toEqual(["fork", "register:session_child", "project:session_child"])
  })

  test("deletes a forked child when registration is denied", async () => {
    const calls: string[] = []
    const item = adapter()
    const app = routes({
      adapter: {
        ...item,
        forkSession: async () => ({ id: "session_child" }),
        deleteSession: async (id) => { calls.push(`delete:${id}`) },
      },
      sessionAccessPolicy: registrationPolicy(async () => ({
        allowed: false,
        status: 403,
        code: "session_private",
        message: "Registration denied",
      })),
      afterCreateSession: async () => { calls.push("project") },
    })

    const response = await app.request("http://localhost/session/session_parent/fork", {
      method: "POST",
      body: "{}",
    })

    expect(response.status).toBe(403)
    expect(calls).toEqual(["delete:session_child"])
  })

  test("keeps a missing backend title empty in the created lifecycle row", async () => {
    const lifecycle: SessionLifecycleEvent[] = []
    const res = await routes({ adapter: adapter(), lifecycle }).request("http://localhost/session", {
      method: "POST",
      body: "{}",
    })

    expect(res.status).toBe(201)
    expect((lifecycle.find((event) => event.phase === "created")?.info as { title?: string } | undefined)?.title).toBe("")
  })

  test("filters transcript-bearing collections through the verified relay actor", async () => {
    const calls: Array<{ operation: string; actorId?: string; sessionIds: string[] }> = []
    const policy: SessionAccessPolicy = {
      authorize: async () => ({ allowed: true }),
      authorizePrefix: async () => ({ allowed: true }),
      filterSessions: async (input) => {
        calls.push({
          operation: input.operation,
          actorId: input.actor?.actorId,
          sessionIds: [...input.sessionIds],
        })
        return input.sessionIds.filter((id) => id === "session_allowed")
      },
    }
    const routes = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveDirectory: () => undefined,
      listSessions: async () => [
        { id: "session_allowed" },
        { id: "session_hidden" },
      ] as AgentSessionRow[],
      getStatus: () => ({ session_allowed: { type: "idle" }, session_hidden: { type: "busy" } }),
      listPermissions: async () => [
        { id: "perm_allowed", sessionID: "session_allowed" },
        { id: "perm_hidden", sessionID: "session_hidden" },
      ] as AgentPermissionRow[],
      listQuestions: async () => [
        { id: "question_allowed", sessionID: "session_allowed", questions: [] },
        { id: "question_hidden", sessionID: "session_hidden", questions: [] },
      ] as AgentQuestionRow[],
      sessionAccessPolicy: policy,
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    })
    const app = new Hono()
    app.use("*", async (c, next) => {
      ;(c as unknown as { set(name: string, value: unknown): void }).set("relayHostAuth", {
        actor_id: "actor_verified",
        actor_kind: "human",
        workspace_id: "ws_1",
        org_id: "org_1",
        role: "editor",
      })
      await next()
    })
    app.route("/", routes)

    expect(await (await app.request("http://localhost/session")).json()).toHaveLength(1)
    expect(await (await app.request("http://localhost/session/status")).json()).toEqual({ session_allowed: { type: "idle" } })
    expect(await (await app.request("http://localhost/permission")).json()).toEqual([
      { id: "perm_allowed", sessionID: "session_allowed" },
    ])
    expect(await (await app.request("http://localhost/question")).json()).toEqual([
      { id: "question_allowed", sessionID: "session_allowed", questions: [] },
    ])
    expect(calls).toEqual([
      { operation: "session_list", actorId: "actor_verified", sessionIds: ["session_allowed", "session_hidden"] },
      { operation: "session_status", actorId: "actor_verified", sessionIds: ["session_allowed", "session_hidden"] },
      { operation: "permission_list", actorId: "actor_verified", sessionIds: ["session_allowed", "session_hidden"] },
      { operation: "question_list", actorId: "actor_verified", sessionIds: ["session_allowed", "session_hidden"] },
    ])
  })

  test("threads immutable actor attribution from verified relay claims and ignores body spoofing", async () => {
    const starts: unknown[] = []
    const routes = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveRuntime: () => ({
        turns: {
          start: async (input: unknown) => {
            starts.push(input)
            return {
              sessionId: "session_1",
              userMessageId: "user_1",
              assistantMessageId: "assistant_1",
              directory: undefined,
              prompt: {
                parts: [],
                userMessageId: "user_1",
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
      } as unknown as AgentRuntime),
      resolveDirectory: () => undefined,
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    })
    const app = new Hono()
    app.use("*", async (c, next) => {
      ;(c as unknown as { set(name: string, value: unknown): void }).set("relayHostAuth", {
        actor_id: "actor_verified",
        actor_kind: "human",
        actor_public_id: "user_public_verified",
        actor_name: "Verified User",
        actor_avatar_url: "https://example.invalid/avatar",
        workspace_id: "ws_1",
        org_id: "org_1",
        role: "editor",
      })
      await next()
    })
    app.route("/", routes)

    const response = await app.request("http://localhost/session/session_1/message", {
      method: "POST",
      body: JSON.stringify({
        actorId: "actor_attacker",
        actorKind: "agent",
        author: { id: "attacker", name: "Attacker", kind: "agent" },
        parts: [],
      }),
    })

    expect(response.status).toBe(200)
    expect(starts).toEqual([expect.objectContaining({
      actorId: "actor_verified",
      actorKind: "human",
      author: {
        id: "user_public_verified",
        name: "Verified User",
        avatarUrl: "https://example.invalid/avatar",
        kind: "human",
      },
    })])
  })

  test("returns an empty agent list when harness cannot expose live agent options", async () => {
    const res = await routes({
      adapter: {
        ...adapter(),
        listAgents: async () => {
          throw new Error("opencode does not expose live agent options")
        },
      },
    }).request("http://localhost/agent")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("passes undefined directory through detail routes", async () => {
    const directories: RuntimeDirectory[] = []
    const res = await routes({
      adapter: adapter({ onDirectory: (directory) => directories.push(directory) }),
    }).request("http://localhost/session/session_1/capabilities")

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ harness: "opencode" })
    expect(directories).toEqual([undefined])
  })

  test("returns snapshot metadata and the canonical session together", async () => {
    const messages: AgentMessageRow[] = [{
      info: { id: "message_1", sessionID: "session_1", role: "assistant" },
      parts: [],
    }]
    const res = await routes({
      adapter: adapter(),
      getMessageSnapshot: () => ({ messages, maxEventOrdinal: 7 }),
      getSession: () => ({ id: "session_1", title: "Settled", time: { created: 1, updated: 2 } }),
    }).request("http://localhost/session/session_1/message?snapshot=1")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      messages,
      maxEventOrdinal: 7,
      session: { id: "session_1", title: "Settled", time: { created: 1, updated: 2 } },
    })
  })

  test("wraps replay messages with the canonical session only for snapshot callers", async () => {
    const messages: AgentMessageRow[] = [{
      info: { id: "message_1", sessionID: "session_1", role: "assistant" },
      parts: [],
    }]
    const app = routes({
      adapter: adapter(),
      getMessages: () => messages,
      getSession: () => ({ id: "session_1", title: "Settled", time: { created: 1, updated: 2 } }),
    })

    const snapshot = await app.request("http://localhost/session/session_1/message?snapshot=1")
    const replay = await app.request("http://localhost/session/session_1/message")

    expect(await snapshot.json()).toEqual({
      messages,
      session: { id: "session_1", title: "Settled", time: { created: 1, updated: 2 } },
    })
    expect(await replay.json()).toEqual(messages)
  })

  test("fails a snapshot when its canonical session no longer exists", async () => {
    const res = await routes({
      adapter: adapter(),
      getMessageSnapshot: () => ({ messages: [], maxEventOrdinal: 7 }),
      getSession: () => null,
    }).request("http://localhost/session/session_missing/message?snapshot=1")

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: "session_not_found", message: "Session not found" },
    })
  })

  test("reads durable subagent associations without consulting the harness", async () => {
    const calls: Array<{ directory: RuntimeDirectory; parentSessionId: string }> = []
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveDirectory: () => undefined,
      listSubagents: (_c, directory, parentSessionId) => {
        calls.push({ directory, parentSessionId })
        return [{ subagentKey: "child_1", revision: 3, status: "running" }]
      },
      sessionBus: {
        publish: () => {},
        subscribe: () => () => {},
      },
      publishGlobal: () => {},
    })
    const res = await app.request("http://localhost/session/parent_1/subagents")

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual([{ subagentKey: "child_1", revision: 3, status: "running" }])
    expect(calls).toEqual([{ directory: undefined, parentSessionId: "parent_1" }])
  })

  test("uses session id as legacy event scope when directory is absent", async () => {
    const events: CompatEnvelope[] = []
    const busEvents: RuntimeSessionBusEvent[] = []
    const res = await routes({
      events,
      busEvents,
      adapter: adapter({
        events: [
          messageUpdated({
            id: "user_1",
            sessionID: "session_1",
            role: "user",
            time: { created: 1 },
          } as Message),
          messagePartUpdated({
            id: "user_1_part_0",
            sessionID: "session_1",
            messageID: "user_1",
            type: "text",
            text: "hello",
          }),
          messageUpdated({
            id: "assistant_1",
            sessionID: "session_1",
            role: "assistant",
            time: { created: 1 },
          } as Message),
          sessionIdle("session_1"),
        ],
        messages: [{
          info: {
            id: "assistant_1",
            sessionID: "session_1",
            role: "assistant",
          },
          parts: [],
        }],
      }),
    }).request("http://localhost/session/session_1/message", {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "test", modelID: "fixture" },
        variant: "fixture",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(events.map((event) => event.directory)).toEqual(["session_1", "session_1", "session_1", "session_1"])
    expect(events.map((event) => event.payload.type).slice(0, 2)).toEqual(["message.updated", "message.part.updated"])
    expect(busEvents).toEqual([
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
    ])
  })

  test("can run message turns through the agent runtime facade", async () => {
    const events: CompatEnvelope[] = []
    const busEvents: RuntimeSessionBusEvent[] = []
    const messages: AgentMessageRow[] = [{
      info: {
        id: "assistant_1",
        sessionID: "session_1",
        role: "assistant",
      },
      parts: [],
    }]
    const turnStarts: unknown[] = []
    const runtime = {
      turns: {
        start: async (input: unknown) => {
          turnStarts.push(input)
          return {
            sessionId: "session_1",
            userMessageId: "user_1",
            assistantMessageId: "assistant_1",
            directory: undefined,
            prompt: {
              parts: [{ type: "text", text: "hello" }],
              userMessageId: "user_1",
              assistantMessageId: "assistant_1",
              agent: "build",
              model: { providerID: "test", modelID: "fixture" },
            },
          }
        },
      },
      events: {
        subscribe: () => (async function*() {
          yield {
            sessionId: "session_1",
            directory: undefined,
            payload: messageUpdated({
              id: "assistant_1",
              sessionID: "session_1",
              role: "assistant",
              time: { created: 1 },
            } as Message),
          }
          yield {
            sessionId: "session_1",
            directory: undefined,
            payload: sessionIdle("session_1"),
          }
        })(),
        list: async () => messages,
      },
    } as unknown as AgentRuntime
    const app = createSessionRoutes({
      resolveAdapter: () => ({
        ...adapter(),
        setPermissionMode: async () => {
          throw new Error("permission mode must be applied by AgentRuntime")
        },
      }),
      resolveRuntime: () => runtime,
      resolveDirectory: () => undefined,
      sessionBus: {
        publish: (event) => busEvents.push(event),
        subscribe: () => () => {},
      },
      publishGlobal: (event) => events.push(event),
    })

    const res = await app.request("http://localhost/session/session_1/message", {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "test", modelID: "fixture" },
        permissionMode: "winner-mode",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(messages[0])
    expect(turnStarts).toEqual([{
      sessionId: "session_1",
      onAdmitted: expect.any(Function),
      parts: [{ type: "text", text: "hello" }],
      agent: "build",
      model: { providerID: "test", modelID: "fixture" },
      permissionMode: "winner-mode",
    }])
    expect(events.map((event) => event.payload.type)).toEqual(["message.updated", "session.idle"])
    expect(busEvents).toEqual([
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
      { type: "process.status", directory: "session_1", configId: "session_1", status: "streaming" },
    ])
  })

  test("preserves the cause instead of flattening a failed turn to 'Stream error'", async () => {
    const events: CompatEnvelope[] = []
    const runtime = {
      turns: {
        start: async () => {
          throw new Error("thread not found: 019f73fb-ef5d-7fd0-9011-124481bc6ef0")
        },
      },
      events: {
        subscribe: () => (async function* () {})(),
        list: async () => [],
      },
    } as unknown as AgentRuntime
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveRuntime: () => runtime,
      resolveDirectory: () => undefined,
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: (event) => events.push(event),
    })

    const res = await app.request("http://localhost/session/session_1/prompt_async", {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "test", modelID: "fixture" },
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    // prompt_async is fire-and-forget: the route acknowledges immediately.
    expect(res.status).toBe(204)
    // Let the detached turn run its catch/finally and publish its failure.
    await new Promise((resolve) => setTimeout(resolve, 10))

    const sessionErrors = events.filter((event) => event.payload.type === "session.error")
    expect(sessionErrors.length).toBeGreaterThan(0)
    for (const event of sessionErrors) {
      const error = (event.payload as { properties: { error: { data?: { message?: string; firstTurnErrorClass?: string } } } })
        .properties.error
      // The real cause survives — never the literal "Stream error".
      expect(error.data?.message).not.toBe("Stream error")
      expect(error.data?.message).toContain("thread not found")
      // And it now classifies (a lost thread → session recovery, not the old workspace fallback).
      expect(error.data?.firstTurnErrorClass).toBe("session")
    }
  })

  test("returns sender-only structured conflicts for message and prompt_async", async () => {
    const events: CompatEnvelope[] = []
    const runtime = {
      turns: {
        start: async () => {
          throw new AgentRuntimeTurnConflictError("session_1")
        },
      },
      events: {
        subscribe: () => (async function* () {})(),
        list: async () => [],
      },
    } as unknown as AgentRuntime
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveRuntime: () => runtime,
      resolveDirectory: () => undefined,
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: (event) => events.push(event),
    })
    const request = () => ({
      method: "POST",
      body: JSON.stringify({
        messageID: "loser",
        permissionMode: "loser-mode",
        parts: [{ type: "text", text: "hello" }],
      }),
    })

    const message = await app.request("http://localhost/session/session_1/message", request())
    const promptAsync = await app.request("http://localhost/session/session_1/prompt_async", request())

    expect(message.status).toBe(409)
    expect(await message.json()).toMatchObject({ error: { code: "session_turn_in_progress" } })
    expect(promptAsync.status).toBe(409)
    expect(await promptAsync.json()).toMatchObject({ error: { code: "session_turn_in_progress" } })
    expect(events.some((event) => event.payload.type === "session.error")).toBe(false)

    const unsupported = await createSessionRoutes({
      resolveAdapter: () => ({ ...adapter(), executeCommand: undefined }) as unknown as AgentHarnessAdapter,
      resolveDirectory: () => undefined,
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    }).request("http://localhost/session/session_1/command", {
      method: "POST",
      body: JSON.stringify({ command: "test" }),
    })
    expect(unsupported.status).toBe(409)
    expect(await unsupported.json()).toMatchObject({ error: { code: "unsupported_operation" } })
  })

  test("prompt_async falls back to 204 when admission does not settle within the bound", async () => {
    // turns.start hangs before ever settling admission (a wedged adapter spawn).
    // Without the timeout the request would hang forever; with it the route
    // honors prompt_async's fire-and-forget contract.
    const runtime = {
      turns: {
        start: () => new Promise(() => {}),
      },
      events: {
        subscribe: () => (async function* () {})(),
        list: async () => [],
      },
    } as unknown as AgentRuntime
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveRuntime: () => runtime,
      resolveDirectory: () => undefined,
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
      promptAsyncAdmissionAckTimeoutMs: 30,
    })

    const res = await app.request("http://localhost/session/session_1/prompt_async", {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
    })

    expect(res.status).toBe(204)
  })

  test("keeps prompt_async success empty and 204", async () => {
    const runtime = {
      turns: {
        start: async () => ({
          sessionId: "session_1",
          userMessageId: "user_1",
          assistantMessageId: "assistant_1",
          directory: undefined,
          prompt: {
            parts: [],
            userMessageId: "user_1",
            assistantMessageId: "assistant_1",
            agent: "build",
            model: { providerID: "test", modelID: "fixture" },
          },
        }),
      },
      events: {
        subscribe: () => (async function* () {
          yield { sessionId: "session_1", directory: undefined, payload: sessionIdle("session_1") }
        })(),
        list: async () => [],
      },
    } as unknown as AgentRuntime
    const response = await createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveRuntime: () => runtime,
      resolveDirectory: () => undefined,
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    }).request("http://localhost/session/session_1/prompt_async", {
      method: "POST",
      body: JSON.stringify({ messageID: "winner", parts: [] }),
    })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
  })

  test("admits exactly one real runtime turn across two route clients", async () => {
    let markStarted: (() => void) | undefined
    let finish: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      finish = resolve
    })
    const modes: string[] = []
    let activeScopes = 0
    const messages: AgentMessageRow[] = [{
      info: { id: "winner_r", sessionID: "session_1", role: "assistant" },
      parts: [],
    }]
    const integrationAdapter: AgentHarnessAdapter = {
      ...adapter({ messages }),
      async *sendMessage(id, prompt) {
        if (prompt.permissionMode) modes.push(prompt.permissionMode)
        markStarted?.()
        yield messageUpdated({
          id: prompt.userMessageId,
          sessionID: id,
          role: "user",
          time: { created: 1 },
        } as Message)
        yield messageUpdated({
          id: prompt.assistantMessageId,
          sessionID: id,
          parentID: prompt.userMessageId,
          role: "assistant",
          time: { created: 2 },
        } as Message)
        await blocked
        yield sessionIdle(id)
      },
    }
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [{
        id: "pi",
        access: "native",
        create: () => integrationAdapter,
      } as unknown as AgentHarnessFactory],
    })
    await runtime.sessions.create({
      id: "session_1",
      directory: undefined,
      harness: { id: "pi", access: "native" },
    })
    const events: CompatEnvelope[] = []
    const app = createSessionRoutes({
      resolveAdapter: () => integrationAdapter,
      resolveRuntime: () => runtime,
      resolveDirectory: () => undefined,
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: (event) => events.push(event),
      createActiveTurnScope: () => {
        activeScopes++
        return { dispose: () => {} }
      },
    })
    const first = app.request("http://localhost/session/session_1/message", {
      method: "POST",
      body: JSON.stringify({
        messageID: "winner",
        permissionMode: "winner-mode",
        parts: [{ type: "text", text: "first" }],
      }),
    })
    await started

    const second = await app.request("http://localhost/session/session_1/prompt_async", {
      method: "POST",
      body: JSON.stringify({
        messageID: "loser",
        permissionMode: "loser-mode",
        parts: [{ type: "text", text: "second" }],
      }),
    })

    expect(second.status).toBe(409)
    expect(modes).toEqual(["winner-mode"])
    expect(activeScopes).toBe(1)
    expect(events.filter((event) =>
      event.payload.type === "message.updated" && event.payload.properties.info.role === "user"
    )).toHaveLength(1)
    expect(events.some((event) => event.payload.type === "session.error")).toBe(false)

    finish?.()
    expect((await first).status).toBe(200)
    runtime.dispose()
  })

  test("prompt_async continues after its accepted client request disconnects", async () => {
    let finishTurn = () => {}
    const turnGate = new Promise<void>((resolve) => { finishTurn = resolve })
    let completeDisposal = () => {}
    const disposal = new Promise<void>((resolve) => { completeDisposal = resolve })
    let disposed = false
    const events: CompatEnvelope[] = []
    const runtime = {
      turns: {
        start: async (input: { onAdmitted?: () => void }) => {
          input.onAdmitted?.()
          return {
            sessionId: "session_1",
            userMessageId: "user_1",
            assistantMessageId: "assistant_1",
            directory: undefined,
            prompt: {
              parts: [{ type: "text", text: "continue" }],
              userMessageId: "user_1",
              assistantMessageId: "assistant_1",
              agent: "build",
              model: { providerID: "test", modelID: "fixture" },
            },
          }
        },
      },
      events: {
        subscribe: () => (async function* () {
          await turnGate
          yield {
            sessionId: "session_1",
            directory: undefined,
            payload: sessionIdle("session_1"),
          }
        })(),
        list: async () => [],
      },
    } as unknown as AgentRuntime
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveRuntime: () => runtime,
      resolveDirectory: () => undefined,
      createActiveTurnScope: () => ({
        dispose: () => {
          disposed = true
          completeDisposal()
        },
      }),
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: (event) => events.push(event),
    })
    const client = new AbortController()

    const response = await app.request("http://localhost/session/session_1/prompt_async", {
      method: "POST",
      signal: client.signal,
      body: JSON.stringify({ parts: [{ type: "text", text: "continue" }] }),
    })
    expect(response.status).toBe(204)

    client.abort()
    finishTurn()
    await disposal

    expect(events.map((event) => event.payload.type)).toContain("session.idle")
    expect(disposed).toBe(true)
  })
})
