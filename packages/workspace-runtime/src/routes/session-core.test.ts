import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { AgentRuntimeContractError, NO_HARNESS_EFFORT, type AgentPermissionModeState, type AgentToolPart, type HarnessInstructionChannel, type SessionHarness } from "@claxedo/agent-runtime-contract"
import type { AgentMessage, AgentPermission, AgentQuestion, AgentSession, AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { RuntimeDirectory } from "../host/contracts"
import { AgentMessagePageError, type AgentMessagePageInput } from "@claxedo/agent-runtime-contract"
import { AgentHarnessEngineError, applySessionConfigUpdate, type ConfigOperations, type TransportCapabilities, type TurnRequest } from "@claxedo/harness/contract"
import type { TurnOutline } from "@claxedo/agent-runtime-contract"
import { AgentRuntimeTurnAdmissionError, type AgentRuntime } from "../host/runtime"
import {
  managedWorkspaceSessionAccessPolicy,
  type ManagedSessionAuthority,
  type SessionAccessDecision,
  type SessionAccessPolicy,
} from "../session-access-policy"
import { FakeTransport, type FakeTransportOptions, type FakeTurn } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, testLaunch, type HostFixture } from "../test-support/host-fixture"
import { createSessionRoutes } from "./session-core"
import type { SessionLifecycleEvent } from "./session-route-options"
import type { ChildSessionHost } from "./session-children"
import { sessionIdle } from "../projection/presentation-events"

const CODEX: SessionHarness = { id: "codex", access: "native" }
const WORKSPACE = "/workspace"

type RouteOptions = Parameters<typeof createSessionRoutes>[0]
type Harness = HostFixture & { transport: FakeTransport }

const hosts: HostFixture[] = []
const beforeDispose: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const settle of beforeDispose.splice(0)) await settle()
  for (const host of hosts.splice(0)) await host.dispose()
})

/** A real runtime host over one scripted Codex transport and a real store. */
function harness(options: FakeTransportOptions = {}): Harness {
  const transport = new FakeTransport({ kind: "codex-app-server", ...options })
  const host = createHostFixture({ transports: { codex: transport }, workspaceId: "ws_1", launch: testLaunch("ws_1", ["actor_1", "actor_verified", "actor_grantee", "creator", "other", "alice", "bob"]) })
  hosts.push(host)
  return Object.assign(host, { transport })
}

async function seed(h: Harness, id: string, directory = WORKSPACE) {
  await h.runtime.sessions.create(sessionCreate({ id, workspaceId: "ws_1", directory, harness: CODEX }))
}

const unsupportedModes: AgentPermissionModeState = { modes: [], appliesFrom: "next-turn", unsupported: "fixture has no permission modes" }

function configOps(overrides: Partial<ConfigOperations> = {}): ConfigOperations {
  return {
    read: async () => { throw new Error("the fixture's config is runtime-owned") },
    update: async () => { throw new Error("the fixture's config is runtime-owned") },
    options: async () => ({ options: [] }),
    permissionModes: async () => unsupportedModes,
    setPermissionMode: async () => unsupportedModes,
    ...overrides,
  }
}

function refusingRuntime(what: string): () => Promise<AgentRuntime> {
  return async () => { throw new Error(`${what} must not resolve the runtime`) }
}

function runtimeDouble(double: unknown): () => Promise<AgentRuntime> {
  return async () => double as AgentRuntime
}

/** The session routes over a host, or over a runtime the test must never reach. */
function sessionRoutes(h: Harness | undefined, options: Partial<RouteOptions> = {}) {
  return createSessionRoutes({
    runtime: h ? async () => h.runtime : refusingRuntime("this route"),
    defaultHarness: () => CODEX,
    requestedSessionHarness: () => undefined,
    resolveDirectory: () => WORKSPACE,
    resolveWorkspaceId: () => "ws_1",
    publishGlobal: () => {},
    ...options,
  })
}

type RelayClaims = Record<string, string>

const EDITOR_CLAIMS: RelayClaims = {
  actor_id: "actor_1",
  actor_kind: "human",
  org_id: "org_1",
  workspace_id: "ws_1",
  host_id: "host_1",
  role: "editor",
}

/**
 * A managed-private policy decides the lifecycle of a RELAY-REPLAYED request,
 * and the runtime reads that off the verified stamp the exposure sets, so a
 * test of it has to arrive stamped. Unstamped, the same runtime answers its
 * own machine's user and reserves nothing.
 */
function stamped(routes: ReturnType<typeof createSessionRoutes>, claims: (c: { req: { header(name: string): string | undefined } }) => RelayClaims = () => EDITOR_CLAIMS) {
  const app = new Hono()
  app.use("*", async (context, next) => {
    ;(context as unknown as { set(name: string, value: unknown): void }).set("relayHostAuth", { ...claims(context), user_id: claims(context).actor_id })
    await next()
  })
  return app.route("/", routes)
}

function managedRoutes(h: Harness | undefined, input: Partial<RouteOptions> & { policy: SessionAccessPolicy; stamped?: boolean }) {
  const { policy, stamped: stamp, ...options } = input
  const routes = sessionRoutes(h, { sessionAccessPolicy: policy, ...options })
  return stamp === false ? routes : stamped(routes)
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
    authorizeSessionStart: async () => ({ allowed: true }),
    authorizeSessionStartStatus: async () => ({ allowed: true }),
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

function registrationPolicy(registerSession: NonNullable<SessionAccessPolicy["registerSession"]>): SessionAccessPolicy {
  return {
    sessionAuthority: "managed-private",
    authorize: async () => ({ allowed: true }),
    authorizeSessionStart: async () => ({ allowed: true }),
    authorizeSessionStartStatus: async () => ({ allowed: true }),
    authorizePrefix: async () => ({ allowed: true }),
    filterSessions: async (input) => input.sessionIds,
    registerSession,
    markRegistrationAmbiguous: async () => ({ allowed: true }),
    beginRegistrationCompensation: async () => ({ allowed: true }),
    completeRegistrationCompensation: async () => ({ allowed: true }),
  }
}

function promptText(turn: FakeTurn) {
  return turn.turn.prompt.parts.map((part) => ("text" in part ? part.text : "")).join("")
}

const post = (app: { request: Hono["request"] }, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

test("session config-options applies the session read policy before reading exact-session state", async () => {
  const calls: string[] = []
  const checked: string[] = []
  const h = harness({
    config: configOps({
      options: async (target) => {
        if (!("session" in target)) throw new Error("Missing session target")
        calls.push(target.session.binding.sessionId)
        return { options: [{ id: "mode", name: "Mode", type: "select", currentValue: target.session.binding.sessionId }] }
      },
    }),
  })
  await seed(h, "owned")
  const app = managedRoutes(h, {
    policy: managedPolicy({ authorize: async (input) => {
      checked.push(`${input.sessionId}:${input.operation}`)
      return input.sessionId === "owned" ? { allowed: true } : { allowed: false, status: 403, code: "session_access_denied", message: "Private session" }
    } }),
  })
  const allowed = await app.request("http://localhost/session/owned/config-options?sessionId=other")
  expect(allowed.status).toBe(200)
  expect(await allowed.json()).toMatchObject({ options: [{ currentValue: "owned" }] })
  const denied = await app.request("http://localhost/session/private/config-options")
  expect(denied.status).toBe(403)
  expect(calls).toEqual(["owned"])
  expect(checked).toEqual(["owned:session_config_read", "private:session_config_read"])
})

describe("createSessionRoutes private-session lifecycle", () => {
  test("requires a preassigned session and reservation operation before runtime mutation", async () => {
    const h = harness()
    const response = await post(managedRoutes(h, { policy: managedPolicy() }), "/session", {})
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_reservation_required" } })
    expect(h.transport.starts).toEqual([])
  })

  test("registers the exact reserved operation at the created session's own update time before returning create success", async () => {
    const calls: unknown[] = []
    const h = harness()
    const policy = managedPolicy({
      registerSession: async (value) => {
        calls.push(value)
        return { allowed: true }
      },
    })
    const response = await post(managedRoutes(h, { policy }), "/session", { id: "ses_1", title: "Private" }, {
      "x-claxedo-session-registration-operation": "op_create_1",
    })
    expect(response.status).toBe(201)
    expect(calls).toHaveLength(1)
    const stored = h.store.getSession("ses_1")!.time
    expect(calls[0]).toMatchObject({
      sessionId: "ses_1",
      registrationOperationId: "op_create_1",
      sessionTitle: "Private",
      sessionTime: { created: stored.created, updated: stored.updated },
      actor: { actorId: "actor_1", actorKind: "human" },
      authority: { orgId: "org_1", workspaceId: "ws_1", role: "editor" },
    })
  })

  test("marks an unavailable registration ambiguous and preserves runtime state for exact retry", async () => {
    let attempts = 0
    const ambiguous: unknown[] = []
    const h = harness()
    const policy = managedPolicy({
      registerSession: async () => ++attempts === 1
        ? { allowed: false, status: 503, code: "authority_unavailable", message: "retry" }
        : { allowed: true },
      markRegistrationAmbiguous: async (value) => { ambiguous.push(value); return { allowed: true } },
    })
    const request = () => post(managedRoutes(h, { policy }), "/session", { id: "ses_1", title: "Private" }, {
      "x-claxedo-session-registration-operation": "op_create_1",
    })

    expect((await request()).status).toBe(503)
    expect(h.transport.starts).toHaveLength(1)
    expect(h.transport.closed).toEqual([])
    expect(ambiguous).toHaveLength(1)
    expect((await request()).status).toBe(201)
    expect(h.transport.starts).toHaveLength(1)
  })

  test("compensates runtime state after definitive registration denial", async () => {
    const calls: string[] = []
    const h = harness({ onClose: () => { calls.push("delete") } })
    const policy = managedPolicy({
      registerSession: async () => ({ allowed: false, status: 403, code: "session_private", message: "denied" }),
      beginRegistrationCompensation: async () => { calls.push("begin"); return { allowed: true } },
      completeRegistrationCompensation: async () => { calls.push("complete"); return { allowed: true } },
    })
    const response = await post(managedRoutes(h, { policy }), "/session", { id: "ses_1" }, {
      "x-claxedo-session-registration-operation": "op_create_1",
    })
    expect(response.status).toBe(403)
    expect(calls).toEqual(["begin", "delete", "complete"])
    expect(h.store.getSession("ses_1")).toBeNull()
  })

  test("requires an exact reservation before a managed fork mutates runtime state", async () => {
    let forks = 0
    const h = harness({ fork: async () => { forks += 1; return { upstreamSessionId: "unexpected" } } })
    await seed(h, "ses_parent")
    const response = await post(managedRoutes(h, { policy: managedPolicy() }), "/session/ses_parent/fork", { messageId: "msg_1" })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_reservation_required" } })
    expect(forks).toBe(0)
  })

  test("forks into the reserved child id, which its host persists, and registers the exact operation before success", async () => {
    const calls: unknown[] = []
    const h = harness({
      fork: async (session, messageId, childId) => {
        calls.push({ parentId: session.binding.sessionId, messageId, directory: session.directory, childId })
        return { upstreamSessionId: `upstream-${childId}` }
      },
    })
    await seed(h, "ses_parent")
    const policy = managedPolicy({
      registerSession: async (value) => { calls.push(value); return { allowed: true } },
    })
    const response = await post(managedRoutes(h, { policy }), "/session/ses_parent/fork", { id: "ses_child", messageId: "msg_1" }, {
      "x-claxedo-session-registration-operation": "op_fork_1",
    })
    expect(response.status).toBe(201)
    expect(calls[0]).toEqual({
      parentId: "ses_parent",
      messageId: "msg_1",
      directory: WORKSPACE,
      childId: "ses_child",
    })
    const child = h.store.getSession("ses_child")
    expect(child).toBeTruthy()
    expect(calls[1]).toMatchObject({
      sessionId: "ses_child",
      registrationOperationId: "op_fork_1",
      sessionTime: { created: child!.time.created, updated: child!.time.updated },
      actor: { actorId: "actor_1", actorKind: "human" },
    })
    expect(await response.json()).toMatchObject({ id: "ses_child", time: { created: child!.time.created, updated: child!.time.updated } })
  })

  test("filters list rows through private-session authority", async () => {
    const policy = managedPolicy({ filterSessions: async () => ["ses_visible"] })
    const response = await managedRoutes(undefined, {
      policy,
      listSessions: async () => [
        { id: "ses_visible", title: "Visible", time: { created: 1, updated: 1 } },
        { id: "ses_private", title: "Private", time: { created: 1, updated: 1 } },
      ] as AgentSession[],
    }).request("/session")
    expect((await response.json() as Array<{ id: string }>).map((row) => row.id)).toEqual(["ses_visible"])
  })

  test("requires a stable message id before a managed prompt mutates the runtime", async () => {
    const h = harness()
    await seed(h, "ses_private")
    const response = await post(managedRoutes(h, { policy: managedPolicy() }), "/session/ses_private/message", {
      parts: [{ type: "text", text: "hello" }],
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_turn_id_required" } })
    expect(h.transport.turns).toEqual([])
  })

  test("returns a durable admission conflict before a managed prompt mutates the runtime", async () => {
    const h = harness()
    await seed(h, "ses_private")
    const response = await post(managedRoutes(h, {
      policy: managedPolicy({
        acquireTurn: async () => ({
          allowed: false,
          status: 409,
          code: "session_turn_in_progress",
          message: "A durable turn is already active",
        }),
      }),
    }), "/session/ses_private/message", { messageID: "msg_2", parts: [{ type: "text", text: "hello" }] })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: "session_turn_in_progress" } })
    expect(h.transport.turns).toEqual([])
  })

  test("holds the durable turn through checkpoint and final message publication", async () => {
    const calls: string[] = []
    const h = harness()
    await seed(h, "ses_private")
    h.eventHub.subscribeGlobal((event) => { calls.push(`publish:${event.payload.type}`) })
    const response = await post(managedRoutes(h, {
      policy: managedPolicy({
        releaseTurn: async () => {
          calls.push("release")
          return { released: true }
        },
      }),
      afterMessageCheckpoint: () => {
        calls.push("checkpoint")
      },
      publishGlobal: (event) => {
        calls.push(`publish:${event.payload.type}`)
      },
    }), "/session/ses_private/message", { messageID: "user_1", parts: [{ type: "text", text: "hello" }] })

    expect(response.status).toBe(200)
    const checkpoint = calls.indexOf("checkpoint")
    const finalPublish = calls.lastIndexOf("publish:message.updated")
    const release = calls.indexOf("release")
    expect(checkpoint).toBeGreaterThanOrEqual(0)
    expect(finalPublish).toBeGreaterThanOrEqual(0)
    expect(release).toBeGreaterThan(checkpoint)
    expect(release).toBeGreaterThan(finalPublish)
  })

  test("the same managed policy creates with no reservation and registers nothing for an UNSTAMPED caller", async () => {
    // A desktop daemon mounts this policy for the org members the relay
    // replays onto it and keeps serving its own user on the same runtimes. The
    // ingress refuses a relayed request it cannot verify, so the absence of a
    // stamp is that user, and the lifecycle a reservation belongs to is not
    // theirs.
    const registrations: unknown[] = []
    const policy = managedPolicy({
      registerSession: async (value) => { registrations.push(value); return { allowed: true } },
    })
    const response = await post(managedRoutes(harness(), { policy, stamped: false }), "/session", {})

    expect(response.status).toBe(201)
    expect(registrations).toEqual([])
  })

  test("durable turn admission is the stamped caller's: a prompt with no message id is refused for them and admitted for the machine's own user", async () => {
    const turns: string[] = []
    const h = harness()
    await seed(h, "ses_1")
    const policy = managedPolicy({
      acquireTurn: async (input) => { turns.push(input.turnId); return { allowed: false, status: 503, code: "unreachable", message: "unreachable" } },
    })

    const refused = await post(managedRoutes(h, { policy }), "/session/ses_1/message", { parts: [{ type: "text", text: "hi" }] })
    const direct = await post(managedRoutes(h, { policy, stamped: false }), "/session/ses_1/message", { parts: [{ type: "text", text: "hi" }] })

    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: "session_turn_id_required" } })
    expect(direct.status).toBe(200)
    expect(turns).toEqual([])
  })
})

