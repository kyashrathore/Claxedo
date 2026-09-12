import { describe, expect, test } from "bun:test"
import { createSessionRoutes, type RuntimeSessionBusEvent, type SessionLifecycleEvent } from "./session-core"
import type {
  AgentHarnessFactory,
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentRuntime,
  AgentRuntimeStreamEvent,
  AgentSession,
  HarnessCapabilities,
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
// These fixtures carry only the fields the routes under test read; the cast
// keeps them minimal rather than filling in a full UserMessage/AssistantMessage.
import { messagePartUpdated, messageUpdated, sessionIdle, type CompatEnvelope } from "../compat-events"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import { Hono } from "hono"
import type { SessionAccessPolicy } from "../session-access-policy"

function adapter(input: {
  onDirectory?: (directory: RuntimeDirectory) => void
  events?: AgentRuntimeStreamEvent[]
  messages?: AgentMessage[]
  getMessagePage?: (
    id: string,
    page: AgentMessagePageInput,
    directory: RuntimeDirectory,
  ) => Promise<AgentMessagePage>
} = {}): AgentHarnessAdapter {
  return {
    getSession: async (binding) => {
      input.onDirectory?.(binding.directory)
      return { id: binding.sessionId, title: "Hybrid", time: { created: 1, updated: 1 } }
    },
    createSession: async () => ({ id: "session_1" }),
    updateSession: async (binding) => ({ id: binding.sessionId, title: "Hybrid", time: { created: 1, updated: 1 } }),
    getSessionConfig: async (binding) => {
      input.onDirectory?.(binding.directory)
      return {
        harness: { id: "codex", access: "native" },
        model: { providerID: "test", modelID: "fixture" },
        agent: "build",
        variant: null,
      } satisfies SessionConfig
    },
    updateSessionConfig: async (_binding, patch) => ({
      harness: patch.harness ?? { id: "codex", access: "native" },
      ...(patch.model ? { model: patch.model } : {}),
      agent: patch.agent ?? null,
      variant: patch.variant ?? null,
    }),
    deleteSession: async () => {},
    readHarnessCapabilities: (directory) => {
      input.onDirectory?.(directory)
      return {
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
        goals: false,
      }
    },
    executeTurn: (binding, _prompt) => (async function* () {
      input.onDirectory?.(binding.directory)
      for (const event of input.events ?? []) yield event
    })(),
    getMessages: async (binding) => {
      input.onDirectory?.(binding.directory)
      return input.messages ?? []
    },
    ...(input.getMessagePage ? {
      getMessagePage: (binding, page) => input.getMessagePage!(binding.sessionId, page, binding.directory),
    } : {}),
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
    probeConfigOptions: async () => ({ options: [] }),
    dispose: () => {},
  }
}

/**
 * Every route fixture needs the binding its host would resolve; a fixture
 * without one fails the prompt routes' permission read long before the
 * behaviour under test runs.
 */
function fixtureExecutionBinding(workspaceId = "workspace-test") {
  return (_c: unknown, directory: RuntimeDirectory, sessionId: string): AgentExecutionBinding => ({
    sessionId,
    workspaceId,
    directory: directory ?? "",
    connectionId: "native:codex",
    upstreamSessionId: sessionId,
  })
}

function managedRoutes(input: {
  policy: SessionAccessPolicy
  adapter: AgentHarnessAdapter
  listSessions?: () => Promise<AgentSession[]>
  runtime?: AgentRuntime
  publishGlobal?: (event: CompatEnvelope) => void
  afterMessageCheckpoint?: () => void
}) {
  const routes = createSessionRoutes({
    resolveAdapter: () => input.adapter,
    resolveDirectory: () => "/workspace",
    resolveExecutionBinding: fixtureExecutionBinding("ws_1"),
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
  test("managed event revocation ends the reader and ignores later private frames", async () => {
    let authorityCalls = 0
    let listener: ((event: unknown) => void) | undefined
    const policy = managedPolicy({
      authorizeStream: async () => {
        authorityCalls += 1
        return authorityCalls === 1
          ? { allowed: true, lease: "lease_short", expiresAt: Date.now() + 30 }
          : { allowed: false, status: 403, code: "session_revoked", message: "revoked" }
      },
    })
    const app = createSessionRoutes({
      resolveAdapter: () => adapter(),
      resolveDirectory: () => "/workspace",
      sessionAccessPolicy: policy,
      sessionBus: {
        publish: () => {},
        subscribe: (next) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
      },
      publishGlobal: () => {},
    })
    const wrapped = new Hono()
    wrapped.use("*", async (c, next) => {
      ;(c as any).set("relayHostAuth", {
        actor_id: "actor_1",
        actor_kind: "human",
        org_id: "org_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        role: "editor",
      })
      await next()
    })
    wrapped.route("/", app)

    const response = await wrapped.request("http://localhost/event?sessionID=ses_private")
    const reader = response.body!.getReader()
    const ended = await Promise.race([
      reader.read().then((item) => item.done),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ])
    listener?.({ type: "session.updated", properties: { info: { id: "ses_private" } } })

    expect(response.status).toBe(200)
    expect(ended).toBe(true)
    expect((await reader.read()).done).toBe(true)
  })

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
      getSession: async (binding: AgentExecutionBinding) => existing ? { id: binding.sessionId, title: "Private", time: { created: 1, updated: 1 } } : null,
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
      forkSession: async (binding: AgentExecutionBinding, messageId: string, childId?: string) => {
        calls.push({ parentId: binding.sessionId, messageId, directory: binding.directory, childId })
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

  test("holds the durable turn through checkpoint and final message publication", async () => {
    const calls: string[] = []
    const assistant = {
      info: { id: "assistant_1", sessionID: "ses_private", role: "assistant" },
      parts: [],
    } as AgentMessage
    const fixture = adapter({
      events: [
        messageUpdated(assistant.info),
        sessionIdle("ses_private"),
      ],
      messages: [assistant],
    })
    const response = await managedRoutes({
      policy: managedPolicy({
        releaseTurn: async () => {
          calls.push("release")
          return { released: true }
        },
      }),
      adapter: fixture,
      afterMessageCheckpoint: () => {
        calls.push("checkpoint")
      },
      publishGlobal: (event) => {
        calls.push(`publish:${event.payload.type}`)
      },
    }).request("/session/ses_private/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageID: "user_1", parts: [{ type: "text", text: "hello" }] }),
    })

    expect(response.status).toBe(200)
    const checkpoint = calls.indexOf("checkpoint")
    const finalPublish = calls.lastIndexOf("publish:message.updated")
    const release = calls.indexOf("release")
    expect(checkpoint).toBeGreaterThanOrEqual(0)
    expect(finalPublish).toBeGreaterThanOrEqual(0)
    expect(release).toBeGreaterThan(checkpoint)
    expect(release).toBeGreaterThan(finalPublish)
  })
})

describe("createSessionRoutes message paging", () => {
  const first = { info: { id: "message-1", sessionID: "session-1", role: "user" }, parts: [] } as AgentMessage
  const second = { info: { id: "message-2", sessionID: "session-1", role: "assistant" }, parts: [] } as AgentMessage

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
    expect(calls).toEqual([{ id: "session-1", page: { limit: 1 }, directory: "" }])
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
      resolveExecutionBinding: fixtureExecutionBinding(),
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
  getMessages?: (directory: RuntimeDirectory, sessionId: string) => Promise<AgentMessage[] | undefined> | AgentMessage[] | undefined
  getMessageSnapshot?: (directory: RuntimeDirectory, sessionId: string) => Promise<{ messages: AgentMessage[]; maxEventOrdinal?: number } | undefined> | { messages: AgentMessage[]; maxEventOrdinal?: number } | undefined
  getSession?: (directory: RuntimeDirectory, sessionId: string) => Promise<AgentSession | null> | AgentSession | null
  sessionAccessPolicy?: SessionAccessPolicy
  afterCreateSession?: (directory: RuntimeDirectory, session: unknown) => Promise<void> | void
}) {
  return createSessionRoutes({
    resolveAdapter: () => input.adapter,
    resolveExecutionBinding: fixtureExecutionBinding(),
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
    markRegistrationAmbiguous: async () => ({ allowed: true }),
    beginRegistrationCompensation: async () => ({ allowed: true }),
    completeRegistrationCompensation: async () => ({ allowed: true }),
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
        updateSessionConfig: async (binding, update) => {
          calls.push(`config:${binding.sessionId}:${update.model?.providerID}:${update.model?.modelID}`)
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
        deleteSession: async (binding) => {
          calls.push(`delete:${binding.sessionId}`)
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
        deleteSession: async (binding) => {
          calls.push(`delete:${binding.sessionId}`)
          persisted.delete(binding.sessionId)
        },
      },
      sessionAccessPolicy: registrationPolicy(async () => {
        attempts += 1
        return attempts === 1
          ? { allowed: false, status: 403, code: "session_private", message: "Registration denied" }
          : { allowed: true }
      }),
      getSession: (_directory, id) => persisted.has(id)
        ? { id, title: "Private", time: { created: 1, updated: 1 } }
        : null,
    })

    const request = () => app.request("http://localhost/session", {
      method: "POST",
      headers: { "x-claxedo-session-registration-operation": "op_stable" },
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

  test("preserves an ambiguous registration for exact-operation retry", async () => {
    const calls: string[] = []
    let registrations = 0
    const item = adapter()
    const app = routes({
      adapter: {
        ...item,
        createSession: async () => ({ id: "session_committed" }),
        deleteSession: async (binding) => { calls.push(`delete:${binding.sessionId}`) },
      },
      sessionAccessPolicy: registrationPolicy(async () => {
        registrations += 1
        if (registrations === 1) throw new Error("authority response timed out after commit")
        return { allowed: true }
      }),
    })

    const request = () => app.request("http://localhost/session", {
      method: "POST",
      headers: { "x-claxedo-session-registration-operation": "op_committed" },
      body: JSON.stringify({ id: "session_committed" }),
    })

    expect((await request()).status).toBe(503)
    expect((await request()).status).toBe(201)
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
      headers: { "x-claxedo-session-registration-operation": "op_fork_child" },
      body: JSON.stringify({ id: "session_child", messageId: "message_1" }),
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
        deleteSession: async (binding) => { calls.push(`delete:${binding.sessionId}`) },
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
      headers: { "x-claxedo-session-registration-operation": "op_fork_denied" },
      body: JSON.stringify({ id: "session_child" }),
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
      sessionAuthority: "managed-private",
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
      ] as AgentSession[],
      getStatus: () => ({ session_allowed: { type: "idle" }, session_hidden: { type: "busy" } }),
      listPermissions: async () => [
        { id: "perm_allowed", sessionID: "session_allowed" },
        { id: "perm_hidden", sessionID: "session_hidden" },
      ] as AgentPermission[],
      listQuestions: async () => [
        { id: "question_allowed", sessionID: "session_allowed", questions: [] },
        { id: "question_hidden", sessionID: "session_hidden", questions: [] },
      ] as AgentQuestion[],
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
    expect(await res.json()).toMatchObject({ harness: "codex" })
    expect(directories).toEqual([undefined])
  })

  test("returns snapshot metadata and the canonical session together", async () => {
    const messages: AgentMessage[] = [{
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
    const messages: AgentMessage[] = [{
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

  test("rejects a binding without its required machine directory before publishing prompt events", async () => {
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
          }),
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
          }),
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

    expect(res.status).toBe(500)
    expect(events).toEqual([])
    expect(busEvents).toEqual([])
  })

  test("can run message turns through the agent runtime facade", async () => {
    const events: CompatEnvelope[] = []
    const busEvents: RuntimeSessionBusEvent[] = []
    const messages: AgentMessage[] = [{
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
            }),
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
      resolveExecutionBinding: fixtureExecutionBinding(),
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
      resolveExecutionBinding: fixtureExecutionBinding(),
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

  test("shell forwards command, agent, model, and messageID to the adapter and discards its result", async () => {
    const calls: unknown[] = []
    const app = createSessionRoutes({
      resolveAdapter: () => ({
        ...adapter(),
        shell: async (id: string, input: unknown, directory: RuntimeDirectory) => {
          calls.push({ id, input, directory })
        },
      }),
      resolveDirectory: () => "/workspace",
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    })

    const response = await app.request("http://localhost/session/session_1/shell", {
      method: "POST",
      body: JSON.stringify({
        command: "ls -la",
        agent: "build",
        model: { providerID: "opencode", modelID: "model" },
        messageID: "msg_1",
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(calls).toEqual([{
      id: "session_1",
      input: {
        command: "ls -la",
        agent: "build",
        model: { providerID: "opencode", modelID: "model" },
        messageID: "msg_1",
      },
      directory: "/workspace",
    }])
  })

  test("shell defaults command and agent to empty strings and omits model/messageID when absent", async () => {
    const calls: unknown[] = []
    const app = createSessionRoutes({
      resolveAdapter: () => ({
        ...adapter(),
        shell: async (_id: string, input: unknown) => { calls.push(input) },
      }),
      resolveDirectory: () => "/workspace",
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    })

    const response = await app.request("http://localhost/session/session_1/shell", {
      method: "POST",
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(200)
    expect(calls).toEqual([{ command: "", agent: "" }])
  })

  test("shell refuses when the adapter does not advertise commands support", async () => {
    const response = await createSessionRoutes({
      resolveAdapter: () => ({
        ...adapter(),
        readHarnessCapabilities: () => ({
          harness: "codex",
          abort: false,
          reconnect: false,
          replay: false,
          permissions: false,
          questions: false,
          todos: false,
          commands: false,
          fork: false,
          revert: false,
          unrevert: false,
          configOptions: false,
          subagents: false,
        }),
        shell: undefined,
      }) as unknown as AgentHarnessAdapter,
      resolveDirectory: () => "/workspace",
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    }).request("http://localhost/session/session_1/shell", {
      method: "POST",
      body: JSON.stringify({ command: "ls", agent: "build" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_operation", capability: "commands", harness: "codex" },
    })
  })

  test("shell refuses when the harness advertises commands but the adapter has no shell method", async () => {
    const response = await createSessionRoutes({
      resolveAdapter: () => ({ ...adapter(), shell: undefined }) as unknown as AgentHarnessAdapter,
      resolveDirectory: () => "/workspace",
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    }).request("http://localhost/session/session_1/shell", {
      method: "POST",
      body: JSON.stringify({ command: "ls", agent: "build" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_operation", reason: "adapter_method_unavailable" },
    })
  })

  test("summarize forwards providerID, modelID, and auto to the adapter and discards its result", async () => {
    const calls: unknown[] = []
    const app = createSessionRoutes({
      resolveAdapter: () => ({
        ...adapter(),
        summarize: async (id: string, input: unknown, directory: RuntimeDirectory) => {
          calls.push({ id, input, directory })
        },
      }),
      resolveDirectory: () => "/workspace",
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    })

    const response = await app.request("http://localhost/session/session_1/summarize", {
      method: "POST",
      body: JSON.stringify({ providerID: "opencode", modelID: "model", auto: true }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(calls).toEqual([{
      id: "session_1",
      input: { providerID: "opencode", modelID: "model", auto: true },
      directory: "/workspace",
    }])
  })

  test("summarize defaults providerID and modelID to empty strings and omits auto when absent", async () => {
    const calls: unknown[] = []
    const app = createSessionRoutes({
      resolveAdapter: () => ({
        ...adapter(),
        summarize: async (_id: string, input: unknown) => { calls.push(input) },
      }),
      resolveDirectory: () => "/workspace",
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    })

    const response = await app.request("http://localhost/session/session_1/summarize", {
      method: "POST",
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(200)
    expect(calls).toEqual([{ providerID: "", modelID: "" }])
  })

  test("summarize refuses when the adapter does not advertise commands support", async () => {
    const response = await createSessionRoutes({
      resolveAdapter: () => ({
        ...adapter(),
        readHarnessCapabilities: () => ({
          harness: "codex",
          abort: false,
          reconnect: false,
          replay: false,
          permissions: false,
          questions: false,
          todos: false,
          commands: false,
          fork: false,
          revert: false,
          unrevert: false,
          configOptions: false,
          subagents: false,
        }),
        summarize: undefined,
      }) as unknown as AgentHarnessAdapter,
      resolveDirectory: () => "/workspace",
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    }).request("http://localhost/session/session_1/summarize", {
      method: "POST",
      body: JSON.stringify({ providerID: "opencode", modelID: "model" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_operation", capability: "commands", harness: "codex" },
    })
  })

  test("summarize refuses when the harness advertises commands but the adapter has no summarize method", async () => {
    const response = await createSessionRoutes({
      resolveAdapter: () => ({ ...adapter(), summarize: undefined }) as unknown as AgentHarnessAdapter,
      resolveDirectory: () => "/workspace",
      sessionBus: { publish: () => {}, subscribe: () => () => {} },
      publishGlobal: () => {},
    }).request("http://localhost/session/session_1/summarize", {
      method: "POST",
      body: JSON.stringify({ providerID: "opencode", modelID: "model" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_operation", reason: "adapter_method_unavailable" },
    })
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
    const messages: AgentMessage[] = [{
      info: { id: "winner_r", sessionID: "session_1", role: "assistant" },
      parts: [],
    }]
    const integrationAdapter: AgentHarnessAdapter = {
      ...adapter({ messages }),
      async *executeTurn(binding, prompt) {
        const id = binding.sessionId
        if (prompt.permissionMode) modes.push(prompt.permissionMode)
        markStarted?.()
        yield messageUpdated({
          id: prompt.userMessageId!,
          sessionID: id,
          role: "user",
          time: { created: 1 },
        })
        yield messageUpdated({
          id: prompt.assistantMessageId,
          sessionID: id,
          parentID: prompt.userMessageId,
          role: "assistant",
          time: { created: 2 },
        })
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
      workspaceId: "workspace-test",
      id: "session_1",
      directory: "/work",
      harness: { id: "pi", access: "native" },
    })
    const events: CompatEnvelope[] = []
    const app = createSessionRoutes({
      resolveAdapter: () => integrationAdapter,
      resolveRuntime: () => runtime,
      resolveExecutionBinding: fixtureExecutionBinding(),
      resolveDirectory: () => "/work",
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
    await runtime.dispose()
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

for (const operation of ["reply", "reject"] as const) {
  test(`a stale question ${operation} returns not-found without resolving a default harness`, async () => {
    let resolved = 0
    const app = createSessionRoutes({
      resolveDirectory: () => "/work",
      listQuestions: async () => [],
      resolveAdapter: () => { resolved++; throw new Error("No default harness configured") },
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })
    app.onError(() => new Response("unexpected harness resolution", { status: 500 }))
    const response = await app.request(`http://localhost/question/finished-question/${operation}?directory=%2Fwork`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: [["Staging"]] }),
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: "interaction_not_found" } })
    expect(resolved).toBe(0)
  })
}

test("question listing filters the authoritative workspace inventory without resolving the supplied session", async () => {
  const rows = [
    { id: "question_first", sessionID: "session_first", questions: [] },
    { id: "question_second", sessionID: "session_second", questions: [] },
  ]
  const app = createSessionRoutes({
    resolveAdapter: () => { throw new Error("must not select a harness from an unverified session query") },
    resolveDirectory: () => "/repo",
    listQuestions: async () => rows,
    sessionBus: { publish: () => {}, subscribe: () => () => {} },
    publishGlobal: () => {},
  })
  const selected = await app.request("http://localhost/question?sessionId=session_first")
  expect(selected.status).toBe(200)
  expect(await selected.json()).toEqual([rows[0]])
  const unknown = await app.request("http://localhost/question?sessionId=another_workspace_session")
  expect(unknown.status).toBe(200)
  expect(await unknown.json()).toEqual([])
  for (const operation of ["reply", "reject"]) {
    const response = await app.request(`http://localhost/question/question_first/${operation}?sessionId=another_workspace_session`, {
      method: "POST", body: JSON.stringify({ answers: [["Staging"]] }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: "interaction_session_mismatch" } })
  }
})

test("delete publishes the removed identity only after durable deletion succeeds", async () => {
  for (const fail of [false, true]) {
    const events: CompatEnvelope[] = []
    const order: string[] = []
    const a = adapter()
    a.deleteSession = async () => { order.push("adapter") }
    const app = createSessionRoutes({
      resolveAdapter: () => a,
      resolveDirectory: () => "/workspace",
      resolveExecutionBinding: fixtureExecutionBinding("ws"),
      afterDeleteSession: () => { order.push("store"); if (fail) throw new Error("store deletion failed") },
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal: (event) => { order.push("event"); events.push(event) },
    })
    const result = await app.request("http://localhost/session/deleted", { method: "DELETE" })
    expect(result.status).toBe(fail ? 500 : 200)
    expect(order).toEqual(fail ? ["adapter", "store"] : ["adapter", "store", "event"])
    expect(events).toEqual(fail ? [] : [{ directory: "/workspace", payload: { type: "session.deleted", properties: { info: { id: "deleted", directory: "/workspace" } } } }])
  }
})

test("late approval is not found without resolving a retired harness", async () => {
  let resolved = false
  const app = createSessionRoutes({
    resolveAdapter: () => { resolved = true; throw new Error("retired harness") },
    resolveDirectory: () => "/workspace",
    listPermissions: async () => [],
    sessionBus: { publish() {}, subscribe: () => () => {} },
    publishGlobal() {},
  })
  const result = await app.request("http://localhost/session/deleted/permissions/expired", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: "always" }),
  })
  expect(result.status).toBe(404)
  expect(resolved).toBe(false)
})

describe("createSessionRoutes session instructions", () => {
  function instructionRoutes(input: { instructionChannel: boolean }) {
    const creates: Array<{ id?: string; options?: { instructions?: string } }> = []
    const turns: Array<string | undefined> = []
    let stored: string | undefined
    const configRead = { fails: false }
    const fixture: AgentHarnessAdapter = {
      ...adapter(),
      ...(input.instructionChannel ? { adapterCapabilities: ["session-instructions"] as const } : {}),
      getSession: async () => null,
      createSession: async (_directory, _title, id, options) => {
        creates.push({ id, options })
        stored = options?.instructions
        return { id: id ?? "ses_instructions" }
      },
      getSessionConfig: async () => {
        if (configRead.fails) throw new Error("session config store unreachable")
        return {
          harness: { id: "codex", access: "native" },
          variant: null,
          agent: null,
          ...(stored ? { instructions: stored } : {}),
        }
      },
      executeTurn: (_binding, prompt) => (async function* () {
        entered.push(prompt.system)
        notify()
        if (held) await held
        turns.push(prompt.system)
        notify()
      })(),
    }
    const entered: Array<string | undefined> = []
    let held: Promise<void> | undefined
    let release: (() => void) | undefined
    const model = {
      hold() {
        held = new Promise<void>((resolve) => {
          release = resolve
        })
      },
      release() {
        release?.()
      },
    }
    const events: CompatEnvelope[] = []
    const watchers = new Set<() => void>()
    function notify() {
      for (const watcher of watchers) watcher()
    }
    // prompt_async answers before its turn runs, so every assertion about what
    // the detached turn did has to wait for the turn itself rather than a timer.
    function settled(done: () => boolean) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(check)
          reject(new Error("detached prompt_async turn never reached the expected state"))
        }, 1_000)
        const check = () => {
          if (!done()) return
          watchers.delete(check)
          clearTimeout(timer)
          resolve()
        }
        watchers.add(check)
        check()
      })
    }
    const app = createSessionRoutes({
      resolveAdapter: () => fixture,
      resolveDirectory: () => "/workspace",
      resolveExecutionBinding: fixtureExecutionBinding("ws_1"),
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal(event) {
        events.push(event)
        notify()
      },
    })
    return { app, creates, turns, entered, model, configRead, events, settled }
  }

  function refusals(events: CompatEnvelope[]) {
    return events
      .filter((event) => event.payload.type === "session.error")
      .map((event) => (event.payload as { properties: { error?: { data?: { code?: string } } } }).properties.error?.data?.code)
  }

  function create(app: ReturnType<typeof createSessionRoutes>, body: Record<string, unknown>) {
    return app.request("http://localhost/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  function promptTurn(app: ReturnType<typeof createSessionRoutes>, id: string) {
    return app.request(`http://localhost/session/${id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "go" }],
        agent: "build",
        model: { providerID: "test", modelID: "fixture" },
        variant: "fixture",
      }),
    })
  }

  function promptAsync(app: ReturnType<typeof createSessionRoutes>, id: string, messageID: string) {
    return app.request(`http://localhost/session/${id}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "go" }],
        messageID,
        agent: "build",
        model: { providerID: "test", modelID: "fixture" },
        variant: "fixture",
      }),
    })
  }

  test("carries the block to session creation and reads it back on the config", async () => {
    const { app, creates } = instructionRoutes({ instructionChannel: true })
    const created = await create(app, { id: "ses_instructions", instructions: "Answer only in haiku." })
    expect(created.status).toBe(201)
    expect(creates).toEqual([{ id: "ses_instructions", options: { instructions: "Answer only in haiku." } }])

    const config = await app.request("http://localhost/session/ses_instructions/config")
    expect(await config.json()).toMatchObject({ instructions: "Answer only in haiku." })
  })

  test("leaves the create options empty when no block was sent", async () => {
    const { app, creates } = instructionRoutes({ instructionChannel: true })
    expect((await create(app, { id: "ses_plain" })).status).toBe(201)
    expect(creates).toEqual([{ id: "ses_plain", options: {} }])
  })

  test("refuses a block over the cap before the harness is asked to create anything", async () => {
    const { app, creates } = instructionRoutes({ instructionChannel: true })
    const response = await create(app, { id: "ses_big", instructions: "x".repeat(65_537) })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_instructions_too_large" } })
    expect(creates).toEqual([])
  })

  test("measures the cap in UTF-8 bytes rather than code units", async () => {
    const { app, creates } = instructionRoutes({ instructionChannel: true })
    const response = await create(app, { id: "ses_utf8", instructions: "🙂".repeat(16_385) })
    expect(response.status).toBe(400)
    expect(creates).toEqual([])
  })

  test("refuses a harness with no instruction channel instead of dropping the block", async () => {
    const { app, creates } = instructionRoutes({ instructionChannel: false })
    const response = await create(app, { id: "ses_unsupported", instructions: "Answer only in haiku." })
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ error: { code: "session_instructions_unsupported" } })
    expect(creates).toEqual([])
  })

  // The prompt names agent, model and variant: that combination once skipped
  // the config read entirely, which is the door the retained block arrives
  // through.
  test("a later turn carries the retained block even when the caller named agent, model and variant", async () => {
    const { app, turns } = instructionRoutes({ instructionChannel: true })
    expect((await create(app, { id: "ses_resume", instructions: "Answer only in haiku." })).status).toBe(201)

    expect((await promptTurn(app, "ses_resume")).status).toBe(200)
    expect(turns).toEqual(["Answer only in haiku."])
  })

  test("a session that retained nothing still prompts, with no instruction channel used", async () => {
    const { app, turns } = instructionRoutes({ instructionChannel: true })
    expect((await create(app, { id: "ses_plain" })).status).toBe(201)

    expect((await promptTurn(app, "ses_plain")).status).toBe(200)
    expect(turns).toEqual([undefined])
  })

  test("refuses the turn when the config read fails, without asking the harness to run it", async () => {
    const { app, turns, configRead } = instructionRoutes({ instructionChannel: true })
    expect((await create(app, { id: "ses_unreadable", instructions: "Answer only in haiku." })).status).toBe(201)

    configRead.fails = true
    expect((await promptTurn(app, "ses_unreadable")).status).toBe(500)
    expect(turns).toEqual([])
  })

  // prompt_async's 204 is a delivery receipt — the Tasks bridge records the turn
  // as handed off on it — so a turn refused before anything ran has to be the
  // response, and the refused message id has to submit again.
  test("answers the config-read refusal, and the same id then runs once with the retained block", async () => {
    const { app, turns, configRead, events, settled } = instructionRoutes({ instructionChannel: true })
    expect((await create(app, { id: "ses_recover", instructions: "Answer only in haiku." })).status).toBe(201)

    configRead.fails = true
    const refused = await promptAsync(app, "ses_recover", "msg_recover")
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ error: { code: "session_configuration_unavailable" } })
    expect(turns).toEqual([])
    expect(refusals(events)).toEqual([])

    configRead.fails = false
    expect((await promptAsync(app, "ses_recover", "msg_recover")).status).toBe(204)
    await settled(() => turns.length > 0)
    expect(turns).toEqual(["Answer only in haiku."])

    expect((await promptAsync(app, "ses_recover", "msg_recover")).status).toBe(204)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(turns).toEqual(["Answer only in haiku."])
  })

  test("answers 204 while the model is still running the turn", async () => {
    const { app, turns, entered, model, settled } = instructionRoutes({ instructionChannel: true })
    expect((await create(app, { id: "ses_slow" })).status).toBe(201)

    model.hold()
    expect((await promptAsync(app, "ses_slow", "msg_slow")).status).toBe(204)
    await settled(() => entered.length > 0)
    expect(turns).toEqual([])

    model.release()
    await settled(() => turns.length > 0)
    expect(turns).toEqual([undefined])
  })
})

describe("createSessionRoutes session model group", () => {
  const GROUP = {
    primary: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "claude-opus-4-1" }, effort: "high" },
    review: { harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5-codex" } },
  }

  function groupRoutes() {
    const creates: Array<{ id?: string; options?: { group?: unknown } }> = []
    let stored: SessionConfig["group"]
    const fixture: AgentHarnessAdapter = {
      ...adapter(),
      adapterCapabilities: ["session-instructions"] as const,
      getSession: async () => null,
      createSession: async (_directory, _title, id, options) => {
        creates.push({ id, options })
        stored = options?.group
        return { id: id ?? "ses_group" }
      },
      getSessionConfig: async () => ({
        harness: { id: "codex", access: "native" },
        variant: null,
        agent: null,
        ...(stored ? { group: stored } : {}),
      }),
    }
    const app = createSessionRoutes({
      resolveAdapter: () => fixture,
      resolveDirectory: () => "/workspace",
      resolveExecutionBinding: fixtureExecutionBinding("ws_1"),
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })
    return { app, creates }
  }

  function create(app: ReturnType<typeof createSessionRoutes>, body: Record<string, unknown>) {
    return app.request("http://localhost/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  test("retains the group at create and reads it back on the session config", async () => {
    const { app, creates } = groupRoutes()
    expect((await create(app, { id: "ses_group", group: GROUP })).status).toBe(201)
    expect(creates).toEqual([{ id: "ses_group", options: { group: GROUP } }])

    const config = await app.request("http://localhost/session/ses_group/config")
    expect(await config.json()).toMatchObject({ group: GROUP })
  })

  test("leaves the create options empty when no group was sent", async () => {
    const { app, creates } = groupRoutes()
    expect((await create(app, { id: "ses_plain" })).status).toBe(201)
    expect(creates).toEqual([{ id: "ses_plain", options: {} }])
  })

  test("refuses a malformed group by field before the harness is asked to create anything", async () => {
    const { app, creates } = groupRoutes()
    const response = await create(app, { id: "ses_bad", group: { archivist: GROUP.primary } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "session_group_invalid", message: expect.stringContaining("group.archivist") },
    })
    expect(creates).toEqual([])
  })

  test("names the slot field a caller got wrong rather than dropping the slot", async () => {
    const { app, creates } = groupRoutes()
    const response = await create(app, { id: "ses_bad", group: { primary: { harness: "claude" } } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("group.primary.model") },
    })
    expect(creates).toEqual([])
  })

  test("refuses a PATCH that carries a group instead of changing what the session was created under", async () => {
    const { app } = groupRoutes()
    expect((await create(app, { id: "ses_group", group: GROUP })).status).toBe(201)

    const patched = await app.request("http://localhost/session/ses_group/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: { primary: GROUP.review } }),
    })
    expect(patched.status).toBe(409)
    expect(await patched.json()).toMatchObject({ error: { code: "session_group_immutable" } })

    const config = await app.request("http://localhost/session/ses_group/config")
    expect(await config.json()).toMatchObject({ group: GROUP })
  })
})

describe("GET /session/capabilities effort levels", () => {
  function capabilityRoutes(effortLevels: HarnessCapabilities["effortLevels"]) {
    const fixture: AgentHarnessAdapter = {
      ...adapter(),
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
        goals: false,
        ...(effortLevels ? { effortLevels } : {}),
      }),
    }
    return createSessionRoutes({
      resolveAdapter: () => fixture,
      resolveDirectory: () => "/workspace",
      resolveExecutionBinding: fixtureExecutionBinding("ws_1"),
      sessionBus: { publish() {}, subscribe: () => () => {} },
      publishGlobal() {},
    })
  }

  test("reports each harness's own effort catalog on the global and per-session reads", async () => {
    const resolved = { status: "resolved", models: [{ modelID: "gpt-5-codex", levels: ["low", "high"], default: "high" }] } as const
    const app = capabilityRoutes(resolved)
    expect(await (await app.request("http://localhost/session/capabilities")).json())
      .toMatchObject({ harness: "codex", effortLevels: resolved })
    expect(await (await app.request("http://localhost/session/ses_1/capabilities")).json())
      .toMatchObject({ effortLevels: resolved })
  })

  test("carries an unsupported catalog through rather than omitting the field", async () => {
    const app = capabilityRoutes({ status: "unsupported", models: [] })
    expect(await (await app.request("http://localhost/session/capabilities")).json())
      .toMatchObject({ effortLevels: { status: "unsupported", models: [] } })
  })

  test("an adapter that reports no catalog leaves the field absent rather than inventing one", async () => {
    const app = capabilityRoutes(undefined)
    expect(await (await app.request("http://localhost/session/capabilities")).json())
      .not.toHaveProperty("effortLevels")
  })
})
