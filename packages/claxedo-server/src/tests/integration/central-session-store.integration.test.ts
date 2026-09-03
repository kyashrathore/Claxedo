import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * One store for central session meta.
 *
 * `POST /api/control/sessions` (ControlPlaneSessionRoutes) writes the row
 * through `runtime.createHybridSession`, and every later read — the central
 * runtime's `getSession`/`listSessions`, and the local `/api/claxedo/session/
 * :id/meta` projection route — reads it back from
 * `services.projectionStore`. Both halves are composed from the SAME
 * `createDefaultLocalControlPlaneServices()` object in `createSelfHostedApp`,
 * so this pins that the self-hosted composition never grows a second store:
 * a write side that succeeds while the read side answers 404
 * `session_not_found` would leave the app falling through to the workspace
 * runtime for a session that is central.
 *
 * Note `/api/claxedo/session/:id/meta` answers 200 with a synthesized
 * `{ sessionID, tags: [], attachments: [] }` fallback for an unknown id, so it
 * is asserted on its stored fields — its status alone proves nothing.
 */

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-central-session-store-"))
const previous = {
  HOME: process.env.HOME,
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
  CLAXEDO_DEPLOYMENT_MODE: process.env.CLAXEDO_DEPLOYMENT_MODE,
  CLAXEDO_SIGNED_CLOUD_AUTH: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
  CLAXEDO_EMBEDDED_AUTH: process.env.CLAXEDO_EMBEDDED_AUTH,
  CLAXEDO_WORKSPACE_AUTHORITY_URL: process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL,
  CLAXEDO_PI_MODEL: process.env.CLAXEDO_PI_MODEL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
}

process.env.HOME = path.join(root, "home")
process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
delete process.env.CLAXEDO_DEPLOYMENT_MODE
delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
delete process.env.CLAXEDO_EMBEDDED_AUTH
delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
// The create route asks for `requireModel: true`, so the box needs a Pi model
// the same way a real self-host box configures one: a catalog model plus the
// provider credential that makes it `connected`. No request leaves the box.
process.env.CLAXEDO_PI_MODEL = "anthropic/claude-3-5-haiku-latest"
process.env.ANTHROPIC_API_KEY = "sk-ant-central-session-store-test"

await Promise.all([
  fs.mkdir(process.env.HOME, { recursive: true }),
  fs.mkdir(process.env.CLAXEDO_DATA_DIR, { recursive: true }),
  fs.mkdir(process.env.CLAXEDO_STATE_DIR, { recursive: true }),
])

const [{ createSelfHostedApp, createDefaultLocalControlPlaneServices }, { ClaxedoDB }] = await Promise.all([
  import("../../deployments/self-hosted-node/app"),
  import("../../platform/db"),
])

const services = createDefaultLocalControlPlaneServices()
const app = createSelfHostedApp(services).app

describe("central session meta has one store in the self-hosted composition", () => {
  let sessionId = ""

  beforeAll(async () => {
    const created = await request("http://127.0.0.1/api/control/sessions", {
      method: "POST",
      body: JSON.stringify({ mode: "hybrid", title: "Central store", harness: "pi" }),
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const body = await created.json() as { session: { id: string; host: string } }
    expect(body.session.host).toBe("central")
    sessionId = body.session.id
    expect(sessionId).toBeTruthy()
  })

  afterAll(async () => {
    ClaxedoDB.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  test("the create route's write lands in the projection store the runtime reads", async () => {
    await expect(services.projectionStore.session_meta(sessionId)).resolves.toMatchObject({
      sessionID: sessionId,
      host: "central",
      sessionRef: `central:${sessionId}`,
      title: "Central store",
    })
    expect((await services.projectionStore.list_session_metas({ includeArchived: false }))
      .map((meta) => meta.sessionID)).toContain(sessionId)
  })

  test("the central runtime reads the created session back through the session route", async () => {
    // The app's first read after create carries an empty `directory`; a
    // central session has none, and the answer must not depend on it.
    for (const query of ["", "?directory=", "?directory=%2Ftmp"]) {
      const read = await request(`http://127.0.0.1/api/control/session/${sessionId}${query}`)
      expect(read.status, `${query}: ${await read.clone().text()}`).toBe(200)
      await expect(read.json()).resolves.toMatchObject({
        id: sessionId,
        host: "central",
        sessionRef: `central:${sessionId}`,
      })
    }
  })

  test("the central runtime lists the created session", async () => {
    const listed = await request("http://127.0.0.1/api/control/session")
    expect(listed.status).toBe(200)
    const rows = await listed.json() as Array<{ id: string; host: string }>
    expect(rows.filter((row) => row.id === sessionId)).toEqual([
      expect.objectContaining({ id: sessionId, host: "central" }),
    ])
  })

  test("the local projection route serves the same stored row", async () => {
    const meta = await request(`http://127.0.0.1/api/claxedo/session/${sessionId}/meta`)
    expect(meta.status).toBe(200)
    await expect(meta.json()).resolves.toMatchObject({
      sessionID: sessionId,
      host: "central",
      title: "Central store",
    })
  })
})

function request(url: string, init: RequestInit = {}) {
  return app.request(url, {
    ...init,
    headers: {
      Origin: new URL(url).origin,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}