describe("createSessionRoutes message paging", () => {
  const first = { info: { id: "message-1", sessionID: "session-1", role: "user" }, parts: [] } as unknown as AgentMessage
  const second = { info: { id: "message-2", sessionID: "session-1", role: "assistant" }, parts: [] } as unknown as AgentMessage

  test("uses the route authority's page and forwards its opaque cursor without reaching the runtime", async () => {
    const calls: Array<{ sessionId: string; page: AgentMessagePageInput; directory: RuntimeDirectory }> = []
    const app = sessionRoutes(undefined, {
      getMessagePage: (_c, directory, sessionId, page) => {
        calls.push({ sessionId, page, directory })
        return { messages: [first, second], nextCursor: "journal:opaque/next" }
      },
    })

    const response = await app.request("http://localhost/session/session-1/message?limit=2&before=journal%3Aopaque%2Fbefore")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([first, second])
    expect(response.headers.get("access-control-expose-headers")).toBe("X-Next-Cursor")
    expect(response.headers.get("x-next-cursor")).toBe("journal:opaque/next")
    expect(calls).toEqual([{
      sessionId: "session-1",
      page: { limit: 2, before: "journal:opaque/before" },
      directory: WORKSPACE,
    }])
  })

  test("forwards the authoritative latest-turn view without a numeric limit", async () => {
    const calls: AgentMessagePageInput[] = []
    const app = sessionRoutes(undefined, {
      getMessagePage: (_c, _directory, _sessionId, page) => {
        calls.push(page)
        return { messages: [first, second], nextCursor: "before-user" }
      },
    })

    const response = await app.request("http://localhost/session/session-1/message?view=latest-turn")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([first, second])
    expect(response.headers.get("x-next-cursor")).toBe("before-user")
    expect(calls).toEqual([{ view: "latest-turn" }])
  })

  test("forwards a whole-turn read before a cursor as the latest-turn view with that cursor", async () => {
    const calls: AgentMessagePageInput[] = []
    const app = sessionRoutes(undefined, {
      getMessagePage: (_c, _directory, _sessionId, page) => {
        calls.push(page)
        return { messages: [first, second] }
      },
    })

    const response = await app.request("http://localhost/session/session-1/message?view=latest-turn&before=before-user")

    expect(response.status).toBe(200)
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(calls).toEqual([{ view: "latest-turn", before: "before-user" }])
  })

  const pagedSession = { id: "session-1", title: "Paged", time: { created: 1, updated: 1 } } as AgentSession

  /** The session routes over a store-shaped read of one timed session; no runtime is reached. */
  function readRoutes(options: Partial<RouteOptions> = {}) {
    return sessionRoutes(undefined, {
      getSession: (_c, _directory, sessionId) => (sessionId === pagedSession.id ? pagedSession : null),
      ...options,
    })
  }

  test("answers an outline read with the session's row and its turn outline, and names a missing session or an absent store", async () => {
    const outline: TurnOutline = {
      turns: [{ id: "user-1", createdAt: 1, user: "why?" }],
      complete: true,
    }
    const app = readRoutes({ getTurnOutline: (_c, _directory, sessionId) => (sessionId === "session-1" ? outline : undefined) })

    const served = await app.request("http://localhost/session/session-1/outline")
    expect(served.status).toBe(200)
    expect(served.headers.get("cache-control")).toBe("no-store")
    expect(await served.json()).toEqual({ session: await (await app.request("http://localhost/session/session-1")).json(), outline })

    const missing = await app.request("http://localhost/session/session-2/outline")
    expect(missing.status).toBe(404)

    const unsupported = await readRoutes().request("http://localhost/session/session-1/outline")
    expect(unsupported.status).toBe(501)
  })

  const pagedTurn = (index: number): AgentMessage[] => {
    const user = `user-${index}`
    const worked = `assistant-${index}-a`
    const answered = `assistant-${index}-b`
    const assistant = (id: string, parts: AgentMessage["parts"]) => ({
      info: { id, sessionID: "session-1", role: "assistant", parentID: user, time: { created: 2, completed: 3 } },
      parts,
    }) as AgentMessage
    return [
      { info: { id: user, sessionID: "session-1", role: "user", time: { created: 1 } }, parts: [{ id: `${user}-p`, sessionID: "session-1", messageID: user, type: "text", text: `Prompt ${index}` }] } as AgentMessage,
      assistant(worked, [
        { id: `${worked}-t`, sessionID: "session-1", messageID: worked, type: "text", text: "Looking." },
        { id: `${worked}-r`, sessionID: "session-1", messageID: worked, type: "tool", callID: "c", tool: "read", state: { status: "completed", input: {}, output: "x", title: "read", metadata: {}, time: { start: 1, end: 2 } } },
      ]),
      assistant(answered, [{ id: `${answered}-t`, sessionID: "session-1", messageID: answered, type: "text", text: `Answer ${index}.` }]),
    ]
  }

  function pagedRoutes() {
    const turns = Array.from({ length: 30 }, (_, index) => pagedTurn(index))
    const reads: AgentMessagePageInput[] = []
    const app = readRoutes({
      getMessagePage: (_c, _directory, _sessionId, page) => {
        reads.push(page)
        const end = "before" in page && page.before !== undefined ? Number(page.before) : turns.length
        return { messages: turns[end - 1] ?? [], ...(end > 1 ? { nextCursor: String(end - 1) } : {}) }
      },
      getTurnOutline: () => ({ turns: [], complete: true }),
    })
    return { app, turns, reads }
  }

  const viewport = "rows=10&cols=100&reasoning=0&shell=0&edit=0"

  test("a first read's page walks back one whole turn at a time and sends every part of each turn, its tools as headers", async () => {
    const { app, turns, reads } = pagedRoutes()

    const response = await app.request(`http://localhost/session/session-1/outline?${viewport}`)

    expect(response.status).toBe(200)
    const { page } = await response.json()
    expect(reads).toEqual([{ view: "latest-turn" }, ...["29", "28", "27", "26"].map((before) => ({ view: "latest-turn" as const, before }))])
    expect(page.turns.map((item: { cursor: string }) => item.cursor)).toEqual(["25", "26", "27", "28", "29"])
    const latest = page.turns.at(-1)
    expect(Object.keys(latest).sort()).toEqual(["cursor", "messages"])
    expect(latest.messages.map((message: AgentMessage) => message.parts.map((part) => part.id))).toEqual(turns[29].map((message) => message.parts.map((part) => part.id)))
    expect(latest.messages[1].parts[1]).toMatchObject({ type: "tool", headerOnly: true, state: { output: "" } })
  })

  test("a page read answers the turns before its cursor, projected as the first page is", async () => {
    const { app, reads } = pagedRoutes()

    const response = await app.request(`http://localhost/session/session-1/page?${viewport}&before=27`)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const page = await response.json()
    expect(reads).toEqual(["27", "26", "25", "24", "23"].map((before) => ({ view: "latest-turn" as const, before })))
    expect(page.turns.map((item: { cursor: string }) => item.cursor)).toEqual(["22", "23", "24", "25", "26"])
  })

  const toolBody = (name: string, bytes = 1024) => `${name}:${"x".repeat(bytes)}`
  const toolBodies = ["read-output", "read-preview", "read-attachment", "bash-output", "bash-metadata", "edit-old", "edit-new", "edit-output", "edit-before", "edit-after"]

  function bodiedTurns(): AgentMessage[][] {
    const message = (id: string, role: "user" | "assistant", parts: Array<Record<string, unknown>>, parentID?: string) => ({
      info: { id, sessionID: "session-1", role, time: { created: 1, ...(role === "assistant" ? { completed: 2 } : {}) }, ...(parentID ? { parentID } : {}) },
      parts: parts.map((part, index) => ({ id: `${id}-p${index}`, sessionID: "session-1", messageID: id, ...part })),
    }) as AgentMessage
    const tool = (name: string, messageId: string, input: Record<string, unknown>, metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      type: "tool",
      tool: name,
      callID: `call-${name}-${messageId}`,
      state: { status: "completed", input, output: toolBody(`${name}-output`, 64 * 1024), title: name, metadata, time: { start: 1, end: 2 }, ...extra },
    })
    const tools = (messageId: string) => ({
      read: tool("read", messageId, { filePath: "shot.png" }, { loaded: ["shot.png"], preview: toolBody("read-preview") }, {
        attachments: [{ id: `${messageId}-attachment`, sessionID: "session-1", messageID: messageId, type: "file", mime: "image/png", url: `data:image/png;base64,${toolBody("read-attachment")}` }],
      }),
      bash: tool("bash", messageId, { command: "ls" }, { command: "ls", exitCode: 0, output: toolBody("bash-metadata") }),
      edit: tool("edit", messageId, { filePath: "a.ts", oldString: toolBody("edit-old"), newString: toolBody("edit-new") }, {
        filediff: { file: "a.ts", additions: 1, deletions: 1, before: toolBody("edit-before"), after: toolBody("edit-after") },
      }),
    })
    const unfolded = (index: number, name: "read" | "bash" | "edit") => [
      message(`user-${index}`, "user", [{ type: "text", text: name }]),
      message(`assistant-${index}`, "assistant", [tools(`assistant-${index}`)[name], { type: "text", text: "Done." }], `user-${index}`),
    ]
    return [
      unfolded(1, "bash"),
      unfolded(2, "edit"),
      unfolded(3, "read"),
      [
        message("user-4", "user", [{ type: "text", text: "all" }]),
        message("assistant-4-a", "assistant", [{ type: "text", text: "Looking." }, ...Object.values(tools("assistant-4-a"))], "user-4"),
        message("assistant-4-b", "assistant", [{ type: "text", text: "Done." }], "user-4"),
      ],
    ]
  }

  test("every read sends a tool as its header, and whole only when the reader's shell or edit setting opens it", async () => {
    const turns = bodiedTurns()
    const stored = new Map(turns.flat().map((message) => [message.info.id, message.parts.map((part) => part.id)]))
    const app = readRoutes({
      getMessagePage: (_c, _directory, _sessionId, page) => {
        const end = "before" in page && page.before !== undefined ? Number(page.before) : turns.length
        return { messages: turns[end - 1] ?? [], ...(end > 1 ? { nextCursor: String(end - 1) } : {}) }
      },
      getTurnOutline: () => ({ turns: [], complete: true }),
    })
    type Turn = { messages: AgentMessage[]; cursor?: string }
    const sentAsHeaders = (label: string, sent: Turn[], reader: { shell: boolean; edit: boolean }) => {
      const tools = sent.flatMap((turn) => {
        expect(turn.messages.map((message) => message.parts.map((part) => part.id)), label).toEqual(turn.messages.map((message) => stored.get(message.info.id)!))
        return turn.messages.flatMap((message) => message.parts.filter((part): part is AgentToolPart => part.type === "tool"))
      })
      expect(new Set(tools.map((part) => part.tool)), label).toEqual(new Set(["read", "bash", "edit"]))
      for (const part of tools) {
        const json = JSON.stringify(part)
        if ((part.tool === "bash" && reader.shell) || (part.tool === "edit" && reader.edit)) {
          expect(part.headerOnly, `${label}: ${part.tool}`).toBeUndefined()
          expect(toolBodies.filter((name) => name.startsWith(`${part.tool}-`)).filter((name) => !json.includes(`${name}:`)), `${label}: ${part.tool}`).toEqual([])
        } else {
          expect(part, `${label}: ${part.tool}`).toMatchObject({ headerOnly: true, state: { status: "completed", output: "" } })
          expect(part.state, `${label}: ${part.tool}`).not.toHaveProperty("attachments")
          expect(toolBodies.filter((name) => json.includes(`${name}:`)), `${label}: ${part.tool}`).toEqual([])
        }
      }
    }

    for (const reader of [{ reasoning: false, shell: false, edit: false }, { reasoning: false, shell: true, edit: true }]) {
      const settings = `reasoning=0&shell=${Number(reader.shell)}&edit=${Number(reader.edit)}`
      const { page: first } = await (await app.request(`http://localhost/session/session-1/outline?rows=40&cols=100&${settings}`)).json() as { page: { turns: Turn[] } }
      const latest = first.turns.at(-1)!
      expect(first.turns.length, settings).toBe(4)
      sentAsHeaders(`first read, ${settings}`, first.turns, reader)
      const page = await (await app.request(`http://localhost/session/session-1/page?rows=40&cols=100&${settings}&before=${latest.cursor}`)).json() as { turns: Turn[] }
      expect(page.turns.length, settings).toBe(3)
      sentAsHeaders(`page read, ${settings}`, page.turns, reader)
    }
  })

  test("a part read answers one part whole, and names a part the session lacks or a runtime that cannot read one", async () => {
    const part = pagedTurn(3)[1].parts[1]
    const app = readRoutes({ getPart: (_c, _directory, sessionId, messageId, partId) => (sessionId === "session-1" && messageId === part.messageID && partId === part.id ? part : undefined) })

    const served = await app.request(`http://localhost/session/session-1/message/${part.messageID}/part/${part.id}`)
    expect(served.status).toBe(200)
    expect(served.headers.get("cache-control")).toBe("no-store")
    expect(await served.json()).toEqual(part)

    const missing = await app.request(`http://localhost/session/session-1/message/${part.messageID}/part/nope`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "part_not_found" } })

    expect((await readRoutes().request(`http://localhost/session/session-1/message/${part.messageID}/part/${part.id}`)).status).toBe(501)
  })

  test("a first read or a page read names every extent it needs and refuses one out of range, and a page read names its cursor", async () => {
    const { app } = pagedRoutes()
    for (const query of ["rows=10&cols=100", "rows=10&reasoning=0", "rows=10&cols=100&reasoning=0", "rows=0&cols=100&reasoning=0&shell=0&edit=0", "rows=10&cols=100&reasoning=yes&shell=0&edit=0", "rows=10&cols=2001&reasoning=1&shell=0&edit=0", "rows=10&cols=100&reasoning=0&shell=0&edit=2"]) {
      expect((await app.request(`http://localhost/session/session-1/outline?${query}`)).status).toBe(400)
      expect((await app.request(`http://localhost/session/session-1/page?${query}&before=3`)).status).toBe(400)
    }
    expect((await app.request(`http://localhost/session/session-1/page?${viewport}`)).status).toBe(400)
    expect((await app.request("http://localhost/session/session-1/page?before=3")).status).toBe(400)
  })

  test("returns unsupported instead of violating a bounded request with full history", async () => {
    let routeFullReads = 0
    const app = sessionRoutes(undefined, {
      getMessages: () => {
        routeFullReads += 1
        return [first, second]
      },
    })
    const response = await app.request("http://localhost/session/session-1/message?limit=1")

    expect(response.status).toBe(501)
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(routeFullReads).toBe(0)
  })

  test("preserves full history for legacy requests without paging parameters", async () => {
    let pageReads = 0
    const response = await sessionRoutes(undefined, {
      getMessages: () => [first, second],
      getMessagePage: () => {
        pageReads += 1
        return { messages: [second] }
      },
    }).request("http://localhost/session/session-1/message")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([first, second])
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(pageReads).toBe(0)
  })

  test("keeps snapshot reads full and ignores paging parameters", async () => {
    let pageCalls = 0
    const snapshot = { messages: [first, second], maxEventOrdinal: 14 }
    const app = sessionRoutes(undefined, {
      getMessageSnapshot: () => snapshot,
      getSession: (_c, _directory, sessionId) => ({ id: sessionId, title: "Hybrid", time: { created: 1, updated: 1 } }) as AgentSession,
      getMessagePage: () => {
        pageCalls += 1
        return { messages: [second], nextCursor: "must-not-leak" }
      },
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
    let pageReads = 0
    const app = sessionRoutes(undefined, {
      getMessagePage: () => {
        pageReads += 1
        return { messages: [] }
      },
    })

    for (const query of [
      "limit=0",
      "limit=1.5",
      "limit=501",
      "before=cursor",
      "limit=1&before=",
      "view=unknown",
      "view=latest-turn&limit=1",
      "view=latest-turn&before=",
      "view=latest-surface&before=cursor",
    ]) {
      const response = await app.request(`http://localhost/session/session-1/message?${query}`)
      expect(response.status).toBe(400)
    }
    expect(pageReads).toBe(0)
  })

  test("names which half of a turn coverage request is wrong and reads neither producer", async () => {
    let coverageReads = 0
    let pageReads = 0
    const app = sessionRoutes(undefined, {
      turnCoverage: () => {
        coverageReads += 1
        return undefined
      },
      getMessagePage: () => {
        pageReads += 1
        return { messages: [] }
      },
    })

    const refusals = await Promise.all(
      [
        "turn=turn-a",
        "coverage=1",
        "turn=turn-a&coverage=2",
        "turn=&coverage=1",
        "turn=turn-a&coverage=1&view=latest-turn",
        "turn=turn-a&coverage=1&limit=2",
        "turn=turn-a&coverage=1&before=cursor",
      ].map(async (query) => {
        const response = await app.request(`http://localhost/session/session-1/message?${query}`)
        return [response.status, await response.text()] as const
      }),
    )

    expect(refusals.map(([status]) => status)).toEqual([400, 400, 400, 400, 400, 400, 400])
    expect(refusals[0]?.[1]).toContain("turn requires coverage=1")
    expect(refusals[1]?.[1]).toContain("coverage=1 requires a non-empty turn")
    expect(refusals[2]?.[1]).toContain("turn requires coverage=1")
    expect(refusals[3]?.[1]).toContain("coverage=1 requires a non-empty turn")
    for (const [, body] of refusals.slice(4)) {
      expect(body).toContain("turn coverage cannot be combined with view, limit or before")
    }
    expect(coverageReads).toBe(0)
    expect(pageReads).toBe(0)
  })

  test("answers a turn coverage read from the journal owner alone", async () => {
    const calls: Array<{ sessionId: string; turnId: string; directory: RuntimeDirectory }> = []
    let pageReads = 0
    const app = sessionRoutes(undefined, {
      getMessagePage: () => {
        pageReads += 1
        return { messages: [] }
      },
      turnCoverage: (_c, directory, sessionId, turnId) => {
        calls.push({ sessionId, turnId, directory })
        return {
          turnId,
          coverage: "complete",
          terminal: { status: "completed", completedAt: 7, assistantMessageId: "message-2" },
          committedSequence: 12,
          messages: [first, second],
        }
      },
    })

    const response = await app.request("http://localhost/session/session-1/message?turn=message-1&coverage=1")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      turnId: "message-1",
      coverage: "complete",
      terminal: { status: "completed", completedAt: 7, assistantMessageId: "message-2" },
      committedSequence: 12,
      messages: [first, second],
    })
    expect(response.headers.get("x-next-cursor")).toBeNull()
    expect(calls).toEqual([{ sessionId: "session-1", turnId: "message-1", directory: WORKSPACE }])
    expect(pageReads).toBe(0)
  })

  test("refuses coverage for a turn no journal in this runtime owns", async () => {
    const response = await sessionRoutes(undefined).request("http://localhost/session/session-1/message?turn=message-1&coverage=1")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      turnId: "message-1",
      coverage: "unavailable",
      reason: "No turn journal in this runtime owns this session",
      committedSequence: 0,
      messages: [],
    })
  })

  test("maps typed page errors to their explicit HTTP status", async () => {
    const failing = (error: AgentMessagePageError) => sessionRoutes(undefined, { getMessagePage: () => { throw error } })

    const [missing, invalid] = await Promise.all([
      failing(new AgentMessagePageError(404, "session was not found")).request("http://localhost/session/missing/message?limit=1"),
      failing(new AgentMessagePageError(400, "cursor is invalid")).request("http://localhost/session/session-1/message?limit=1&before=opaque"),
    ])

    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain("session was not found")
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toContain("cursor is invalid")
  })

  test("does not trust an invalid status from a page error", async () => {
    const app = sessionRoutes(undefined, {
      getMessagePage: () => { throw new AgentMessagePageError(200, "invalid producer status") },
    })

    const response = await app.request("http://localhost/session/session-1/message?limit=1")

    expect(response.status).toBe(500)
  })
})

