import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { globalBus, type GlobalEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { projectLocalSessionMetaFromEvent, sessionMetaProjectionTap } from "./session-meta-tap"

/** Captures every `globalBus` frame published while the test runs. */
function watchGlobalBus() {
  const seen: GlobalEvent[] = []
  const unsubscribe = globalBus.subscribe((event) => seen.push(event))
  return { seen, unsubscribe }
}

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

function mount(store: {
  put_session_meta: ReturnType<typeof vi.fn>
  delete_session_meta: ReturnType<typeof vi.fn>
  session_meta: ReturnType<typeof vi.fn>
}) {
  const app = new Hono()
  app.use(sessionMetaProjectionTap(store as never))
  // Stands in for the workspace runtime proxy, which answers these itself.
  app.post("/session", (c) => c.json({ id: "ses_1", title: "First", directory: "/work" }))
  app.patch("/session/:id", (c) => c.json({ id: c.req.param("id"), title: "Renamed" }))
  app.delete("/session/:id", (c) => c.json({ ok: true }))
  app.post("/session/failing", (c) => c.json({ error: "nope" }, 500))
  return app
}

function store(meta?: Record<string, unknown>) {
  return {
    put_session_meta: vi.fn(async (_id: string, _meta: Record<string, unknown>) => {}),
    delete_session_meta: vi.fn(async (_id: string) => {}),
    session_meta: vi.fn(async (_id: string) => meta),
  }
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

  test("publishes session.deleted on globalBus, the way the desktop's session list already consumes", async () => {
    // The live defect: this same relay-shaped surface publishes
    // `session.lifecycle` `creating`/`created` for a new session
    // (`packages/workspace-runtime/src/routes/session-core.ts`) but nothing at
    // all for a delete, so a session removed from the web stayed in the
    // desktop's sidebar. `session.deleted` is the native-opencode-shaped event
    // the sidebar's reducer already switches on
    // (`packages/claxedo-app/src/features/session/data/sync/session-list-events.ts`).
    const projection = store({ directory: "/work", parentID: undefined })
    const bus = watchGlobalBus()
    try {
      await mount(projection).request("http://localhost/session/ses_1?directory=%2Fwork", { method: "DELETE" })
    } finally {
      bus.unsubscribe()
    }

    const published = bus.seen.find((event) => event.payload.type === "session.deleted")
    expect(published).toMatchObject({
      directory: "/work",
      payload: { type: "session.deleted", properties: { info: { id: "ses_1" } } },
    })
  })

  test("keeps the visible session count when a deleted session was a subsession", async () => {
    // The sidebar only decrements its total for a top-level session; a
    // subsession's `parentID` must survive into the event or every reply
    // thread deletion would undercount the list.
    const projection = store({ directory: "/work", parentID: "ses_parent" })
    const bus = watchGlobalBus()
    try {
      await mount(projection).request("http://localhost/session/ses_1?directory=%2Fwork", { method: "DELETE" })
    } finally {
      bus.unsubscribe()
    }

    const published = bus.seen.find((event) => event.payload.type === "session.deleted")
    expect(published).toMatchObject({
      payload: { properties: { info: { id: "ses_1", parentID: "ses_parent" } } },
    })
  })

  test("never fails the response when the delete publish throws", async () => {
    const projection = store()
    const unsubscribe = globalBus.subscribe(() => {
      throw new Error("no subscriber to see this")
    })
    let response: Response
    try {
      response = await mount(projection).request("http://localhost/session/ses_1?directory=%2Fwork", {
        method: "DELETE",
      })
    } finally {
      unsubscribe()
    }

    expect(response.status).toBe(200)
    expect(projection.delete_session_meta).toHaveBeenCalledWith("ses_1")
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

describe("SSE session meta projection", () => {
  test("records an auto-generated title that never arrives over HTTP", async () => {
    // The reason this exists alongside the HTTP tap: a harness's async rename
    // is published only on the workspace's own event stream, so the tap above
    // cannot see it. Without this, titles revert to "Untitled" after a restart.
    const sync = vi.fn(async (_ws: unknown, _info: Record<string, unknown>) => {})
    await projectLocalSessionMetaFromEvent({ sync_session_meta: sync } as never, {
      directory: "/work",
      payload: { type: "session.updated", properties: { info: { id: "ses_1", title: "Auto title" } } },
    })

    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0]?.[1]).toMatchObject({ id: "ses_1", title: "Auto title", directory: "/work" })
  })

  test("ignores an event with no session info", async () => {
    const sync = vi.fn(async () => {})
    await projectLocalSessionMetaFromEvent({ sync_session_meta: sync } as never, {
      directory: "/work",
      payload: { type: "session.updated", properties: {} },
    })

    expect(sync).not.toHaveBeenCalled()
  })
})
