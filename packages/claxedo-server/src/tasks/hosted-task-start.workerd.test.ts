import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { applyControlPlaneBaseline } from "../test-support/control-plane-migrations"
import { hostedWorkerCompatibility, wranglerBundle } from "../test-support/hosted-worker-bundle"
import { startOriginId } from "@claxedo/tasks"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { originCloudWorkspaceId } from "../workspace/origin-cloud-workspace"
import { mintTasksCapability } from "./capability"

const FIXTURE_WORKER = fileURLToPath(new URL("../test-support/hosted-task-start-worker.ts", import.meta.url))
const ORIGIN = "https://core.test"
const TASKS = `${ORIGIN}/api/claxedo/tasks`
const REPO = "https://github.com/acme/importer.git"

type RuntimeSession = { id: string; title?: string; instructions: string; time: { created: number; updated: number }; messages: string[] }

let miniflare: Miniflare
const sessions = new Map<string, RuntimeSession>()
const runtimeRequests: string[] = []
let heldCreate: { arrived: () => void; released: Promise<void> } | undefined

const bearerOf = (request: Request) => (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")

const control = (path: string, body: unknown) =>
  miniflare.dispatchFetch(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) })

/**
 * The workspace runtime behind the relay, as much of it as a Start reads: its
 * capabilities, the session create, and the reads that follow. As the real
 * runtime's session routes do, a create that carries a reservation registers
 * the session with the control plane before it answers, every session route
 * asks the control plane whether the token's actor may use that session, and a
 * human turn lands in the session's published row.
 */
async function runtime(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const match = /^\/workspaces\/([^/]+)(\/.*)$/.exec(url.pathname)
  if (url.host !== "relay.test" || !match) return new Response(`unexpected outbound ${request.url}`, { status: 599 })
  const path = match[2]
  runtimeRequests.push(`${request.method} ${path}`)
  if (path === "/session/capabilities") {
    return Response.json({
      harness: "codex",
      modelSelection: { status: "optional", models: [{ providerId: "openai", modelId: "gpt-5", name: "GPT-5" }] },
    })
  }
  if (path === "/session" && request.method === "POST") {
    const held = heldCreate
    heldCreate = undefined
    held?.arrived()
    await held?.released
    const body = (await request.json()) as { id: string; title?: string; instructions?: string }
    const session = { id: body.id, ...(body.title ? { title: body.title } : {}), instructions: body.instructions ?? "", time: { created: 10, updated: 10 }, messages: [] }
    const operationId = request.headers.get("x-claxedo-session-registration-operation")
    if (operationId) {
      const registered = await control("/__register", {
        token: bearerOf(request),
        operationId,
        sessionId: body.id,
        createdAt: 10,
        updatedAt: 10,
        ...(body.title ? { title: body.title } : {}),
      })
      if (!registered.ok) return Response.json({ error: { code: "registration_denied", message: await registered.text() } }, { status: 403 })
    }
    sessions.set(body.id, session)
    return Response.json({ id: session.id, title: session.title, time: session.time, directory: "/workspace" }, { status: 201 })
  }
  const session = /^\/session\/([^/]+)(\/message|\/config|\/prompt_async)?$/.exec(path)
  const row = session ? sessions.get(decodeURIComponent(session[1])) : undefined
  if (session && !row) return Response.json({ error: { code: "not_found" } }, { status: 404 })
  if (row) {
    const authorized = await control("/__authorize", {
      token: bearerOf(request),
      sessionId: row.id,
      action: request.method === "GET" ? "read" : "write",
    })
    if (!authorized.ok) return Response.json({ error: { code: "session_authorization_denied", message: await authorized.text() } }, { status: 403 })
  }
  if (row && request.method === "DELETE" && !session?.[2]) {
    sessions.delete(row.id)
    return Response.json({ ok: true })
  }
  if (row && session?.[2] === "/prompt_async") {
    row.messages.push(((await request.json()) as { messageID: string }).messageID)
    const published = await control("/__human-turn", { sessionId: row.id })
    if (!published.ok) return new Response(await published.text(), { status: 500 })
    return new Response(null, { status: 204 })
  }
  if (row && session?.[2] === "/message") {
    return Response.json(row.messages.map((id) => ({ info: { id, role: "user", time: { created: 11 } }, parts: [] })))
  }
  if (row && session?.[2] === "/config") {
    return Response.json({
      harness: { id: "codex", access: "native" },
      model: { providerID: "openai", modelID: "gpt-5" },
      variant: null,
      instructions: row.instructions,
    })
  }
  if (row) return Response.json({ id: row.id, time: row.time })
  return Response.json({ error: { code: "unexpected", message: path } }, { status: 500 })
}

