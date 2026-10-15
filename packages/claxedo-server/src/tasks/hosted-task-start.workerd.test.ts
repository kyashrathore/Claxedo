import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { applyControlPlaneBaseline } from "../test-support/control-plane-migrations"
import { hostedWorkerCompatibility, wranglerBundle } from "../test-support/hosted-worker-bundle"
import { startOriginId } from "@claxedo/tasks"
import { originCloudWorkspaceId } from "../workspace/origin-cloud-workspace"

const FIXTURE_WORKER = fileURLToPath(new URL("./fixtures/hosted-task-start-worker.fixture.ts", import.meta.url))
const ORIGIN = "https://core.test"
const TASKS = `${ORIGIN}/api/claxedo/tasks`
const REPO = "https://github.com/acme/importer.git"

type RuntimeSession = { id: string; title?: string; instructions: string; time: { created: number; updated: number }; messages: string[] }

let miniflare: Miniflare
const sessions = new Map<string, RuntimeSession>()
const runtimeRequests: string[] = []

/**
 * The workspace runtime behind the relay, as much of it as a Start reads: its
 * capabilities, the session create, and the reads that follow. A create that
 * carries a reservation registers the session with the control plane before it
 * answers, which is what the real runtime's session routes do.
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
    const body = (await request.json()) as { id: string; title?: string; instructions?: string }
    const session = { id: body.id, ...(body.title ? { title: body.title } : {}), instructions: body.instructions ?? "", time: { created: 10, updated: 10 }, messages: [] }
    const operationId = request.headers.get("x-claxedo-session-registration-operation")
    if (operationId) {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      const registered = await miniflare.dispatchFetch(`${ORIGIN}/__register`, {
        method: "POST",
        body: JSON.stringify({ token, operationId, sessionId: body.id, createdAt: 10, updatedAt: 10, ...(body.title ? { title: body.title } : {}) }),
      })
      if (!registered.ok) return Response.json({ error: { code: "registration_denied", message: await registered.text() } }, { status: 403 })
    }
    sessions.set(body.id, session)
    return Response.json({ id: session.id, title: session.title, time: session.time, directory: "/workspace" }, { status: 201 })
  }
  const session = /^\/session\/([^/]+)(\/message|\/config|\/prompt_async)?$/.exec(path)
  const row = session ? sessions.get(decodeURIComponent(session[1])) : undefined
  if (session && !row) return Response.json({ error: { code: "not_found" } }, { status: 404 })
  if (row && session?.[2] === "/prompt_async") {
    row.messages.push(((await request.json()) as { messageID: string }).messageID)
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

beforeAll(async () => {
  miniflare = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.js", contents: wranglerBundle(FIXTURE_WORKER) }],
    d1Databases: ["CONTROL_PLANE_DB"],
    outboundService: runtime,
  })
  await applyControlPlaneBaseline((await miniflare.getD1Database("CONTROL_PLANE_DB")) as unknown as D1Database)
}, 180_000)

afterAll(async () => {
  await miniflare?.dispose()
})

async function post<T>(url: string, subject: string | undefined, body: unknown): Promise<{ status: number; body: T }> {
  const response = await miniflare.dispatchFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(subject ? { authorization: `Bearer ${subject}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as T }
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
  const response = await post<{ result: T }>(`${TASKS}/commands`, subject, { clientRequestId, command: body })
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
  const response = await post<{ userId: string }>(`${ORIGIN}/__person`, undefined, { subject })
  expect(response.status).toBe(200)
}

async function project(subject: string, workspaceId: string) {
  const response = await post<{ projectId: string; orgId: string }>(`${ORIGIN}/__workspace`, undefined, { subject, workspaceId, repoUrl: REPO, gitBranch: "main" })
  expect(response.status).toBe(200)
  return response.body
}

async function cloudPreset(subject: string, name: string) {
  const result = await command<{ preset: { id: string } }>(subject, `preset-${name}`, {
    type: "preset.create",
    input: {
      name,
      instructions: "Read before you write.",
      execution: { placement: "cloud", capabilities: { mode: "selected", plugins: [], skills: [] } },
      agentStartable: false,
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

async function start(subject: string, taskId: string, presetId: string, attempt = 1) {
  const preview = await post<Preview>(`${TASKS}/tasks/${taskId}/start-preview`, subject, startBody(presetId, attempt))
  expect(preview.status).toBe(200)
  if (!preview.body.preview.available) return { preview: preview.body.preview, started: undefined }
  const started = await post<Started>(`${TASKS}/tasks/${taskId}/sessions`, subject, {
    ...startBody(presetId, attempt),
    clientRequestId: `start-${taskId}-${attempt}`,
    previewDigest: preview.body.preview.digest,
    handoffText: null,
  })
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
      blockers: [{ code: "source_unavailable", detail: expect.stringContaining("could not be provisioned") }],
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
    const refused = await post<Preview>(`${TASKS}/tasks/${taskId}/start-preview`, "mallory", startBody(presetId))
    expect(refused.status).not.toBe(200)
  })
})

