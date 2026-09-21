import { afterEach, describe, expect, test } from "vitest"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type {
  AgentMessage,
  AgentRuntimeStatus,
  CleanupFact,
  ExecutionFact,
  PersistenceFact,
  RecoveryFactEvidence,
  RecoveryFacts,
  RecoveryError,
  RecoveryOutcome,
  RecoveryRefusal,
  RecoveryRequest,
  RecoveryTarget,
} from "@claxedo/agent-runtime-contract"
import { createSessionRoutes } from "@claxedo/workspace-runtime/routes"
import { createClaxedoMcpClient } from "../client/index"
import type { ClaxedoFetch } from "../client/contract"
import type { McpAuditEvent } from "../context"
import {
  CLAXEDO_MCP_PATH,
  createClaxedoMcpRoutes,
  fullUserCredential,
  inProcessFetch,
  type ClaxedoMcpMountOptions,
  type RuntimeCredentialClaims,
} from "../server"
import { registerSessionTools } from "./sessions"
import { controlPlaneWorkspaceRow, workspaceListHostRows } from "../client/control-plane-workspaces.fixture"

type FixtureSession = {
  id: string
  title: string
  parentID?: string
  harness: string
  permissionCeiling?: string
  permissionMode?: string
}

type CreateCall = { query: Record<string, string>; body: Record<string, unknown> }

type Workspace = {
  id: string
  directory: string
  online: boolean
  backing: "cloud-vm" | "local-worktree"
  name?: string
  sessions: FixtureSession[]
  status: Record<string, AgentRuntimeStatus>
  messages: AgentMessage[]
  creates: CreateCall[]
  prompts: Array<{ session: string; text: string }>
  aborted: string[]
  deleted: string[]
  worktrees: Array<{ name?: string; query: Record<string, string> }>
  requests: string[]
  modes: Record<string, string>
  /** Holds every turn open until it is cancelled, so a Stop has a turn to name. */
  holdTurns?: boolean
  /** What the recovery owner answers a submitted cancellation with. */
  cancellation?: (request: RecoveryRequest) => RecoveryOutcome
  releases: Map<string, () => void>
  running: Set<string>
}

function workspace(input: Partial<Workspace> & Pick<Workspace, "id" | "directory">): Workspace {
  return {
    online: true,
    backing: "local-worktree",
    sessions: [],
    status: {},
    messages: [],
    creates: [],
    prompts: [],
    aborted: [],
    deleted: [],
    worktrees: [],
    requests: [],
    modes: {},
    releases: new Map(),
    running: new Set(),
    ...input,
  }
}

/**
 * The rungs a native harness reports. `acceptEdits` carries no rung, so it can
 * never be chosen as the widest mode under a ceiling.
 */
const PERMISSION_MODES = [
  { id: "ask", name: "Ask", level: "ask" as const },
  { id: "acceptEdits", name: "Accept edits" },
  { id: "auto", name: "Auto", level: "auto" as const },
  { id: "full", name: "Full", level: "full" as const },
]

function message(id: string, text: string): AgentMessage {
  return { info: { id, role: "assistant" }, parts: [{ type: "text", text }] } as unknown as AgentMessage
}

function evidence<V extends string>(value: V): RecoveryFactEvidence<V> {
  return { value, source: "fixture", observedAt: 1, generation: "gen_1" }
}

function recoveryFacts(
  overrides: { execution?: ExecutionFact; cleanup?: CleanupFact; persistence?: PersistenceFact } = {},
): RecoveryFacts {
  return {
    execution: evidence(overrides.execution ?? "terminal"),
    cleanup: evidence(overrides.cleanup ?? "unknown"),
    persistence: evidence(overrides.persistence ?? "committed"),
  }
}

/**
 * What a local Stop settles as. `cancel_turn`'s postcondition demands
 * `cleanup: "verified_clear"` and no adapter can establish that, so `succeeded`
 * is unreachable and a healthy Stop closes as `needs_action` with cleanup
 * unknown — the shape every consumer has to read as a stop.
 */
function healthyStop(
  operationId: string,
  requestId: string,
  target: RecoveryTarget,
): RecoveryOutcome {
  return {
    kind: "operation",
    operation: {
      operationId, requestId, target, action: "cancel_turn", scopeRevision: "gen_1", attempt: 1,
      state: "needs_action", phase: "graceful_cancel", phaseDeadlineAt: 2, facts: recoveryFacts(),
      cleanupErrors: [],
      nextActions: [{ action: "inspect", scopePreviewRequired: false, reason: "confirm the turn released its resources" }],
      receipt: "durable", createdAt: 1, updatedAt: 1,
    },
  }
}

/**
 * A Stop whose facts leave work behind: execution still running or unproven,
 * or the interrupted state not committed. The owner names the error that
 * explains it, which is what makes the operation `failed` rather than
 * `needs_action`.
 */