describe("createSessionRoutes directory-less sessions", () => {
  function directoryless(h: Harness | undefined, options: Partial<RouteOptions> = {}) {
    return sessionRoutes(h, {
      resolveDirectory: () => undefined,
      getSession: (_c, _directory, sessionId) => ({ id: sessionId, title: "Held", time: { created: 1, updated: 1 } }) as AgentSession,
      getSessionConfig: async () => ({ harness: CODEX, agent: null, variant: null }),
      ...options,
    })
  }

  test("persists the complete config before publishing a created session", async () => {
    const h = harness()
    const lifecycle: SessionLifecycleEvent[] = []
    const configAtCreated: unknown[] = []
    const app = sessionRoutes(h, {
      publishSessionLifecycle: (event) => {
        lifecycle.push(event)
        if (event.phase === "created" && event.sessionID) configAtCreated.push(h.store.getSessionConfig(event.sessionID))
      },
    })

    const res = await post(app, "/session", {
      model: { providerID: "claude-sdk", id: "sonnet", variant: "high" },
      agent: "build",
    })

    expect(res.status).toBe(201)
    expect(lifecycle.map((event) => event.phase)).toEqual(["creating", "created"])
    expect(configAtCreated).toEqual([expect.objectContaining({
      model: { providerID: "claude-sdk", modelID: "sonnet" },
      variant: "high",
      agent: "build",
    })])
    expect(h.transport.starts[0]?.config).toMatchObject({ model: { providerID: "claude-sdk", modelID: "sonnet" }, agent: "build" })
  })

  test("rolls back a session whose initial config cannot be persisted", async () => {
    const calls: string[] = []
    const lifecycle: SessionLifecycleEvent[] = []
    const h = harness({
      capabilities: { configOwner: "harness" },
      config: configOps({
        update: async () => {
          calls.push("config")
          throw new Error("config unavailable")
        },
      }),
      onClose: (session) => { calls.push(`delete:${session.binding.sessionId}`) },
    })
    const app = sessionRoutes(h, { publishSessionLifecycle: (event) => lifecycle.push(event) })

    const res = await post(app, "/session", {
      id: "session_rejected",
      harness: CODEX,
      model: { providerID: "claude-sdk", id: "sonnet" },
    })

    expect(res.status).toBe(500)
    expect(calls).toEqual(["config", "delete:session_rejected"])
    expect(lifecycle.map((event) => event.phase)).toEqual(["creating", "failed"])
    expect(await res.json()).toMatchObject({ error: { message: "config unavailable" } })
    expect(h.store.getSession("session_rejected")).toBeNull()
  })

  test("rolls back an explicit registration denial so the same requested id can retry", async () => {
    const calls: string[] = []
    let attempts = 0
    const h = harness({
      onStart: (input) => { calls.push(`create:${input.sessionId}`) },
      onClose: (session) => { calls.push(`delete:${session.binding.sessionId}`) },
    })
    const app = stamped(sessionRoutes(h, {
      sessionAccessPolicy: registrationPolicy(async () => {
        attempts += 1
        return attempts === 1
          ? { allowed: false, status: 403, code: "session_private", message: "Registration denied" }
          : { allowed: true }
      }),
    }))

    const request = () => post(app, "/session", { id: "session_stable" }, { "x-claxedo-session-registration-operation": "op_stable" })
    expect((await request()).status).toBe(403)
    expect((await request()).status).toBe(201)
    expect(calls).toEqual([
      "create:session_stable",
      "delete:session_stable",
      "create:session_stable",
    ])
  })

  test("preserves an ambiguous registration for exact-operation retry", async () => {
    let registrations = 0
    const h = harness()
    const app = stamped(sessionRoutes(h, {
      sessionAccessPolicy: registrationPolicy(async () => {
        registrations += 1
        if (registrations === 1) throw new Error("authority response timed out after commit")
        return { allowed: true }
      }),
    }))

    const request = () => post(app, "/session", { id: "session_committed" }, { "x-claxedo-session-registration-operation": "op_committed" })

    expect((await request()).status).toBe(503)
    expect((await request()).status).toBe(201)
    expect(registrations).toBe(2)
    expect(h.transport.closed).toEqual([])
    expect(h.transport.starts).toHaveLength(1)
  })

  test("registers and projects a forked child before returning it", async () => {
    const calls: string[] = []
    const h = harness({
      fork: async (_session, _messageId, childId) => {
        calls.push("fork")
        return { upstreamSessionId: `upstream-${childId}` }
      },
    })
    await seed(h, "session_parent")
    const app = stamped(sessionRoutes(h, {
      sessionAccessPolicy: registrationPolicy(async (input) => {
        calls.push(`register:${input.sessionId}`)
        return { allowed: true }
      }),
      afterCreateSession: async (_c, _directory, session) => {
        calls.push(`project:${(session as { id: string }).id}`)
      },
    }))

    const response = await post(app, "/session/session_parent/fork", { id: "session_child", messageId: "message_1" }, {
      "x-claxedo-session-registration-operation": "op_fork_child",
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "session_child" })
    expect(calls).toEqual(["fork", "register:session_child", "project:session_child"])
  })

  test("deletes a forked child when registration is denied", async () => {
    const calls: string[] = []
    const h = harness({
      fork: async (_session, _messageId, childId) => ({ upstreamSessionId: `upstream-${childId}` }),
      onClose: (session) => { calls.push(`delete:${session.binding.sessionId}`) },
    })
    await seed(h, "session_parent")
    const app = stamped(sessionRoutes(h, {
      sessionAccessPolicy: registrationPolicy(async () => ({
        allowed: false,
        status: 403,
        code: "session_private",
        message: "Registration denied",
      })),
      afterCreateSession: async () => { calls.push("project") },
    }))

    const response = await post(app, "/session/session_parent/fork", { id: "session_child" }, {
      "x-claxedo-session-registration-operation": "op_fork_denied",
    })

    expect(response.status).toBe(403)
    expect(calls).toEqual(["delete:session_child"])
    expect(h.store.getSession("session_child")).toBeNull()
  })

  test("keeps a missing backend title empty in the created lifecycle row", async () => {
    const lifecycle: SessionLifecycleEvent[] = []
    const res = await post(sessionRoutes(harness(), { publishSessionLifecycle: (event) => lifecycle.push(event) }), "/session", {})

    expect(res.status, await res.clone().text()).toBe(201)
    expect((lifecycle.find((event) => event.phase === "created")?.info as { title?: string } | undefined)?.title).toBe("")
  })

  /** The host's own session read, with each row's times replaced by fixed ones a clock could not produce. */
  const fixedTimes = (h: Harness, time: (id: string) => { created: number; updated: number } | undefined) =>
    (_c: unknown, _directory: RuntimeDirectory, sessionId: string) => {
      const row = h.store.getSession(sessionId)
      if (!row) return null
      const stamped = time(sessionId)
      const { time: _stored, ...untimed } = row
      return (stamped ? { ...untimed, time: stamped } : untimed) as AgentSession
    }

  test("a created session answers and announces its store's own times, never the route's clock", async () => {
    const h = harness()
    const lifecycle: SessionLifecycleEvent[] = []
    const app = sessionRoutes(h, {
      getSession: fixedTimes(h, () => ({ created: 1, updated: 1 })),
      publishSessionLifecycle: (event) => lifecycle.push(event),
    })

    const res = await post(app, "/session", {})

    expect(res.status).toBe(201)
    expect((await res.json() as { time?: unknown }).time).toEqual({ created: 1, updated: 1 })
    expect((lifecycle.find((event) => event.phase === "created")?.info as { time?: unknown } | undefined)?.time).toEqual({ created: 1, updated: 1 })
  })

  test("a session read, opened, first-read or listed with no creation or update time is refused, never given the route's clock", async () => {
    const untimed = { id: "ses_untimed", title: "Untimed" } as AgentSession
    const app = directoryless(undefined, {
      getSession: () => untimed,
      getTurnOutline: () => ({ turns: [], complete: true }),
      runtime: runtimeDouble({
        permissions: { list: async () => [] },
        questions: { list: async () => [] },
        reads: { capabilities: async () => ({ harness: "codex", todos: false }) },
        goals: { capabilities: async () => ({ implemented: false }) },
      }),
    })
    for (const path of ["/session/ses_untimed", "/session/ses_untimed?view=open", "/session/ses_untimed/outline"]) {
      expect((await app.request(`http://localhost${path}`)).status, path).toBe(500)
    }
    const listed = await managedRoutes(undefined, {
      policy: managedPolicy({ filterSessions: async () => [untimed.id] }),
      listSessions: async () => [untimed],
    }).request("http://localhost/session")
    expect(listed.status).toBe(500)
  })

  test("a renamed session answers and announces its store's times after the write, never the adapter's accepted copy", async () => {
    const h = harness()
    await seed(h, "session_1")
    const events: AgentEventEnvelope[] = []
    const app = sessionRoutes(h, { publishGlobal: (event) => events.push(event) })

    const response = await app.request("http://localhost/session/session_1", {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed" }),
    })

    expect(response.status).toBe(200)
    const stored = h.store.getSession("session_1")!
    expect(stored.title).toBe("Renamed")
    expect((await response.json() as { time?: unknown }).time).toEqual(stored.time)
    const announced = events.map((event) => event.payload).filter((payload) => payload.type === "session.updated")
    expect(announced.map((payload) => (payload as { properties: { info: { time: unknown } } }).properties.info.time)).toEqual([stored.time])
  })

  const unreadBacks = [
    ["cannot be read back", () => undefined],
    ["reads back with no times", () => undefined, true],
  ] as const
  for (const [readBack, , untimedRow] of unreadBacks) {
    for (const managed of [true, false]) {
      test(`a created session that ${readBack} is deleted before it is registered, projected or announced (${managed ? "managed" : "unmanaged"})`, async () => {
        const calls: string[] = []
        const lifecycle: SessionLifecycleEvent[] = []
        const events: AgentEventEnvelope[] = []
        const h = harness({ onClose: (session) => calls.push(`close:${session.binding.sessionId}`) })
        const options: Partial<RouteOptions> = {
          getSession: untimedRow ? fixedTimes(h, () => undefined) : () => null,
          publishGlobal: (event) => events.push(event),
          publishSessionLifecycle: (event) => lifecycle.push(event),
          afterCreateSession: async () => { calls.push("project") },
        }
        const app = managed
          ? managedRoutes(h, {
              ...options,
              policy: {
                ...registrationPolicy(async (input) => {
                  calls.push(`register:${input.sessionId}`)
                  return { allowed: true }
                }),
                beginRegistrationCompensation: async () => { calls.push("compensate"); return { allowed: true } },
              },
            })
          : sessionRoutes(h, options)

        const response = await post(app, "/session", managed ? { id: "session_1" } : {},
          managed ? { "x-claxedo-session-registration-operation": "op_create_unread" } : {})

        expect(response.status).toBe(500)
        const created = h.transport.starts[0].sessionId
        expect(calls).toEqual([`close:${created}`])
        expect(h.store.getSession(created)).toBeNull()
        expect(events).toEqual([])
        expect(lifecycle.map((event) => event.phase)).toEqual(["creating", "failed"])
      })

      test(`a forked child that ${readBack} is deleted before it is registered, projected or announced (${managed ? "managed" : "unmanaged"})`, async () => {
        const calls: string[] = []
        const events: AgentEventEnvelope[] = []
        const h = harness({
          fork: async (_session, _messageId, childId) => { calls.push("fork"); return { upstreamSessionId: `upstream-${childId}` } },
          onClose: (session) => calls.push(`close:${session.binding.sessionId}`),
        })
        await seed(h, "session_parent")
        const options: Partial<RouteOptions> = {
          getSession: (_c, directory, sessionId) => sessionId === "session_child"
            ? untimedRow ? fixedTimes(h, () => undefined)(_c, directory, sessionId) : null
            : h.store.getSession(sessionId),
          publishGlobal: (event) => events.push(event),
          afterCreateSession: async () => { calls.push("project") },
        }
        const app = managed
          ? managedRoutes(h, {
              ...options,
              policy: {
                ...registrationPolicy(async (input) => {
                  calls.push(`register:${input.sessionId}`)
                  return { allowed: true }
                }),
                beginRegistrationCompensation: async () => { calls.push("compensate"); return { allowed: true } },
              },
            })
          : sessionRoutes(h, options)

        const response = await post(app, "/session/session_parent/fork", { id: "session_child", messageId: "message_1" },
          managed ? { "x-claxedo-session-registration-operation": "op_fork_unread" } : {})

        expect(response.status).toBe(500)
        expect(calls).toEqual(["fork", "close:session_child"])
        expect(h.store.getSession("session_child")).toBeNull()
        expect(events).toEqual([])
      })
    }
  }

  for (const managed of [false, true]) {
    test(`a fork the harness refuses as unsupported answers the unsupported shape and is never read back, registered or deleted (${managed ? "managed" : "unmanaged"})`, async () => {
      const calls: string[] = []
      const h = harness({
        fork: async () => {
          calls.push("fork")
          throw new AgentRuntimeContractError({ code: "unsupported_operation", operation: "fork", message: "this harness names its forks itself" })
        },
        onClose: (session) => calls.push(`close:${session.binding.sessionId}`),
      })
      await seed(h, "session_parent")
      const options: Partial<RouteOptions> = { afterCreateSession: async () => { calls.push("project") } }
      const app = managed
        ? managedRoutes(h, {
            ...options,
            policy: registrationPolicy(async (input) => {
              calls.push(`register:${input.sessionId}`)
              return { allowed: true }
            }),
          })
        : sessionRoutes(h, options)

      const response = await post(app, "/session/session_parent/fork", { id: "session_child", messageId: "message_1" },
        managed ? { "x-claxedo-session-registration-operation": "op_fork_reserved" } : {})

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "unsupported_operation", operation: "fork", capability: "fork", reason: "harness_refused", message: "this harness names its forks itself" },
      })
      expect(calls).toEqual(["fork"])
      expect(h.store.getSession("session_child")).toBeNull()
    })
  }

  test("a forked child is persisted by its host before it is read back, and answers its row's times", async () => {
    const h = harness({ fork: async (_session, _messageId, childId) => ({ upstreamSessionId: `upstream-${childId}` }) })
    await seed(h, "session_parent")

    const response = await post(sessionRoutes(h, {
      getSession: fixedTimes(h, (id) => ({ created: 3, updated: id === "session_parent" ? 3 : 4 })),
    }), "/session/session_parent/fork", { messageId: "message_1" })

    expect(response.status).toBe(201)
    const forked = await response.json() as { id: string; time: unknown }
    expect(h.store.getSession(forked.id)).toBeTruthy()
    expect(forked.time).toEqual({ created: 3, updated: 4 })
  })

  test("filters transcript-bearing collections through the verified relay actor", async () => {
    const calls: Array<{ operation: string; actorId?: string; sessionIds: string[] }> = []
    const policy: SessionAccessPolicy = {
      sessionAuthority: "managed-private",
      authorize: async () => ({ allowed: true }),
      authorizeSessionStart: async () => ({ allowed: true }),
      authorizeSessionStartStatus: async () => ({ allowed: true }),
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
    const inventory = {
      permissions: {
        list: async () => [
          { id: "perm_allowed", sessionID: "session_allowed" },
          { id: "perm_hidden", sessionID: "session_hidden" },
        ] as AgentPermission[],
      },
      questions: {
        list: async () => [
          { id: "question_allowed", sessionID: "session_allowed", questions: [] },
          { id: "question_hidden", sessionID: "session_hidden", questions: [] },
        ] as AgentQuestion[],
      },
    }
    const app = stamped(createSessionRoutes({
      runtime: runtimeDouble(inventory),
      defaultHarness: () => CODEX,
      requestedSessionHarness: () => undefined,
      resolveDirectory: () => undefined,
      listSessions: async () => [
        { id: "session_allowed", time: { created: 1, updated: 2 } },
        { id: "session_hidden", time: { created: 1, updated: 2 } },
      ] as AgentSession[],
      getStatus: () => ({ session_allowed: { type: "idle" }, session_hidden: { type: "busy" } }),
      sessionAccessPolicy: policy,
      publishGlobal: () => {},
    }), () => ({ actor_id: "actor_verified", actor_kind: "human", workspace_id: "ws_1", org_id: "org_1", role: "editor" }))

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

  test("opens a session with its own status, requests, todos and subagents as the per-fact routes answer them, on the session read's one decision", async () => {
    const decisions: string[] = []
    const filtered: string[] = []
    const policy: SessionAccessPolicy = {
      sessionAuthority: "managed-private",
      authorize: async (input) => {
        decisions.push(`${input.sessionId}:${input.operation}`)
        return { allowed: true }
      },
      authorizeSessionStart: async () => ({ allowed: true }),
      authorizeSessionStartStatus: async () => ({ allowed: true }),
      authorizePrefix: async () => ({ allowed: true }),
      filterSessions: async (input) => {
        filtered.push(input.operation)
        return input.sessionIds.filter((id) => id === "session_open")
      },
    }
    const todos = [{ id: "todo_1", content: "Read the view", status: "pending", priority: "medium" }]
    const subagents = [{ subagentKey: "sub_1", revision: 2, toolCallEdges: [{ toolCallId: "call_1", role: "spawn", revision: 1 }] }]
    const routes = sessionRoutes(undefined, {
      runtime: runtimeDouble({
        permissions: {
          list: async () => [
            { id: "perm_open", sessionID: "session_open" },
            { id: "perm_other", sessionID: "session_other" },
          ] as AgentPermission[],
        },
        questions: {
          list: async () => [
            { id: "question_open", sessionID: "session_open", questions: [] },
            { id: "question_other", sessionID: "session_other", questions: [] },
          ] as AgentQuestion[],
        },
        reads: { declaredCapabilities: async () => ({ harness: "codex", todos: true }) },
        goals: { capabilities: async () => ({ implemented: false, available: false, actions: [], optionalFields: [], recovery: "blocked" }) },
      }),
      getSession: (_c, _directory, sessionId) => ({ id: sessionId, title: "Open", time: { created: 1, updated: 1 } }) as AgentSession,
      getStatus: () => ({ session_open: { type: "busy" }, session_other: { type: "idle" } }),
      getTodos: (_c, _directory, sessionId) => sessionId === "session_open" ? todos : [],
      listSubagents: (_c, _directory, parentSessionId) => parentSessionId === "session_open" ? subagents : [],
      sessionAccessPolicy: policy,
    })

    const opened = await routes.request("http://localhost/session/session_open?view=open")

    expect(opened.status).toBe(200)
    const view = await opened.json()
    expect(decisions).toEqual(["session_open:session_meta_read"])
    expect(filtered).toEqual([])
    expect(view).not.toHaveProperty("session")
    expect(view.status).toEqual({ value: (await (await routes.request("http://localhost/session/status")).json()).session_open })
    expect(view.permissions).toEqual({ value: await (await routes.request("http://localhost/permission")).json() })
    expect(view.questions).toEqual({ value: await (await routes.request("http://localhost/question")).json() })
    expect(view.todos).toEqual({ value: todos })
    expect(view.subagents).toEqual({ value: await (await routes.request("http://localhost/session/session_open/subagents")).json() })
    expect(view.subagents).toEqual({ value: subagents })
    expect((await routes.request("http://localhost/session/session_open?view=everything")).status).toBe(400)
  })

  test("a prompt naming a message id another session holds is refused with 409 message_id_conflict, on /message and prompt_async", async () => {
    const h = harness()
    await seed(h, "session_a")
    await seed(h, "session_b")
    await h.runtime.turns.start({ sessionId: "session_a", messageId: "msg_shared", parts: [{ type: "text", text: "first" }], origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false } })
    await h.runtime.turns.whenIdle("session_a")
    const app = sessionRoutes(h)
    const prompt = { messageID: "msg_shared", parts: [{ type: "text", text: "steal" }] }

    for (const path of ["/session/session_b/message", "/session/session_b/prompt_async"]) {
      const response = await post(app, path, prompt)
      expect(response.status, path).toBe(409)
      expect(await response.json(), path).toMatchObject({ error: { code: "message_id_conflict" } })
    }
    expect(h.store.getMessages("session_a").map((message) => message.info.id)).toContain("msg_shared")
    expect(h.store.getMessages("session_b")).toEqual([])
  })

  test("a permission mode the harness does not offer is refused as bad input by its typed code", async () => {
    const offered: AgentPermissionModeState = { modes: [{ id: "default", name: "Default" }], currentModeId: "default", appliesFrom: "next-turn" }
    const h = harness({
      config: configOps({ permissionModes: async () => offered, setPermissionMode: async () => offered }),
    })
    await seed(h, "session_modes")

    const response = await sessionRoutes(h).request("http://localhost/session/session_modes/permission-mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modeId: "nope" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "unknown_permission_mode" } })
  })

  test("a prompt naming a mode its harness does not offer, or naming one to a harness with no modes, is refused as bad input and runs no turn", async () => {
    const offered: AgentPermissionModeState = { modes: [{ id: "default", name: "Default" }], currentModeId: "default", appliesFrom: "next-turn" }
    const withModes = harness({ config: configOps({ permissionModes: async () => offered, setPermissionMode: async () => offered }) })
    const withoutModes = harness({ config: configOps() })
    for (const [h, code] of [[withModes, "unknown_permission_mode"], [withoutModes, "permission_mode_unsupported"]] as const) {
      await seed(h, "session_modes")
      for (const path of ["/session/session_modes/message", "/session/session_modes/prompt_async"]) {
        const response = await post(sessionRoutes(h), path, { permissionMode: "nope", parts: [{ type: "text", text: "go" }] })
        expect(response.status, `${code} ${path}`).toBe(400)
        expect(await response.json()).toMatchObject({ error: { code } })
      }
      expect(h.transport.turns).toEqual([])
    }
  })

  test("threads immutable actor attribution from verified relay claims and ignores body spoofing", async () => {
    const starts: unknown[] = []
    const runtime = {
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
            delivery: "start",
          }
        },
      },
      events: {
        subscribe: () => (async function* () {
          yield { sessionId: "session_1", directory: undefined, payload: sessionIdle("session_1") }
        })(),
        list: async () => [],
      },
      reads: { permissionModes: async () => undefined },
    }
    const app = stamped(directoryless(undefined, { runtime: runtimeDouble(runtime) }), () => ({
      actor_id: "actor_verified",
      actor_kind: "human",
      actor_public_id: "user_public_verified",
      actor_name: "Verified User",
      actor_avatar_url: "https://example.invalid/avatar",
      workspace_id: "ws_1",
      org_id: "org_1",
      role: "editor",
    }))

    const response = await post(app, "/session/session_1/message", {
      actorId: "actor_attacker",
      actorKind: "agent",
      author: { id: "attacker", name: "Attacker", kind: "agent" },
      parts: [],
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
    const res = await directoryless(harness({
      agents: { list: async () => { throw new Error("opencode does not expose live agent options") } },
    })).request("http://localhost/agent")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("passes undefined directory through detail routes", async () => {
    const targets: unknown[] = []
    const res = await directoryless(undefined, {
      runtime: runtimeDouble({
        reads: {
          capabilities: async (target: unknown) => {
            targets.push(target)
            return { harness: "codex" }
          },
        },
      }),
    }).request("http://localhost/session/session_1/capabilities")

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ harness: "codex" })
    expect(targets).toEqual([{ sessionId: "session_1" }])
  })

  test("returns snapshot metadata and the canonical session together", async () => {
    const messages = [{
      info: { id: "message_1", sessionID: "session_1", role: "assistant" },
      parts: [],
    }] as unknown as AgentMessage[]
    const res = await directoryless(undefined, {
      getMessageSnapshot: () => ({ messages, maxEventOrdinal: 7 }),
      getSession: () => ({ id: "session_1", title: "Settled", time: { created: 1, updated: 2 } }) as AgentSession,
    }).request("http://localhost/session/session_1/message?snapshot=1")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      messages,
      maxEventOrdinal: 7,
      session: { id: "session_1", title: "Settled", time: { created: 1, updated: 2 } },
    })
  })

  test("wraps replay messages with the canonical session only for snapshot callers", async () => {
    const messages = [{
      info: { id: "message_1", sessionID: "session_1", role: "assistant" },
      parts: [],
    }] as unknown as AgentMessage[]
    const app = directoryless(undefined, {
      getMessages: () => messages,
      getSession: () => ({ id: "session_1", title: "Settled", time: { created: 1, updated: 2 } }) as AgentSession,
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
    const res = await directoryless(undefined, {
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
    const res = await directoryless(undefined, {
      listSubagents: (_c, directory, parentSessionId) => {
        calls.push({ directory, parentSessionId })
        return [{ subagentKey: "child_1", revision: 3, status: "running" }]
      },
    }).request("http://localhost/session/parent_1/subagents")

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual([{ subagentKey: "child_1", revision: 3, status: "running" }])
    expect(calls).toEqual([{ directory: undefined, parentSessionId: "parent_1" }])
  })

  test("refuses a prompt for a session this runtime does not hold before publishing prompt events", async () => {
    const events: AgentEventEnvelope[] = []
    const h = harness()
    const app = sessionRoutes(h, { publishGlobal: (event) => events.push(event) })
    const prompt = { agent: "build", model: { providerID: "test", modelID: "fixture" }, variant: "fixture", parts: [{ type: "text", text: "hello" }] }

    for (const route of ["message", "prompt_async"]) {
      const res = await post(app, `/session/session_1/${route}`, prompt)
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: { code: "session_not_found" } })
    }
    expect(events).toEqual([])
    expect(h.transport.turns).toEqual([])
  })

  test("can run message turns through the agent runtime facade, which sets the turn's own mode on the harness once and stores it", async () => {
    const events: AgentEventEnvelope[] = []
    const set: string[] = []
    const winner: AgentPermissionModeState = { modes: [{ id: "winner-mode", name: "Winner" }], currentModeId: "winner-mode", appliesFrom: "next-turn" }
    const h = harness({
      config: configOps({
        permissionModes: async () => winner,
        setPermissionMode: async (_session, modeId) => { set.push(modeId); return winner },
      }),
    })
    await seed(h, "session_1")

    const res = await post(sessionRoutes(h, { publishGlobal: (event) => events.push(event) }), "/session/session_1/message", {
      messageID: "user_1",
      agent: "build",
      model: { providerID: "test", modelID: "fixture" },
      permissionMode: "winner-mode",
      parts: [{ type: "text", text: "hello" }],
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ info: { id: "user_1_r", role: "assistant" } })
    expect(h.transport.turns.map((turn) => ({
      text: promptText(turn),
      agent: turn.turn.prompt.agent,
      model: turn.turn.model,
      permissionMode: turn.turn.prompt.permissionMode,
    }))).toEqual([{
      text: "hello",
      agent: "build",
      model: { providerID: "test", modelID: "fixture" },
      permissionMode: "winner-mode",
    }])
    expect(set).toEqual(["winner-mode"])
    expect(h.store.getSessionConfig("session_1")?.permissionMode).toBe("winner-mode")
    expect(events).toEqual([])
  })

  test("a prompt_async whose turn fails to start publishes the failure once, with its cause instead of 'Stream error'", async () => {
    const events: AgentEventEnvelope[] = []
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
    }
    let turnCleanedUp!: () => void
    const cleanedUp = new Promise<void>((resolve) => { turnCleanedUp = resolve })
    const app = directoryless(undefined, {
      runtime: runtimeDouble(runtime),
      publishGlobal: (event) => events.push(event),
      flushSessionDocuments: async () => turnCleanedUp(),
    })

    const res = await post(app, "/session/session_1/prompt_async", {
      agent: "build",
      model: { providerID: "test", modelID: "fixture" },
      parts: [{ type: "text", text: "hello" }],
    })

    expect(res.status).toBe(204)
    await cleanedUp

    const sessionErrors = events.filter((event) => event.payload.type === "session.error")
    expect(sessionErrors).toHaveLength(1)
    for (const event of sessionErrors) {
      const error = (event.payload as { properties: { error: { data?: { message?: string; firstTurnErrorClass?: string } } } })
        .properties.error
      expect(error.data?.message).not.toBe("Stream error")
      expect(error.data?.message).toContain("thread not found")
      expect(error.data?.firstTurnErrorClass).toBe("session")
    }
  })

  test("returns sender-only structured conflicts for message and prompt_async", async () => {
    const events: AgentEventEnvelope[] = []
    const runtime = {
      turns: {
        start: async () => {
          throw new AgentRuntimeTurnAdmissionError("session_1")
        },
      },
      reads: { permissionModes: async (): Promise<AgentPermissionModeState> => ({ modes: [{ id: "loser-mode", name: "Loser" }], appliesFrom: "next-turn" }) },
      events: {
        subscribe: () => (async function* () {})(),
        list: async () => [],
      },
    }
    const app = directoryless(undefined, { runtime: runtimeDouble(runtime), publishGlobal: (event) => events.push(event) })
    const request = { messageID: "loser", permissionMode: "loser-mode", parts: [{ type: "text", text: "hello" }] }

    const message = await post(app, "/session/session_1/message", request)
    const promptAsync = await post(app, "/session/session_1/prompt_async", request)

    expect(message.status).toBe(409)
    expect(await message.json()).toMatchObject({ error: { code: "session_turn_in_progress" } })
    expect(promptAsync.status).toBe(409)
    expect(await promptAsync.json()).toMatchObject({ error: { code: "session_turn_in_progress" } })
    expect(events.some((event) => event.payload.type === "session.error")).toBe(false)
  })

  test("the legacy command route answers 501 without resolving a harness", async () => {
    const response = await post(directoryless(undefined), "/session/session_1/command", { command: "test" })
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ error: { code: "unsupported_operation" } })
  })

  for (const route of ["shell", "summarize", "revert", "unrevert"] as const) {
    test(`${route} answers 501 without resolving a harness`, async () => {
      const response = await sessionRoutes(undefined).request(`http://localhost/session/session_1/${route}`, { method: "POST" })

      expect(response.status).toBe(501)
      expect(await response.json()).toEqual({
        ok: false,
        error: {
          code: "unsupported_operation",
          operation: route,
          reason: "not_implemented",
          message: `${route} is not implemented`,
        },
      })
    })
  }

  test("a denied caller is refused before learning an operation is not implemented", async () => {
    const response = await managedRoutes(undefined, {
      policy: managedPolicy({ authorize: async () => ({ allowed: false, status: 403, code: "session_access_denied", message: "Private session" }) }),
    }).request("http://localhost/session/session_1/revert", { method: "POST" })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "session_access_denied" } })
  })

  test("prompt_async falls back to 204 when admission does not settle within the bound", async () => {
    // turns.start hangs before ever settling admission (a wedged harness
    // spawn). Without the timeout the request would hang forever; with it the
    // route honors prompt_async's fire-and-forget contract.
    const runtime = {
      turns: { start: () => new Promise(() => {}) },
      events: {
        subscribe: () => (async function* () {})(),
        list: async () => [],
      },
    }
    const app = directoryless(undefined, { runtime: runtimeDouble(runtime), promptAsyncAdmissionAckTimeoutMs: 30 })

    const res = await post(app, "/session/session_1/prompt_async", { parts: [{ type: "text", text: "hello" }] })

    expect(res.status).toBe(204)
  })

  function admittedTurn() {
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
      delivery: "start",
    }
  }

  test("keeps prompt_async success empty and 204", async () => {
    const runtime = {
      turns: { start: async () => admittedTurn() },
      events: {
        subscribe: () => (async function* () {
          yield { sessionId: "session_1", directory: undefined, payload: sessionIdle("session_1") }
        })(),
        list: async () => [],
      },
    }
    const response = await post(directoryless(undefined, { runtime: runtimeDouble(runtime) }), "/session/session_1/prompt_async", { messageID: "winner", parts: [] })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
  })

  test("a resubmission racing a failed admission of its id joins the failure, then a later retry admits", async () => {
    let starts = 0
    let started!: () => void
    let release!: () => void
    const attempted = new Promise<void>((resolve) => { started = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const runtime = {
      turns: {
        start: async () => {
          starts += 1
          if (starts === 1) {
            started()
            await blocked
            throw new AgentRuntimeTurnAdmissionError("session_1")
          }
          return admittedTurn()
        },
      },
      events: {
        subscribe: () => (async function* () {})(),
        list: async () => [],
      },
    }
    const app = directoryless(undefined, { runtime: runtimeDouble(runtime) })
    const submit = () => post(app, "/session/session_1/prompt_async", { messageID: "raced", parts: [{ type: "text", text: "hello" }] })

    const first = submit()
    await attempted
    const second = submit()
    // The retry's pre-dedup awaits are all settled promises: one macrotask
    // parks it on the pending admission before the first's failure lands.
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()

    expect((await first).status).toBe(409)
    const retried = await second
    expect(retried.status).toBe(409)
    expect(await retried.json()).toMatchObject({ error: { code: "session_turn_in_progress" } })

    // The failed admission released the id, so a retry that arrives once the
    // cause is gone admits for real instead of joining the stale failure.
    expect((await submit()).status).toBe(204)
    expect(starts).toBe(2)
  })

  test("a resubmission racing a successful admission of its id joins the accepted answer", async () => {
    let starts = 0
    let started!: () => void
    let admit!: () => void
    const attempted = new Promise<void>((resolve) => { started = resolve })
    const blocked = new Promise<void>((resolve) => { admit = resolve })
    const runtime = {
      turns: {
        start: async () => {
          starts += 1
          started()
          await blocked
          return admittedTurn()
        },
      },
      events: {
        subscribe: () => (async function* () {})(),
        list: async () => [],
      },
    }
    const app = directoryless(undefined, { runtime: runtimeDouble(runtime) })
    const submit = () => post(app, "/session/session_1/prompt_async", { messageID: "joined", parts: [{ type: "text", text: "hello" }] })

    const first = submit()
    await attempted
    const second = submit()
    await new Promise((resolve) => setTimeout(resolve, 0))
    admit()

    expect((await first).status).toBe(204)
    expect((await second).status).toBe(204)
    expect(starts).toBe(1)
  })

  test("a resubmission after admission completed is still deduplicated", async () => {
    let starts = 0
    const runtime = {
      turns: {
        start: async () => {
          starts += 1
          return admittedTurn()
        },
      },
      events: {
        subscribe: () => (async function* () {})(),
        list: async () => [],
      },
    }
    const app = directoryless(undefined, { runtime: runtimeDouble(runtime) })
    const submit = () => post(app, "/session/session_1/prompt_async", { messageID: "settled", parts: [{ type: "text", text: "hello" }] })

    expect((await submit()).status).toBe(204)
    expect((await submit()).status).toBe(204)
    expect(starts).toBe(1)
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
    const offered = (current?: string): AgentPermissionModeState => ({
      modes: [{ id: "winner-mode", name: "Winner" }, { id: "loser-mode", name: "Loser" }], ...(current ? { currentModeId: current } : {}), appliesFrom: "next-turn",
    })
    const h = harness({
      config: configOps({ permissionModes: async () => offered(), setPermissionMode: async (_session, modeId) => offered(modeId) }),
      turn: async function* ({ session, turn }) {
        if (turn.prompt.permissionMode) modes.push(turn.prompt.permissionMode)
        markStarted?.()
        await blocked
        yield { type: "finish", sessionId: session.binding.sessionId }
      },
    })
    await seed(h, "session_1", "/work")
    const events: AgentEventEnvelope[] = []
    h.eventHub.subscribeGlobal((event) => events.push(event))
    const app = sessionRoutes(h, {
      resolveDirectory: () => "/work",
      publishGlobal: (event) => events.push(event),
      createActiveTurnScope: () => {
        activeScopes++
        return { dispose: () => {} }
      },
    })
    const first = post(app, "/session/session_1/message", {
      messageID: "winner",
      permissionMode: "winner-mode",
      parts: [{ type: "text", text: "first" }],
    })
    await started

    const second = await post(app, "/session/session_1/prompt_async", {
      messageID: "loser",
      permissionMode: "loser-mode",
      parts: [{ type: "text", text: "second" }],
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
  })

  test("prompt_async continues after its accepted client request disconnects", async () => {
    let finishTurn = () => {}
    const turnGate = new Promise<void>((resolve) => { finishTurn = resolve })
    let completeDisposal = () => {}
    const disposal = new Promise<void>((resolve) => { completeDisposal = resolve })
    let disposed = false
    let consumed = false
    const events: AgentEventEnvelope[] = []
    const runtime = {
      turns: {
        start: async (input: { onAdmitted?: () => void }) => {
          input.onAdmitted?.()
          return { ...admittedTurn(), prompt: { ...admittedTurn().prompt, parts: [{ type: "text", text: "continue" }] } }
        },
      },
      events: {
        subscribe: () => (async function* () {
          await turnGate
          consumed = true
          yield {
            sessionId: "session_1",
            directory: undefined,
            payload: sessionIdle("session_1"),
          }
        })(),
        list: async () => [],
      },
    }
    const app = directoryless(undefined, {
      runtime: runtimeDouble(runtime),
      createActiveTurnScope: () => ({
        dispose: () => {
          disposed = true
          completeDisposal()
        },
      }),
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

    expect(consumed).toBe(true)
    expect(events).toEqual([])
    expect(disposed).toBe(true)
  })
})

for (const operation of ["reply", "reject"] as const) {
  test(`a stale question ${operation} returns not-found without starting a harness`, async () => {
    const h = harness()
    const app = sessionRoutes(h, { resolveDirectory: () => "/work" })
    app.onError(() => new Response("unexpected harness resolution", { status: 500 }))
    const response = await post(app, `/question/finished-question/${operation}?directory=%2Fwork`, { answers: [["Staging"]] })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: "interaction_not_found" } })
    expect(h.transport.starts).toEqual([])
    expect(h.transport.attaches).toEqual([])
  })
}

test("question listing filters the authoritative workspace inventory without resolving the supplied session", async () => {
  const rows = [
    { id: "question_first", sessionID: "session_first", questions: [] },
    { id: "question_second", sessionID: "session_second", questions: [] },
  ] as AgentQuestion[]
  const app = sessionRoutes(undefined, {
    resolveDirectory: () => "/repo",
    runtime: runtimeDouble({ questions: { list: async () => rows } }),
  })
  const selected = await app.request("http://localhost/question?sessionId=session_first")
  expect(selected.status).toBe(200)
  expect(await selected.json()).toEqual([rows[0]])
  const unknown = await app.request("http://localhost/question?sessionId=another_workspace_session")
  expect(unknown.status).toBe(200)
  expect(await unknown.json()).toEqual([])
  for (const operation of ["reply", "reject"]) {
    const response = await post(app, `/question/question_first/${operation}?sessionId=another_workspace_session`, { answers: [["Staging"]] })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: "interaction_session_mismatch" } })
  }
})

