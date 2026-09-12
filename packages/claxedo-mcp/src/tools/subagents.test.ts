import { afterEach, describe, expect, test } from "vitest"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { createClaxedoMcpClient } from "../client/index"
import {
  CLAXEDO_MCP_PATH,
  createClaxedoMcpRoutes,
  fullUserCredential,
  inProcessFetch,
  type ClaxedoMcpMountOptions,
} from "../server"
import { registerSubagentTools } from "./subagents"

const DIRECTORY = "/workspaces/test"
const WORKSPACE = "ws_1"
const MODE_LEVELS: Record<string, string | undefined> = {
  "read-only": "ask",
  "workspace-write": "auto",
  "full-access": "full",
  untrusted: undefined,
}
const LEVEL_ORDER = ["ask", "auto", "full"]

const GROUP = {
  planning: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "claude-opus-4" }, effort: "high" },
  review: { harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5" } },
}

type FakeSession = {
  id: string
  parentID?: string
  permissionMode: string
  archived?: number
  answer: string
  turnMs: number
  model?: unknown
  variant?: string
  instructions?: string
  group?: Record<string, unknown>
}

type FakeHarnessCapabilities = {
  modelSelection?: { status: string; models?: Array<{ providerId: string; modelId: string; name: string }> }
  effortLevels?: { status: string; models: Array<{ modelID: string; levels: string[] }> }
}

type FakeRow = {
  subagentKey: string
  childSessionId: string
  providerKind: "claxedo"
  status: string
  label?: string
  subagentType?: string
  wake?: string
}

const HARNESSES = ["claude", "codex", "cursor", "pi", "opencode"]
const CONNECTIONS = ["review-bot"]

const error = (code: string, message: string) => ({ error: { code, message } })

/**
 * The child-session half of the workspace-runtime session routes, answering
 * exactly what `session-children.routes.test.ts` pins for the real ones. The
 * runtime itself is not reachable from this package: its route module needs an
 * adapter and a store from `@claxedo/agent-sdk-runtime`, which is not a
 * dependency here.
 */
