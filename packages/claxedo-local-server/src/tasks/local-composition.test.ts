/**
 * Tasks through the real desktop-local app, not through a bare Hono holding
 * the contribution: the loopback gate, the route mount and the SQLite store
 * are all part of what a request has to get through, and mounting the routes
 * alone would prove none of them.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { mountControlPlaneRouteContributions } from "@claxedo/server-core/platform/http/route-contribution"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { createLocalApp, type LocalAppOptions } from "../app/local-app"
import { testDaemon } from "../app/test-support/daemon"
import { createLocalTasksComposition, type LocalTasksComposition } from "./local-composition"

const LOOPBACK = "http://127.0.0.1:4096"
const TASKS = "/api/claxedo/tasks"

let dataDir: string
const workspaceDirs: string[] = []
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-local-tasks-"))
  for (const key of ["CLAXEDO_DATA_DIR", "CLAXEDO_DEPLOYMENT_MODE", "CLAXEDO_SIGNED_CLOUD_AUTH"]) saved[key] = process.env[key]
  process.env.CLAXEDO_DATA_DIR = dataDir
  delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
})

afterEach(() => {
  ClaxedoDB.close()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const directory of workspaceDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

function services() {
  return {
    auth: localOnlyAuthAdapter(),
    credentials: {
      listCredentials: async () => [],
      getCredentialByProvider: async () => undefined,
      putCredential: async () => ({ id: "cred_1" }),
      deleteCredential: async () => true,
      deleteCredentialsByProvider: async () => 0,
      updateCredentialStatus: async () => {},
      syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    },
    localExecution: { enabled: true },
    telemetry: { capture: vi.fn() },
    projectionStore: {
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      list_session_metas: vi.fn(async () => []),
      list_session_navigation_metas: vi.fn(async () => []),
    },
    relay: {},
    sandbox: {},
    durableSessionLog: {},
  } as unknown as LocalAppOptions["services"]
}

/**
 * The composition behind the real local app, reached as the application that
 * owns this daemon. Every request below carries the daemon capability, which
 * is what the person at this machine is admitted by; what a request adds to it
 * is the only thing that makes it a session's.
 */
function app(composition: LocalTasksComposition = createLocalTasksComposition()) {
  const identity = testDaemon()
  const instance = createLocalApp({
    services: services(),
    daemon: identity.daemon,
    routeContributions: composition.routeContributions,
  }).app
  return {
    composition,
    request: (url: string, init: RequestInit = {}) =>
      instance.request(url, {
        ...init,
        headers: { ...identity.capability, ...Object.fromEntries(new Headers(init.headers)) },
      }),
  }
}

/** A workspace row of this machine's own, which is where a grant reads its owner and project from. */
async function localWorkspace() {
  const directory = mkdtempSync(path.join(tmpdir(), "claxedo-local-tasks-ws-"))
  workspaceDirs.push(directory)
  const git = (args: readonly string[]) => execFileSync("git", [...args], { cwd: directory, stdio: "pipe" })
  git(["init", "-b", "main"])
  git(["config", "user.email", "fixture@example.com"])
  git(["config", "user.name", "Fixture"])
  const workspace = await ensureWorkspace({ directory })
  if (!workspace) throw new Error("the workspace store stored no row for the fixture directory")
  return { id: workspace.id, project: workspace.project_id ?? workspace.id }
}