test("delete publishes the removed identity only after durable deletion succeeds", async () => {
  for (const fail of [false, true]) {
    const events: AgentEventEnvelope[] = []
    const order: string[] = []
    const h = harness({ onClose: () => { order.push("harness") } })
    await seed(h, "deleted")
    const app = sessionRoutes(h, {
      afterDeleteSession: () => { order.push("store"); if (fail) throw new Error("store deletion failed") },
      publishGlobal: (event) => { order.push("event"); events.push(event) },
    })
    const result = await app.request("http://localhost/session/deleted", { method: "DELETE" })
    expect(result.status).toBe(fail ? 500 : 200)
    expect(order).toEqual(fail ? ["harness", "store"] : ["harness", "store", "event"])
    expect(events).toEqual(fail ? [] : [{ directory: WORKSPACE, payload: { type: "session.deleted", properties: { info: { id: "deleted", directory: WORKSPACE } } } }])
  }
})

test("late approval is not found without starting a retired harness", async () => {
  const h = harness()
  const result = await post(sessionRoutes(h), "/session/deleted/permissions/expired", { response: "always" })
  expect(result.status).toBe(404)
  expect(h.transport.starts).toEqual([])
  expect(h.transport.attaches).toEqual([])
})

describe("createSessionRoutes session instructions", () => {
  function instructionRoutes(input: { instructionChannel: HarnessInstructionChannel }) {
    const turns: Array<string | undefined> = []
    const entered: Array<string | undefined> = []
    let held: Promise<void> | undefined
    let release: (() => void) | undefined
    const configRead = { fails: false }
    const events: AgentEventEnvelope[] = []
    const watchers = new Set<() => void>()
    function notify() {
      for (const watcher of watchers) watcher()
    }
    const h = harness({
      capabilities: { instructionChannel: input.instructionChannel },
      turn: async function* ({ session, turn }) {
        entered.push(turn.system)
        notify()
        if (held) await held
        turns.push(turn.system)
        notify()
        yield { type: "finish", sessionId: session.binding.sessionId }
      },
    })
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
    const app = sessionRoutes(h, {
      getSessionConfig: async (_c, _directory, sessionId) => {
        if (configRead.fails) throw new Error("session config store unreachable")
        const config = h.store.getSessionConfig(sessionId)
        if (!config) throw new Error(`Session ${sessionId} has no config`)
        return config
      },
      publishGlobal(event) {
        events.push(event)
        notify()
      },
    })
    return { app, h, turns, entered, model, configRead, events, settled }
  }

  function sessionErrors(events: AgentEventEnvelope[]) {
    return events.filter((event) => event.payload.type === "session.error")
  }

  const prompt = { parts: [{ type: "text", text: "go" }], agent: "build", model: { providerID: "test", modelID: "fixture" }, variant: "fixture" }

  test("carries the block to session creation and reads it back on the config", async () => {
    const { app, h } = instructionRoutes({ instructionChannel: "turn-system-prompt" })
    const created = await post(app, "/session", { id: "ses_instructions", instructions: "Answer only in haiku." })
    expect(created.status).toBe(201)
    expect(h.transport.starts.map((start) => ({ id: start.sessionId, instructions: start.instructions }))).toEqual([
      { id: "ses_instructions", instructions: "Answer only in haiku." },
    ])

    const config = await app.request("http://localhost/session/ses_instructions/config")
    expect(await config.json()).toMatchObject({ instructions: "Answer only in haiku." })
  })

  test("leaves the start without instructions when no block was sent", async () => {
    const { app, h } = instructionRoutes({ instructionChannel: "turn-system-prompt" })
    expect((await post(app, "/session", { id: "ses_plain" })).status).toBe(201)
    expect(h.transport.starts.map((start) => ({ id: start.sessionId, instructions: start.instructions }))).toEqual([
      { id: "ses_plain", instructions: undefined },
    ])
  })

  test("refuses a block over the cap before the harness is asked to create anything", async () => {
    const { app, h } = instructionRoutes({ instructionChannel: "turn-system-prompt" })
    const response = await post(app, "/session", { id: "ses_big", instructions: "x".repeat(65_537) })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "session_instructions_too_large" } })
    expect(h.transport.starts).toEqual([])
  })

  test("measures the cap in UTF-8 bytes rather than code units", async () => {
    const { app, h } = instructionRoutes({ instructionChannel: "turn-system-prompt" })
    const response = await post(app, "/session", { id: "ses_utf8", instructions: "🙂".repeat(16_385) })
    expect(response.status).toBe(400)
    expect(h.transport.starts).toEqual([])
  })

  test("refuses a harness with no instruction channel instead of dropping the block", async () => {
    const { app, h } = instructionRoutes({ instructionChannel: "none" })
    const response = await post(app, "/session", { id: "ses_unsupported", instructions: "Answer only in haiku." })
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ error: { code: "session_instructions_unsupported" } })
    expect(h.transport.starts).toEqual([])
  })

  // Naming agent, model and variant is the one prompt shape that could skip
  // the config read, and the retained block arrives through that read.
  test("a later turn carries the retained block even when the caller named agent, model and variant", async () => {
    const { app, turns } = instructionRoutes({ instructionChannel: "turn-system-prompt" })
    expect((await post(app, "/session", { id: "ses_resume", instructions: "Answer only in haiku." })).status).toBe(201)

    expect((await post(app, "/session/ses_resume/message", prompt)).status).toBe(200)
    expect(turns).toEqual(["Answer only in haiku."])
  })

  test("a session that retained nothing still prompts, with no instruction channel used", async () => {
    const { app, turns } = instructionRoutes({ instructionChannel: "turn-system-prompt" })
    expect((await post(app, "/session", { id: "ses_plain" })).status).toBe(201)

    expect((await post(app, "/session/ses_plain/message", prompt)).status).toBe(200)
    expect(turns).toEqual([undefined])
  })

  // The host reads the retained block from the store it admits the turn in,
  // so a route-level config read that fails is never the source of it.
  test("a turn runs under the block the host store retained, never under a route-level config read", async () => {
    const { app, turns, configRead } = instructionRoutes({ instructionChannel: "turn-system-prompt" })
    expect((await post(app, "/session", { id: "ses_unreadable", instructions: "Answer only in haiku." })).status).toBe(201)

    configRead.fails = true
    expect((await post(app, "/session/ses_unreadable/message", prompt)).status).toBe(200)
    expect(turns).toEqual(["Answer only in haiku."])
  })

  test("a prompt_async id runs once with the retained block, and its resubmission joins it", async () => {
    const { app, turns, events, settled } = instructionRoutes({ instructionChannel: "turn-system-prompt" })
    expect((await post(app, "/session", { id: "ses_recover", instructions: "Answer only in haiku." })).status).toBe(201)

    expect((await post(app, "/session/ses_recover/prompt_async", { ...prompt, messageID: "msg_recover" })).status).toBe(204)
    await settled(() => turns.length > 0)
    expect(turns).toEqual(["Answer only in haiku."])

    expect((await post(app, "/session/ses_recover/prompt_async", { ...prompt, messageID: "msg_recover" })).status).toBe(204)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(turns).toEqual(["Answer only in haiku."])
    expect(sessionErrors(events)).toEqual([])
  })

  test("answers 204 while the model is still running the turn", async () => {
    const { app, turns, entered, model, settled } = instructionRoutes({ instructionChannel: "turn-system-prompt" })
    expect((await post(app, "/session", { id: "ses_slow" })).status).toBe(201)

    model.hold()
    expect((await post(app, "/session/ses_slow/prompt_async", { ...prompt, messageID: "msg_slow" })).status).toBe(204)
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
    const h = harness()
    return { h, app: sessionRoutes(h) }
  }

  test("retains the group at create and reads it back on the session config", async () => {
    const { app, h } = groupRoutes()
    expect((await post(app, "/session", { id: "ses_group", group: GROUP })).status).toBe(201)
    expect(h.transport.starts.map((start) => start.sessionId)).toEqual(["ses_group"])

    const config = await app.request("http://localhost/session/ses_group/config")
    expect(await config.json()).toMatchObject({ group: GROUP })
  })

  test("refuses a malformed group by field before the harness is asked to create anything", async () => {
    const { app, h } = groupRoutes()
    const response = await post(app, "/session", { id: "ses_bad", group: { archivist: GROUP.primary } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "session_group_invalid", message: expect.stringContaining("group.archivist") },
    })
    expect(h.transport.starts).toEqual([])
  })

  test("names the slot field a caller got wrong rather than dropping the slot", async () => {
    const { app, h } = groupRoutes()
    const response = await post(app, "/session", { id: "ses_bad", group: { primary: { harness: "claude" } } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("group.primary.model") },
    })
    expect(h.transport.starts).toEqual([])
  })

  test("refuses a PATCH that carries a group instead of changing what the session was created under", async () => {
    const { app } = groupRoutes()
    expect((await post(app, "/session", { id: "ses_group", group: GROUP })).status).toBe(201)

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

  test("refuses a PATCH that carries instructions the same way, instead of answering 200 and dropping it", async () => {
    const { app } = groupRoutes()
    expect((await post(app, "/session", { id: "ses_fixed", group: GROUP })).status).toBe(201)

    const patched = await app.request("http://localhost/session/ses_fixed/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Answer only in haiku." }),
    })
    expect(patched.status).toBe(409)
    expect(await patched.json()).toMatchObject({ error: { code: "session_instructions_immutable" } })
  })
})