let signingEnv: Record<string, string>

beforeAll(async () => {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  signingEnv = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  miniflare = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: wranglerBundle(FIXTURE_WORKER) }],
    d1Databases: ["CONTROL_PLANE_DB"],
    bindings: signingEnv,
    outboundService: runtime,
  })
  await applyControlPlaneBaseline((await miniflare.getD1Database("CONTROL_PLANE_DB")) as unknown as D1Database)
}, 180_000)

afterAll(async () => {
  await miniflare?.dispose()
})

async function post(url: string, subject: string | undefined, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await miniflare.dispatchFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(subject ? { authorization: `Bearer ${subject}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function get<T>(url: string, subject: string): Promise<T> {
  return (await (await miniflare.dispatchFetch(url, { headers: { authorization: `Bearer ${subject}` } })).json()) as T
}

type Rows = {
  workspaces: Array<{ workspace_id: string; project_id: string; backing: string; display_name: string; repo_url: string | null; git_branch: string | null; deleted_at: number | null }>
  sessions: Array<{ session_id: string; workspace_id: string; project_id: string; deleted_at: number | null }>
  links: Array<{ task_id: string; slot: string; attempt: number; session_id: string; session_workspace_id: string; placement: string }>
  leases: Array<{ workspace_id: string; status: string }>
}

const rows = async () => (await (await miniflare.dispatchFetch(`${ORIGIN}/__rows`)).json()) as Rows

async function command<T>(subject: string, clientRequestId: string, body: Record<string, unknown>) {
  const response = (await post(`${TASKS}/commands`, subject, { clientRequestId, command: body }) as { status: number; body: { result: T } })
  expect(response.status).toBe(200)
  return response.body.result
}

const startBody = (presetId: string, attempt = 1) => ({
  taskRevision: 1,
  presetId,
  presetRevision: 1,
  slot: "primary",
  attempt,
  continueFromPrevious: false,
})

type Preview = { preview: { digest: string; available: boolean; blockers: Array<{ code: string; detail: string }>; placement: string } }
type Started = { created: boolean; link: { sessionRef: { sessionId: string; workspaceId: string } } }

async function person(subject: string) {
  const response = (await post(`${ORIGIN}/__person`, undefined, { subject }) as { status: number; body: { userId: string } })
  expect(response.status).toBe(200)
  return response.body.userId
}

async function project(subject: string, workspaceId: string) {
  const response = (await post(`${ORIGIN}/__workspace`, undefined, { subject, workspaceId, repoUrl: REPO, gitBranch: "main" }) as { status: number; body: { projectId: string; orgId: string } })
  expect(response.status).toBe(200)
  return response.body
}

async function cloudPreset(subject: string, name: string, agentStartable = false) {
  const result = await command<{ preset: { id: string } }>(subject, `preset-${name}`, {
    type: "preset.create",
    input: {
      name,
      instructions: "Read before you write.",
      execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } },
      agentStartable,
      configurations: {
        primary: { harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5" }, effort: null },
      },
    },
  })
  return result.preset.id
}

async function task(subject: string, projectId: string, title: string) {
  const result = await command<{ task: { id: string } }>(subject, `task-${title}`, {
    type: "task.create",
    input: { projectId, title, description: "", workspaceId: null, parentTaskId: null },
  })
  return result.task.id
}

async function start(subject: string, taskId: string, presetId: string, attempt = 1, from: Record<string, unknown> = {}) {
  const preview = (await post(`${TASKS}/tasks/${taskId}/start-preview`, subject, { ...startBody(presetId, attempt), ...from }) as { status: number; body: Preview })
  expect(preview.status).toBe(200)
  if (!preview.body.preview.available) return { preview: preview.body.preview, started: undefined }
  const started = (await post(`${TASKS}/tasks/${taskId}/sessions`, subject, {
    ...startBody(presetId, attempt),
    ...from,
    clientRequestId: `start-${taskId}-${attempt}`,
    previewDigest: preview.body.preview.digest,
    handoffText: null,
  }) as { status: number; body: Started })
  return { preview: preview.body.preview, started }
}

describe("a hosted cloud task start on workerd", () => {
  test("creates the task's own cloud root in D1, registers its session there and records the link", async () => {
    await person("alice")
    const { projectId } = await project("alice", "ws_alice_main")
    const presetId = await cloudPreset("alice", "Isolated review")
    const taskId = await task("alice", projectId, "Ship the importer")

    const { preview, started } = await start("alice", taskId, presetId)
    expect(preview).toMatchObject({ available: true, blockers: [], placement: "cloud" })
    expect(started).toMatchObject({ status: 200, body: { created: true } })
    const root = started!.body.link.sessionRef.workspaceId
    const sessionId = started!.body.link.sessionRef.sessionId
    expect(root).toMatch(/^ws_[0-9a-f]{24}$/)

    const stored = await rows()
    expect(stored.workspaces.find((row) => row.workspace_id === root)).toMatchObject({
      project_id: projectId,
      backing: "cloud-vm",
      display_name: "Ship the importer (primary, attempt 1)",
      repo_url: REPO,
      git_branch: "main",
      deleted_at: null,
    })
    expect(stored.sessions).toContainEqual(expect.objectContaining({ session_id: sessionId, workspace_id: root, project_id: projectId, deleted_at: null }))
    expect(stored.links).toEqual([
      { task_id: taskId, slot: "primary", attempt: 1, session_id: sessionId, session_workspace_id: root, placement: "cloud" },
    ])
    expect(stored.leases).toContainEqual({ workspace_id: root, status: "ready" })
    expect(runtimeRequests).toContain("POST /session")

    const detail = await get<{ links: Array<{ liveness: string; sessionRef: { sessionId: string } }> }>(`${TASKS}/tasks/${taskId}`, "alice")
    expect(detail.links).toMatchObject([{ liveness: "live", sessionRef: { sessionId } }])
  })

  test("a started task's link reads live and sent from its session's row, and reading it never wakes the stopped sandbox", async () => {
    await person("erin")
    const { projectId } = await project("erin", "ws_erin_main")
    const presetId = await cloudPreset("erin", "Erin review")
    const taskId = await task("erin", projectId, "Erin's task")
    const { started } = await start("erin", taskId, presetId)
    expect(started).toMatchObject({ status: 200 })
    const root = started!.body.link.sessionRef.workspaceId
    const sessionId = started!.body.link.sessionRef.sessionId

    expect(await post(`${ORIGIN}/__stop`, undefined, { workspaceId: root })).toMatchObject({ status: 200, body: { ok: true, status: "stopped" } })
    const ensures = async () => ((await (await miniflare.dispatchFetch(`${ORIGIN}/__ensures`)).json()) as { ensures: number }).ensures
    const before = await ensures()
    const reads = runtimeRequests.length

    const detail = await get<{ links: Array<{ liveness: string; handoff: string; sessionRef: { sessionId: string } }> }>(`${TASKS}/tasks/${taskId}`, "erin")
    expect(detail.links).toMatchObject([{ liveness: "live", handoff: "sent", sessionRef: { sessionId } }])
    expect(await ensures()).toBe(before)
    expect(runtimeRequests.slice(reads)).toEqual([])
  })

  test("a root's agent starts a cloud task with its grant, and the session it creates is registered as the root's owner", async () => {
    const userId = await person("gina")
    const { projectId, orgId } = await project("gina", "ws_gina_main")
    const presetId = await cloudPreset("gina", "Gina agents", true)
    const { started } = await start("gina", await task("gina", projectId, "Gina's first task"), presetId)
    expect(started).toMatchObject({ status: 200 })
    const root = started!.body.link.sessionRef
    const { token } = await mintTasksCapability(
      { userId, orgId, projectId, workspaceId: root.workspaceId, operations: ["read", "create", "start"] },
      signingEnv,
    )

    const created = (await post(`${TASKS}/commands`, token, {
      clientRequestId: "gina-agent-task",
      command: {
        type: "task.create",
        input: { projectId, title: "Gina's agent task", description: "", workspaceId: null, parentTaskId: null, createdFrom: root },
      },
    }) as { status: number; body: { result: { task: { id: string } } } })
    expect(created.status).toBe(200)
    const hop = await start(token, created.body.result.task.id, presetId, 1, { startedFrom: root })
    expect(hop.preview).toMatchObject({ available: true, blockers: [] })
    expect(hop.started).toMatchObject({ status: 200, body: { created: true } })
    const session = hop.started!.body.link.sessionRef
    expect((await rows()).sessions).toContainEqual(expect.objectContaining({ session_id: session.sessionId, workspace_id: session.workspaceId, deleted_at: null }))
  })

  test("a task with no workspace preference starts in the person's own workspace of its project, not in a task's cloud root", async () => {
    await person("dana")
    const { projectId } = await project("dana", "ws_dana_main")
    const cloud = await cloudPreset("dana", "Dana cloud")
    expect((await start("dana", await task("dana", projectId, "Dana cloud task"), cloud)).started).toMatchObject({ status: 200 })

    const local = await command<{ preset: { id: string } }>("dana", "preset-dana-local", {
      type: "preset.create",
      input: {
        name: "Dana local",
        instructions: "",
        execution: { placement: "local", capabilities: { mode: "inherit-local" } },
        agentStartable: false,
        configurations: {
          primary: { harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5" }, effort: null },
        },
      },
    })
    const { preview, started } = await start("dana", await task("dana", projectId, "Dana local task"), local.preset.id)
    expect(preview).toMatchObject({ available: true, blockers: [], placement: "local" })
    expect(started?.body.link.sessionRef.workspaceId).toBe("ws_dana_main")
  })

  test("a Start the browser sends again while the first is still creating answers both with one link, one session and one root", async () => {
    await person("frank")
    const { projectId } = await project("frank", "ws_frank_main")
    const presetId = await cloudPreset("frank", "Frank review")
    const taskId = await task("frank", projectId, "Frank's task")
    const preview = (await post(`${TASKS}/tasks/${taskId}/start-preview`, "frank", startBody(presetId)) as { status: number; body: Preview })
    expect(preview.body.preview).toMatchObject({ available: true })
    const request = { ...startBody(presetId), clientRequestId: "start-frank-once", previewDigest: preview.body.preview.digest, handoffText: null }
    const creates = () => runtimeRequests.filter((entry) => entry === "POST /session").length
    const before = creates()
    let release!: () => void
    const arrived = new Promise<void>((resolve) => {
      heldCreate = { arrived: resolve, released: new Promise<void>((done) => { release = done }) }
    })

    const first = post(`${TASKS}/tasks/${taskId}/sessions`, "frank", request)
    await arrived
    const resent = post(`${TASKS}/tasks/${taskId}/sessions`, "frank", request)
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const [created, replayed] = (await Promise.all([first, resent])) as [{ status: number; body: Started }, { status: number; body: Started }]

    expect([created.status, replayed.status]).toEqual([200, 200])
    const link = created.body.link.sessionRef
    expect(replayed.body.link.sessionRef).toEqual(link)
    expect(creates()).toBe(before + 1)
    const stored = await rows()
    expect(stored.links.filter((row) => row.task_id === taskId)).toEqual([
      { task_id: taskId, slot: "primary", attempt: 1, session_id: link.sessionId, session_workspace_id: link.workspaceId, placement: "cloud" },
    ])
    expect(stored.sessions.filter((row) => row.workspace_id === link.workspaceId)).toHaveLength(1)
    expect(stored.workspaces.filter((row) => row.display_name === "Frank's task (primary, attempt 1)")).toHaveLength(1)
    expect(new Set(sessions.get(link.sessionId)?.messages)).toHaveProperty("size", 1)
  })

  test("a Start the browser sends again after the first one answered is answered with that session, not refused as stale", async () => {
    await person("hana")
    const { projectId } = await project("hana", "ws_hana_main")
    const presetId = await cloudPreset("hana", "Hana review")
    const taskId = await task("hana", projectId, "Hana's task")
    const preview = (await post(`${TASKS}/tasks/${taskId}/start-preview`, "hana", startBody(presetId)) as { status: number; body: Preview })
    const request = { ...startBody(presetId), clientRequestId: "start-hana-once", previewDigest: preview.body.preview.digest, handoffText: null }
    const creates = () => runtimeRequests.filter((entry) => entry === "POST /session").length
    const before = creates()

    const created = (await post(`${TASKS}/tasks/${taskId}/sessions`, "hana", request)) as { status: number; body: Started }
    const replayed = (await post(`${TASKS}/tasks/${taskId}/sessions`, "hana", request)) as { status: number; body: Started }

    expect(created).toMatchObject({ status: 200, body: { created: true } })
    expect(replayed).toMatchObject({ status: 200, body: { created: false, link: { sessionRef: created.body.link.sessionRef } } })
    expect(creates()).toBe(before + 1)
    expect((await rows()).links.filter((row) => row.task_id === taskId)).toHaveLength(1)
    expect(sessions.get(created.body.link.sessionRef.sessionId)?.messages).toHaveLength(1)
  })

  test("a root whose sandbox failed to provision is started again by the same attempt", async () => {
    await person("bob")
    const { projectId, orgId } = await project("bob", "ws_bob_main")
    const presetId = await cloudPreset("bob", "Bob review")
    const taskId = await task("bob", projectId, "Retry the importer")
    const root = await originCloudWorkspaceId(startOriginId(orgId, taskId, "primary", 1))
    expect((await post(`${ORIGIN}/__fail-provision`, undefined, { workspaceId: root })).status).toBe(200)

    const failed = await start("bob", taskId, presetId)
    expect(failed.preview).toMatchObject({
      available: false,
      blockers: [{ code: "source_unavailable", detail: expect.stringContaining("The cloud workspace could not start: ") }],
    })

    const retried = await start("bob", taskId, presetId)
    expect(retried.preview).toMatchObject({ available: true, blockers: [] })
    expect(retried.started).toMatchObject({ status: 200, body: { created: true, link: { sessionRef: { workspaceId: root } } } })
  })

  test("another person cannot start a session in someone else's task root", async () => {
    await person("carol")
    const { projectId } = await project("carol", "ws_carol_main")
    const presetId = await cloudPreset("carol", "Carol review")
    const taskId = await task("carol", projectId, "Carol's task")
    const { started } = await start("carol", taskId, presetId)
    expect(started).toMatchObject({ status: 200 })

    await person("mallory")
    const refused = (await post(`${TASKS}/tasks/${taskId}/start-preview`, "mallory", startBody(presetId)) as { status: number; body: Preview })
    expect(refused.status).not.toBe(200)
  })
})

