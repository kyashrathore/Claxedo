import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-session-list-integration-"))
const previous = {
  HOME: process.env.HOME,
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
  CLAXEDO_DEPLOYMENT_MODE: process.env.CLAXEDO_DEPLOYMENT_MODE,
  CLAXEDO_SIGNED_CLOUD_AUTH: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
  CLAXEDO_EMBEDDED_AUTH: process.env.CLAXEDO_EMBEDDED_AUTH,
  CLAXEDO_WORKSPACE_AUTHORITY_URL: process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL,
}

process.env.HOME = path.join(root, "home")
process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
delete process.env.CLAXEDO_DEPLOYMENT_MODE
delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
delete process.env.CLAXEDO_EMBEDDED_AUTH
delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL

await Promise.all([
  fs.mkdir(process.env.HOME, { recursive: true }),
  fs.mkdir(process.env.CLAXEDO_DATA_DIR, { recursive: true }),
  fs.mkdir(process.env.CLAXEDO_STATE_DIR, { recursive: true }),
])

const [{ createApp, createDefaultLocalControlPlaneServices }, { ClaxedoDB }] = await Promise.all([
  import("./deployments/local/server"),
  import("./adapters/storage/db"),
])

const services = createDefaultLocalControlPlaneServices()
const app = createApp(services).app

const alpha = workspace("ws_alpha", "project_alpha", "/work/alpha")
const beta = workspace("ws_beta", "project_alpha", "/work/beta")
const gamma = workspace("ws_gamma", "project_beta", "/work/gamma")

describe("current control-plane session-list integration", () => {
  beforeAll(async () => {
    await Promise.all([
      seed(alpha, "session_alpha_new", "Alpha new", 30),
      seed(alpha, "session_alpha_old", "Alpha old", 10),
      seed(alpha, "session_alpha_archived", "Alpha archived", 40, 50),
      seed(beta, "session_beta", "Beta", 20),
      seed(gamma, "session_gamma", "Gamma", 15),
    ])
  })

  afterAll(async () => {
    ClaxedoDB.close()
    restore("HOME", previous.HOME)
    restore("CLAXEDO_DATA_DIR", previous.CLAXEDO_DATA_DIR)
    restore("CLAXEDO_STATE_DIR", previous.CLAXEDO_STATE_DIR)
    restore("CLAXEDO_DEPLOYMENT_MODE", previous.CLAXEDO_DEPLOYMENT_MODE)
    restore("CLAXEDO_SIGNED_CLOUD_AUTH", previous.CLAXEDO_SIGNED_CLOUD_AUTH)
    restore("CLAXEDO_EMBEDDED_AUTH", previous.CLAXEDO_EMBEDDED_AUTH)
    restore("CLAXEDO_WORKSPACE_AUTHORITY_URL", previous.CLAXEDO_WORKSPACE_AUTHORITY_URL)
    await fs.rm(root, { recursive: true, force: true })
  })

  test("keeps the real session-list composition loopback-only in unsigned self-host mode", async () => {
    const denied = await request("http://control.example.test/api/control/session-list?scope=workspace&groupBy=none")

    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "unsigned_local_loopback_required" },
    })

    const allowed = await request("http://127.0.0.1/api/control/session-list?scope=workspace&groupBy=none&directory=%2Fwork%2Falpha")
    expect(allowed.status).toBe(200)
  })

  test("returns the current empty ungrouped response shape", async () => {
    const response = await request(
      "http://127.0.0.1/api/control/session-list?scope=workspace&groupBy=none&directory=%2Fwork%2Fmissing&limit=10",
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 10 },
      items: [],
      totalKnown: 0,
    })
  })

  test("serves groupBy=none from the durable projection with active-only and current ordering semantics", async () => {
    const response = await request(
      "http://127.0.0.1/api/control/session-list?scope=workspace&groupBy=none&directory=%2Fwork%2Falpha&limit=10",
    )

    expect(response.status).toBe(200)
    const body = await response.json() as {
      items: Array<{ sessionId: string; sessionRef: string }>
      totalKnown: number
    }
    expect(body.items.map((item) => item.sessionId)).toEqual(["session_alpha_new", "session_alpha_old"])
    expect(body.items[0]?.sessionRef).toBe("workspace:ws_alpha:session:session_alpha_new")
    expect(body.totalKnown).toBe(2)
  })

  test("applies the current archived selector before returning an ungrouped page", async () => {
    const response = await request(
      "http://127.0.0.1/api/control/session-list?scope=workspace&groupBy=none&directory=%2Fwork%2Falpha&archived=archived&limit=10",
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      items: [{ sessionId: "session_alpha_archived", archivedAt: 50 }],
      totalKnown: 1,
    })
  })

  test("serves groupBy=project for the requested project scope", async () => {
    const response = await request(
      "http://127.0.0.1/api/control/session-list?scope=project&projectId=project_alpha&groupBy=project&archived=all&limit=10",
    )

    expect(response.status).toBe(200)
    const body = await response.json() as {
      view: { scope: string; groupBy: string }
      groups: Array<{ id: string; items: Array<{ sessionId: string }>; totalKnown: number }>
    }
    expect(body.view).toMatchObject({ scope: "project", groupBy: "project" })
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0]?.id).toBe("project_alpha")
    expect(body.groups[0]?.items.map((item) => item.sessionId)).toEqual([
      "session_alpha_archived",
      "session_alpha_new",
      "session_beta",
      "session_alpha_old",
    ])
    expect(body.groups[0]?.totalKnown).toBe(4)
  })

  test("serves groupBy=workspace inside a project without leaking another project", async () => {
    const response = await request(
      "http://127.0.0.1/api/control/session-list?scope=project&projectId=project_alpha&groupBy=workspace&archived=all&limit=10",
    )

    expect(response.status).toBe(200)
    const body = await response.json() as {
      groups: Array<{ id: string; items: Array<{ sessionId: string }> }>
    }
    expect(body.groups.map((group) => group.id)).toEqual(["ws_alpha", "ws_beta"])
    expect(body.groups[0]?.items.map((item) => item.sessionId)).toEqual([
      "session_alpha_archived",
      "session_alpha_new",
      "session_alpha_old",
    ])
    expect(body.groups[1]?.items.map((item) => item.sessionId)).toEqual(["session_beta"])
    expect(body.groups.flatMap((group) => group.items).some((item) => item.sessionId === "session_gamma")).toBe(false)
  })
})

function workspace(id: string, project_id: string, directory: string) {
  return {
    id,
    project_id,
    directory,
    kind: "local" as const,
    created_at: 1,
    updated_at: 1,
  }
}

function seed(
  ws: ReturnType<typeof workspace>,
  id: string,
  title: string,
  updated: number,
  archived?: number,
) {
  return services.projectionStore.sync_session_meta(ws, {
    id,
    title,
    directory: ws.directory,
    time: { created: 1, updated, ...(archived ? { archived } : {}) },
  })
}

function request(url: string) {
  return app.request(url, {
    headers: {
      Authorization: "Bearer local-test-token",
      Origin: new URL(url).origin,
    },
  })
}

function restore(key: keyof NodeJS.ProcessEnv, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