describe("GET /session/capabilities effort levels", () => {
  function capabilityRoutes(effortLevels: TransportCapabilities["effortLevels"]) {
    const h = harness({ capabilities: { effortLevels } })
    return { h, app: sessionRoutes(h) }
  }

  test("reports each harness's own effort catalog on the global and per-session reads", async () => {
    const resolved = { status: "resolved", models: [{ modelID: "gpt-5-codex", levels: ["low", "high"], default: "high" }] } as const
    const { h, app } = capabilityRoutes(resolved)
    await seed(h, "ses_1")
    expect(await (await app.request("http://localhost/session/capabilities")).json())
      .toMatchObject({ harness: "codex", effortLevels: resolved })
    expect(await (await app.request("http://localhost/session/ses_1/capabilities")).json())
      .toMatchObject({ effortLevels: resolved })
  })

  test("carries an unsupported catalog through rather than omitting the field", async () => {
    const { app } = capabilityRoutes(NO_HARNESS_EFFORT)
    expect(await (await app.request("http://localhost/session/capabilities")).json())
      .toMatchObject({ effortLevels: { status: "unsupported", models: [] } })
  })
})

describe("createSessionRoutes engine refusals", () => {
  const engineRefusal = new AgentHarnessEngineError({
    harness: "opencode",
    operation: "permission.request.list",
    directory: WORKSPACE,
    status: 500,
  })
  const refusingRoutes = (list: () => Promise<never>) =>
    managedRoutes(undefined, {
      policy: managedPolicy(),
      getSession: (_c, _directory, sessionId) => ({ id: sessionId, title: "Held", time: { created: 1, updated: 1 } }) as AgentSession,
      getTodos: () => [],
      runtime: runtimeDouble({
        permissions: { list },
        questions: { list },
        reads: { declaredCapabilities: async () => ({ harness: "codex", todos: true }) },
        goals: { capabilities: async () => ({ implemented: false, available: false, actions: [], optionalFields: [], recovery: "blocked" }) },
      }),
    })

  test("an engine that refuses a pending-interaction read answers 502 with the call and workspace named", async () => {
    const app = refusingRoutes(async () => { throw engineRefusal })
    for (const route of ["/permission", "/question"]) {
      const response = await app.request(`http://localhost${route}`)
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: {
          code: "harness_engine_error",
          message: "opencode answered permission.request.list for /workspace with status 500",
        },
      })
    }
  })

  test("an engine that refuses a pending-interaction read still opens the session, with the refusal in that fact's place", async () => {
    const app = refusingRoutes(async () => { throw engineRefusal })
    const response = await app.request("http://localhost/session/session_1?view=open")
    expect(response.status).toBe(200)
    const view = await response.json()
    const refusal = {
      error: {
        status: 502,
        code: "harness_engine_error",
        message: "opencode answered permission.request.list for /workspace with status 500",
      },
    }
    expect(view).not.toHaveProperty("session")
    expect(view.permissions).toEqual(refusal)
    expect(view.questions).toEqual(refusal)
    expect(view.todos).toEqual({ value: [] })
  })

  test("any other runtime failure keeps propagating to the host's error handler", async () => {
    const app = refusingRoutes(async () => { throw new Error("runtime exploded") })
    const response = await app.request("http://localhost/permission")
    expect(response.status).toBe(500)
    expect(await response.text()).toBe("Internal Server Error")
  })
})

