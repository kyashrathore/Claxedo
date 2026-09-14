import { afterEach, describe, expect, test } from "vitest"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createClaxedoMcpClient } from "../client/index"
import type { ClaxedoFetch, TasksOperation } from "../client/contract"
import { assertToolAccess, McpAccessDenied, type McpCredential, type McpToolAccess } from "../context"
import { CLAXEDO_MCP_PATH, createClaxedoMcpRoutes, fullUserCredential, mcpAuditRecord } from "../server"
import { registerTaskTools } from "./tasks"

const ALL_OPERATIONS: readonly TasksOperation[] = ["read", "create", "start"]

const TASK = {
  id: "tsk_1",
  revision: 3,
  scopeId: "scope_1",
  projectId: "prj_1",
  number: 7,
  workspaceId: null,
  parentTaskId: null,
  createdFrom: null,
  title: "Ship the store",
  description: "the whole body",
  status: "todo",
  childSetRevision: 1,
  archivedAt: null,
  createdAt: 10,
  updatedAt: 20,
}

const SUMMARY = (() => {
  const { description, ...rest } = TASK
  return { ...rest, hasDescription: description.length > 0, links: { count: 2 }, children: { total: 1, done: 0 } }
})()

const CONFIGURATION = {
  harness: { id: "claude", access: "native" },
  model: { providerID: "anthropic", modelID: "claude-sonnet" },
  effort: null,
}

const PRESET = {
  id: "pst_1",
  revision: 2,
  scopeId: "scope_1",
  ownerId: "owner_1",
  name: "Default",
  instructions: "work carefully",
  execution: { placement: "local", capabilities: { mode: "inherit-local" } },
  agentStartable: false,
  configurations: { primary: CONFIGURATION },
  archivedAt: null,
  createdAt: 1,
  updatedAt: 2,
}

const PREVIEW = {
  digest: "dgst_1",
  expiresAt: 9_999,
  placement: "local",
  slot: "primary",
  attempt: 1,
  configuration: CONFIGURATION,
  capabilities: { mode: "inherit-local" },
  available: true,
  blockers: [],
  currentSession: null,
  previousTranscriptReadable: false,
  destinationDescription: "this machine, in /w",
}

const LINK = {
  taskId: "tsk_1",
  slot: "primary",
  attempt: 1,
  sessionRef: { sessionId: "ses_started", workspaceId: "ws_local" },
  continuedFrom: null,
  presetId: "pst_1",
  presetRevision: 2,
  presetNameAtStart: "Default",
  createdAt: 30,
  liveness: "live",
  handoff: "sent",
}

function deadLink(attempt: number) {
  return { ...LINK, attempt, liveness: "deleted", sessionRef: { sessionId: `ses_${attempt}`, workspaceId: "ws_local" } }
}

type Call = { method: string; path: string; body?: unknown }

type ServiceState = {
  /** Answers returned in place of the defaults, keyed by `"<METHOD> <path without query>"`. */
  answers: Record<string, { status: number; body: unknown }>
  links: readonly unknown[]
  /** The `/presets` catalog, one entry per page; page n is served for `cursor=page_n`. */
  presetPages: ReadonlyArray<readonly unknown[]>
  preview: Record<string, unknown>
  throws?: string
}