function unsettledStop(
  request: RecoveryRequest,
  facts: { execution?: ExecutionFact; persistence?: PersistenceFact },
): RecoveryOutcome {
  const target = request.target
  const initiatingError: RecoveryError = {
    code: facts.execution ? "cancellation_timeout" : "persistence_unavailable",
    origin: "fixture-owner",
    target,
    stage: facts.execution ? "graceful_cancel" : "reconcile",
    executionMayContinue: facts.execution !== undefined,
    message: facts.execution ? "the provider never acknowledged the cancellation" : "the transcript store refused the write",
    at: 2,
  }
  return {
    kind: "operation",
    operation: {
      operationId: "op_unsettled", requestId: request.requestId, target, action: "cancel_turn",
      scopeRevision: "gen_1", attempt: 1, state: "failed", phase: initiatingError.stage, phaseDeadlineAt: 2,
      facts: recoveryFacts(facts), initiatingError, cleanupErrors: [],
      nextActions: [{ action: "cancel_turn", scopePreviewRequired: false, reason: "retry the cancellation" }],
      receipt: "durable", createdAt: 1, updatedAt: 2,
    },
  }
}

/**
 * The owner the recovery routes answer from. Only a session with a turn open
 * has a target, so a Stop on an idle session gets the same "no turn to name"
 * refusal the real owner gives rather than a fabricated success.
 */
function recoveryOwner(state: Workspace, _sessionId: string) {
  return {
    inspect: (id: string) => ({
      sessionId: id,
      ...(state.running.has(id)
        ? { target: { scope: "turn" as const, workspaceId: state.id, sessionId: id, turnId: `turn_${id}`, ownerGeneration: "gen_1" } }
        : {}),
      facts: recoveryFacts(),
      health: { status: "ok" as const },
      failures: [],
      operations: [],
      queued: 0,
    }),
    submit: async (request: RecoveryRequest): Promise<RecoveryOutcome> => {
      const target = request.target
      if (target.scope !== "turn") throw new Error(`the fixture only cancels turns, not a ${target.scope}`)
      state.aborted.push(target.sessionId)
      state.releases.get(target.sessionId)?.()
      return state.cancellation
        ? state.cancellation(request)
        : healthyStop(`op_${state.aborted.length}`, request.requestId, target)
    },
    read: () => undefined,
    reportContainmentFailure: () => {},
  }
}

/**
 * One workspace's runtime: the real session-core routes over an in-memory
 * adapter, plus the local server's worktree route, which lives in
 * `@claxedo/local-server` and cannot be imported here without a cycle. Its
 * body is the shape `createWorktree` answers with.
 */
