import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { sessionMetaProjectionTap } from "./session-meta-tap"

/**
 * Request-level, on purpose.
 *
 * A first attempt at the local composition dropped this tap entirely and the
 * route-inventory contract test passed anyway — the tap adds no route path, so
 * nothing about the registered route table changes when it disappears. The only
 * way to know it is wired is to send a request and look at what was recorded.
 */

let dataDir: string
let previousDataDir: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-meta-tap-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function mount(store: { put_session_meta: ReturnType<typeof vi.fn>; delete_session_meta: ReturnType<typeof vi.fn> }) {
  const app = new Hono()
  app.use(sessionMetaProjectionTap(store as never))
  // Stands in for the workspace runtime proxy, which answers these itself.
  app.post("/session", (c) => c.json({ id: "ses_1", title: "First", directory: "/work" }))
  app.patch("/session/:id", (c) => c.json({ id: c.req.param("id"), title: "Renamed" }))
  app.delete("/session/:id", (c) => c.json({ ok: true }))
  app.post("/session/failing", (c) => c.json({ error: "nope" }, 500))
  return app
}

function store() {
  return { put_session_meta: vi.fn(async () => {}), delete_session_meta: vi.fn(async () => {}) }
}

describe("session meta projection tap", () => {
  test("records a created session's metadata from the proxied response", async () => {
    const projection = store()
    const response = await mount(projection).request("http://localhost/session?directory=%2Fwork", { method: "POST" })

    expect(response.status).toBe(200)
    expect(projection.put_session_meta).toHaveBeenCalledTimes(1)
    const [id, meta] = projection.put_session_meta.mock.calls[0]!
    expect(id).toBe("ses_1")
    expect(meta).toMatchObject({ title: "First", directory: "/work" })
  })

  test("records a rename", async () => {
    const projection = store()
    await mount(projection).request("http://localhost/session/ses_1?directory=%2Fwork", { method: "PATCH" })

    expect(projection.put_session_meta.mock.calls[0]?.[1]).toMatchObject({ title: "Renamed" })
  })

  test("records a delete", async () => {
    const projection = store()
    await mount(projection).request("http://localhost/session/ses_1?directory=%2Fwork", { method: "DELETE" })

    expect(projection.delete_session_meta).toHaveBeenCalledWith("ses_1")
    expect(projection.put_session_meta).not.toHaveBeenCalled()
  })

  test("records nothing for a failed request", async () => {
    // A 500 that still returned a JSON body must not be projected as a session.
    const projection = store()
    await mount(projection).request("http://localhost/session/failing?directory=%2Fwork", { method: "POST" })

    expect(projection.put_session_meta).not.toHaveBeenCalled()
    expect(projection.delete_session_meta).not.toHaveBeenCalled()
  })

  test("skips cloud workspaces, which the authority owns", async () => {
    const cloud = await ensureWorkspace({
      workspaceId: "ws_cloud",
      directory: "/workspace",
      kind: "cloud",
      driver: "daytona",
    })
    expect(cloud?.kind).toBe("cloud")

    const projection = store()
    await mount(projection).request("http://localhost/session?workspaceId=ws_cloud", { method: "POST" })

    expect(projection.put_session_meta).not.toHaveBeenCalled()
  })

  test("never fails the response when recording throws", async () => {
    // Best-effort by construction: a broken projection store costs a stale
    // session list, not a failed session creation.
    const projection = {
      put_session_meta: vi.fn(async () => { throw new Error("store is down") }),
      delete_session_meta: vi.fn(async () => {}),
    }
    const response = await mount(projection as never).request(
      "http://localhost/session?directory=%2Fwork",
      { method: "POST" },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: "ses_1" })
  })
})