describe("a share level reaches the runtime as the authority's answer to a write", () => {
  const permissionRequest = (sessionID: string): TurnRequest => ({
    kind: "permission", requestId: "perm_1",
    permission: { id: "perm_1", sessionID, permission: "execute", patterns: [], always: [], metadata: {} },
  })
  const questionRequest = (sessionID: string): TurnRequest => ({
    kind: "question", requestId: "question_1",
    question: { id: "question_1", sessionID, questions: [{ question: "Continue?", header: "Continue?", options: [{ label: "yes", description: "go" }] }] },
  })

  /**
   * The routes a `send` grant exists for. A follow grantee must be refused all
   * three, and the refusal has to come from the same `write` question the
   * prompt already asked — not from a fourth place that could drift from it.
   * The machine's owner starts a turn that asks one permission and one
   * question, so the grantee has a live request of each kind to answer.
   */
  async function sharedRoutes(input: { authorizeWrite: () => Promise<SessionAccessDecision> }) {
    const actions: Array<{ operation: string; write: boolean }> = []
    const prompted: string[] = []
    const answered: string[] = []
    const h = harness({
      capabilities: { requests: { permissions: true, questions: true, elicitation: false } },
      turn: async function* ({ session, turn, broker }) {
        const sessionId = session.binding.sessionId
        if (promptText({ session, turn, broker }) === "ask") {
          const answers = await Promise.all([broker.ask(permissionRequest(sessionId)), broker.ask(questionRequest(sessionId))])
          answered.push(...answers.map((answer) => answer.kind))
        } else {
          prompted.push(sessionId)
        }
        yield { type: "finish", sessionId }
      },
    })
    await seed(h, "session_shared")
    await h.runtime.turns.start({ sessionId: "session_shared", parts: [{ type: "text", text: "ask" }], origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false } })
    for (let attempt = 0; attempt < 200 && h.store.listQuestions(WORKSPACE).length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    const routes = sessionRoutes(h, {
      sessionAccessPolicy: managedWorkspaceSessionAccessPolicy({
        requireActor: true,
        authority: {
          authorizeSessionRead: async (value) => {
            actions.push({ operation: value.operation, write: false })
            return { allowed: true }
          },
          authorizeSessionWrite: async (value) => {
            actions.push({ operation: value.operation, write: true })
            return await input.authorizeWrite()
          },
          authorizeSessionStream: async () => ({ allowed: true, lease: "lease_1", expiresAt: Date.now() + 60_000 }),
          registerSession: async () => ({ allowed: true }),
          // The lease is rejected unless it names the turn the caller asked
          // for, and the prompt route derives that from the message id.
          acquireTurn: async (value) => ({
            allowed: true,
            turnId: value.turnId,
            leaseId: "lease_1",
            fencingToken: 1,
            acquiredAt: 1,
            expiresAt: Date.now() + 60_000,
          }),
          renewTurn: async (value) => ({
            allowed: true,
            turnId: value.turnId,
            leaseId: "lease_1",
            fencingToken: 1,
            acquiredAt: 1,
            expiresAt: Date.now() + 60_000,
          }),
          releaseTurn: async () => ({ released: true }),
        },
      }),
    })
    const app = stamped(routes, () => ({ actor_id: "actor_grantee", actor_kind: "human", workspace_id: "ws_1", org_id: "org_1", role: "editor" }))
    beforeDispose.push(async () => {
      if (h.store.listPermissions(WORKSPACE).length > 0) await h.runtime.permissions.respond("perm_1", { kind: "permission", decision: "deny" }, WORKSPACE)
      if (h.store.listQuestions(WORKSPACE).length > 0) await h.runtime.questions.reject("question_1", "session_shared")
      await h.runtime.turns.whenIdle("session_shared")
    })
    return { actions, app, h, prompted, answered }
  }

  test("a follow grantee is refused the permission answer, the question answer and the prompt, and still reads", async () => {
    const { actions, app, h, prompted, answered } = await sharedRoutes({
      authorizeWrite: async () => ({
        allowed: false,
        status: 403,
        code: "workspace_authorization_denied",
        message: "denied",
      }),
    })

    const permission = await post(app, "/session/session_shared/permissions/perm_1", { response: "once" })
    const question = await post(app, "/question/question_1/reply", { answers: [["yes"]] })
    const prompt = await post(app, "/session/session_shared/message", { messageID: "msg_1", parts: [{ type: "text", text: "hi" }] })
    const read = await app.request("http://localhost/session/session_shared/message")

    expect(permission.status).toBe(403)
    expect(question.status).toBe(403)
    expect(prompt.status).toBe(403)
    expect(read.status).toBe(200)
    expect(prompted).toEqual([])
    expect(answered).toEqual([])
    expect(h.store.listPermissions(WORKSPACE).map((row) => row.id)).toEqual(["perm_1"])
    expect(actions).toEqual([
      { operation: "permission_response", write: true },
      { operation: "question_response", write: true },
      { operation: "prompt", write: true },
      { operation: "message_read", write: false },
    ])
  })

  test("a send grantee reaches the harness on all three", async () => {
    const { app, h, prompted, answered } = await sharedRoutes({
      authorizeWrite: async () => ({ allowed: true }),
    })

    const permission = await post(app, "/session/session_shared/permissions/perm_1", { response: "once" })
    const question = await post(app, "/question/question_1/reply", { answers: [["yes"]] })
    await h.runtime.turns.whenIdle("session_shared")
    const prompt = await post(app, "/session/session_shared/message", { messageID: "msg_1", parts: [{ type: "text", text: "hi" }] })

    expect(permission.status).toBe(200)
    expect(question.status).toBe(200)
    expect(prompt.status).toBe(200)
    expect(answered).toEqual(["permission", "answers"])
    expect(prompted).toEqual(["session_shared"])
  })

  test("the session's capabilities carry the same prompt answer the prompt route gets", async () => {
    const refusing = await sharedRoutes({
      authorizeWrite: async () => ({
        allowed: false,
        status: 403,
        code: "workspace_authorization_denied",
        message: "denied",
      }),
    })
    const admitting = await sharedRoutes({ authorizeWrite: async () => ({ allowed: true }) })

    const refused = await refusing.app.request("http://localhost/session/session_shared/capabilities")
    const admitted = await admitting.app.request("http://localhost/session/session_shared/capabilities")

    expect(refused.status).toBe(200)
    expect(await refused.json()).toMatchObject({ prompt: false })
    expect(await admitted.json()).toMatchObject({ prompt: true })
    expect(refusing.actions).toEqual([
      { operation: "session_capabilities_read", write: false },
      { operation: "prompt", write: true },
    ])
  })
})