function runtimeApp(state: Workspace) {
  const find = (id: string) => state.sessions.find((row) => row.id === id) ?? null
  const routes = createSessionRoutes({
    resolveDirectory: () => state.directory,
    resolveExecutionBinding: (_c, directory, sessionId) => ({
      workspaceId: state.id,
      directory: directory ?? state.directory,
      sessionId,
      connectionId: "conn",
      upstreamSessionId: sessionId,
    }),
    listSessions: async () => state.sessions.map((row) => ({ ...row })),
    getSession: (_c, _directory, sessionId) => find(sessionId),
    getStatus: () => state.status,
    getMessagePage: () => ({ messages: state.messages, nextCursor: "cursor_1" }),
    requestedSessionHarness: (c) => {
      const nativeHarness = c.req.query("nativeHarness")
      return nativeHarness ? { id: nativeHarness, access: "native" as const } : undefined
    },
    // Production routes a harness change to the handoff transaction; the
    // fixture records the switch the same way it records a config update.
    switchSessionHarness: async (_c, _directory, sessionId, update) => {
      const row = find(sessionId)
      const harness = update.harness?.id
      if (row && harness) row.harness = harness
      return { harness: { id: row?.harness ?? "claude", access: "native" as const }, agent: "build", variant: null }
    },
    publishGlobal: () => {},
    resolveRecoveryOwner: (_c, { sessionId }) => recoveryOwner(state, sessionId),
    resolveAdapter: () => ({
      instructionChannel: "none" as const,
      getSession: async (binding) => find(binding.sessionId),
      createSession: async (_directory, title, id) => {
        const created: FixtureSession = { id: id ?? `ses_${state.sessions.length + 1}`, title: title ?? "", harness: "claude" }
        state.sessions.push(created)
        return created
      },
      updateSession: async (binding, updates) => {
        const row = find(binding.sessionId)
        if (row && typeof updates.title === "string") row.title = updates.title
        return row
      },
      getSessionConfig: async (binding) => ({
        harness: { id: find(binding.sessionId)?.harness ?? "claude", access: "native" as const },
        agent: "build",
        variant: null,
      }),
      updateSessionConfig: async (binding, update) => {
        const row = find(binding.sessionId)
        const harness = update.harness?.id
        if (row && harness) row.harness = harness
        return { harness: { id: row?.harness ?? "claude", access: "native" as const }, agent: "build", variant: null }
      },
      deleteSession: async (binding) => { state.deleted.push(binding.sessionId) },
      readHarnessCapabilities: () => ({
        harness: "claude",
        abort: true,
        reconnect: false,
        replay: true,
        permissions: true,
        questions: true,
        todos: false,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: false,
        subagents: true,
        goals: false,
        effortLevels: NO_HARNESS_EFFORT,
        instructionChannel: "none",
      }),
      executeTurn: (binding, input) => {
        const text = input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
        state.prompts.push({ session: binding.sessionId, text })
        const holding = state.holdTurns
        state.running.add(binding.sessionId)
        return (async function* () {
          try {
            if (holding) await new Promise<void>((resolve) => { state.releases.set(binding.sessionId, resolve) })
          } finally {
            state.running.delete(binding.sessionId)
            state.releases.delete(binding.sessionId)
          }
        })()
      },
      getMessages: async () => state.messages,
      dispose: () => {},
      listPermissions: async () => [],
      listQuestions: async () => [],
      listDraftPermissionModes: async () => ({ modes: PERMISSION_MODES, appliesFrom: "next-turn" as const }),
      listPermissionModes: async (binding) => ({ modes: PERMISSION_MODES, currentModeId: state.modes[binding.sessionId] ?? "ask", appliesFrom: "next-turn" as const }),
      setPermissionMode: async (binding, modeId) => {
        state.modes[binding.sessionId] = modeId
        return { modes: PERMISSION_MODES, currentModeId: modeId, appliesFrom: "next-turn" as const }
      },
    }),
  })
  const app = new Hono()
    .post("/experimental/worktree", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { name?: string }
      state.worktrees.push({ ...(body.name ? { name: body.name } : {}), query: Object.fromEntries(new URL(c.req.url).searchParams) })
      const name = body.name ?? `worktree-${state.worktrees.length}`
      return c.json({ name, branch: `claxedo/${name}`, directory: `${state.directory}/../${name}` })
    })
    .route("/", routes)
  return async (request: Request) => {
    state.requests.push(`${request.method} ${new URL(request.url).pathname}`)
    const url = new URL(request.url)
    if (url.pathname === "/session" && request.method === "POST") {
      state.creates.push({
        query: Object.fromEntries(url.searchParams),
        body: (await request.clone().json().catch(() => ({}))) as Record<string, unknown>,
      })
    }
    return app.fetch(request)
  }
}

/** The control plane: the workspace list, the connection handshake, and cloud workspace creation. */
function controlPlane(workspaces: readonly Workspace[], created: Workspace[]) {
  const calls: Array<{ method: string; path: string; body?: string }> = []
  const fetchLike: ClaxedoFetch = async (path, init) => {
    calls.push({ method: init?.method ?? "GET", path, ...(typeof init?.body === "string" ? { body: init.body } : {}) })
    const url = new URL(path, "http://control.local")
    const connection = /^\/api\/workspace\/([^/]+)\/connection$/.exec(url.pathname)
    if (connection) {
      const id = decodeURIComponent(connection[1])
      return Response.json({
        workspaceId: id,
        relayUrl: "https://relay.example",
        runtimeAccessToken: `rat-${id}`,
        tokenExpiresAt: Date.now() + 900_000,
      })
    }
    if (url.pathname === "/api/workspace" && init?.method !== "POST") {
      const rows = [...workspaces, ...created].map((row) =>
        controlPlaneWorkspaceRow({
          workspace_id: row.id,
          backing: row.backing,
          host_online: row.online,
          remote_directory: row.directory,
          ...(row.name ? { display_name: row.name } : {}),
        }))
      return Response.json({ workspaces: workspaceListHostRows(rows, url.searchParams.get("host")) })
    }
    if (url.pathname === "/api/workspace/create") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { workspaceName?: string }
      const row = workspace({ id: `ws_cloud_${created.length + 1}`, directory: "/workspace", backing: "cloud-vm", ...(body.workspaceName ? { name: body.workspaceName } : {}) })
      created.push(row)
      return Response.json({ workspaceId: row.id, directory: row.directory })
    }
    return Response.json({ error: { code: "not_found", message: url.pathname } }, { status: 404 })
  }
  return { calls, fetch: fetchLike }
}

/** The relay: splices a `/workspaces/:id/...` request into that workspace's runtime, and only with its token. */
function relay(all: () => readonly Workspace[]) {
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const match = /^\/workspaces\/([^/]+)(\/.*)$/.exec(url.pathname)
    if (!match) return Response.json({ error: { code: "relay_no_route", message: url.pathname } }, { status: 404 })
    const id = decodeURIComponent(match[1])
    if (new Headers(init?.headers).get("authorization") !== `Bearer rat-${id}`) {
      return Response.json({ error: { code: "relay_unauthorized", message: id } }, { status: 401 })
    }
    const target = all().find((row) => row.id === id)
    if (!target) return Response.json({ error: { code: "relay_unknown_workspace", message: id } }, { status: 404 })
    if (!target.online) return Response.json({ error: { code: "relay_host_offline", message: id } }, { status: 503 })
    return runtimeApp(target)(new Request(`http://runtime.local${match[2]}${url.search}`, init))
  }
}

