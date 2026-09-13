import { afterEach, describe, expect, test } from "vitest"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { AgentPermission, AgentQuestion, AgentRuntimeStatus } from "@claxedo/agent-runtime-contract"
import { createSessionRoutes } from "@claxedo/workspace-runtime/routes"
import { createClaxedoMcpClient } from "../client/index"
import type { ClaxedoFetch } from "../client/contract"
import { McpAccessDenied, type McpAuditEvent, type McpScope, type McpToolContext } from "../context"
import {
  CLAXEDO_MCP_PATH,
  createClaxedoMcpRoutes,
  fullUserCredential,
  inProcessFetch,
  type ClaxedoMcpMountOptions,
} from "../server"
import { boundedWaitMs, registerAttentionTools, replyToPermission, WAIT_FOR_ATTENTION_MAX_MS } from "./attention"

const DIRECTORY = "/w"

type FixtureSession = { id: string; title: string; parentID?: string }

type Harness = {
  permissions: boolean
  questions: boolean
  sessions: FixtureSession[]
  status: Record<string, AgentRuntimeStatus>
  pendingPermissions: AgentPermission[]
  pendingQuestions: AgentQuestion[]
  answered: Array<{ id: string; decision: string }>
  replied: Array<{ id: string; answers: string[][] }>
  rejected: string[]
  fail?: string
}

function harness(input: Partial<Harness> = {}): Harness {
  return {
    permissions: true,
    questions: true,
    sessions: [],
    status: {},
    pendingPermissions: [],
    pendingQuestions: [],
    answered: [],
    replied: [],
    rejected: [],
    ...input,
  }
}

function permission(id: string, sessionID: string, title: string): AgentPermission {
  return { id, sessionID, title, permission: "bash", patterns: [], always: [], metadata: {} }
}

function question(id: string, sessionID: string, prompt: string): AgentQuestion {
  return { id, sessionID, questions: [{ question: prompt, header: prompt, options: [{ label: "yes", description: "" }] }] }
}

/**
 * The real workspace-runtime session routes over an in-memory harness: the
 * only thing faked is the adapter a driver would be, which is where a pending
 * permission is produced and where the ACP abort fix clears one.
 */
