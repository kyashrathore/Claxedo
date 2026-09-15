/**
 * Tasks through the real desktop-local app, not through a bare Hono holding
 * the contribution: the loopback gate, the route mount and the SQLite store
 * are all part of what a request has to get through, and mounting the routes
 * alone would prove none of them.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { mountControlPlaneRouteContributions } from "@claxedo/server-core/platform/http/route-contribution"
import { createLocalApp, type LocalAppOptions } from "../app/local-app"
import { createLocalTasksComposition } from "./local-composition"

const LOOPBACK = "http://127.0.0.1:4096"
const TASKS = "/api/claxedo/tasks"

let dataDir: string
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

function app() {
  return createLocalApp({ services: services(), routeContributions: createLocalTasksComposition().routeContributions }).app
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