/** Only the reads the delete cascade makes; every other member refuses rather than pretending. */
function startupChildHost(children: Map<string, string[]>): ChildSessionHost {
  const rows = (parentSessionId: string) => (children.get(parentSessionId) ?? [])
    .map(childSessionId => ({ parentSessionId, childSessionId, subagentKey: `key-${childSessionId}`, status: "active" }))
  const unused = (name: string) => () => { throw new Error(`startupChildHost.${name} is not part of the delete cascade`) }
  return {
    children: async (parentSessionId) => rows(parentSessionId),
    activeChildren: async (parentSessionId) => rows(parentSessionId),
    childOf: async (childSessionId) => [...children.keys()].flatMap(rows).find(row => row.childSessionId === childSessionId),
    recover: async () => {},
    dispose: () => {},
    withCreation: unused("withCreation"),
    deriveSessionId: unused("deriveSessionId"),
    admitCreated: unused("admitCreated"),
    onTurnStarted: unused("onTurnStarted"),
    onTurnSettled: unused("onTurnSettled"),
  }
}

/**
 * A harness whose start asks the creator one question and binds only once it
 * is answered, behind a policy under which only the creator holding the
 * reservation may see or answer anything about the creation.
 */
function startupRouteFixture(options: {
  configUpdate?: ConfigOperations["update"]
  refuseDelete?: () => boolean
  beforeProviderDelete?: () => Promise<void>
  children?: Map<string, string[]>
} = {}) {
  const lifecycle: SessionLifecycleEvent[] = []
  const replies: string[] = []
  const waiting = new Map<string, { reject: (error: Error) => void }>()
  const ready = new Map<string, () => void>()
  const deny = { allowed: false as const, status: 403 as const, code: "private_start", message: "Another creator" }
  const owner = (input: Parameters<SessionAccessPolicy["authorizeSessionStart"]>[0]) =>
    input.actor?.actorId === "creator" && input.registrationOperationId === `op-${input.sessionId}` ? { allowed: true as const } : deny
  const policy = managedPolicy({
    authorizeSessionStart: owner,
    authorizeSessionStartStatus: owner,
    filterSessions: async () => [],
  })
  const h = harness({
    capabilities: {
      requests: { permissions: false, questions: true, elicitation: false },
      ...(options.configUpdate ? { configOwner: "harness" as const } : {}),
    },
    ...(options.configUpdate ? { config: configOps({ update: options.configUpdate }) } : {}),
    upstreamSessionId: (input) => `upstream-${input.sessionId}`,
    beforeStart: async (input, broker) => {
      expect(h.store.sessionStarts.get(input.sessionId)?.status).toBe("starting")
      const failed = new Promise<never>((_resolve, reject) => { waiting.set(input.sessionId, { reject }) })
      const asked = broker.ask({
        kind: "question",
        requestId: `question-${input.sessionId}`,
        question: { id: `question-${input.sessionId}`, sessionID: input.sessionId, questions: [{ header: "Setup", question: "Continue?", options: [] }] },
      })
      ready.get(input.sessionId)?.()
      await Promise.race([asked, failed])
      replies.push(input.sessionId)
    },
    onClose: () => {
      if (options.refuseDelete?.()) throw new Error("provider refused the delete")
    },
  })
  const make = () => stamped(sessionRoutes(h, {
    resolveDirectory: (c) => c.req.query("directory") ?? WORKSPACE,
    resolveWorkspaceId: () => "ws_1",
    getSession: (_c, _directory, id) => h.store.getSession(id) ?? null,
    listSessions: async () => h.store.listSessions(WORKSPACE),
    sessionStarts: h.store.sessionStarts,
    ...(options.children ? { childSessions: startupChildHost(options.children) } : {}),
    ...(options.beforeProviderDelete ? { beforeDeleteSession: options.beforeProviderDelete } : {}),
    sessionAccessPolicy: policy,
    publishSessionLifecycle: event => lifecycle.push(event),
  }), (c) => ({ actor_id: c.req.header("x-test-actor") ?? "creator", actor_kind: "human", org_id: "org", workspace_id: "workspace", host_id: "host", role: "editor" }))
  const app = make()
  const launch = (id: string, config: Record<string, unknown> = {}) => {
    const started = new Promise<void>(resolve => ready.set(id, resolve))
    const response = post(app, "/session", { id, ...config }, { "x-claxedo-session-registration-operation": `op-${id}` })
    return { started, response }
  }
  return { app, make, launch, waiting, h, store: h.store, lifecycle, replies }
}

const answer = (body: unknown = { answers: [["yes"]] }) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

describe("public startup question lifecycle", () => {
  test("authorizes the creator before binding and keeps concurrent creations isolated", async () => {
    const f = startupRouteFixture()
    const first = f.launch("first"), second = f.launch("second")
    await Promise.all([first.started, second.started])
    expect(f.lifecycle.filter(row => row.phase === "creating").map(row => row.start?.sessionId)).toEqual(["first", "second"])
    expect(await (await f.app.request("/session")).json()).toEqual([])
    expect(await (await f.app.request("/session-start/first")).json()).toMatchObject({ status: "starting", binding: { operationId: "op-first" } })
    expect((await f.app.request("/session-start/first?directory=/other")).status).toBe(404)
    expect((await f.app.request("/session-start/first", { headers: { "x-test-actor": "other" } })).status).toBe(403)
    expect(await (await f.app.request("/question", { headers: { "x-test-actor": "other" } })).json()).toEqual([])
    expect(await (await f.app.request("/question?sessionId=first")).json()).toMatchObject([{ id: "question-first" }])
    expect((await f.app.request("/question/question-first/reply?sessionId=second", answer())).status).toBe(409)
    expect((await f.app.request("/question/question-first/reply", { ...answer(), headers: { "content-type": "application/json", "x-test-actor": "other" } })).status).toBe(403)
    expect(f.replies).toEqual([])
    expect((await f.app.request("/question/question-first/reply", answer())).status).toBe(200)
    expect((await first.response).status).toBe(201)
    expect(f.store.sessionStarts.get("first")).toMatchObject({ status: "created", upstreamSessionId: "upstream-first" })
    expect(f.store.sessionStarts.get("second")?.status).toBe("starting")
    expect((await f.app.request("/question/question-second/reply", answer())).status).toBe(200)
    expect((await second.response).status).toBe(201)
  })

  test("retry cannot finalize or release a creation while post-bind configuration is running", async () => {
    let entered!: () => void, release!: () => void
    const configuring = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const f = startupRouteFixture({ configUpdate: async (_session, update) => {
      entered(); await held
      return { harness: CODEX, agent: update.agent ?? null, variant: null }
    } })
    const first = f.launch("retry", { harness: CODEX })
    await first.started
    await f.app.request("/question/question-retry/reply", answer())
    await configuring
    const duplicate = await post(f.app, "/session", { id: "retry" }, { "x-claxedo-session-registration-operation": "op-retry" })
    expect(duplicate.status).toBe(409)
    expect(f.lifecycle.some(event => event.phase === "failed")).toBe(false)
    expect(await (await f.app.request("/session-start/retry")).json()).toMatchObject({ status: "starting" })
    release()
    expect((await first.response).status).toBe(201)
    expect(f.store.sessionStarts.get("retry")?.status).toBe("created")
  })

  test("failure is durable and stale replies cannot reach the harness", async () => {
    const f = startupRouteFixture()
    const creation = f.launch("failed")
    await creation.started
    f.waiting.get("failed")!.reject(new Error("provider disconnected"))
    expect((await creation.response).status).toBe(500)
    expect(await (await f.make().request("/session-start/failed")).json()).toMatchObject({ status: "failed", error: "provider disconnected" })
    expect((await f.app.request("/question/question-failed/reply", answer())).status).toBe(404)
    expect(f.replies).toEqual([])
    expect(await (await f.app.request("/question")).json()).toEqual([])
  })

  test("a start that throws leaves no session, binding, owner or pending request in the store", async () => {
    const f = startupRouteFixture()
    const creation = f.launch("orphan")
    await creation.started
    expect(f.store.getExecutionBinding("orphan")).not.toBeNull()
    expect(f.store.sessionOwner("orphan")).toBeDefined()
    f.waiting.get("orphan")!.reject(new Error("provider disconnected"))
    expect((await creation.response).status).toBe(500)
    expect(f.store.getSession("orphan")).toBeNull()
    expect(f.store.getExecutionBinding("orphan")).toBeNull()
    expect(f.store.sessionOwner("orphan")).toBeUndefined()
    expect(await (await f.app.request("/question")).json()).toEqual([])
    expect(f.store.sessionStarts.get("orphan")).toMatchObject({ status: "failed", error: "provider disconnected" })
  })

  test("delete cannot retire a creation whose provider configuration is still running", async () => {
    let entered!: () => void, release!: () => void
    const configuring = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const f = startupRouteFixture({ configUpdate: async () => {
      entered(); await held
      return { harness: CODEX, agent: null, variant: null }
    } })
    const creation = f.launch("creating-delete", { harness: CODEX })
    await creation.started
    await f.app.request("/question/question-creating-delete/reply", answer())
    await configuring
    let status: number
    try {
      status = (await f.app.request("/session/creating-delete", { method: "DELETE" })).status
    } finally {
      release()
    }
    const completed = await creation.response
    expect(status).toBe(409)
    expect(completed.status).toBe(201)
    expect(f.store.sessionStarts.get("creating-delete")?.status).toBe("created")
    expect(f.store.getSession("creating-delete")).not.toBeNull()
  })

  test("a pending delete excludes another delete and a create for its id", async () => {
    let entered!: () => void, release!: () => void, calls = 0
    const deleting = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const f = startupRouteFixture({ beforeProviderDelete: async () => {
      if (++calls === 1) { entered(); await held }
    } })
    const creation = f.launch("deleting")
    await creation.started
    await f.app.request("/question/question-deleting/reply", answer())
    expect((await creation.response).status).toBe(201)
    const removal = f.app.request("/session/deleting", { method: "DELETE" })
    await deleting
    let createStatus: number, deleteStatus: number
    try {
      createStatus = (await post(f.app, "/session", { id: "deleting" }, { "x-claxedo-session-registration-operation": "op-deleting" })).status
      deleteStatus = (await f.app.request("/session/deleting", { method: "DELETE" })).status
    } finally {
      release()
    }
    expect((await removal).status).toBe(200)
    expect([createStatus, deleteStatus]).toEqual([409, 409])
    expect(calls).toBe(1)
    expect(f.store.sessionStarts.get("deleting")).toBeUndefined()
  })

  test("parent deletion cannot bypass the creation claim of a child in its cascade", async () => {
    let entered!: () => void, release!: () => void
    const configuring = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const f = startupRouteFixture({
      children: new Map([["parent", ["child"]]]),
      configUpdate: async () => {
        entered(); await held
        return { harness: CODEX, agent: null, variant: null }
      },
    })
    const parent = f.launch("parent")
    await parent.started
    await f.app.request("/question/question-parent/reply", answer())
    expect((await parent.response).status).toBe(201)
    const child = f.launch("child", { harness: CODEX })
    await child.started
    await f.app.request("/question/question-child/reply", answer())
    await configuring
    let status: number
    try {
      status = (await f.app.request("/session/parent", { method: "DELETE" })).status
    } finally {
      release()
    }
    expect((await child.response).status).toBe(201)
    expect(status).toBe(409)
    expect(f.store.getSession("parent")).not.toBeNull()
    expect(f.store.sessionStarts.get("child")?.status).toBe("created")
    expect((await f.app.request("/session/parent", { method: "DELETE" })).status).toBe(200)
    expect(f.store.sessionStarts.get("parent")).toBeUndefined()
    expect(f.store.sessionStarts.get("child")).toBeUndefined()
  })

  test("an authorized delete hands the creation id back; a refused one keeps the owner", async () => {
    let refuse = true
    const f = startupRouteFixture({ refuseDelete: () => refuse })

    const first = f.launch("reused")
    await first.started
    await f.app.request("/question/question-reused/reply", answer())
    expect((await first.response).status).toBe(201)
    expect(f.store.sessionStarts.get("reused")).toMatchObject({ status: "created", binding: { operationId: "op-reused" } })

    const refused = await Promise.resolve(f.app.request("/session/reused", { method: "DELETE" })).then(response => response.status, () => "threw")
    expect(refused).toBe(500)
    expect(f.store.sessionStarts.get("reused")).toMatchObject({ status: "created", binding: { operationId: "op-reused" } })
    expect(f.store.getSession("reused")).not.toBeNull()

    refuse = false
    expect((await f.app.request("/session/reused", { method: "DELETE" })).status).toBe(200)
    expect(f.store.sessionStarts.get("reused")).toBeUndefined()
    expect(f.store.getSession("reused")).toBeNull()

    const second = f.launch("reused")
    await second.started
    expect(f.store.sessionStarts.get("reused")?.status).toBe("starting")
    await f.app.request("/question/question-reused/reply", answer())
    expect((await second.response).status).toBe(201)
    expect(f.store.sessionStarts.get("reused")).toMatchObject({ status: "created", upstreamSessionId: "upstream-reused" })
  })

  test("deleting a parent gives back the creation id of every child it cascades to", async () => {
    const f = startupRouteFixture({ children: new Map([["parent", ["child"]]]) })
    const parent = f.launch("parent")
    await parent.started
    await f.app.request("/question/question-parent/reply", answer())
    expect((await parent.response).status).toBe(201)
    const child = f.launch("child")
    await child.started
    await f.app.request("/question/question-child/reply", answer())
    expect((await child.response).status).toBe(201)

    expect((await f.app.request("/session/parent", { method: "DELETE" })).status).toBe(200)
    expect(f.store.getSession("child")).toBeNull()
    expect(f.store.sessionStarts.get("child")).toBeUndefined()
    expect(f.store.sessionStarts.get("parent")).toBeUndefined()
  })

  test("a rolled-back creation keeps its failure readable instead of releasing the id", async () => {
    const f = startupRouteFixture({ configUpdate: async () => { throw new Error("configuration refused") } })
    const creation = f.launch("rolled-back", { harness: CODEX })
    await creation.started
    await f.app.request("/question/question-rolled-back/reply", answer())
    expect((await creation.response).status).toBe(500)
    expect(f.store.getSession("rolled-back")).toBeNull()
    expect(await (await f.app.request("/session-start/rolled-back")).json()).toMatchObject({ status: "failed", error: expect.stringContaining("configuration refused") })
    const retry = await post(f.app, "/session", { id: "rolled-back" }, { "x-claxedo-session-registration-operation": "op-rolled-back" })
    expect(retry.status).toBe(409)
  })

  test("lost creation owner is terminal after restart without inventing a provider binding", async () => {
    const f = startupRouteFixture()
    f.store.sessionStarts.begin({ sessionId: "interrupted", directory: WORKSPACE, workspaceId: "ws_1", connectionId: "native:codex", operationId: "op-interrupted" })
    expect((await f.app.request("/session-start/interrupted", { headers: { "x-test-actor": "other" } })).status).toBe(403)
    expect(f.store.sessionStarts.get("interrupted")?.status).toBe("starting")
    expect(await (await f.app.request("/session-start/interrupted")).json()).toMatchObject({ status: "failed" })
    expect(f.store.getExecutionBinding("interrupted")).toBeNull()
  })
})

