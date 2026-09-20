import { afterEach, describe, expect, test } from "vitest"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { AgentMessage, AgentRuntimeStatus } from "@claxedo/agent-runtime-contract"
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
import { controlPlaneWorkspaceRow, workspaceListScopeRows } from "../client/control-plane-workspaces.fixture"

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
        return (async function* () {})()
      },
      getMessages: async () => state.messages,
      dispose: () => {},
      abort: async (binding) => {
        state.aborted.push(binding.sessionId)
        return { ok: true as const, status: "cancelled" as const }
      },
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
      return Response.json({ workspaces: workspaceListScopeRows(rows, url.searchParams.get("access")) })
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

async function connect(url: string, token: string) {
  const client = new Client({ name: "fixture-host", version: "0.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const [block] = result.content as Array<{ type: string; text: string }>
  return { text: block?.text ?? "", isError: result.isError === true }
}

async function json(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args)
  if (result.isError) throw new Error(result.text)
  return JSON.parse(result.text) as Record<string, unknown>
}

const local = () =>
  workspace({
    id: "ws_local",
    directory: "/w",
    name: "Mac",
    sessions: [{ id: "ses_root", title: "Fix login", harness: "claude" }, { id: "ses_child", title: "Child", parentID: "ses_root", harness: "codex" }],
    status: { ses_root: { type: "busy" }, ses_child: { type: "idle" } },
    messages: [message("msg_1", "hello")],
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

  test("caps a session a runtime credential creates at that credential's own permission mode", async () => {
    const state = local()
    const { url } = await listen({ local: state, claims: { permissionMode: "auto" } })
    const client = await connect(url, "rt-token")
    const created = await json(client, "session_create", {})
    expect(created).toMatchObject({ permissionCeiling: "auto" })
    expect(state.creates.at(-1)?.body).toMatchObject({ permissionCeiling: "auto" })
    expect(state.modes[String(created.id)]).toBe("auto")
  })

  test("caps at ask when the runtime credential declares no mode, and names no ceiling for a person", async () => {
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

  test("session_abort stops the running turn", async () => {
    const state = local()
    const { url } = await listen({ local: state })
    const client = await connect(url, "cli-jwt")
    await json(client, "session_abort", { session: "ses_root" })
    expect(state.aborted).toEqual(["ses_root"])
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
    const client = await connect(person.url, "cli-jwt")
    expect(await json(client, "session_delete", { session: "ses_root" })).toEqual({ session: "ses_root", deleted: { ok: true } })
    expect(state.deleted).toEqual(["ses_root"])

    const inside = await listen({ local: local() })
    const agent = await connect(inside.url, "rt-token")
    expect((await agent.listTools()).tools.map((tool) => tool.name)).not.toContain("session_delete")
    expect(await call(agent, "session_delete", { session: "ses_root" })).toMatchObject({ isError: true })
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
