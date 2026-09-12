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
import { routeContributions } from "./local-composition"

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
  return createLocalApp({ services: services(), routeContributions }).app
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
      instructions: true,
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
    expect(await listed.json()).toMatchObject({ items: [{ title: "Ship the store" }] })
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
      contributions: routeContributions,
      mount: (contribution) => bare.route(contribution.path, contribution.routes),
    })

    expect((await bare.request(`http://tasks.example${TASKS}/capabilities`)).status).toBe(403)
    expect((await bare.request(`${LOOPBACK}${TASKS}/capabilities`)).status).toBe(200)
  })
})