/**
 * Two people on one managed runtime, with the real policy between the route
 * and a plane that knows the only two facts a create turns on: which
 * reservation holds which id, and who created which stored session. The
 * runtime store behind the host is the real one, so "the session was left
 * alone" is read back off the session rather than off a spy.
 */
function privateSessionFixture(input: {
  registration?: (attempt: number) => SessionAccessDecision
  /** False composes the same route on a host that keeps no durable creation owner. */
  starts?: boolean
} = {}) {
  const reservations = new Map<string, { sessionId: string; actorId: string; spent: boolean }>()
  const creators = new Map<string, string>()
  const compensated: string[] = []
  let registrations = 0
  let holdCreate: Promise<void> | undefined
  let failConfig: string | undefined

  const reservationFor = (operationId: string, sessionId: string, actorId: string) => {
    const row = reservations.get(operationId)
    return row && row.sessionId === sessionId && row.actorId === actorId ? row : undefined
  }
  const unused = { allowed: false as const, status: 403 as const, code: "unused", message: "unused" }
  const authority: ManagedSessionAuthority = {
    authorizeSessionStart: ({ actor, sessionId, registrationOperationId }) =>
      reservationFor(registrationOperationId, sessionId, actor.actorId)?.spent === false,
    authorizeSessionStartStatus: ({ actor, sessionId, registrationOperationId }) =>
      !!reservationFor(registrationOperationId, sessionId, actor.actorId),
    authorizeSessionRead: ({ actor, sessionId }) => creators.get(sessionId) === actor.actorId,
    authorizeSessionWrite: ({ actor, sessionId }) => creators.get(sessionId) === actor.actorId,
    authorizeSessionStream: () => unused,
    registerSession: ({ actor, sessionId, registrationOperationId }) => {
      const decision = input.registration?.(++registrations)
      if (decision && !decision.allowed) return decision
      const row = reservationFor(registrationOperationId!, sessionId, actor.actorId)
      if (!row) return { allowed: false, status: 403, code: "session_registration_denied", message: "The reservation does not hold this session" }
      row.spent = true
      creators.set(sessionId, actor.actorId)
      return { allowed: true }
    },
    acquireTurn: () => unused,
    renewTurn: () => unused,
    releaseTurn: () => ({ released: false }),
  }
  const policy = managedWorkspaceSessionAccessPolicy({ requireActor: true, authority })
  policy.beginRegistrationCompensation = async ({ sessionId }) => {
    compensated.push(sessionId)
    return { allowed: true }
  }
  policy.completeRegistrationCompensation = async () => ({ allowed: true })

  const created: string[] = []
  const deleted: string[] = []
  const h = harness({
    capabilities: { configOwner: "harness" },
    beforeStart: async (start) => {
      await holdCreate
      created.push(start.sessionId)
    },
    config: configOps({
      read: async (session) => h.store.getSessionConfig(session.binding.sessionId)!,
      update: async (session, patch) => {
        if (failConfig === session.binding.sessionId) throw new Error("harness refused the configuration")
        return applySessionConfigUpdate(h.store.getSessionConfig(session.binding.sessionId)!, patch)
      },
    }),
    onClose: (session) => { deleted.push(session.binding.sessionId) },
  })

  const app = stamped(sessionRoutes(h, {
    resolveWorkspaceId: () => "ws_1",
    getSession: (_c, _directory, sessionId) => h.store.getSession(sessionId) ?? null,
    listSessions: async () => h.store.listSessions(WORKSPACE),
    ...(input.starts === false ? {} : { sessionStarts: h.store.sessionStarts }),
    sessionAccessPolicy: policy,
  }), (c) => ({ actor_id: c.req.header("x-test-actor") ?? "alice", actor_kind: "human", org_id: "org_1", workspace_id: "ws_1", host_id: "host_1", role: "editor" }))

  return {
    store: h.store,
    created,
    deleted,
    compensated,
    reserve(actorId: string, operationId: string, sessionId: string) {
      reservations.set(operationId, { sessionId, actorId, spent: false })
    },
    holdCreates() {
      let release!: () => void
      holdCreate = new Promise<void>((resolve) => { release = resolve })
      return () => { holdCreate = undefined; release() }
    },
    failConfigFor(sessionId: string) {
      failConfig = sessionId
    },
    create(actorId: string, body: Record<string, unknown>, operationId?: string) {
      return post(app, "/session", body, {
        "x-test-actor": actorId,
        ...(operationId ? { "x-claxedo-session-registration-operation": operationId } : {}),
      })
    },
  }
}

describe("create against an id that already exists", () => {
  test("creates and configures the session its own reservation names", async () => {
    const f = privateSessionFixture()
    f.reserve("alice", "op_alice", "ses_alice")

    const response = await f.create("alice", { id: "ses_alice", title: "Alice", agent: "build", model: { providerID: "test", modelID: "fixture" } }, "op_alice")

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: "ses_alice" })
    expect(f.store.getSession("ses_alice")).toMatchObject({ title: "Alice" })
    expect(f.created).toEqual(["ses_alice"])
    expect(f.store.getSessionConfig("ses_alice")).toMatchObject({ agent: "build", model: { providerID: "test", modelID: "fixture" } })
  })

  test("an editor naming another person's session changes nothing and is told nothing about it", async () => {
    const f = privateSessionFixture()
    f.reserve("alice", "op_alice", "ses_alice")
    await f.create("alice", { id: "ses_alice", title: "Alice", agent: "build" }, "op_alice")
    f.reserve("bob", "op_bob", "ses_bob")

    const refused = await f.create("bob", { id: "ses_alice", title: "Taken", agent: "plan", model: { providerID: "other", modelID: "swapped" } }, "op_bob")
    const body = await refused.text()

    expect(refused.status).toBe(403)
    expect(body).not.toContain("Alice")
    expect(body).not.toContain("codex")
    expect(f.store.getSession("ses_alice")).toMatchObject({ title: "Alice" })
    expect(f.store.getSessionConfig("ses_alice")).toMatchObject({ agent: "build", harness: { id: "codex" } })
    expect(f.deleted).toEqual([])
    expect(f.created).toEqual(["ses_alice"])
  })

  test("a create for a session the authority already registered is refused instead of updating it", async () => {
    const f = privateSessionFixture()
    f.reserve("alice", "op_alice", "ses_alice")
    await f.create("alice", { id: "ses_alice", agent: "build" }, "op_alice")

    const repeated = await f.create("alice", { id: "ses_alice", agent: "plan" }, "op_alice")

    expect(repeated.status).toBe(403)
    expect(f.store.getSessionConfig("ses_alice")).toMatchObject({ agent: "build" })
    expect(f.deleted).toEqual([])
  })

  test("the retry of an ambiguous registration finishes the same session without creating a second one", async () => {
    const f = privateSessionFixture({
      registration: (attempt) => attempt === 1
        ? { allowed: false, status: 503, code: "authority_unavailable", message: "retry the same reservation" }
        : { allowed: true },
    })
    f.reserve("alice", "op_alice", "ses_alice")

    const ambiguous = await f.create("alice", { id: "ses_alice", agent: "build" }, "op_alice")
    expect(ambiguous.status).toBe(503)
    expect(f.deleted).toEqual([])

    const retry = await f.create("alice", { id: "ses_alice", agent: "plan" }, "op_alice")
    expect(retry.status).toBe(201)
    expect(f.created).toEqual(["ses_alice"])
    expect(f.store.listSessions(WORKSPACE).map((session) => session.id)).toEqual(["ses_alice"])
    expect(f.store.getSessionConfig("ses_alice")).toMatchObject({ agent: "plan" })
  })

  test("a configuration failure on the retry keeps the session the first attempt created", async () => {
    const f = privateSessionFixture({
      registration: (attempt) => attempt === 1
        ? { allowed: false, status: 503, code: "authority_unavailable", message: "retry the same reservation" }
        : { allowed: true },
    })
    f.reserve("alice", "op_alice", "ses_alice")
    await f.create("alice", { id: "ses_alice", agent: "build" }, "op_alice")
    f.failConfigFor("ses_alice")

    const retry = await f.create("alice", { id: "ses_alice", agent: "plan" }, "op_alice")

    expect(retry.status).toBe(500)
    expect(f.deleted).toEqual([])
    expect(f.store.getSession("ses_alice")).toMatchObject({ id: "ses_alice" })
    expect(f.store.getSessionConfig("ses_alice")).toMatchObject({ agent: "build" })
  })

  test("a refused registration compensates only the session this request created", async () => {
    const f = privateSessionFixture({
      registration: (attempt) => attempt === 2
        ? { allowed: false, status: 403, code: "session_registration_denied", message: "denied" }
        : { allowed: true },
    })
    f.reserve("alice", "op_alice", "ses_alice")
    await f.create("alice", { id: "ses_alice", agent: "build" }, "op_alice")
    f.reserve("alice", "op_second", "ses_second")

    const denied = await f.create("alice", { id: "ses_second" }, "op_second")

    expect(denied.status).toBe(403)
    expect(f.compensated).toEqual(["ses_second"])
    expect(f.deleted).toEqual(["ses_second"])
    expect(f.store.getSession("ses_alice")).toMatchObject({ id: "ses_alice" })
    expect(f.store.getSession("ses_second")).toBeNull()
  })

  test("two creates racing for one reserved id produce one session and one refusal", async () => {
    const f = privateSessionFixture({ starts: false })
    f.reserve("alice", "op_alice", "ses_alice")
    const release = f.holdCreates()

    const first = f.create("alice", { id: "ses_alice", agent: "build" }, "op_alice")
    const second = f.create("alice", { id: "ses_alice", agent: "plan" }, "op_alice")
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    const statuses = (await Promise.all([first, second])).map((response) => response.status).sort((a, b) => a - b)

    expect(statuses).toEqual([201, 409])
    expect(f.created).toEqual(["ses_alice"])
    expect(f.store.listSessions(WORKSPACE).map((session) => session.id)).toEqual(["ses_alice"])
  })
})