function fakeRuntime(options: {
  turnMs?: number
  parentMode?: string
  defaultHarness?: string | null
  harnessCapabilities?: FakeHarnessCapabilities
} = {}) {
  const sessions = new Map<string, FakeSession>()
  const rows = new Map<string, FakeRow[]>()
  const messages = new Map<string, Array<{ info: { id: string; role: string; sessionID: string }; parts: Array<{ id: string; sessionID: string; messageID: string; type: "text"; text: string }> }>>()
  const idempotency = new Map<string, string>()
  const prompted = new Set<string>()
  const prompts: Array<{ sessionId: string; text: string; model?: unknown }> = []
  const timers: ReturnType<typeof setTimeout>[] = []
  const turnTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let counter = 0

  const seed = (id: string, session: Partial<FakeSession> = {}) => {
    sessions.set(id, {
      id,
      permissionMode: options.parentMode ?? "read-only",
      answer: "Ship it.",
      turnMs: options.turnMs ?? 10,
      ...session,
    })
    return id
  }

  const childrenOf = (parent: string) => rows.get(parent) ?? []
  const rowFor = (sessionId: string) => {
    for (const [, list] of rows) {
      const found = list.find((row) => row.childSessionId === sessionId)
      if (found) return found
    }
    return undefined
  }

  /**
   * The runtime marks a child terminal only when its turn unwinds, in
   * `onTurnSettled`: the last assistant message decides `completed` against
   * `killed`, and the parent's wake is queued from there. An abort therefore
   * lands on the row a tick after `POST /abort` has already answered.
   */
  const settleTurn = (child: FakeSession, status: "completed" | "killed") => {
    turnTimers.delete(child.id)
    const row = rowFor(child.id)
    if (!row || !["pending", "running", "paused"].includes(row.status)) return
    const messageId = `msg_${child.id}`
    messages.set(child.id, [{
      info: { id: messageId, role: "assistant", sessionID: child.id },
      parts: [{ id: `p_${child.id}`, sessionID: child.id, messageID: messageId, type: "text", text: child.answer }],
    }])
    row.status = status
    row.wake = "pending"
    timers.push(setTimeout(() => { row.wake = "delivered" }, 5))
  }

  const scheduleTurn = (child: FakeSession, status: "completed" | "killed", delayMs: number) => {
    clearTimeout(turnTimers.get(child.id))
    const timer = setTimeout(() => settleTurn(child, status), delayMs)
    turnTimers.set(child.id, timer)
    timers.push(timer)
  }

  const app = new Hono()
    .post("/session", async (c) => {
      const connection = c.req.query("connectionId")
      const harness = connection ?? c.req.query("nativeHarness")
      if (!harness || !(connection ? CONNECTIONS : HARNESSES).includes(harness)) {
        return c.json(error("unknown_native_harness", `Unknown harness "${harness ?? ""}"`), 400)
      }
      const body = await c.req.json() as Record<string, string | undefined> & { model?: unknown }
      const parentID = body.parentID
      if (!parentID) return c.json(error("child_sessions_unsupported", "This fixture only creates children"), 501)
      const parent = sessions.get(parentID)
      if (!parent) return c.json(error("parent_session_not_found", `Parent session ${parentID} not found`), 404)
      if (parent.parentID) return c.json(error("subagent_recursion_denied", "A child session cannot create children of its own"), 409)
      if (parent.archived !== undefined) return c.json(error("parent_session_archived", "An archived session cannot create children"), 409)

      const existingId = body.clientRequestId ? idempotency.get(`${parentID}\0${body.clientRequestId}`) : undefined
      if (existingId) {
        const row = childrenOf(parentID).find((candidate) => candidate.childSessionId === existingId)
        return c.json({ id: existingId, parentID, subagentKey: row?.subagentKey }, 200)
      }
      const active = childrenOf(parentID).filter((row) => ["pending", "running", "paused"].includes(row.status))
      if (active.length >= 4) {
        return c.json(error("subagent_child_cap_reached", `Session ${parentID} already has ${active.length} active children (limit 4)`), 409)
      }
      const ceiling = narrower(MODE_LEVELS[parent.permissionMode], body.permissionCeiling)
      const requested = body.permissionMode
      if (requested && !(requested in MODE_LEVELS)) {
        return c.json(error("unknown_permission_mode", `Unknown permission mode "${requested}"`), 400)
      }
      const level = requested ? MODE_LEVELS[requested] : undefined
      if (requested && ceiling && level && LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(ceiling)) {
        return c.json({
          error: {
            code: "permission_ceiling_exceeded",
            message: `Permission mode "${requested}" (${level}) widens the ${ceiling} ceiling`,
            ceiling,
            requested: { modeId: requested, level },
          },
        }, 403)
      }
      const permissionMode = requested ?? widestUnder(ceiling) ?? parent.permissionMode
      const id = `ses_child_${++counter}`
      seed(id, {
        parentID,
        permissionMode,
        answer: parent.answer,
        turnMs: parent.turnMs,
        ...(body.model ? { model: body.model } : {}),
        ...(body.variant ? { variant: body.variant } : {}),
        ...(body.instructions ? { instructions: body.instructions } : {}),
      })
      const row: FakeRow = {
        subagentKey: `subagent_${counter}`,
        childSessionId: id,
        providerKind: "claxedo",
        status: "pending",
        subagentType: body.role ?? harness,
        label: body.title ?? body.role ?? `${harness} subagent`,
      }
      rows.set(parentID, [...childrenOf(parentID), row])
      if (body.clientRequestId) idempotency.set(`${parentID}\0${body.clientRequestId}`, id)
      return c.json({ id, parentID, subagentKey: row.subagentKey, permissionMode }, 201)
    })
    .post("/session/:id/prompt_async", async (c) => {
      const id = c.req.param("id")
      const child = sessions.get(id)
      if (!child) return c.json(error("session_not_found", `Session ${id} not found`), 404)
      const body = await c.req.json() as { messageID?: string; parts: Array<{ type: string; text: string }> }
      const key = `${id}\0${body.messageID ?? ""}`
      if (body.messageID && prompted.has(key)) return c.body(null, 204)
      if (body.messageID) prompted.add(key)
      prompts.push({ sessionId: id, text: body.parts.map((part) => part.text).join(""), ...(child.model ? { model: child.model } : {}) })
      const row = rowFor(id)
      if (row) row.status = "running"
      scheduleTurn(child, "completed", child.turnMs)
      return c.body(null, 204)
    })
    .post("/session/:id/abort", (c) => {
      const child = sessions.get(c.req.param("id"))
      if (child) scheduleTurn(child, "killed", 0)
      return c.json({ ok: true, status: "cancelled" })
    })
    .get("/session/capabilities", (c) => {
      const requested = c.req.query("nativeHarness") ?? c.req.query("connectionId")
      if (requested && ![...HARNESSES, ...CONNECTIONS].includes(requested)) {
        return c.json(error("unknown_native_harness", `Unknown harness "${requested}"`), 400)
      }
      if (!requested && options.defaultHarness === null) {
        return c.json(error("workspace_harness_not_configured", "No default harness is configured on this runtime"), 409)
      }
      return c.json({
        harness: requested ?? options.defaultHarness ?? "codex",
        subagents: true,
        ...options.harnessCapabilities,
      })
    })
    .get("/session/:id/config", (c) => {
      const session = sessions.get(c.req.param("id"))
      if (!session) return c.json(error("session_not_found", "not found"), 404)
      const model = session.model as { providerID?: string; id?: string } | undefined
      return c.json({
        harness: { id: "codex", access: "native" },
        ...(model?.providerID && model.id ? { model: { providerID: model.providerID, modelID: model.id } } : {}),
        variant: session.variant ?? null,
        instructions: session.instructions ?? "",
        ...(session.group ? { group: session.group } : {}),
      })
    })
    .get("/session/:id/subagents", (c) => c.json(childrenOf(c.req.param("id"))))
    // `messagePageResponse` answers with the messages alone and puts the cursor
    // on `X-Next-Cursor`; a `{ messages }` envelope here is what let
    // `summaryOf` read `page.data.messages` and crash against the real route.
    .get("/session/:id/message", (c) => c.json(messages.get(c.req.param("id")) ?? []))
    .get("/session/:id", (c) => {
      const session = sessions.get(c.req.param("id"))
      if (!session) return c.json(error("session_not_found", "not found"), 404)
      return c.json({
        id: session.id,
        ...(session.parentID ? { parentID: session.parentID } : {}),
        ...(session.archived === undefined ? {} : { time: { archived: session.archived } }),
      })
    })

  return {
    app,
    seed,
    childrenOf,
    prompts,
    sessions,
    config: async (sessionId: string) =>
      await (await app.request(`http://runtime.test/session/${sessionId}/config`)).json() as Record<string, unknown>,
    dispose: () => { for (const timer of timers.splice(0)) clearTimeout(timer) },
  }
}