/** The Tasks routes as `createTasksRoutes` answers them, recording what each tool actually sent. */
function tasksService(input: Partial<ServiceState> = {}) {
  const state: ServiceState = {
    answers: {},
    links: [],
    presetPages: [[PRESET]],
    preview: PREVIEW,
    ...input,
  }
  const calls: Call[] = []
  const fetchLike: ClaxedoFetch = async (requestPath, init) => {
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ method, path: requestPath, ...(body === undefined ? {} : { body }) })
    if (state.throws) throw new Error(state.throws)
    const url = new URL(requestPath, "http://control-plane.local")
    const route = url.pathname.slice("/api/claxedo/tasks".length)
    const answer = state.answers[`${method} ${route}`]
    if (answer) return Response.json(answer.body, { status: answer.status })
    if (method === "GET" && route === "/tasks") return Response.json({ items: [SUMMARY], nextCursor: null })
    if (method === "GET" && route === "/tasks/tsk_1") return Response.json({ task: TASK, links: state.links })
    if (method === "GET" && route === "/presets") {
      const index = Number(url.searchParams.get("cursor")?.slice("page_".length) ?? 0)
      const next = index + 1 < state.presetPages.length ? `page_${index + 1}` : null
      return Response.json({ items: state.presetPages[index] ?? [], nextCursor: next })
    }
    if (method === "GET" && route === "/presets/pst_1") return Response.json({ preset: PRESET })
    if (method === "POST" && route === "/commands") {
      return Response.json({ result: { type: "task.create", task: { ...TASK, createdFrom: body?.command?.input?.createdFrom ?? null }, parent: null }, replayed: false })
    }
    if (method === "POST" && route === "/tasks/tsk_1/start-preview") return Response.json({ preview: state.preview })
    if (method === "POST" && route === "/tasks/tsk_1/sessions") {
      const presetId = body?.presetId ?? LINK.presetId
      const preset = state.presetPages.flat().find((row) => (row as { id: string }).id === presetId) as { name: string } | undefined
      return Response.json({
        link: { ...LINK, attempt: body?.attempt ?? 1, slot: body?.slot ?? "primary", presetId, presetNameAtStart: preset?.name ?? LINK.presetNameAtStart },
        created: true,
      })
    }
    return Response.json({ error: { code: "not_found", message: `Task ${route} was not found` } }, { status: 404 })
  }
  return { calls, fetch: fetchLike, state }
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
  service?: ReturnType<typeof tasksService>
  operations?: readonly TasksOperation[]
  crossMachineWrites?: boolean
  project?: { id?: string; status?: number }
  grantedProject?: string
}

async function listen(input: MountInput = {}) {
  const audits: Array<Record<string, unknown>> = []
  const localCalls: string[] = []
  const project = input.project ?? { id: "prj_1" }
  const localFetch: ClaxedoFetch = async (path) => {
    localCalls.push(path)
    if (!path.startsWith("/project/current")) return new Response(null, { status: 404 })
    if (project.status) return Response.json({ error: { code: "project_not_found", message: "no project" } }, { status: project.status })
    return Response.json({ id: project.id, label: "Demo" })
  }
  const routes = createClaxedoMcpRoutes({
    mount: "node",
    verifyRuntimeCredential: (token) =>
      token === "rt-token"
        ? { runtimeId: "rt_1", workspaceId: "ws_local", sessionId: "ses_caller", expiresAt: Number.MAX_SAFE_INTEGER }
        : undefined,
    resolveUserCredential: async (request) =>
      request.headers.get("authorization") === "Bearer cli-jwt" ? fullUserCredential({ actorId: "actor_1", clientId: "cli" }) : undefined,
    createClient: () =>
      createClaxedoMcpClient({
        deployment: "node",
        local: { fetch: localFetch, workspace: { workspaceId: "ws_local", directory: "/w" } },
        ...(input.service
          ? {
              tasks: {
                fetch: input.service.fetch,
                operations: input.operations ?? ALL_OPERATIONS,
                ...(input.grantedProject ? { projectId: input.grantedProject } : {}),
              },
            }
          : {}),
      }),
    registerTools: [{ id: "tasks", reach: "account", register: registerTaskTools }],
    audit: (event) => void audits.push(mcpAuditRecord(event)),
    crossMachineWrites: () => input.crossMachineWrites === true,
  })
  mounts.push(routes)
  const app = new Hono().route(CLAXEDO_MCP_PATH, routes.routes)
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { url: `http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}`, audits, localCalls }
}