const servers: Array<ReturnType<typeof serve>> = []
const clients: Client[] = []
const mounts: Array<{ dispose(): void }> = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  for (const mount of mounts.splice(0)) mount.dispose()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

type MountInput = {
  local?: Workspace
  workspaces?: readonly Workspace[]
  mount?: ClaxedoMcpMountOptions["mount"]
  claims?: Partial<RuntimeCredentialClaims>
  crossMachineWrites?: boolean
}

async function listen(input: MountInput) {
  const audits: McpAuditEvent[] = []
  const created: Workspace[] = []
  const workspaces = input.workspaces ?? (input.local ? [input.local] : [])
  const all = () => [...workspaces, ...created]
  const control = controlPlane(workspaces, created)
  const mount = input.mount ?? "node"
  const local = input.local
  const routes = createClaxedoMcpRoutes({
    mount,
    verifyRuntimeCredential: (token) =>
      token === "rt-token"
        ? { runtimeId: "rt_1", workspaceId: local?.id ?? "ws_local", userId: "user_1", expiresAt: Number.MAX_SAFE_INTEGER, ...input.claims }
        : undefined,
    resolveUserCredential: async (request) =>
      request.headers.get("authorization") === "Bearer cli-jwt" ? fullUserCredential({ actorId: "actor_1", clientId: "cli" }) : undefined,
    crossMachineWrites: () => input.crossMachineWrites === true,
    createClient: () =>
      createClaxedoMcpClient({
        deployment: mount === "hosted" ? "hosted" : mount,
        ...(local && mount !== "hosted"
          ? { local: { fetch: inProcessFetch(runtimeApp(local)), workspace: { workspaceId: local.id, directory: local.directory } } }
          : {}),
        controlPlane: { fetch: control.fetch },
        fetch: relay(all),
      }),
    registerTools: [{ id: "sessions", reach: "runtime", register: registerSessionTools }],
    audit: (event) => { audits.push(event) },
  })
  mounts.push(routes)
  const app = new Hono().route(CLAXEDO_MCP_PATH, routes.routes)
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { url: `http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}`, audits, control, created }
}

async function connect(url: string, token: string, confirm?: () => "accept" | "decline" | "cancel") {
  const client = new Client({ name: "fixture-host", version: "0.0.0" }, confirm ? { capabilities: { elicitation: { form: {} } } } : {})
  if (confirm) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: confirm(), content: {} }))
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const [block] = result.content as Array<{ type: string; text: string }>
  return { text: block?.text ?? "", isError: result.isError === true }
}

/** A recovery tool answers with its summary ahead of the payload, so both are read. */
async function cancel(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: "session_cancel_turn", arguments: args })
  const [summary, payload] = result.content as Array<{ type: string; text: string }>
  return {
    summary: summary?.text ?? "",
    payload: JSON.parse(payload?.text ?? "{}") as Record<string, unknown>,
    isError: result.isError === true,
  }
}

/** A recovery tool puts its summary ahead of the payload, so the payload is found by parsing. */
async function json(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const blocks = result.content as Array<{ type: string; text: string }>
  if (result.isError === true) throw new Error(blocks[0]?.text ?? "")
  for (const block of blocks) {
    try {
      return JSON.parse(block.text ?? "") as Record<string, unknown>
    } catch {}
  }
  throw new Error(`${name} answered no JSON payload: ${blocks.map((block) => block.text).join(" | ")}`)
}

const local = (overrides: Partial<Workspace> = {}) =>
  workspace({
    id: "ws_local",
    directory: "/w",
    name: "Mac",
    sessions: [{ id: "ses_root", title: "Fix login", harness: "claude" }, { id: "ses_child", title: "Child", parentID: "ses_root", harness: "codex" }],
    status: { ses_root: { type: "busy" }, ses_child: { type: "idle" } },
    messages: [message("msg_1", "hello")],
    ...overrides,
  })