function narrower(parent: string | undefined, declared: string | undefined) {
  const ranked = [parent, declared].filter((level): level is string => !!level && LEVEL_ORDER.includes(level))
  if (ranked.length === 0) return undefined
  return ranked.reduce((left, right) => LEVEL_ORDER.indexOf(left) <= LEVEL_ORDER.indexOf(right) ? left : right)
}

function widestUnder(ceiling: string | undefined) {
  if (!ceiling) return undefined
  return Object.entries(MODE_LEVELS)
    .filter(([, level]) => level && LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(ceiling))
    .sort(([, left], [, right]) => LEVEL_ORDER.indexOf(right ?? "") - LEVEL_ORDER.indexOf(left ?? ""))[0]?.[0]
}

const servers: Array<ReturnType<typeof serve>> = []
const clients: Client[] = []
const mounts: Array<{ dispose(): void }> = []
const runtimes: Array<{ dispose(): void }> = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  for (const mount of mounts.splice(0)) mount.dispose()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function mount(runtime: ReturnType<typeof fakeRuntime>, options: Partial<ClaxedoMcpMountOptions> = {}) {
  runtimes.push(runtime)
  const routes = createClaxedoMcpRoutes({
    mount: "loopback",
    verifyRuntimeCredential: (token) =>
      token.startsWith("rt-token:")
        ? { runtimeId: "rt_1", workspaceId: WORKSPACE, sessionId: token.slice("rt-token:".length), userId: "user_1", permissionMode: "ask", expiresAt: Number.MAX_SAFE_INTEGER }
        : undefined,
    createClient: () => createClaxedoMcpClient({
      deployment: "loopback",
      local: { fetch: inProcessFetch((request) => runtime.app.fetch(request)), workspace: { workspaceId: WORKSPACE, directory: DIRECTORY } },
    }),
    registerTools: [registerSubagentTools],
    audit: () => undefined,
    ...options,
  })
  mounts.push(routes)
  const app = new Hono().route(CLAXEDO_MCP_PATH, routes.routes)
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return `http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}`
}

