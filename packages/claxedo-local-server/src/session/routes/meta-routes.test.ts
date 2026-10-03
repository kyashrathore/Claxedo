import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "fs"
import { execFileSync } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { ControlPlaneAuthError, localOnlyAuthAdapter, type ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"

const root = path.join(realpathSync(os.tmpdir()), `session-meta-routes-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

// These modules share the storage and workspace dependency graph. Loading
// them concurrently deadlocks Vitest's SSR module evaluator before collection.
const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
const { putSessionMeta, deleteSessionMeta, sessionMeta, listSessionMetas, syncSessionMeta } = await import("@claxedo/server-core/session/meta/index")
const { ClaxedoSessionMetaTable } = await import("@claxedo/server-core/session/meta.sql")
const { ensureWorkspace, deleteWorkspace, upsertProjectRecord } = await import("@claxedo/server-core/workspace/store/index")
const { SessionMetaRoutes } = await import("./meta-routes")
ClaxedoDB.Drizzle()

/**
 * A directory on THIS machine, stored the only way the store will store one.
 *
 * `ensureWorkspace` refuses a row it cannot place: a worktree needs a repo to
 * key on, and a provisioner row needs the driver that names the machine it
 * runs on. A row seeded without either is silently absent and the route under
 * test then answers about nothing.
 */
async function worktree(directory: string) {
  await fs.mkdir(directory, { recursive: true })
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
  return directory
}

let runtimeClock = 0
function runtimeTimes() {
  runtimeClock += 1
  return { createdAt: runtimeClock, updatedAt: runtimeClock }
}

const authConfig = {
  enabled: true,
  issuer: "https://issuer.example.test",
  jwksUrl: "https://issuer.example.test/.well-known/jwks.json",
} as const

const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed",
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
  },
})

function services(input: { workspaces?: unknown[] } = {}): ControlPlaneServicesContract {
  return {
    projectionStore: {} as never,
    durableSessionLog: {} as never,
    auth: localOnlyAuthAdapter(),
    credentials: {} as never,
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: true },
    authority: {
      usersMe: vi.fn(async () => ({})),
      authorizeSessionRead: vi.fn(async () => {}),
      listWorkspaces: vi.fn(async () => input.workspaces ?? []),
      // Caller-authorized list in production; for these route tests the local
      // projection store is the seeded source of truth for which sessions exist.
      // The rows carry what the authority's own rows carry, which names neither
      // the workspace nor the project.
      listSessions: vi.fn(async (_auth, args: { workspaceId: string }) =>
        (await listSessionMetas({ workspaceID: args.workspaceId })).map((row) => ({
          session_id: row.sessionID,
          title: row.title,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        })),
      ),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "member",
        workspace: {
          workspace_id: "ws_1",
          backing: "cloud-vm" as const,
        },
      })),
    } as unknown as ControlPlaneServicesContract["authority"],
  }
}

function buildApp(svc = services()) {
  return {
    svc,
    app: SessionMetaRoutes({
      services: svc,
      authConfig,
      verifier,
    }),
  }
}

function restoreEnv(input: Record<string, string | undefined>) {
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = input[key]
  }
}

describe("session metadata routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (prev.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
    if (prev.CLAXEDO_STATE_DIR === undefined) delete process.env.CLAXEDO_STATE_DIR
    else process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
  })

  test("exact local location uses canonical workspace project and resolves hidden sessions without listing rows", async () => {
    const ws = await ensureWorkspace({ workspaceId: `ws_location_${randomUUID()}`, directory: await worktree(path.join(root, `location-${randomUUID()}`)) })
    if (!ws) throw new Error("test workspace was not created")
    const id = `ses_location_${randomUUID()}`
    await syncSessionMeta(ws, { id, title: "Private title", time: { created: 100, updated: 500 },
      attention: { sequence: 10, generation: 1, activitySequence: 10, activityAt: 500, working: false, awaitingInput: false,
        outcome: { sequence: 10, status: "completed", completedAt: 500 } } })
    const { writeSessionReader, LOCAL_SESSION_READER } = await import("@claxedo/server-core/session/reader")
    expect(writeSessionReader({ sessionRef: (await sessionMeta(id))!.sessionRef!, readerId: LOCAL_SESSION_READER,
      command: { kind: "settle", generation: 1, activitySequence: 10, outcomeSequence: 10, revision: 0 }, now: 600 }).ok).toBe(true)
    const app = SessionMetaRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test" } })
    const hidden = await app.request(`http://localhost/api/claxedo/session-list?scope=workspace&workspaceId=${ws.id}&limit=5`)
    expect(hidden.status).toBe(200)
    expect(await hidden.json()).toMatchObject({ items: [], totalKnown: 0 })
    const all = await app.request(`http://localhost/api/claxedo/session-list?scope=workspace&workspaceId=${ws.id}&limit=5&settled=all`)
    expect(await all.json()).toMatchObject({ items: [{ sessionId: id, reader: { settledThrough: 10 } }], totalKnown: 1 })
    const exact = await app.request(`http://localhost/api/claxedo/session-list?scope=workspace&workspaceId=${ws.id}&sessionId=${id}&limit=2&settled=all&seen=all`)
    expect(exact.status).toBe(200)
    expect(await exact.json()).toMatchObject({ items: [{ sessionId: id, reader: { settledThrough: 10 } }], totalKnown: 1 })
    const response = await app.request(`http://localhost/api/claxedo/session/${id}/location`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionId: id, workspaceId: ws.id, projectId: ws.project_id })
    await putSessionMeta(id, { archived: Date.now() })
    expect((await app.request(`http://localhost/api/claxedo/session/${id}/location`)).status).toBe(200)
    expect((await app.request(`http://localhost/api/claxedo/session/${id}/location?workspaceId=wrong`)).status).toBe(404)
    expect((await app.request(`http://localhost/api/claxedo/session/${id}/location?workspaceId=`)).status).toBe(400)
    await deleteSessionMeta(id)
    expect((await app.request(`http://localhost/api/claxedo/session/${id}/location`)).status).toBe(404)
  })

  test("exact local location refuses ambiguous ids and cached cloud identity", async () => {
    const ws = await ensureWorkspace({ workspaceId: `ws_location_ambiguous_${randomUUID()}`, directory: await worktree(path.join(root, `location-ambiguous-${randomUUID()}`)) })
    const cloudId = `ws_location_cloud_${randomUUID()}`
    const cloud = await ensureWorkspace({ workspaceId: cloudId, directory: `workspace:${cloudId}`, remote_directory: "/workspace", kind: "cloud", driver: "modal" })
    if (!ws || !cloud) throw new Error("test workspaces were not created")
    const id = `ses_location_ambiguous_${randomUUID()}`
    await putSessionMeta(id, { ws, ...runtimeTimes() })
    const stored = ClaxedoDB.use((db) => db.select().from(ClaxedoSessionMetaTable).all().find((row) => row.session_id === id))!
    ClaxedoDB.use((db) => db.insert(ClaxedoSessionMetaTable).values({ ...stored, session_ref: `duplicate:${id}`, workspace_id: cloud.id }).run())
    const app = SessionMetaRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test" } })
    expect((await app.request(`http://localhost/api/claxedo/session/${id}/location`)).status).toBe(404)
    const cloudSession = `ses_cloud_location_${randomUUID()}`
    await putSessionMeta(cloudSession, { ws: cloud, ...runtimeTimes() })
    expect((await app.request(`http://localhost/api/claxedo/session/${cloudSession}/location`)).status).toBe(404)
  })

  test("exact navigation reads an off-page root with canonical project, machine and working facts", async () => {
    const ws = await ensureWorkspace({ workspaceId: `ws_exact_navigation_${randomUUID()}`, directory: await worktree(path.join(root, `exact-navigation-${randomUUID()}`)) })
    if (!ws) throw new Error("test workspace was not created")
    if (!ws.project_id) throw new Error("test workspace has no canonical project")
    await upsertProjectRecord({ id: ws.project_id, name: "Exact navigation project" })
    const id = `ses_exact_navigation_${randomUUID()}`
    const attention = { generation: 1, sequence: 13, activitySequence: 10, activityAt: 10, working: true, awaitingInput: false }
    const lastTurn = { status: "completed" as const, completedAt: 9, assistantMessageId: "msg_previous" }
    await syncSessionMeta(ws, { id, title: "Older working session", time: { created: 1, updated: 13 }, attention, lastTurn })
    for (let index = 0; index < 30; index += 1) {
      await putSessionMeta(`${id}_new_${index}`, { ws, title: `New session ${index}`, createdAt: 20 + index, updatedAt: 20 + index })
    }
    const refreshSessionProjection = vi.fn(async () => {})
    const app = SessionMetaRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test" }, refreshSessionProjection })
    const base = `http://localhost/api/claxedo/session-list?scope=workspace&workspaceId=${ws.id}&sort=human_turn_desc`
    const first = await app.request(`${base}&limit=5`)
    const firstBody = await first.json() as { items: Array<{ sessionId: string }>; totalKnown: number }
    expect(firstBody.items).toHaveLength(5)
    expect(firstBody.items.some((item) => item.sessionId === id)).toBe(false)
    expect(firstBody.totalKnown).toBe(31)
    const exact = await app.request(`${base}&sessionId=${id}&limit=2&settled=all&seen=all`)
    expect(exact.status).toBe(200)
    expect(await exact.json()).toMatchObject({ items: [{ sessionId: id, workspaceId: ws.id, projectId: ws.project_id,
      title: "Older working session", ownership: "owned", projectName: "Exact navigation project",
      placement: { kind: "local", machineName: expect.any(String) }, attention, lastTurn }], totalKnown: 1 })
    expect(refreshSessionProjection).toHaveBeenCalledTimes(2)
    expect(refreshSessionProjection).toHaveBeenLastCalledWith(expect.objectContaining({ id: ws.id }))
  })

  test("exact navigation returns no row or metadata for missing, deleted, ambiguous or wrong-workspace ids", async () => {
    const workspaces = await Promise.all(["one", "two"].map(async (name) => ensureWorkspace({
      workspaceId: `ws_exact_absent_${name}_${randomUUID()}`, directory: await worktree(path.join(root, `exact-absent-${name}-${randomUUID()}`)),
    })))
    const [one, two] = workspaces
    if (!one || !two) throw new Error("test workspaces were not created")
    const id = `ses_exact_absent_${randomUUID()}`
    await putSessionMeta(id, { ws: one, title: "Must not leak", ...runtimeTimes() })
    const app = SessionMetaRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test" } })
    const read = async (sessionId: string, workspaceId = one.id) => {
      const response = await app.request(`http://localhost/api/claxedo/session-list?scope=workspace&workspaceId=${workspaceId}&sessionId=${sessionId}&limit=2&settled=all`)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ items: [], totalKnown: 0 })
    }
    const invalid = await app.request(`http://localhost/api/claxedo/session-list?scope=workspace&workspaceId=${one.id}&sessionId=`)
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: { code: "invalid_session_list_query", message: "Session id is empty" } })
    await read(`${id}_missing`)
    await read(id, two.id)
    const deletedId = `${id}_deleted`
    await putSessionMeta(deletedId, { ws: one, title: "Deleted private row", ...runtimeTimes() })
    await deleteSessionMeta(deletedId)
    await read(deletedId)
    const stored = ClaxedoDB.use((db) => db.select().from(ClaxedoSessionMetaTable).all().find((row) => row.session_id === id))!
    ClaxedoDB.use((db) => db.insert(ClaxedoSessionMetaTable).values({ ...stored, session_ref: `duplicate:${id}`, workspace_id: two.id }).run())
    await read(id)
  })

  test("exact local location authorizes the canonical session before returning project metadata", async () => {
    const ws = await ensureWorkspace({ workspaceId: `ws_location_auth_${randomUUID()}`, directory: await worktree(path.join(root, `location-auth-${randomUUID()}`)) })
    if (!ws) throw new Error("test workspace was not created")
    const id = `ses_location_auth_${randomUUID()}`
    await putSessionMeta(id, { ws, ...runtimeTimes() })
    const { app, svc } = buildApp()
    vi.mocked(svc.authority!.authorizeSessionRead).mockRejectedValueOnce(new ControlPlaneAuthError(403, "workspace_authorization_denied", "Session is private"))
    const denied = await app.request(`http://localhost/api/claxedo/session/${id}/location`, { headers: { Authorization: "Bearer other_user" } })
    expect(denied.status).toBe(403)
    expect(await denied.json()).not.toHaveProperty("projectId")
    expect(svc.authority!.authorizeSessionRead).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ subject: "other_user" }) }), { sessionId: id, workspaceId: ws.id })
  })

  test.each(["missing", "cloud"] as const)("exact local location authorizes before inspecting an unauthorized %s workspace", async (kind) => {
    const workspaceId = `ws_location_guard_${kind}_${randomUUID()}`
    const ws = kind === "cloud"
      ? await ensureWorkspace({ workspaceId, directory: `workspace:${workspaceId}`, remote_directory: "/workspace", kind: "cloud", driver: "modal" })
      : await ensureWorkspace({ workspaceId, directory: await worktree(path.join(root, `location-guard-${randomUUID()}`)) })
    if (!ws) throw new Error("test workspace was not created")
    const id = `ses_location_guard_${randomUUID()}`
    await putSessionMeta(id, { ws, ...runtimeTimes() })
    if (kind === "missing") await deleteWorkspace(ws.id)
    const { app, svc } = buildApp()
    vi.mocked(svc.authority!.authorizeSessionRead).mockRejectedValueOnce(new ControlPlaneAuthError(403, "workspace_authorization_denied", "Session is private"))
    const response = await app.request(`http://localhost/api/claxedo/session/${id}/location`, { headers: { Authorization: "Bearer denied_user" } })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "workspace_authorization_denied", message: "Session is private", retryable: false } })
    expect(svc.authority!.authorizeSessionRead).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ subject: "denied_user" }) }), { sessionId: id, workspaceId: ws.id })
  })

  test("reader mutation requires the exact workspace and refuses an unavailable runtime without changing reader state", async () => {
    const directory = await worktree(path.join(root, `reader-boundary-${randomUUID()}`))
    const ws = await ensureWorkspace({ workspaceId: `ws_reader_${randomUUID()}`, directory })
    if (!ws) throw new Error("test workspace was not created")
    await putSessionMeta("ses_reader_boundary", { ws, ...runtimeTimes() })
    const app = SessionMetaRoutes()
    const request = (query: string) => app.request(`http://localhost/api/claxedo/session/ses_reader_boundary/reader${query}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "settle", generation: 1, activitySequence: 1, revision: 0 }),
    })
    expect((await request("")).status).toBe(400)
    expect((await request("?workspaceId=ws_other")).status).toBe(404)
    expect((await request(`?workspaceId=${ws.id}`)).status).toBe(503)
    const { readSessionReader, LOCAL_SESSION_READER } = await import("@claxedo/server-core/session/reader")
    expect(readSessionReader((await sessionMeta("ses_reader_boundary"))!.sessionRef!, LOCAL_SESSION_READER)).toBeUndefined()
    await syncSessionMeta(ws, { id: "ses_reader_boundary", title: "Reader", time: { created: 100, updated: 500 },
      attention: { sequence: 10, generation: 1, activitySequence: 10, activityAt: 500, working: false, awaitingInput: false,
        outcome: { sequence: 10, status: "completed", completedAt: 500 } } })
    const seen = await app.request(`http://localhost/api/claxedo/session/ses_reader_boundary/reader?workspaceId=${ws.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "seen", generation: 1, outcomeSequence: 10 }),
    })
    expect(seen.status).toBe(200)
    expect(await seen.json()).toMatchObject({ ok: true, state: { revision: 1, seenThrough: 10 } })
    expect(readSessionReader((await sessionMeta("ses_reader_boundary"))!.sessionRef!, LOCAL_SESSION_READER)?.settledThrough).toBeUndefined()
  })

  test("local unsigned mode remains available when signed auth is disabled", async () => {
    await putSessionMeta("local_1", { directory: "/tmp/local-1", ...runtimeTimes() })
    const local = SessionMetaRoutes()
    const res = await local.request("http://localhost/api/claxedo/session/local_1/meta", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["global"] }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      sessionID: "local_1",
      tags: ["global"],
    })
  })

  test("a metadata write for a session no runtime has recorded is refused and writes nothing", async () => {
    const res = await SessionMetaRoutes().request("http://localhost/api/claxedo/session/never_recorded/meta", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["global"] }),
    })

    expect(res.status).toBe(404)
    expect(await sessionMeta("never_recorded")).toBeUndefined()
  })

  test("local unsigned mode lists projected session metadata on the local product route", async () => {
    await putSessionMeta("local_list_1", {
      ...runtimeTimes(),
      directory: "/tmp/local-list",
      tags: ["global"],
      title: "Local list row",
    })

    const res = await SessionMetaRoutes().request(
      `http://localhost/api/claxedo/session?directory=${encodeURIComponent("/tmp/local-list")}`,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sessions: [expect.objectContaining({
        sessionID: "local_list_1",
        directory: "/tmp/local-list",
        title: "Local list row",
      })],
    })
  })

  test("an explicit unknown workspace cannot fall back to project or directory metadata", async () => {
    const directory = await worktree(path.join(root, "explicit-workspace-boundary"))
    const ws = await ensureWorkspace({ workspaceId: "ws_meta_boundary", project_id: "ws_project_boundary", directory })
    if (!ws) throw new Error("test workspace was not created")
    await putSessionMeta("meta_boundary_session", { ws, title: "Must remain scoped", ...runtimeTimes() })
    const refreshSessionProjection = vi.fn()
    const app = SessionMetaRoutes({ refreshSessionProjection })
    for (const workspaceId of ["ws_missing", "", "   "]) {
      const query = new URLSearchParams({ workspaceId, directory, projectId: "ws_project_boundary" })
      const response = await app.request(`http://localhost/api/claxedo/session?${query}`)
      expect(response.status).toBe(404)
    }
    const query = new URLSearchParams({ workspaceId: "ws_missing", directory, projectId: "ws_project_boundary" })
    const response = await app.request(`http://localhost/api/claxedo/session/meta_boundary_new/meta?${query}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Must not be written" }),
    })
    expect(response.status).toBe(404)
    expect(await sessionMeta("meta_boundary_new")).toBeUndefined()
    expect(refreshSessionProjection).not.toHaveBeenCalled()
    const valid = await app.request("http://localhost/api/claxedo/session?workspaceId=ws_meta_boundary")
    expect(valid.status).toBe(200)
    expect(await valid.json()).toMatchObject({ sessions: [expect.objectContaining({ sessionID: "meta_boundary_session" })] })
    const project = await app.request("http://localhost/api/claxedo/session?projectId=ws_project_boundary")
    expect(project.status).toBe(200)
    expect(await project.json()).toMatchObject({ sessions: [expect.objectContaining({ sessionID: "meta_boundary_session" })] })
  })

  test("refreshes a resolved workspace snapshot before serving its first session list", async () => {
    const directory = await worktree(path.join(root, `local-refresh-${randomUUID()}`))
    const workspaceId = `ws_local_refresh_${randomUUID()}`
    const resolvedWorkspace = await ensureWorkspace({
      workspaceId,
      directory,
    })
    if (!resolvedWorkspace) throw new Error("test workspace was not created")
    const refreshSessionProjection = vi.fn(async () => {
      await putSessionMeta("local_refresh_1", {
        ...runtimeTimes(),
        ws: resolvedWorkspace,
        title: "Refreshed before list",
      })
    })

    const res = await SessionMetaRoutes({ refreshSessionProjection }).request(
      `http://localhost/api/claxedo/session-list?scope=workspace&workspaceId=${encodeURIComponent(workspaceId)}&limit=10`,
    )

    expect(res.status).toBe(200)
    // A workspace on this machine is addressed by its directory, not by its id.
    await expect(res.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ sessionId: "local_refresh_1", sessionRef: `local:${directory}:session:local_refresh_1` })],
    })
    expect(refreshSessionProjection).toHaveBeenCalledWith(expect.objectContaining({
      id: workspaceId,
      directory,
      kind: "local",
    }))
  })

  // The other arm of the same producer: a provisioner row has no directory on
  // this machine, so its sessions are addressed by workspace id.
  test("addresses a provisioner-placed workspace's sessions by id", async () => {
    const workspaceId = `ws_cloud_refresh_${randomUUID()}`
    const resolvedWorkspace = await ensureWorkspace({
      workspaceId,
      directory: `workspace:${workspaceId}`,
      remote_directory: "/workspace",
      kind: "cloud",
      driver: "modal",
    })
    if (!resolvedWorkspace) throw new Error("test workspace was not created")
    const refreshSessionProjection = vi.fn(async () => {
      await putSessionMeta("cloud_refresh_1", {
        ...runtimeTimes(),
        ws: resolvedWorkspace,
        title: "Cloud row",
      })
    })

    const res = await SessionMetaRoutes({ refreshSessionProjection }).request(
      `http://localhost/api/claxedo/session-list?scope=workspace&workspaceId=${encodeURIComponent(workspaceId)}&limit=10`,
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      items: [expect.objectContaining({
        sessionId: "cloud_refresh_1",
        sessionRef: `workspace:${workspaceId}:session:cloud_refresh_1`,
      })],
    })
    expect(refreshSessionProjection).toHaveBeenCalledWith(expect.objectContaining({
      id: workspaceId,
      kind: "cloud",
    }))
  })

  test("local unsigned mode serves bounded rail pages on the local product route", async () => {
    const directory = `/tmp/local-navigation-${randomUUID()}`
    await putSessionMeta("local_navigation_1", {
      ...runtimeTimes(),
      directory,
      title: "Local navigation one",
    })
    await putSessionMeta("local_navigation_2", {
      ...runtimeTimes(),
      directory,
      title: "Local navigation two",
    })

    const first = await SessionMetaRoutes().request(
      `http://localhost/api/claxedo/session-list?scope=workspace&directory=${encodeURIComponent(directory)}&limit=1`,
    )
    expect(first.status).toBe(200)
    const firstBody = await first.json() as {
      items: Array<{ sessionId: string; directory: string }>
      nextCursor?: string
      totalKnown: number
    }
    expect(firstBody.items).toHaveLength(1)
    expect(firstBody.items[0]?.directory).toBe(directory)
    expect(firstBody.totalKnown).toBe(2)
    expect(firstBody.nextCursor).toEqual(expect.any(String))

    const second = await SessionMetaRoutes().request(
      `http://localhost/api/claxedo/session-list?scope=workspace&directory=${encodeURIComponent(directory)}&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
    )
    expect(second.status).toBe(200)
    const secondBody = await second.json() as {
      items: Array<{ sessionId: string }>
      nextCursor?: string
    }
    expect(secondBody.items).toHaveLength(1)
    expect(new Set([...firstBody.items, ...secondBody.items].map((item) => item.sessionId))).toEqual(
      new Set(["local_navigation_1", "local_navigation_2"]),
    )
    expect(secondBody.nextCursor).toBeUndefined()
  })

  test("a project page is one order across the project's workspaces, each reconciled first", async () => {
    const projectId = `proj_local_pages_${randomUUID()}`
    const workspaces = await Promise.all(["one", "two"].map(async (name) => {
      const directory = await worktree(path.join(root, `local-project-${name}-${randomUUID()}`))
      const workspace = await ensureWorkspace({ workspaceId: `ws_${name}_${randomUUID()}`, project_id: projectId, directory })
      if (!workspace) throw new Error("test workspace was not created")
      return workspace
    }))
    for (const [index, workspace] of [...workspaces, ...workspaces, ...workspaces].entries()) {
      await putSessionMeta(`ses_project_${index}`, { ws: workspace, title: `Session ${index}`, ...runtimeTimes() })
    }
    const refreshSessionProjection = vi.fn(async (_workspace: { id: string }) => {})
    const routes = SessionMetaRoutes({ refreshSessionProjection })
    const listed: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const res = await routes.request(
        `http://localhost/api/claxedo/session-list?scope=project&projectId=${projectId}&sort=human_turn_desc&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { items: Array<{ sessionId: string }>; nextCursor?: string }
      listed.push(...body.items.map((item) => item.sessionId))
      cursor = body.nextCursor
      pages++
    } while (cursor && pages < 10)

    expect(pages).toBe(3)
    expect(new Set(listed)).toEqual(new Set([0, 1, 2, 3, 4, 5].map((index) => `ses_project_${index}`)))
    expect(listed).toHaveLength(6)
    expect(refreshSessionProjection.mock.calls.map(([workspace]) => workspace.id))
      .toEqual(expect.arrayContaining(workspaces.map((workspace) => workspace.id)))
  })

  test("pages the rail past a parent's children without listing one or retiring the cursor early", async () => {
    const directory = `/tmp/local-navigation-children-${randomUUID()}`
    await putSessionMeta("child_parent_1", { directory, title: "First root", ...runtimeTimes() })
    await putSessionMeta("child_parent_2", { directory, title: "Second root", ...runtimeTimes() })
    for (const parent of ["child_parent_1", "child_parent_2"]) {
      await putSessionMeta(`${parent}_child`, { directory, title: `Child of ${parent}`, parentID: parent, ...runtimeTimes() })
    }

    const listed: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 4; page += 1) {
      const url = `http://localhost/api/claxedo/session-list?scope=workspace&directory=${encodeURIComponent(directory)}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      const res = await SessionMetaRoutes().request(url)
      expect(res.status).toBe(200)
      const body = await res.json() as { items: Array<{ sessionId: string }>; nextCursor?: string }
      listed.push(...body.items.map((item) => item.sessionId))
      cursor = body.nextCursor
      if (!cursor) break
    }

    expect(listed).toEqual(["child_parent_2", "child_parent_1"])
    expect(cursor).toBeUndefined()
  })

  test("signed cloud mode rejects missing bearer tokens", async () => {
    const { app } = buildApp()
    const res = await app.request("http://localhost/api/claxedo/session/sess_1/meta")

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: { code: "missing_bearer_token" },
    })
  })

  test("a signed project list is the authority's keyset page for the project, authorized per row", async () => {
    const svc = services()
    const listSessionPage = vi.fn(async () => [
      { session_id: "ses_b", workspace_id: "ws_two", project_id: "proj_pages", created_at: 2, updated_at: 2, last_human_turn_at: 9 },
      { session_id: "ses_a", workspace_id: "ws_one", project_id: "proj_pages", created_at: 1, updated_at: 1 },
    ])
    Object.assign(svc.authority!, { listSessionPage, countSessions: vi.fn(async () => (2)) })

    const res = await buildApp(svc).app.request(
      "http://localhost/api/claxedo/session-list?scope=project&projectId=proj_pages&sort=human_turn_desc&limit=1",
      { headers: { Authorization: "Bearer user_1" } },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { items: Array<{ sessionRef: string }>; nextCursor?: string }
    expect(body.items.map((item) => item.sessionRef)).toEqual(["workspace:ws_two:session:ses_b"])
    expect(body.nextCursor).toBeTypeOf("string")
    expect(listSessionPage).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }), {
      projectId: "proj_pages",
      ownership: "all",
      seen: "all",
      settled: "active",
      sort: "human_turn_desc",
      archived: "active",
      limit: 2,
    })
    expect(svc.authority?.listWorkspaces).not.toHaveBeenCalled()
  })

  test("a signed workspace list pages the workspace its directory names", async () => {
    const directory = await worktree(path.join(root, `signed-workspace-${randomUUID()}`))
    await ensureWorkspace({ workspaceId: "ws_signed_page", project_id: "proj_signed_page", directory })
    const svc = services()
    const listSessionPage = vi.fn(async () => [])
    Object.assign(svc.authority!, { listSessionPage, countSessions: vi.fn(async () => (0)) })

    const res = await buildApp(svc).app.request(
      `http://localhost/api/claxedo/session-list?scope=workspace&directory=${encodeURIComponent(directory)}&limit=5`,
      { headers: { Authorization: "Bearer user_1" } },
    )

    expect(res.status).toBe(200)
    expect(listSessionPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws_signed_page" }))
  })

  test("signed cloud mode honors an explicitly composed auth config", async () => {
    const old = {
      CLAXEDO_SIGNED_CLOUD_AUTH: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
    }
    delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
    try {
      const res = await SessionMetaRoutes({
        services: services(),
        verifier,
        authConfig: {
          enabled: true,
          adapter: "custom",
          issuer: "https://idp.example.test",
          jwksUrl: "https://idp.example.test/.well-known/jwks.json",
        },
      }).request("http://localhost/api/claxedo/session/sess_env/meta")
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({
        error: { code: "missing_bearer_token" },
      })
    } finally {
      restoreEnv(old)
    }
  })

  test("signed reads require authority session visibility", async () => {
    await putSessionMeta("sess_read", {
      ...runtimeTimes(),
      ws: {
        id: "ws_1",
        project_id: "proj_1",
        directory: "/tmp/read",
        kind: "cloud",
        created_at: 1,
        updated_at: 1,
      },
      tags: ["global"],
    })
    const { app, svc } = buildApp()
    const res = await app.request("http://localhost/api/claxedo/session/sess_read/meta", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      sessionID: "sess_read",
      workspaceID: "ws_1",
      tags: ["global"],
    })
    expect(body.directory).toBeUndefined()
    expect(svc.authority?.usersMe).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }))
    expect(svc.authority?.authorizeSessionRead).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      {
        sessionId: "sess_read",
        workspaceId: "ws_1",
      },
    )
  })

  test("signed reads redact local-only absolute directories", async () => {
    await putSessionMeta("sess_path", {
      ...runtimeTimes(),
      ws: {
        id: "ws_1",
        project_id: "proj_1",
        directory: "/Users/example/private/repo",
        kind: "cloud",
        created_at: 1,
        updated_at: 1,
      },
      tags: ["global"],
    })
    const { app } = buildApp()
    const res = await app.request("http://localhost/api/claxedo/session/sess_path/meta", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("/Users/example/private/repo")
    expect(body).toMatchObject({
      sessionID: "sess_path",
      workspaceID: "ws_1",
      projectID: "proj_1",
      tags: ["global"],
      attachments: [],
    })
    expect(body.directory).toBeUndefined()
  })

  test("signed writes resolve directory and authorize workspace through the authority", async () => {
    const dir = await worktree(path.join(root, "repo"))
    await ensureWorkspace({
      workspaceId: "ws_1",
      project_id: "proj_1",
      directory: dir,
    })
    await putSessionMeta("sess_write", { workspaceID: "ws_1", directory: dir, ...runtimeTimes() })
    const { app, svc } = buildApp()
    const res = await app.request(`http://localhost/api/claxedo/session/sess_write/meta?workspaceId=ws_1&directory=${encodeURIComponent(dir)}`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: ["global"] }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      sessionID: "sess_write",
      workspaceID: "ws_1",
      tags: ["global"],
    })
    expect(body.directory).toBeUndefined()
    expect(svc.authority?.openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      { workspaceId: "ws_1" },
    )
    expect(await sessionMeta("sess_write")).toMatchObject({
      workspaceID: "ws_1",
    })
  })

  test("signed writes fail closed without workspace context", async () => {
    const { app } = buildApp()
    const res = await app.request("http://localhost/api/claxedo/session/orphan/meta", {
      method: "PUT",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: ["global"] }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { code: "workspace_authorization_denied" },
    })
  })
})