describe("session_create", () => {
  test("chooses the harness on the query string the runtime reads and sends the first turn", async () => {
    const state = local()
    const { url } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")
    const created = await json(client, "session_create", { harness: "codex", title: "Consult", prompt: "review this plan" })

    expect(state.creates).toEqual([{ query: { nativeHarness: "codex", workspace: "ws_local" }, body: { title: "Consult" } }])
    expect(created).toMatchObject({ id: expect.any(String), prompted: true })
    expect(state.prompts).toEqual([{ session: created.id, text: "review this plan" }])
    expect(state.sessions.at(-1)).toMatchObject({ id: created.id, title: "Consult" })
  })

  test("caps a session a runtime credential creates at ask, and names no ceiling for a person", async () => {
    const state = local()
    const runtime = await listen({ local: state })
    const capped = await json(await connect(runtime.url, "rt-token"), "session_create", {})
    expect(capped).toMatchObject({ permissionCeiling: "ask" })
    expect(state.creates.at(-1)?.body).toMatchObject({ permissionCeiling: "ask" })
    expect(state.modes[String(capped.id)]).toBe("ask")

    const person = await listen({ local: state })
    const uncapped = await json(await connect(person.url, "cli-jwt"), "session_create", {})
    expect(state.creates.at(-1)?.body).toEqual({})
    expect(state.modes[String(uncapped.id)]).toBeUndefined()
  })

  test("registers a worktree first and creates the session in the directory it answers with", async () => {
    const state = local()
    const { url } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")
    const created = await json(client, "session_create", { placement: { worktree: { name: "review" } } })

    expect(state.worktrees).toEqual([{ name: "review", query: { workspaceId: "ws_local" } }])
    expect(created.worktree).toMatchObject({ name: "review", directory: "/w/../review" })
    expect(state.creates.at(-1)?.query).toMatchObject({ directory: "/w/../review" })
  })

  test("creates the provisioner-placed workspace at the control plane and the session through the relay", async () => {
    const state = local()
    const { url, control, created } = await listen({ mount: "hosted", workspaces: [state] })
    const client = await connect(url, "cli-jwt")
    const session = await json(client, "session_create", { placement: { cloud: { repoUrl: "https://github.com/me/app.git", name: "App" } } })

    expect(control.calls.map((row) => `${row.method} ${row.path}`)).toContain("POST /api/workspace/create")
    expect(session.cloudWorkspace).toEqual({ id: "ws_cloud_1", directory: "/workspace" })
    expect(created[0].creates.at(-1)?.query).toMatchObject({ workspace: "ws_cloud_1" })
    expect(state.creates).toEqual([])
  })

  test("refuses cloud placement from inside a session until the account allows it", async () => {
    const state = local()
    const denied = await listen({ local: state, workspaces: [state] })
    const refusal = await call(await connect(denied.url, "rt-token"), "session_create", {
      placement: { cloud: { repoUrl: "https://github.com/me/app.git" } },
    })
    expect(refusal).toMatchObject({ isError: true })
    expect(refusal.text).toMatch(/act on my other machines|act on other machines/)
    expect(denied.created).toEqual([])

    const allowed = await listen({ local: state, workspaces: [state], crossMachineWrites: true })
    await json(await connect(allowed.url, "rt-token"), "session_create", { placement: { cloud: { repoUrl: "https://github.com/me/app.git" } } })
    expect(allowed.created).toHaveLength(1)
  })

  test("refuses a session a runtime credential places on another machine", async () => {
    const state = local()
    const other = workspace({ id: "ws_other", directory: "/other" })
    const { url } = await listen({ local: state, workspaces: [state, other] })
    const refusal = await call(await connect(url, "rt-token"), "session_create", { workspace: "ws_other" })
    expect(refusal).toMatchObject({ isError: true })
    expect(refusal.text).toContain("ws_other")
    expect(other.creates).toEqual([])
  })

  test("audits the session it created, not a session named in the request", async () => {
    const state = local()
    const { url, audits } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")
    const created = await json(client, "session_create", {})
    expect(created).toMatchObject({ id: expect.any(String) })
    expect(audits).toEqual([
      expect.objectContaining({
        tool: "session_create",
        sessionId: created.id,
        credential: expect.objectContaining({ kind: "user" }),
      }),
    ])
  })
})

describe("sessions_list", () => {
  test("lists root sessions with their status across every workspace the account can see", async () => {
    const state = local()
    const cloud = workspace({
      id: "ws_cloud",
      directory: "/workspace",
      backing: "cloud-vm",
      sessions: [{ id: "ses_cloud", title: "Cloud run", harness: "codex" }],
      status: { ses_cloud: { type: "idle" } },
    })
    const { url } = await listen({ mount: "hosted", workspaces: [state, cloud] })
    const client = await connect(url, "cli-jwt")
    const listed = (await json(client, "sessions_list")).workspaces as Array<Record<string, unknown>>

    expect(listed.map((row) => String(row.workspace)).toSorted((left, right) => left.localeCompare(right)))
      .toEqual(["ws_cloud", "ws_local"])
    const mac = listed.find((row) => row.workspace === "ws_local")
    expect(mac).toMatchObject({ name: "Mac", host: "machine" })
    const macSessions = (mac?.sessions ?? []) as Array<Record<string, unknown>>
    expect(macSessions.map((row) => row.id)).toEqual(["ses_root"])
    expect(macSessions[0]).toMatchObject({ status: { type: "busy" } })
  })

  test("says a machine is offline instead of answering from a stale copy", async () => {
    const state = local()
    const offline = workspace({ id: "ws_off", directory: "/off", online: false, sessions: [{ id: "ses_old", title: "Old", harness: "claude" }] })
    const { url } = await listen({ mount: "hosted", workspaces: [state, offline] })
    const client = await connect(url, "cli-jwt")
    const listed = (await json(client, "sessions_list")).workspaces as Array<Record<string, unknown>>

    expect(listed.find((row) => row.workspace === "ws_off")).toEqual({ workspace: "ws_off", host: "machine", unavailable: "machine offline" })
    expect(offline.requests).toEqual([])
  })

  test("names its own workspace when no account credential is reachable", async () => {
    const state = local()
    const { url } = await listen({ local: state })
    const client = await connect(url, "rt-token")
    const listed = (await json(client, "sessions_list")).workspaces as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ workspace: "ws_local" })
  })
})