function runtimeApp(state: Harness) {
  const routes = createSessionRoutes({
    resolveDirectory: () => DIRECTORY,
    resolveExecutionBinding: (_c, directory, sessionId) => ({
      workspaceId: "ws_local",
      directory: directory ?? DIRECTORY,
      sessionId,
      connectionId: "conn",
      upstreamSessionId: sessionId,
    }),
    listSessions: async () => state.sessions.filter((row) => !row.parentID).map((row) => ({ ...row })),
    getSession: (_c, _directory, sessionId) => state.sessions.find((row) => row.id === sessionId) ?? null,
    getStatus: () => state.status,
    listPermissions: async () => state.pendingPermissions,
    listQuestions: async () => state.pendingQuestions,
    sessionBus: { publish: () => {}, subscribe: () => () => {} },
    publishGlobal: () => {},
    resolveAdapter: () => ({
      instructionChannel: "none" as const,
      getSession: async (binding) => state.sessions.find((row) => row.id === binding.sessionId) ?? null,
      createSession: async () => ({ id: "ses_new" }),
      updateSession: async (binding) => state.sessions.find((row) => row.id === binding.sessionId) ?? null,
      getSessionConfig: async () => ({ harness: { id: "codex", access: "native" as const }, agent: "build", variant: null }),
      updateSessionConfig: async () => ({ harness: { id: "codex", access: "native" as const }, agent: "build", variant: null }),
      deleteSession: async () => {},
      readHarnessCapabilities: () => ({
        harness: "codex",
        abort: true,
        reconnect: false,
        replay: true,
        permissions: state.permissions,
        questions: state.questions,
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
      executeTurn: () => (async function* () {})(),
      getMessages: async () => [],
      dispose: () => {},
      abort: async (binding) => {
        state.pendingPermissions = state.pendingPermissions.filter((row) => row.sessionID !== binding.sessionId)
        return { ok: true as const, status: "cancelled" as const }
      },
      listPermissions: async () => state.pendingPermissions,
      respondPermission: async (_binding, permId, decision) => {
        state.answered.push({ id: permId, decision })
        state.pendingPermissions = state.pendingPermissions.filter((row) => row.id !== permId)
      },
      listQuestions: async () => state.pendingQuestions,
      replyQuestion: async (_binding, id, answers) => {
        state.replied.push({ id, answers })
        state.pendingQuestions = state.pendingQuestions.filter((row) => row.id !== id)
      },
      rejectQuestion: async (_binding, id) => {
        state.rejected.push(id)
        state.pendingQuestions = state.pendingQuestions.filter((row) => row.id !== id)
      },
    }),
  })
  const app = new Hono().route("/", routes)
  return (request: Request) => {
    if (state.fail) return Promise.reject(new Error(state.fail))
    return app.fetch(request)
  }
}

type WorkspaceRow = { workspace_id: string; access: "cloud" | "user-hosted"; display_name?: string; host_online?: boolean }

function controlPlaneFetch(rows: readonly WorkspaceRow[]): ClaxedoFetch {
  return async (path) => {
    const url = new URL(path, "http://control.local")
    if (url.pathname !== "/api/workspace") return new Response("no such route", { status: 404 })
    const access = url.searchParams.get("access")
    return Response.json({ workspaces: rows.filter((row) => row.access === access) })
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

const runtimeClaims = { runtimeId: "rt_1", workspaceId: "ws_local", userId: "user_1", expiresAt: Number.MAX_SAFE_INTEGER }

type MountInput = {
  state: Harness
  mount?: ClaxedoMcpMountOptions["mount"]
  workspaces?: readonly WorkspaceRow[]
  callerSession?: string
  userScopes?: readonly McpScope[]
}

async function listen(input: MountInput) {
  const audits: McpAuditEvent[] = []
  const runtime = runtimeApp(input.state)
  const mount = input.mount ?? "node"
  const control = input.workspaces ? controlPlaneFetch(input.workspaces) : undefined
  const routes = createClaxedoMcpRoutes({
    mount,
    verifyRuntimeCredential: (token) => (token === "rt-token" ? { ...runtimeClaims, sessionId: input.callerSession } : undefined),
    resolveUserCredential: async (request) => {
      if (request.headers.get("authorization") !== "Bearer cli-jwt") return undefined
      if (!input.userScopes) return fullUserCredential({ actorId: "actor_1", clientId: "cli" })
      return { kind: "user", actorId: "actor_1", scopes: new Set(input.userScopes), clientId: "cli", readOnly: false }
    },
    createClient: () =>
      createClaxedoMcpClient({
        deployment: mount === "hosted" ? "hosted" : mount,
        ...(mount === "hosted" ? {} : { local: { fetch: inProcessFetch(runtime), workspace: { workspaceId: "ws_local", directory: DIRECTORY } } }),
        ...(control ? { controlPlane: { fetch: control } } : {}),
      }),
    registerTools: [{ id: "attention", register: registerAttentionTools }],
    enabledToolGroups: () => ["attention"],
    audit: (event) => { audits.push(event) },
  })
  mounts.push(routes)
  const app = new Hono().route(CLAXEDO_MCP_PATH, routes.routes)
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  const suffix = input.callerSession ? `?session=${input.callerSession}` : ""
  return { url: `http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}${suffix}`, audits, runtime }
}

async function connect(url: string, token: string, elicit?: (message: string) => { action: "accept" | "decline"; response?: string }) {
  const client = new Client({ name: "fixture-host", version: "0.0.0" }, elicit ? { capabilities: { elicitation: { form: {} } } } : {})
  const prompts: string[] = []
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message)
      const answer = elicit(request.params.message)
      return { action: answer.action, content: answer.response ? { response: answer.response } : {} }
    })
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return { client, prompts }
}

async function callText(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const [block] = result.content as Array<{ type: string; text: string }>
  return { text: block?.text ?? "", isError: result.isError === true }
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).toSorted()

describe("sessions_board", () => {
  test("groups pending work by workspace and nests a child's items under its parent", async () => {
    const state = harness({
      sessions: [
        { id: "ses_parent", title: "Fix login" },
        { id: "ses_child", title: "Codex child", parentID: "ses_parent" },
        { id: "ses_grandchild", title: "Codex grandchild", parentID: "ses_child" },
        { id: "ses_quiet", title: "Docs" },
      ],
      status: { ses_parent: { type: "busy" }, ses_child: { type: "busy" }, ses_grandchild: { type: "busy" }, ses_quiet: { type: "idle" } },
      pendingPermissions: [permission("perm_1", "ses_parent", "Bash rm -rf"), permission("perm_2", "ses_grandchild", "Write file")],
      pendingQuestions: [question("q_1", "ses_grandchild", "Which database?")],
    })
    const { url } = await listen({ state, workspaces: [{ workspace_id: "ws_local", access: "user-hosted", display_name: "Mac" }] })
    const { client } = await connect(url, "cli-jwt")
    const { text } = await callText(client, "sessions_board")
    expect(text).toBe([
      "ws_local (Mac) — user-hosted",
      "  ses_parent \"Fix login\"  busy",
      "    permission perm_1 — Bash rm -rf",
      "    ses_child \"Codex child\"  busy",
      "      ses_grandchild \"Codex grandchild\"  busy",
      "        permission perm_2 — Write file",
      "        question q_1 — Which database? [yes]",
      "  ses_quiet \"Docs\"  idle",
    ].join("\n"))
  })

  test("climbs to the root of a chain the root listing and the pending row both skip", async () => {
    const state = harness({
      sessions: [
        { id: "ses_root", title: "Root" },
        { id: "ses_a", title: "A", parentID: "ses_root" },
        { id: "ses_b", title: "B", parentID: "ses_a" },
        { id: "ses_c", title: "C", parentID: "ses_b" },
      ],
      status: { ses_root: { type: "busy" }, ses_a: { type: "busy" }, ses_b: { type: "busy" }, ses_c: { type: "busy" } },
      pendingPermissions: [permission("perm_deep", "ses_c", "Write file")],
    })
    const { url } = await listen({ state })
    const { client } = await connect(url, "cli-jwt")
    const { text } = await callText(client, "sessions_board")
    expect(text.split("\n").slice(1)).toEqual([
      "  ses_root \"Root\"  busy",
      "    ses_a \"A\"  busy",
      "      ses_b \"B\"  busy",
      "        ses_c \"C\"  busy",
      "          permission perm_deep — Write file",
    ])
  })

  test("never reports a session on a harness that raises no permissions as awaiting one", async () => {
    const state = harness({
      permissions: false,
      questions: false,
      sessions: [{ id: "ses_cursor", title: "Cursor run" }],
      status: { ses_cursor: { type: "busy" } },
    })
    const { url } = await listen({ state })
    const { client } = await connect(url, "cli-jwt")
    const board = await callText(client, "sessions_board")
    expect(board.text).toContain("ses_cursor \"Cursor run\"  busy")
    expect(board.text).not.toContain("permission")
    const reply = await callText(client, "permission_reply", { session: "ses_cursor", permission: "perm_x", response: "once" })
    expect(reply.isError).toBe(true)
    expect(state.answered).toEqual([])
  })

  test("drops an aborted turn's permission on the next read without a reconnect", async () => {
    const state = harness({
      sessions: [{ id: "ses_acp", title: "ACP run" }],
      status: { ses_acp: { type: "busy" } },
      pendingPermissions: [permission("perm_acp", "ses_acp", "Write file")],
    })
    const { url, runtime } = await listen({ state })
    const { client } = await connect(url, "cli-jwt")
    expect((await callText(client, "sessions_board")).text).toContain("permission perm_acp")
    expect((await runtime(new Request("http://127.0.0.1/session/ses_acp/abort", { method: "POST" }))).status).toBe(200)
    expect((await callText(client, "sessions_board")).text).not.toContain("perm_acp")
  })

  test("reports a machine it cannot reach as offline rather than as empty", async () => {
    const unreachable = harness({ fail: "connect ECONNREFUSED" })
    const { url } = await listen({
      state: unreachable,
      workspaces: [
        { workspace_id: "ws_local", access: "user-hosted", display_name: "Mac" },
        { workspace_id: "ws_asleep", access: "user-hosted", display_name: "Laptop", host_online: false },
      ],
    })
    const { client } = await connect(url, "cli-jwt")
    const { text } = await callText(client, "sessions_board")
    expect(text).toContain("machine offline: connect ECONNREFUSED")
    expect(text).toContain("ws_asleep (Laptop) — user-hosted\n  machine offline")
  })
})

describe("answering", () => {
  test("a person's reply reaches the runtime and is audited as the actor, against the session it addressed", async () => {
    const state = harness({
      sessions: [{ id: "ses_1", title: "Build" }],
      status: { ses_1: { type: "busy" } },
      pendingPermissions: [permission("perm_1", "ses_1", "Bash ls")],
      pendingQuestions: [question("q_1", "ses_1", "Which port?"), question("q_2", "ses_1", "Which host?")],
    })
    const { url, audits } = await listen({ state })
    const { client } = await connect(url, "cli-jwt")
    expect((await callText(client, "permission_reply", { session: "ses_1", permission: "perm_1", response: "always" })).text)
      .toContain("Answered permission perm_1")
    expect(state.answered).toEqual([{ id: "perm_1", decision: "allow_always" }])
    expect((await callText(client, "question_reply", { request: "q_2", answers: [["8080"]] })).text)
      .toContain("Answered question q_2")
    expect((await callText(client, "question_reject", { request: "q_1" })).text).toContain("Rejected question q_1")
    expect(state.rejected).toEqual(["q_1"])
    // A question names a request id, not a session; the audit line still has
    // to say which session was answered.
    expect(audits.map((event) => ({ tool: event.tool, sessionId: event.sessionId }))).toEqual([
      { tool: "permission_reply", sessionId: "ses_1" },
      { tool: "question_reply", sessionId: "ses_1" },
      { tool: "question_reject", sessionId: "ses_1" },
    ])
  })

  test("a question that is not pending is refused, and audited with no session because none was touched", async () => {
    const { url, audits } = await listen({ state: harness({ sessions: [{ id: "ses_1", title: "Build" }] }) })
    const { client } = await connect(url, "cli-jwt")
    expect((await callText(client, "question_reject", { request: "q_gone" })).text).toContain("No question q_gone is pending here")
    expect(audits.map((event) => ({ tool: event.tool, sessionId: event.sessionId })))
      .toEqual([{ tool: "question_reject", sessionId: undefined }])
  })

  test("a session may answer its own child's question and nothing else", async () => {
    const state = harness({
      sessions: [
        { id: "ses_parent", title: "Parent" },
        { id: "ses_child", title: "Child", parentID: "ses_parent" },
        { id: "ses_other", title: "Other" },
      ],
      pendingQuestions: [question("q_child", "ses_child", "Which db?"), question("q_other", "ses_other", "Which db?")],
    })
    const { url } = await listen({ state, mount: "loopback", callerSession: "ses_parent" })
    const { client } = await connect(url, "rt-token")
    expect(await toolNames(client)).toEqual(["question_reply"])
    expect((await callText(client, "question_reply", { request: "q_child", answers: [["Postgres"]] })).text)
      .toContain("Answered question q_child")
    expect(state.replied).toEqual([{ id: "q_child", answers: [["Postgres"]] }])
    const foreign = await callText(client, "question_reply", { request: "q_other", answers: [["MySQL"]] })
    expect(foreign.isError).toBe(true)
    expect(foreign.text).toContain("not a child of this session")
    expect(state.replied).toHaveLength(1)
  })

  test("a runtime credential is refused every approval tool a person owns", async () => {
    const state = harness({
      sessions: [{ id: "ses_1", title: "Build" }],
      pendingPermissions: [permission("perm_1", "ses_1", "Bash ls")],
      pendingQuestions: [question("q_1", "ses_1", "Which port?")],
    })
    const { url, audits } = await listen({ state, mount: "loopback", callerSession: "ses_1" })
    const { client } = await connect(url, "rt-token")
    expect(await toolNames(client)).toEqual(["question_reply"])
    for (const call of [
      { name: "permission_reply", args: { session: "ses_1", permission: "perm_1", response: "once" } },
      { name: "question_reject", args: { request: "q_1" } },
      { name: "sessions_board", args: {} },
      { name: "wait_for_attention", args: {} },
    ]) {
      const result = await callText(client, call.name, call.args)
      expect(result.isError, call.name).toBe(true)
      expect(result.text, call.name).toContain(`Tool ${call.name} not found`)
    }
    expect(state.answered).toEqual([])
    expect(state.rejected).toEqual([])
    expect(audits).toEqual([])
  })

  /**
   * The list a runtime credential is served is a courtesy; this reaches the
   * function every permission decision passes through, which is what closes
   * the self-approval path a parent would otherwise take on its own child.
   */
  test("the permission gate refuses a runtime credential that reaches it without the tool list", async () => {
    const state = harness({
      sessions: [{ id: "ses_1", title: "Build" }],
      pendingPermissions: [permission("perm_1", "ses_1", "Bash rm -rf")],
    })
    const ctx: McpToolContext = {
      credential: { kind: "runtime", runtimeId: "rt_1", workspaceId: "ws_local", sessionId: "ses_1", crossMachineWrites: false, readOnly: false },
      client: createClaxedoMcpClient({
        deployment: "loopback",
        local: { fetch: inProcessFetch(runtimeApp(state)), workspace: { workspaceId: "ws_local", directory: DIRECTORY } },
      }),
      audit: () => {},
    }
    const denied = await replyToPermission(ctx, { workspaceId: "ws_local" }, {
      sessionID: "ses_1",
      permissionID: "perm_1",
      response: "once",
    }).catch((error: unknown) => error)
    expect(denied).toBeInstanceOf(McpAccessDenied)
    expect((denied as McpAccessDenied).code).toBe("audience")
    expect(state.answered).toEqual([])
  })

  test("a user token without the approve scope is offered no approval tool", async () => {
    const state = harness({
      sessions: [{ id: "ses_1", title: "Build" }],
      pendingPermissions: [permission("perm_1", "ses_1", "Bash rm -rf")],
    })
    const { url } = await listen({ state, userScopes: ["read"] })
    const { client, prompts } = await connect(url, "cli-jwt", () => ({ action: "accept", response: "once" }))
    expect(await toolNames(client)).toEqual(["sessions_board", "wait_for_attention"])
    const { text } = await callText(client, "wait_for_attention", { timeoutMs: 300 })
    expect(prompts).toEqual([])
    expect(text).toContain("permission perm_1 — Bash rm -rf on session ses_1")
    expect(state.answered).toEqual([])
  })
})

describe("wait_for_attention", () => {
  test("offers a pending permission through the host's elicitation and applies the answer", async () => {
    const state = harness({
      sessions: [{ id: "ses_1", title: "Build" }],
      status: { ses_1: { type: "busy" } },
      pendingPermissions: [permission("perm_1", "ses_1", "Bash rm -rf")],
    })
    const { url, audits } = await listen({ state })
    const { client, prompts } = await connect(url, "cli-jwt", () => ({ action: "accept", response: "once" }))
    const { text } = await callText(client, "wait_for_attention", { timeoutMs: 5_000 })
    expect(prompts).toEqual(["Bash rm -rf — session ses_1"])
    expect(text).toContain('Answered permission perm_1 on session ses_1 with "once"')
    expect(state.answered).toEqual([{ id: "perm_1", decision: "allow_once" }])
    expect(audits.map((event) => ({ tool: event.tool, sessionId: event.sessionId }))).toEqual([
      { tool: "permission_reply", sessionId: "ses_1" },
    ])
  })

  test("leaves the permission pending when the person declines", async () => {
    const state = harness({
      sessions: [{ id: "ses_1", title: "Build" }],
      pendingPermissions: [permission("perm_1", "ses_1", "Bash rm -rf")],
    })
    const { url } = await listen({ state })
    const { client } = await connect(url, "cli-jwt", () => ({ action: "decline" }))
    expect((await callText(client, "wait_for_attention", { timeoutMs: 5_000 })).text).toContain("is still pending")
    expect(state.answered).toEqual([])
  })

  test("reports the pending item as text on a host that declared no elicitation", async () => {
    const state = harness({
      sessions: [{ id: "ses_1", title: "Build" }],
      pendingQuestions: [question("q_1", "ses_1", "Which database?")],
    })
    const { url } = await listen({ state })
    const { client } = await connect(url, "cli-jwt")
    const { text } = await callText(client, "wait_for_attention", { timeoutMs: 5_000 })
    expect(text).toContain("question q_1 — Which database? [yes] on session ses_1")
  })

  test("returns when the named session's status changes", async () => {
    const state = harness({ sessions: [{ id: "ses_1", title: "Build" }], status: { ses_1: { type: "busy" } } })
    const { url } = await listen({ state })
    const { client } = await connect(url, "cli-jwt")
    const waiting = callText(client, "wait_for_attention", { timeoutMs: 6_000, session: "ses_1" })
    const flip = setTimeout(() => { state.status = { ses_1: { type: "idle" } } }, 1_200)
    try {
      expect((await waiting).text).toBe("Session ses_1 is now idle.")
    } finally {
      clearTimeout(flip)
    }
  })

  test("returns within the requested bound when nothing is waiting", async () => {
    const { url } = await listen({ state: harness({ sessions: [{ id: "ses_1", title: "Build" }] }) })
    const { client } = await connect(url, "cli-jwt")
    const started = Date.now()
    const { text } = await callText(client, "wait_for_attention", { timeoutMs: 300 })
    const elapsed = Date.now() - started
    expect(text).toBe("Nothing was waiting within 300 ms.")
    expect(elapsed).toBeLessThan(WAIT_FOR_ATTENTION_MAX_MS)
  })

  test("clamps every request to the bound a host tool timeout can survive", () => {
    expect(boundedWaitMs()).toBe(WAIT_FOR_ATTENTION_MAX_MS)
    expect(boundedWaitMs(600_000)).toBe(WAIT_FOR_ATTENTION_MAX_MS)
    expect(boundedWaitMs(1_000)).toBe(1_000)
    expect(WAIT_FOR_ATTENTION_MAX_MS).toBe(50_000)
  })
})