async function command(target: ReturnType<typeof app>, clientRequestId: string, body: Record<string, unknown>) {
  const response = await target.request(`${LOOPBACK}${TASKS}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId, command: body }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const PRESET = {
  type: "preset.create",
  input: {
    name: "Review the diff",
    instructions: "Read the change before proposing one.",
    execution: { placement: "local", capabilities: { mode: "inherit-local" } },
    agentStartable: false,
    configurations: {
      primary: {
        harness: { id: "claude", access: "native" },
        model: { providerID: "anthropic", modelID: "sonnet" },
        effort: null,
      },
    },
  },
}

describe("desktop-local Tasks composition", () => {
  test("answers its capabilities over the loopback app", async () => {
    const response = await app().request(`${LOOPBACK}${TASKS}/capabilities`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      protocolVersion: 1,
      placements: ["local"],
      cloudSelectedCapabilities: false,
    })
  })

  test("commits a preset and a task, and replays a repeated client request id", async () => {
    const target = app()

    const preset = await command(target, "request-preset-1", PRESET)
    expect(preset.status).toBe(200)
    expect(preset.body).toMatchObject({
      replayed: false,
      result: { type: "preset.create", preset: { name: "Review the diff", revision: 1, scopeId: "local", ownerId: "local" } },
    })

    const task = await command(target, "request-task-1", {
      type: "task.create",
      input: { projectId: "project-a", title: "Ship the store", description: "", workspaceId: null, parentTaskId: null },
    })
    expect(task.status).toBe(200)
    expect(task.body).toMatchObject({
      replayed: false,
      result: { type: "task.create", task: { title: "Ship the store", status: "todo", projectId: "project-a" } },
    })

    const again = await command(target, "request-task-1", {
      type: "task.create",
      input: { projectId: "project-a", title: "Ship the store", description: "", workspaceId: null, parentTaskId: null },
    })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ replayed: true })

    const listed = await target.request(`${LOOPBACK}${TASKS}/tasks?projectId=project-a`)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ items: [{ title: "Ship the store", number: 1, childNumber: null }] })
  })

  test("a subtask is filed under its parent's number and read back that way", async () => {
    const target = app()
    const parent = await command(target, "request-parent", {
      type: "task.create",
      input: { projectId: "project-a", title: "Parent", description: "", workspaceId: null, parentTaskId: null },
    })
    const parentId = (parent.body as { result: { task: { id: string } } }).result.task.id

    const child = await command(target, "request-child", {
      type: "task.create",
      input: { projectId: "project-a", title: "Child", description: "", workspaceId: null, parentTaskId: parentId },
    })
    expect(child.status).toBe(200)
    expect(child.body).toMatchObject({ result: { task: { title: "Child", number: 1, childNumber: 1, parentTaskId: parentId } } })

    const children = await target.request(`${LOOPBACK}${TASKS}/tasks/${parentId}/children`)
    expect(children.status).toBe(200)
    expect(await children.json()).toMatchObject({ items: [{ title: "Child", number: 1, childNumber: 1 }] })
  })

  // Through the loopback app, the SQLite migration and the store: the image
  // the create carried is what the attachment route serves back, byte for byte.
  test("an image sent with a create is listed on the task and served back under its own route", async () => {
    const target = app()
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const created = await command(target, "request-task-image", {
      type: "task.create",
      input: {
        projectId: "project-a",
        title: "Match the mock",
        description: "The header should look like this.",
        workspaceId: null,
        parentTaskId: null,
        attachments: [{ filename: "mock.png", mime: "image/png", data: Buffer.from(bytes).toString("base64") }],
      },
    })
    expect(created.status).toBe(200)
    const taskId = (created.body.result as { task: { id: string } }).task.id

    const detail = await target.request(`${LOOPBACK}${TASKS}/tasks/${taskId}`)
    expect(detail.status).toBe(200)
    const attachments = ((await detail.json()) as { attachments: Array<{ id: string; filename: string; mime: string; size: number }> }).attachments
    expect(attachments).toMatchObject([{ filename: "mock.png", mime: "image/png", size: 8 }])
    expect(attachments[0]?.id).toMatch(/^tat_/)

    const served = await target.request(`${LOOPBACK}${TASKS}/tasks/${taskId}/attachments/${attachments[0]?.id}`)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes)

    const refused = await command(target, "request-task-bad-image", {
      type: "task.create",
      input: {
        projectId: "project-a",
        title: "Match the mock",
        description: "",
        workspaceId: null,
        parentTaskId: null,
        attachments: [{ filename: "mock.svg", mime: "image/svg+xml", data: "PHN2Zz4=" }],
      },
    })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ error: { fields: [{ path: "attachments[0].mime", reason: "unknown_value" }] } })
  })

  test("a task written by one request is still there for the next one", async () => {
    const first = app()
    await command(first, "request-durable", {
      type: "task.create",
      input: { projectId: "project-b", title: "Outlives its app", description: "", workspaceId: null, parentTaskId: null },
    })

    const listed = await app().request(`${LOOPBACK}${TASKS}/tasks?projectId=project-b`)
    expect(await listed.json()).toMatchObject({ items: [{ title: "Outlives its app" }] })
  })

  test("the app refuses an unsigned request that did not come from loopback", async () => {
    const response = await app().request(`http://tasks.example${TASKS}/capabilities`)
    expect(response.status).toBe(403)
    // The product's own global gate answers first. The feature's authenticate
    // refuses the same request on its own — proved below — so mounting these
    // routes somewhere that gate does not cover cannot open them.
    expect(await response.json()).toMatchObject({ error: { code: "unsigned_local_loopback_required" } })
  })

  test("a session's grant acts only in its own workspace's project and may record only itself as provenance", async () => {
    const workspace = await localWorkspace()
    const target = app()
    const handle = await target.composition.grants.issue({ workspaceId: workspace.id, sessionId: "ses_caller" })
    if (!handle) throw new Error("the composition issued no grant for its own workspace")
    const asSession = (path: string, init: RequestInit = {}) =>
      target.request(`${LOOPBACK}${TASKS}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${handle}`, ...Object.fromEntries(new Headers(init.headers)) },
      })
    const create = (clientRequestId: string, input: Record<string, unknown>) =>
      asSession("/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientRequestId,
          command: { type: "task.create", input: { title: "From a session", description: "", workspaceId: null, parentTaskId: null, ...input } },
        }),
      })

    const own = await create("grant-own-project", { projectId: workspace.project, createdFrom: { sessionId: "ses_caller", workspaceId: workspace.id } })
    expect(own.status).toBe(200)

    const elsewhere = await create("grant-other-project", { projectId: "project-elsewhere" })
    expect(elsewhere.status).toBe(403)
    expect(await elsewhere.json()).toMatchObject({ error: { message: `This session may act only in project ${workspace.project}` } })

    // The body names the provenance, so the body is exactly what may not be
    // believed: a session may write itself down and nothing else.
    const forged = await create("grant-forged-provenance", {
      projectId: workspace.project,
      createdFrom: { sessionId: "ses_someone_else", workspaceId: workspace.id },
    })
    expect(forged.status).toBe(403)
    expect(await forged.json()).toMatchObject({ error: { message: "This session may record only itself as a task's provenance" } })

    const listed = await asSession(`/tasks?projectId=${workspace.project}`)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ items: [{ title: "From a session" }] })

    // A task of another project named by id, which no query string declares:
    // the project is the task's own, and the grant is asked about it there.
    const persons = await command(target, "person-elsewhere", {
      type: "task.create",
      input: { projectId: "project-elsewhere", title: "The person's own", description: "", workspaceId: null, parentTaskId: null },
    })
    expect(persons.status).toBe(200)
    const hidden = (persons.body.result as { task: { id: string } }).task.id
    expect((await asSession(`/tasks/${hidden}`)).status).toBe(403)
  })

  test("refuses a grant it cannot verify instead of reading it as the person at this machine", async () => {
    const workspace = await localWorkspace()
    let tasksOn = true
    const target = app(createLocalTasksComposition({ enabled: () => tasksOn }))
    const handle = await target.composition.grants.issue({ workspaceId: workspace.id, sessionId: "ses_caller" })
    // A handle of the same shape from a registry that is not this one: what a
    // session still holding a bearer across a daemon restart presents.
    const previousProcess = await createLocalTasksComposition().grants.issue({
      workspaceId: workspace.id,
      sessionId: "ses_caller",
    })
    if (!handle || !previousProcess) throw new Error("the fixture issued no grant")

    const write = (clientRequestId: string, headers: Record<string, string>) =>
      target.request(`${LOOPBACK}${TASKS}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          clientRequestId,
          command: {
            type: "task.create",
            input: { projectId: workspace.project, title: clientRequestId, description: "", workspaceId: null, parentTaskId: null },
          },
        }),
      })

    for (const [label, authorization] of [
      ["unknown", "Bearer not-a-handle-this-machine-issued"],
      ["empty", "Bearer  "],
      ["shaped like a header, not a handle", `Bearer ${handle} extra`],
      ["issued by a previous process", `Bearer ${previousProcess}`],
    ] as const) {
      const refused = await write(`refused-${label}`, { authorization })
      expect(refused.status, `a ${label} grant was admitted`).toBe(403)
      expect(await refused.json()).toMatchObject({ error: { message: expect.stringContaining("not one this machine issued") } })
      const preview = await target.request(`${LOOPBACK}${TASKS}/tasks/task-missing/start-preview`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ taskRevision: 1, presetId: "preset", presetRevision: 1, slot: "primary", attempt: 1, continueFromPrevious: false }),
      })
      expect(preview.status, `a ${label} grant reached Start`).toBe(403)
    }

    // The switch that hides the Tasks tools withdraws the handle they would
    // act with, so a session holding one across it is refused too.
    tasksOn = false
    const withdrawn = await write("refused-withdrawn", { authorization: `Bearer ${handle}` })
    expect(withdrawn.status).toBe(403)
    tasksOn = true

    // The person is admitted by the daemon capability and carries no bearer.
    // A non-bearer Authorization is not a grant presentation — an unsigned box
    // behind desktop basic auth sends one — so it stays the person's.
    expect((await write("person-plain", {})).status).toBe(200)
    expect((await write("person-basic", { authorization: `Basic ${btoa(":desk-secret")}` })).status).toBe(200)
    expect((await write("session-valid", { authorization: `Bearer ${handle}` })).status).toBe(200)

    const listed = await target.request(`${LOOPBACK}${TASKS}/tasks?projectId=${workspace.project}`)
    const items = ((await listed.json()) as { items: Array<{ title: string }> }).items.map((row) => row.title)
    expect(items.toSorted()).toEqual(["person-basic", "person-plain", "session-valid"])
  })

  test("the contribution itself refuses a non-loopback request", async () => {
    const bare = new Hono()
    mountControlPlaneRouteContributions({
      contributions: createLocalTasksComposition().routeContributions,
      mount: (contribution) => bare.route(contribution.path, contribution.routes),
    })

    expect((await bare.request(`http://tasks.example${TASKS}/capabilities`)).status).toBe(403)
    expect((await bare.request(`${LOOPBACK}${TASKS}/capabilities`)).status).toBe(200)
  })
})