describe("reading and driving one session", () => {
  test("session_get answers with the session and its harness configuration", async () => {
    const { url } = await listen({ local: local() })
    const client = await connect(url, "cli-jwt")
    const read = await json(client, "session_get", { session: "ses_root" })
    expect(read.session).toMatchObject({ id: "ses_root", title: "Fix login" })
    expect(read.config).toMatchObject({ harness: { id: "claude", access: "native" } })
  })

  test("session_transcript reads a page and carries the cursor for the next one", async () => {
    const { url } = await listen({ local: local() })
    const client = await connect(url, "cli-jwt")
    const page = await json(client, "session_transcript", { session: "ses_root" })
    expect(page).toMatchObject({ nextCursor: "cursor_1" })
    expect(page.messages).toHaveLength(1)
  })

  test("session_send admits a turn and audits it against the session it addressed", async () => {
    const state = local()
    const { url, audits } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")
    expect(await json(client, "session_send", { session: "ses_root", text: "carry on" })).toMatchObject({ session: "ses_root" })
    expect(state.prompts).toEqual([{ session: "ses_root", text: "carry on" }])
    expect(audits).toEqual([
      expect.objectContaining({ tool: "session_send", sessionId: "ses_root", credential: expect.objectContaining({ kind: "user" }) }),
    ])
  })

  test("session_cancel_turn reports a healthy Stop as a stop, not as an error", async () => {
    const state = local({ holdTurns: true })
    const { url } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")
    await json(client, "session_send", { session: "ses_root", text: "carry on" })
    await until(() => state.prompts.length === 1, "the turn to reach the harness")

    const stopped = await cancel(client, { session: "ses_root" })

    expect(state.aborted).toEqual(["ses_root"])
    expect(stopped.isError).toBe(false)
    expect(stopped.summary).toContain("Stopped — cleanup not verified")
    expect(stopped.summary).toContain("Next: inspect — confirm the turn released its resources")
    expect(stopped.payload.cancellation).toMatchObject({
      kind: "operation",
      operation: { action: "cancel_turn", state: "needs_action" },
    })
  })

  test.each([
    { fact: "running" as const, reads: "The turn is still running" },
    { fact: "unknown" as const, reads: "Cancellation did not answer for the turn" },
  ])("session_cancel_turn reports execution $fact as unfinished work", async ({ fact, reads }) => {
    const state = local({
      holdTurns: true,
      cancellation: (request) => unsettledStop(request, { execution: fact }),
    })
    const { url } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")
    await json(client, "session_send", { session: "ses_root", text: "carry on" })
    await until(() => state.prompts.length === 1, "the turn to reach the harness")

    const answered = await cancel(client, { session: "ses_root" })

    expect(answered.isError).toBe(true)
    expect(answered.summary).toContain(reads)
    expect(answered.summary).toContain("Next: cancel_turn — retry the cancellation")
  })

  test.each([
    { fact: "pending" as const, reads: "saving the interrupted state has not been committed" },
    { fact: "unavailable" as const, reads: "the store that records the interrupted state is unavailable" },
  ])("session_cancel_turn says the stop was not recorded when persistence is $fact", async ({ fact, reads }) => {
    const state = local({
      holdTurns: true,
      cancellation: (request) => unsettledStop(request, { persistence: fact }),
    })
    const { url } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")
    await json(client, "session_send", { session: "ses_root", text: "carry on" })
    await until(() => state.prompts.length === 1, "the turn to reach the harness")

    const answered = await cancel(client, { session: "ses_root" })

    expect(answered.isError).toBe(true)
    expect(answered.summary).toContain(reads)
    expect(answered.summary).toContain("Error persistence_unavailable from fixture-owner at reconcile")
  })

  test("an interruption nobody recorded is an error even when the owner named no failure", async () => {
    const state = local({
      holdTurns: true,
      cancellation: (request) => ({
        kind: "operation",
        operation: {
          operationId: "op_unsaved", requestId: request.requestId, target: request.target,
          action: "cancel_turn", scopeRevision: "gen_1", attempt: 1, state: "needs_action",
          phase: "reconcile", phaseDeadlineAt: 2, facts: recoveryFacts({ persistence: "pending" }),
          cleanupErrors: [],
          nextActions: [{ action: "reconcile_session", scopePreviewRequired: false, reason: "write the interrupted turn down" }],
          receipt: "volatile", createdAt: 1, updatedAt: 2,
        },
      }),
    })
    const { url } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")
    await json(client, "session_send", { session: "ses_root", text: "carry on" })
    await until(() => state.prompts.length === 1, "the turn to reach the harness")

    const answered = await cancel(client, { session: "ses_root" })

    expect(answered.isError).toBe(true)
    expect(answered.summary).toContain("Execution stopped, but saving the interrupted state has not been committed.")
    expect(answered.summary).not.toContain("still running")
    expect(answered.summary).toContain("Next: reconcile_session — write the interrupted turn down")
  })

  test("session_cancel_turn gives every refusal kind its own wording", async () => {
    const wordings: Array<[RecoveryRefusal, string]> = [
      [{ kind: "generation_conflict", message: "the turn was replaced" }, "that turn has already ended"],
      [{ kind: "intent_conflict", message: "seen before", requestId: "req_1" }, "request req_1 was already used for a different command"],
      [{ kind: "receipt_expired", message: "too late", requestId: "req_1" }, "the receipt for request req_1 has expired"],
      [
        { kind: "scope_changed", message: "widened", scopeRevision: "rev_2", preview: { sessions: ["ses_root"], resources: ["pty_1"], summary: "one session and its terminal" } },
        "what this command would interrupt changed since revision rev_2",
      ],
      [{ kind: "unauthorized", message: "read-only credential" }, "this credential may not run that recovery command"],
      [{ kind: "unavailable", message: "the machine is offline" }, "the owner is unavailable"],
      [{ kind: "version_update_required", message: "update Claxedo", contractVersion: 4 }, "recovery contract version 4"],
    ]
    for (const [refusal, reads] of wordings) {
      const state = local({ holdTurns: true, cancellation: () => ({ kind: "refused", refusal }) })
      const { url } = await listen({ local: state })
      const client = await connect(url, "cli-jwt")
      await json(client, "session_send", { session: "ses_root", text: "carry on" })
      await until(() => state.prompts.length === 1, "the turn to reach the harness")

      const answered = await cancel(client, { session: "ses_root" })

      expect(answered.isError, refusal.kind).toBe(true)
      expect(answered.summary, refusal.kind).toContain(reads)
      expect(answered.summary, refusal.kind).toContain(refusal.message)
      state.releases.get("ses_root")?.()
    }
  })

  test("a session running no turn is told so instead of being reported as stopped", async () => {
    const state = local()
    const { url } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")

    const answered = await call(client, "session_cancel_turn", { session: "ses_root" })

    expect(answered.isError).toBe(true)
    expect(state.aborted).toEqual([])
  })

  test("session_rename retitles and session_handoff moves the session to another harness", async () => {
    const state = local()
    const { url } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")
    await json(client, "session_rename", { session: "ses_root", title: "Login rewrite" })
    expect(state.sessions[0].title).toBe("Login rewrite")
    const moved = await json(client, "session_handoff", { session: "ses_root", harness: "codex" })
    expect(moved.config).toMatchObject({ harness: { id: "codex" } })
    expect(state.sessions[0].harness).toBe("codex")
  })

  test("session_delete removes the session for a person and is never offered inside one", async () => {
    const state = local()
    const person = await listen({ local: state })
    for (const confirm of [undefined, () => "decline" as const, () => "cancel" as const]) {
      const refused = await connect(person.url, "cli-jwt", confirm)
      expect(await call(refused, "session_delete", { session: "ses_root" })).toMatchObject({ isError: true })
    }
    expect(state.deleted).toEqual([])
    const client = await connect(person.url, "cli-jwt", () => "accept")
    expect(await json(client, "session_delete", { session: "ses_root" })).toEqual({ session: "ses_root", deleted: { ok: true } })
    expect(state.deleted).toEqual(["ses_root"])

    const inside = await listen({ local: local() })
    const agent = await connect(inside.url, "rt-token")
    expect((await agent.listTools()).tools.map((tool) => tool.name)).not.toContain("session_delete")
    expect(await call(agent, "session_delete", { session: "ses_root" })).toMatchObject({ isError: true })
  })

  test("drives its own session and the children it started, and refuses every other session in the same workspace", async () => {
    const state = workspace({
      id: "ws_local",
      directory: "/w",
      sessions: [
        { id: "ses_root", title: "Caller", harness: "claude" },
        { id: "ses_child", title: "Child", parentID: "ses_root", harness: "codex" },
        { id: "ses_sibling", title: "Sibling", harness: "claude" },
        { id: "ses_nephew", title: "Sibling's child", parentID: "ses_sibling", harness: "claude" },
      ],
      status: { ses_root: { type: "busy" } },
      holdTurns: true,
    })
    const { url } = await listen({ local: state, claims: { sessionId: "ses_root" } })
    const client = await connect(url, "rt-token")

    await json(client, "session_send", { session: "ses_root", text: "carry on" })
    await json(client, "session_send", { session: "ses_child", text: "finish up" })
    await until(() => state.running.has("ses_child"), "the child's turn to reach the harness")
    await json(client, "session_cancel_turn", { session: "ses_child" })
    expect(state.prompts).toEqual([{ session: "ses_root", text: "carry on" }, { session: "ses_child", text: "finish up" }])
    expect(state.aborted).toEqual(["ses_child"])

    for (const session of ["ses_sibling", "ses_nephew"]) {
      const sent = await call(client, "session_send", { session, text: "do my work" })
      expect(sent.isError, `session_send reached ${session}`).toBe(true)
      expect(sent.text).toContain(session)
      const aborted = await call(client, "session_cancel_turn", { session })
      expect(aborted.isError, `session_cancel_turn reached ${session}`).toBe(true)
    }
    expect(state.prompts).toHaveLength(2)
    expect(state.aborted).toEqual(["ses_child"])
    state.releases.get("ses_root")?.()
  })

  test("takes the parent from the stored session, not from anything the call carries", async () => {
    const state = workspace({
      id: "ws_local",
      directory: "/w",
      sessions: [{ id: "ses_root", title: "Caller", harness: "claude" }, { id: "ses_sibling", title: "Sibling", harness: "claude" }],
    })
    const { url } = await listen({ local: state, claims: { sessionId: "ses_root" } })
    const client = await connect(url, "rt-token")

    const forged = await call(client, "session_send", { session: "ses_sibling", text: "do my work", parentID: "ses_root", parent: "ses_root" })
    expect(forged.isError).toBe(true)
    expect(state.prompts).toEqual([])
    const [tool] = (await client.listTools()).tools.filter((row) => row.name === "session_send")
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["session", "workspace", "directory", "text"])
  })

  test("refuses every session on another machine the account already lets it write to, however that machine's rows read", async () => {
    const state = local()
    // The three shapes another machine's runtime can present: an unrelated
    // session, a row carrying the caller's own id, and a row naming the caller
    // as its parent. None of them is this session's to drive, and a session id
    // is only meaningful together with the runtime that minted it.
    const other = workspace({
      id: "ws_other",
      directory: "/other",
      sessions: [
        { id: "ses_far", title: "Far", harness: "claude" },
        { id: "ses_root", title: "Same id, other machine", harness: "claude" },
        { id: "ses_planted", title: "Claims this caller as its parent", parentID: "ses_root", harness: "claude" },
      ],
    })
    const { url } = await listen({ local: state, workspaces: [state, other], crossMachineWrites: true, claims: { sessionId: "ses_root" } })
    const client = await connect(url, "rt-token")

    for (const session of ["ses_far", "ses_root", "ses_planted"]) {
      const sent = await call(client, "session_send", { session, workspace: "ws_other", text: "run it" })
      expect(sent.isError, `session_send reached ${session} on ws_other`).toBe(true)
      expect(sent.text).toContain("ws_other")
      const aborted = await call(client, "session_cancel_turn", { session, workspace: "ws_other" })
      expect(aborted.isError, `session_cancel_turn reached ${session} on ws_other`).toBe(true)
    }
    expect(other.prompts).toEqual([])
    expect(other.aborted).toEqual([])

    // The same account setting still lets this session start work there, which
    // is what it is for.
    const created = await json(client, "session_create", { workspace: "ws_other", prompt: "begin" })
    expect(other.prompts).toEqual([{ session: created.id, text: "begin" }])
  })

  test("refuses a runtime credential that names no session of its own", async () => {
    const state = local()
    const { url } = await listen({ local: state })
    const client = await connect(url, "rt-token")
    const refusal = await call(client, "session_send", { session: "ses_root", text: "carry on" })
    expect(refusal.isError).toBe(true)
    expect(refusal.text).toContain("names no session")
    expect(state.prompts).toEqual([])
  })

  test("refuses a write a session aims at another machine and lets the read through", async () => {
    const state = local()
    const other = workspace({
      id: "ws_other",
      directory: "/other",
      sessions: [{ id: "ses_far", title: "Far", harness: "claude" }],
      status: { ses_far: { type: "idle" } },
      messages: [message("msg_far", "far away")],
    })
    const { url } = await listen({ local: state, workspaces: [state, other] })
    const client = await connect(url, "rt-token")

    const refusal = await call(client, "session_send", { session: "ses_far", workspace: "ws_other", text: "run it" })
    expect(refusal.isError).toBe(true)
    expect(refusal.text).toContain("ws_other")
    expect(refusal.text).toContain("ws_local")
    expect(other.prompts).toEqual([])

    const read = await json(client, "session_transcript", { session: "ses_far", workspace: "ws_other" })
    expect(read.messages).toHaveLength(1)
  })
})

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