async function connect(url: string, headers: Record<string, string>) {
  const client = new Client({ name: "fixture-host", version: "0.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  clients.push(client)
  return client
}

const asRuntime = (url: string, sessionId: string) => connect(`${url}?session=${sessionId}`, { authorization: `Bearer rt-token:${sessionId}` })

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>

function textOf(result: CallToolResult) {
  const [block] = result.content
  if (!block || block.type !== "text") throw new Error("the tool answered with no text block")
  return block.text
}

const jsonOf = (result: CallToolResult) => JSON.parse(textOf(result)) as Record<string, unknown>

async function until(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe("subagent tools", () => {
  test("create_subagent answers a binding block naming the child the runtime minted", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const created = jsonOf(await call(client, "create_subagent", {
      harness: "codex",
      prompt: "Review the plan",
      role: "reviewer",
      mode: "async",
    }))
    expect(created).toMatchObject({ kind: "claxedo.subagent", status: "running" })
    expect(created.subagentKey).toMatch(/^subagent_/)
    expect(runtime.childrenOf("parent")).toMatchObject([{
      childSessionId: created.sessionId,
      subagentKey: created.subagentKey,
      subagentType: "reviewer",
      status: "running",
    }])
  })

  test("the prompt carries the role line and no history from the parent", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const created = jsonOf(await call(client, "create_subagent", { harness: "codex", prompt: "Review the plan", role: "reviewer", mode: "async" }))
    expect(runtime.prompts).toEqual([{ sessionId: created.sessionId, text: "Role: reviewer\n\nReview the plan" }])
  })

  test("wait returns the child's own answer inside the bound", async () => {
    const runtime = fakeRuntime({ turnMs: 10 })
    const url = await mount(runtime)
    runtime.seed("parent", { answer: "The plan holds." })
    const client = await asRuntime(url, "parent")

    const result = jsonOf(await call(client, "create_subagent", {
      harness: "codex",
      prompt: "Review the plan",
      mode: "wait",
      timeoutMs: 5_000,
    }))
    expect(result).toMatchObject({ kind: "claxedo.subagent", status: "completed", summary: "The plan holds." })
  })

  test("a wait that times out leaves the child running and says so", async () => {
    const runtime = fakeRuntime({ turnMs: 3_000 })
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const result = jsonOf(await call(client, "create_subagent", {
      harness: "codex",
      prompt: "Take your time",
      mode: "wait",
      timeoutMs: 20,
    }))
    expect(result).toMatchObject({ timedOut: true, status: "running" })
    expect(result.summary).toBeUndefined()
    expect(runtime.childrenOf("parent")).toMatchObject([{ status: "running" }])
  })

  test("the completed child reaches a terminal state with the runtime's own wake pending", async () => {
    const runtime = fakeRuntime({ turnMs: 10 })
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const created = jsonOf(await call(client, "create_subagent", { harness: "codex", prompt: "Consult", mode: "wait", timeoutMs: 5_000 }))
    const [row] = runtime.childrenOf("parent")
    expect(row).toMatchObject({ status: "completed", childSessionId: created.sessionId })
    expect(["pending", "delivered"]).toContain(row?.wake)

    await until(() => runtime.childrenOf("parent")[0]?.wake === "delivered", "the wake to be delivered")
    const listed = JSON.parse(textOf(await call(client, "subagent_list"))) as Array<Record<string, unknown>>
    expect(listed).toMatchObject([{ sessionId: created.sessionId, status: "completed", wake: "delivered" }])
  })

  test("a permission mode wider than the caller's is refused with the runtime's own code", async () => {
    const runtime = fakeRuntime({ parentMode: "read-only" })
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const refused = await call(client, "create_subagent", {
      harness: "codex",
      prompt: "Run it",
      mode: "async",
      permissionMode: "full-access",
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("permission_ceiling_exceeded")
    expect(runtime.childrenOf("parent")).toEqual([])
  })

  test("a retried clientRequestId returns the same child instead of a second one", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const args = { harness: "codex", prompt: "Consult", mode: "async", clientRequestId: "req-1" }
    const first = jsonOf(await call(client, "create_subagent", args))
    const retry = jsonOf(await call(client, "create_subagent", args))
    expect(retry.sessionId).toBe(first.sessionId)
    expect(retry.subagentKey).toBe(first.subagentKey)
    expect(runtime.childrenOf("parent")).toHaveLength(1)
  })

  test("a caller that is itself a child cannot start one", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent")
    runtime.seed("child", { parentID: "parent" })
    const client = await asRuntime(url, "child")

    const refused = await call(client, "create_subagent", { harness: "codex", prompt: "Recurse", mode: "async" })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("subagent_recursion_denied")

    const capabilities = jsonOf(await call(client, "subagent_capabilities"))
    expect(capabilities).toMatchObject({ canSpawn: false, parentSessionId: "child" })
    expect(capabilities.reason).toContain("subagent")
  })

  test("the fifth active child is refused and named as the cap", async () => {
    const runtime = fakeRuntime({ turnMs: 60_000 })
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    for (let index = 0; index < 4; index += 1) {
      expect((await call(client, "create_subagent", { harness: "codex", prompt: `task ${index}`, mode: "async" })).isError).toBeFalsy()
    }
    const capped = await call(client, "create_subagent", { harness: "codex", prompt: "one too many", mode: "async" })
    expect(capped.isError).toBe(true)
    expect(textOf(capped)).toContain("subagent_child_cap_reached")

    const capabilities = jsonOf(await call(client, "subagent_capabilities"))
    expect(capabilities).toMatchObject({ canSpawn: false, activeChildren: 4, maxActiveChildren: 4 })
  })

  test("subagent_capabilities reports the runtime's harness, the ceiling and the wait bound", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const capabilities = jsonOf(await call(client, "subagent_capabilities"))
    expect(capabilities).toMatchObject({
      canSpawn: true,
      parentSessionId: "parent",
      permissionCeiling: "ask",
      activeChildren: 0,
      maxActiveChildren: 4,
      waitTimeoutMaxMs: 50_000,
      runtimeHarness: "codex",
    })
    expect(capabilities.harnesses).toMatchObject([
      { id: "claude", status: "unverified" },
      { id: "codex", status: "ready" },
      { id: "cursor", status: "unverified" },
      { id: "pi", status: "unverified" },
      { id: "opencode", status: "unverified" },
    ])
  })

  test("subagent_capabilities answers the reason instead of failing when the runtime declares no default harness", async () => {
    const runtime = fakeRuntime({ defaultHarness: null })
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const answered = await call(client, "subagent_capabilities")
    expect(answered.isError).toBeFalsy()
    const capabilities = jsonOf(answered)
    expect(capabilities).toMatchObject({ canSpawn: true, parentSessionId: "parent" })
    expect(capabilities.runtimeHarness).toBeUndefined()
    expect(capabilities.harnesses).toMatchObject(
      ["claude", "codex", "cursor", "pi", "opencode"].map((id) => ({ id, status: "unverified" })),
    )
    expect(JSON.stringify(capabilities.harnesses)).toContain("No default harness is configured on this runtime")
  })

  test("subagent_status reads one child and subagent_cancel stops it", async () => {
    const runtime = fakeRuntime({ turnMs: 60_000 })
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const created = jsonOf(await call(client, "create_subagent", { harness: "codex", prompt: "Consult", mode: "async" }))
    expect(jsonOf(await call(client, "subagent_status", { subagentKey: created.subagentKey })))
      .toMatchObject({ kind: "claxedo.subagent", sessionId: created.sessionId, status: "running" })

    expect(jsonOf(await call(client, "subagent_cancel", { sessionId: created.sessionId })))
      .toMatchObject({ kind: "claxedo.subagent", sessionId: created.sessionId })

    await until(() => runtime.childrenOf("parent")[0]?.status === "killed", "the cancelled child to settle")
    expect(jsonOf(await call(client, "subagent_status", { subagentKey: created.subagentKey })))
      .toMatchObject({ status: "killed", summary: "Ship it." })
  })

  test("the child is created on the model the caller named", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const created = jsonOf(await call(client, "create_subagent", {
      harness: "codex",
      prompt: "Consult",
      mode: "async",
      model: { providerID: "anthropic", id: "claude-opus-4" },
    }))
    expect(runtime.prompts).toEqual([
      { sessionId: created.sessionId, text: "Consult", model: { providerID: "anthropic", id: "claude-opus-4" } },
    ])
  })

  test("a session that is not this caller's child cannot be cancelled or read", async () => {
    const runtime = fakeRuntime({ turnMs: 60_000 })
    const url = await mount(runtime)
    runtime.seed("parent")
    runtime.seed("other")
    const owner = await asRuntime(url, "other")
    const stranger = await asRuntime(url, "parent")
    const created = jsonOf(await call(owner, "create_subagent", { harness: "codex", prompt: "Consult", mode: "async" }))

    const refused = await call(stranger, "subagent_cancel", { sessionId: String(created.sessionId) })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("is not a child of this session")
    expect(runtime.childrenOf("other")).toMatchObject([{ status: "running" }])

    const unreadable = await call(stranger, "subagent_status", { subagentKey: String(created.subagentKey) })
    expect(unreadable.isError).toBe(true)
  })

  test("a runtime credential without a session id is told it has no parent", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    const client = await connect(url, { authorization: "Bearer rt-token:" })

    const refused = await call(client, "create_subagent", { harness: "codex", prompt: "Consult", mode: "async" })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("names none")
    expect(jsonOf(await call(client, "subagent_capabilities"))).toMatchObject({ canSpawn: false })
  })

  test("a user credential is served no subagent tool at all", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime, {
      mount: "hosted",
      resolveUserCredential: async () => fullUserCredential({ actorId: "actor_1", clientId: "cli" }),
    })
    const client = await connect(url, { authorization: "Bearer cli-jwt" })

    expect((await client.listTools()).tools).toEqual([])
    await expect(call(client, "create_subagent", { harness: "codex", prompt: "Consult", mode: "async" })).rejects.toThrow(/-32601/)
  })
  test("a child started by a configuration runs that slot's harness, model and effort", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent", { group: GROUP })
    const client = await asRuntime(url, "parent")

    const created = jsonOf(await call(client, "create_subagent", {
      configuration: "planning",
      prompt: "Draft the approach",
      mode: "async",
    }))
    expect(await runtime.config(String(created.sessionId))).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude-opus-4" },
      variant: "high",
    })
    // The harness reaches the create in the query, and the row the runtime
    // minted names the one it selected.
    expect(runtime.childrenOf("parent")).toMatchObject([{ subagentType: "claude" }])
  })

  test("the child is given the parent's own instructions and told which configuration it runs", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent", { group: GROUP, instructions: "Read before you write." })
    const client = await asRuntime(url, "parent")

    const created = jsonOf(await call(client, "create_subagent", {
      configuration: "review",
      prompt: "Check it",
      mode: "async",
    }))
    const instructions = String((await runtime.config(String(created.sessionId))).instructions)
    expect(instructions).toContain("Read before you write.")
    expect(instructions).toContain("review configuration")
    expect(instructions).toContain("openai/gpt-5")
    expect(instructions).toContain("cannot start subagents of your own")
    // The prompt is still the task alone; the instruction block is not history.
    expect(runtime.prompts).toEqual([
      { sessionId: created.sessionId, text: "Check it", model: { providerID: "openai", id: "gpt-5" } },
    ])
  })

  test("a configuration this session's group does not name is refused with the ones it has", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent", { group: GROUP })
    const client = await asRuntime(url, "parent")

    const refused = await call(client, "create_subagent", { configuration: "implementation", prompt: "Build it", mode: "async" })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("subagent_configuration_unknown")
    expect(textOf(refused)).toContain("planning, review")
    expect(runtime.childrenOf("parent")).toEqual([])
  })

  test("a session with no group is told so rather than resolving a slot from nothing", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent")
    const client = await asRuntime(url, "parent")

    const refused = await call(client, "create_subagent", { configuration: "planning", prompt: "Draft", mode: "async" })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("no model group")
    expect(runtime.childrenOf("parent")).toEqual([])
  })

  test("a model or harness that contradicts the chosen configuration is refused", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent", { group: GROUP })
    const client = await asRuntime(url, "parent")

    for (const contradiction of [
      { model: { providerID: "openai", id: "gpt-5" } },
      { harness: "codex" },
      { effort: "low" },
    ]) {
      const refused = await call(client, "create_subagent", {
        configuration: "planning",
        prompt: "Draft",
        mode: "async",
        ...contradiction,
      })
      expect(refused.isError, JSON.stringify(contradiction)).toBe(true)
      expect(textOf(refused)).toContain("subagent_configuration_contradicted")
    }
    expect(runtime.childrenOf("parent")).toEqual([])
  })

  test("an effort the harness refuses for that model is refused with the levels it accepts", async () => {
    const runtime = fakeRuntime({
      harnessCapabilities: {
        effortLevels: { status: "resolved", models: [{ modelID: "claude-opus-4", levels: ["low", "medium"] }] },
      },
    })
    const url = await mount(runtime)
    runtime.seed("parent", { group: GROUP })
    const client = await asRuntime(url, "parent")

    const refused = await call(client, "create_subagent", { configuration: "planning", prompt: "Draft", mode: "async" })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("subagent_effort_unsupported")
    expect(textOf(refused)).toContain("it accepts low, medium")
    expect(runtime.childrenOf("parent")).toEqual([])
  })

  test("an effort no catalog has answered for reaches the child instead of being dropped", async () => {
    for (const effortLevels of [
      { status: "unresolved", models: [] },
      { status: "unsupported", models: [] },
      { status: "resolved", models: [{ modelID: "claude-opus-4", levels: ["low", "high"] }] },
    ]) {
      const runtime = fakeRuntime({ harnessCapabilities: { effortLevels } })
      const url = await mount(runtime)
      runtime.seed("parent", { group: GROUP })
      const client = await asRuntime(url, "parent")

      const created = await call(client, "create_subagent", { configuration: "planning", prompt: "Draft", mode: "async" })
      expect(created.isError, effortLevels.status).toBeFalsy()
      expect(await runtime.config(String(jsonOf(created).sessionId)), effortLevels.status).toMatchObject({ variant: "high" })
    }
  })

  test("a model the harness does not offer is refused before any child exists", async () => {
    const runtime = fakeRuntime({
      harnessCapabilities: {
        modelSelection: { status: "optional", models: [{ providerId: "openai", modelId: "gpt-5", name: "GPT-5" }] },
      },
    })
    const url = await mount(runtime)
    runtime.seed("parent", { group: GROUP })
    const client = await asRuntime(url, "parent")

    const refused = await call(client, "create_subagent", { configuration: "planning", prompt: "Draft", mode: "async" })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("subagent_model_unavailable")
    expect(runtime.childrenOf("parent")).toEqual([])
  })

  test("a configuration cannot widen the permission ceiling its parent runs under", async () => {
    const runtime = fakeRuntime({ parentMode: "read-only" })
    const url = await mount(runtime)
    runtime.seed("parent", { group: GROUP })
    const client = await asRuntime(url, "parent")

    const refused = await call(client, "create_subagent", {
      configuration: "planning",
      prompt: "Draft",
      mode: "async",
      permissionMode: "full-access",
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("permission_ceiling_exceeded")
    expect(runtime.childrenOf("parent")).toEqual([])
  })

  test("a retried configuration request returns the same child and prompts it once", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent", { group: GROUP })
    const client = await asRuntime(url, "parent")

    const args = { configuration: "planning", prompt: "Draft", mode: "async", clientRequestId: "req-planning" }
    const first = jsonOf(await call(client, "create_subagent", args))
    const retry = jsonOf(await call(client, "create_subagent", args))
    expect(retry.sessionId).toBe(first.sessionId)
    expect(runtime.childrenOf("parent")).toHaveLength(1)
    expect(runtime.prompts).toEqual([{ sessionId: first.sessionId, text: "Draft", model: { providerID: "anthropic", id: "claude-opus-4" } }])
  })

  test("subagent_capabilities advertises the group a child may be started from", async () => {
    const runtime = fakeRuntime({
      harnessCapabilities: { effortLevels: { status: "resolved", models: [{ modelID: "gpt-5", levels: ["low", "high"] }] } },
    })
    const url = await mount(runtime)
    runtime.seed("parent", { group: GROUP })
    const client = await asRuntime(url, "parent")

    expect(jsonOf(await call(client, "subagent_capabilities"))).toMatchObject({
      canSpawn: true,
      configurations: GROUP,
      effortLevels: { status: "resolved", models: [{ modelID: "gpt-5", levels: ["low", "high"] }] },
    })
  })

  test("a create that names neither a harness nor a configuration is refused", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent", { group: GROUP })
    const client = await asRuntime(url, "parent")

    const refused = await call(client, "create_subagent", { prompt: "Do it", mode: "async" })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("subagent_harness_required")
    expect(runtime.childrenOf("parent")).toEqual([])
  })
  test("a configuration whose harness is a connection reaches the create as a connection, not a native id", async () => {
    const runtime = fakeRuntime()
    const url = await mount(runtime)
    runtime.seed("parent", {
      group: {
        review: {
          harness: { id: "review-bot", access: "connection" },
          model: { providerID: "openai", modelID: "gpt-5" },
        },
      },
    })
    const client = await asRuntime(url, "parent")

    const created = await call(client, "create_subagent", { configuration: "review", prompt: "Check it", mode: "async" })
    expect(created.isError).toBeFalsy()
    expect(runtime.childrenOf("parent")).toMatchObject([{ subagentType: "review-bot" }])
  })
})