async function connect(url: string, token = "rt-token") {
  const client = new Client({ name: "fixture-host", version: "0.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  )
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

describe("task_list", () => {
  test("reads the session's own project and returns one row per task", async () => {
    const service = tasksService()
    const { url, localCalls, audits } = await listen({ service })
    const client = await connect(url)

    expect(await json(client, "task_list", { status: "todo" })).toEqual({
      project: "prj_1",
      tasks: [
        {
          id: "tsk_1",
          number: 7,
          title: "Ship the store",
          status: "todo",
          parent: null,
          hasDescription: true,
          sessions: 2,
          subtasks: { total: 1, done: 0 },
          updatedAt: 20,
        },
      ],
      nextCursor: null,
    })
    expect(localCalls).toEqual(["/project/current?workspace=ws_local"])
    expect(service.calls).toEqual([{ method: "GET", path: "/api/claxedo/tasks/tasks?projectId=prj_1&status=todo" }])
    expect(audits).toEqual([{ tool: "task_list", actor: "runtime:rt_1", client: "runtime:rt_1", workspaceId: "ws_local", callerSessionId: "ses_caller" }])
  })

  test("a grant confined to one project answers for it, so no project route is read", async () => {
    const service = tasksService()
    const { url, localCalls } = await listen({ service, grantedProject: "prj_root" })
    const client = await connect(url)

    await json(client, "task_list", {})
    expect(localCalls).toEqual([])
    expect(service.calls).toEqual([{ method: "GET", path: "/api/claxedo/tasks/tasks?projectId=prj_root" }])
  })

  test("refuses a project outside a confined grant without sending it", async () => {
    const service = tasksService()
    const { url } = await listen({ service, grantedProject: "prj_root" })

    expect(await call(await connect(url), "task_list", { project: "prj_other" })).toEqual({
      text: "This session's Tasks grant is confined to project prj_root; it cannot work in prj_other.",
      isError: true,
    })
    expect(service.calls).toEqual([])
  })

  test("a named project is used as given, and the project route is never read", async () => {
    const service = tasksService()
    const { url, localCalls } = await listen({ service })
    const client = await connect(url)

    await json(client, "task_list", { project: "prj_other", limit: 5, cursor: "c1" })
    expect(localCalls).toEqual([])
    expect(service.calls[0]?.path).toBe("/api/claxedo/tasks/tasks?projectId=prj_other&cursor=c1&limit=5")
  })

  test("names the project to work in when this session's workspace has none", async () => {
    const service = tasksService()
    const { url } = await listen({ service, project: { status: 404 } })
    const client = await connect(url)

    const result = await call(client, "task_list")
    expect(result).toEqual({ text: "This session's workspace has no project of its own; name the project to work in.", isError: true })
    expect(service.calls).toEqual([])
  })
})

describe("task_get", () => {
  test("returns the task and every session it has run, with liveness", async () => {
    const service = tasksService({ links: [LINK] })
    const { url } = await listen({ service })
    const client = await connect(url)

    const answer = await json(client, "task_get", { task: "tsk_1" })
    expect(answer.task).toMatchObject({ id: "tsk_1", revision: 3, description: "the whole body" })
    expect(answer.links).toEqual([{ ...LINK }])
    expect(service.calls).toEqual([{ method: "GET", path: "/api/claxedo/tasks/tasks/tsk_1" }])
  })

  test("passes the service's own not-found sentence back", async () => {
    const service = tasksService({ answers: { "GET /tasks/tsk_gone": { status: 404, body: { error: { code: "not_found", message: "Task tsk_gone was not found" } } } } })
    const { url } = await listen({ service })
    const client = await connect(url)

    expect(await call(client, "task_get", { task: "tsk_gone" })).toEqual({ text: "Task tsk_gone was not found", isError: true })
  })

  test("answers a Tasks service it cannot reach with a sentence", async () => {
    const service = tasksService({ throws: "fetch failed" })
    const { url } = await listen({ service })
    const client = await connect(url)

    expect(await call(client, "task_get", { task: "tsk_1" })).toEqual({
      text: "The Tasks service could not be reached from this session: fetch failed.",
      isError: true,
    })
  })
})

describe("task_create", () => {
  test("sends one task.create command carrying the calling session", async () => {
    const service = tasksService()
    const { url, audits } = await listen({ service })
    const client = await connect(url)

    const answer = await json(client, "task_create", {
      title: "Ship the store",
      description: "the whole body",
      status: "backlog",
      parent: "tsk_parent",
      clientRequestId: "req_1",
    })

    expect(service.calls).toEqual([
      {
        method: "POST",
        path: "/api/claxedo/tasks/commands",
        body: {
          clientRequestId: "req_1",
          command: {
            type: "task.create",
            input: {
              projectId: "prj_1",
              title: "Ship the store",
              description: "the whole body",
              workspaceId: null,
              parentTaskId: "tsk_parent",
              status: "backlog",
              createdFrom: { sessionId: "ses_caller", workspaceId: "ws_local" },
            },
          },
        },
      },
    ])
    expect(answer.task).toEqual({
      id: "tsk_1",
      number: 7,
      title: "Ship the store",
      status: "todo",
      parent: null,
      project: "prj_1",
      createdFrom: { sessionId: "ses_caller", workspaceId: "ws_local" },
    })
    expect(audits).toEqual([{ tool: "task_create", actor: "runtime:rt_1", client: "runtime:rt_1", workspaceId: "ws_local", callerSessionId: "ses_caller" }])
  })

  test("mints its own request id and records no session for a person's credential", async () => {
    const service = tasksService()
    const { url } = await listen({ service })
    const client = await connect(url, "cli-jwt")

    await json(client, "task_create", { title: "From the CLI" })
    const [sent] = service.calls
    const body = sent?.body as { clientRequestId: string; command: { input: Record<string, unknown> } }
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.command.input).toEqual({
      projectId: "prj_1",
      title: "From the CLI",
      description: "",
      workspaceId: null,
      parentTaskId: null,
    })
  })

  test("passes a refused create back in the service's own words", async () => {
    const service = tasksService({
      answers: { "POST /commands": { status: 409, body: { error: { code: "conflict", message: "Task tsk_parent already has children a grandchild cannot join" } } } },
    })
    const { url } = await listen({ service })
    const client = await connect(url)

    expect(await call(client, "task_create", { title: "Nope", parent: "tsk_parent" })).toEqual({
      text: "Task tsk_parent already has children a grandchild cannot join",
      isError: true,
    })
  })
})

describe("task_start", () => {
  test("previews the attempt, then starts it with the preview's own digest", async () => {
    const service = tasksService()
    const { url, audits } = await listen({ service, crossMachineWrites: true })
    const client = await connect(url)

    const answer = await json(client, "task_start", { task: "tsk_1", preset: "pst_1", clientRequestId: "req_start" })

    expect(service.calls).toEqual([
      { method: "GET", path: "/api/claxedo/tasks/tasks/tsk_1" },
      { method: "GET", path: "/api/claxedo/tasks/presets/pst_1" },
      {
        method: "POST",
        path: "/api/claxedo/tasks/tasks/tsk_1/start-preview",
        body: { taskRevision: 3, presetId: "pst_1", presetRevision: 2, slot: "primary", attempt: 1, continueFromPrevious: false },
      },
      {
        method: "POST",
        path: "/api/claxedo/tasks/tasks/tsk_1/sessions",
        body: {
          clientRequestId: "req_start",
          taskRevision: 3,
          presetId: "pst_1",
          presetRevision: 2,
          slot: "primary",
          attempt: 1,
          previewDigest: "dgst_1",
          handoffText: null,
          continueFromPrevious: false,
        },
      },
    ])
    expect(answer).toEqual({
      task: { id: "tsk_1", number: 7, title: TASK.title },
      session: { sessionId: "ses_started", workspaceId: "ws_local" },
      slot: "primary",
      attempt: 1,
      preset: { id: "pst_1", name: "Default" },
      placement: "local",
      destination: "this machine, in /w",
      created: true,
    })
    expect(audits).toEqual([
      { tool: "task_start", actor: "runtime:rt_1", client: "runtime:rt_1", workspaceId: "ws_local", callerSessionId: "ses_caller", sessionId: "ses_started" },
    ])
  })

  test("takes the attempt past a slot's dead session, and carries continue through", async () => {
    const service = tasksService({ links: [deadLink(1), deadLink(2)] })
    const { url } = await listen({ service, crossMachineWrites: true })
    const client = await connect(url)

    await json(client, "task_start", { task: "tsk_1", preset: "pst_1", continue: true })
    expect(service.calls[2]?.body).toMatchObject({ attempt: 3, continueFromPrevious: true })
  })

  test("re-requests the attempt a slot's live session already holds", async () => {
    const service = tasksService({ links: [{ ...LINK, attempt: 2, liveness: "live" }] })
    const { url } = await listen({ service, crossMachineWrites: true })
    const client = await connect(url)

    await json(client, "task_start", { task: "tsk_1", preset: "pst_1" })
    expect(service.calls[2]?.body).toMatchObject({ attempt: 2 })
  })

  test("takes the account's only preset, and names them all when there is more than one", async () => {
    const one = tasksService()
    const first = await listen({ service: one, crossMachineWrites: true })
    await json(await connect(first.url), "task_start", { task: "tsk_1" })
    expect(one.calls[1]).toEqual({ method: "GET", path: "/api/claxedo/tasks/presets" })

    const many = tasksService({ presetPages: [[PRESET, { ...PRESET, id: "pst_2", name: "Cloud" }]] })
    const second = await listen({ service: many, crossMachineWrites: true })
    expect(await call(await connect(second.url), "task_start", { task: "tsk_1" })).toEqual({
      text: "Name the preset to start on: pst_1 (Default), pst_2 (Cloud).",
      isError: true,
    })
    expect(many.calls.some((sent) => sent.path.includes("start-preview"))).toBe(false)
  })

  test("returns a preview blocker verbatim and sends no start", async () => {
    const service = tasksService({
      preview: {
        ...PREVIEW,
        available: false,
        blockers: [{ code: "harness_unavailable", detail: "Claude Code is not installed on this machine." }],
      },
    })
    const { url } = await listen({ service, crossMachineWrites: true })
    const client = await connect(url)

    expect(await call(client, "task_start", { task: "tsk_1", preset: "pst_1" })).toEqual({
      text: "Claude Code is not installed on this machine.",
      isError: true,
    })
    expect(service.calls.some((sent) => sent.path.endsWith("/sessions"))).toBe(false)
  })

  test("a blocker beside an available preview still stops the start", async () => {
    const service = tasksService({
      preview: { ...PREVIEW, available: true, blockers: [{ code: "model_unavailable", detail: "claude-sonnet is not configured here." }] },
    })
    const { url } = await listen({ service, crossMachineWrites: true })

    expect(await call(await connect(url), "task_start", { task: "tsk_1", preset: "pst_1" })).toEqual({
      text: "claude-sonnet is not configured here.",
      isError: true,
    })
    expect(service.calls.some((sent) => sent.path.endsWith("/sessions"))).toBe(false)
  })

  // The grant is the one gate: whoever minted it applied the account's
  // cross-machine setting when deciding whether `start` is in it, so a session
  // holding a grant with `start` is not asked the question a second time.
  test("a session whose grant carries start starts a task without the cross-machine setting", async () => {
    const service = tasksService()
    const { url, audits } = await listen({ service })
    const client = await connect(url)

    expect((await json(client, "task_start", { task: "tsk_1", preset: "pst_1" })).session).toEqual({ sessionId: "ses_started", workspaceId: "ws_local" })
    expect(audits).toEqual([
      { tool: "task_start", actor: "runtime:rt_1", client: "runtime:rt_1", workspaceId: "ws_local", callerSessionId: "ses_caller", sessionId: "ses_started" },
    ])
  })

  test("resolves a preset by its name when the id is not one the routes know", async () => {
    const service = tasksService()
    const { url } = await listen({ service })
    const client = await connect(url)

    const answer = await json(client, "task_start", { task: "tsk_1", preset: "default" })
    expect(answer.preset).toEqual({ id: "pst_1", name: "Default" })
    expect(service.calls.map((sent) => sent.path)).toEqual([
      "/api/claxedo/tasks/tasks/tsk_1",
      "/api/claxedo/tasks/presets/default",
      "/api/claxedo/tasks/presets",
      "/api/claxedo/tasks/tasks/tsk_1/start-preview",
      "/api/claxedo/tasks/tasks/tsk_1/sessions",
    ])
  })

  test("names every preset when the one asked for exists under neither id nor name", async () => {
    const service = tasksService()
    const { url } = await listen({ service })
    const client = await connect(url)

    expect(await call(client, "task_start", { task: "tsk_1", preset: "Nope" })).toEqual({
      text: "No preset is named Nope. The presets are: pst_1 (Default).",
      isError: true,
    })
    expect(service.calls.some((sent) => sent.path.endsWith("/sessions"))).toBe(false)
  })

  test("follows the catalog's cursor to a preset named on a later page", async () => {
    const service = tasksService({ presetPages: [[PRESET], [{ ...PRESET, id: "pst_2", name: "Cloud" }]] })
    const { url } = await listen({ service })
    const client = await connect(url)

    const answer = await json(client, "task_start", { task: "tsk_1", preset: "cloud" })
    expect(answer.preset).toEqual({ id: "pst_2", name: "Cloud" })
    expect(service.calls.map((sent) => sent.path)).toEqual([
      "/api/claxedo/tasks/tasks/tsk_1",
      "/api/claxedo/tasks/presets/cloud",
      "/api/claxedo/tasks/presets",
      "/api/claxedo/tasks/presets?cursor=page_1",
      "/api/claxedo/tasks/tasks/tsk_1/start-preview",
      "/api/claxedo/tasks/tasks/tsk_1/sessions",
    ])
    expect(service.calls[4]?.body).toMatchObject({ presetId: "pst_2" })
  })

  test("exhausts every page before refusing, and the refusal lists them all", async () => {
    const service = tasksService({ presetPages: [[PRESET], [{ ...PRESET, id: "pst_2", name: "Cloud" }]] })
    const { url } = await listen({ service })
    const client = await connect(url)

    expect(await call(client, "task_start", { task: "tsk_1", preset: "Nope" })).toEqual({
      text: "No preset is named Nope. The presets are: pst_1 (Default), pst_2 (Cloud).",
      isError: true,
    })
    expect(service.calls.map((sent) => sent.path).filter((path) => path.includes("/presets?"))).toEqual([
      "/api/claxedo/tasks/presets?cursor=page_1",
    ])
    expect(service.calls.some((sent) => sent.path.endsWith("/sessions"))).toBe(false)
  })

  test("a person's credential starts a task without the cross-machine setting", async () => {
    const service = tasksService()
    const { url } = await listen({ service })
    const client = await connect(url, "cli-jwt")

    expect((await json(client, "task_start", { task: "tsk_1", preset: "pst_1" })).session).toEqual({ sessionId: "ses_started", workspaceId: "ws_local" })
  })
})

describe("the Tasks grant", () => {
  const listed = async (input: MountInput) => {
    const { url } = await listen(input)
    const client = await connect(url)
    return (await client.listTools()).tools.map((tool) => tool.name).toSorted()
  }

  test("lists every tool the granted operations cover", async () => {
    expect(await listed({ service: tasksService() })).toEqual(["task_create", "task_get", "task_list", "task_start"])
  })

  test("omits the tool whose operation the grant lacks", async () => {
    expect(await listed({ service: tasksService(), operations: ["read"] })).toEqual(["task_get", "task_list"])
    expect(await listed({ service: tasksService(), operations: ["read", "create"] })).toEqual(["task_create", "task_get", "task_list"])
    expect(await listed({ service: tasksService(), operations: ["start"] })).toEqual(["task_start"])
  })

  test("omits all of them where the deployment serves no Tasks", async () => {
    expect(await listed({})).toEqual([])
  })
})

describe("the handler-side operation check", () => {
  const credential: McpCredential = {
    kind: "runtime",
    runtimeId: "rt_1",
    workspaceId: "ws_local",
    sessionId: "ses_caller",
    crossMachineWrites: true,
    readOnly: false,
  }
  const access: McpToolAccess = { audiences: ["runtime", "user"], write: true, scope: "act", operation: "start" }

  test("refuses an operation the grant does not carry, whatever tools/list showed", () => {
    expect(() => assertToolAccess(credential, "task_start", access, ["read", "create"])).toThrow(McpAccessDenied)
    expect(() => assertToolAccess(credential, "task_start", access, ["read", "create"]))
      .toThrow("task_start needs the start Tasks operation, which this session was not granted")
  })

  test("refuses every Tasks tool where there is no grant at all", () => {
    expect(() => assertToolAccess(credential, "task_list", { ...access, write: false, scope: "read", operation: "read" }))
      .toThrow("task_list needs the Tasks service, which this Claxedo deployment does not serve")
  })

  test("lets a granted operation through", () => {
    expect(() => assertToolAccess(credential, "task_start", access, ALL_OPERATIONS)).not.toThrow()
  })
})
