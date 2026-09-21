import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "fs"
import { execFileSync } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { localOnlyAuthAdapter, type ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
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
const { putSessionMeta, sessionMeta, listSessionMetas } = await import("@claxedo/server-core/session/meta/index")
const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")
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
      // Participant-scoped list in production; for these route tests the local
      // projection store is the seeded source of truth for which sessions exist.
      listSessions: vi.fn(async (_auth, args: { workspaceId: string }) =>
        (await listSessionMetas({ workspaceID: args.workspaceId })).map((row) => ({
          session_id: row.sessionID,
          workspace_id: row.workspaceID,
          project_id: row.projectID,
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
    process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
    process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
  })

  test("local unsigned mode remains available when signed auth is disabled", async () => {
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

  test("local unsigned mode lists projected session metadata on the local product route", async () => {
    await putSessionMeta("local_list_1", {
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
    await putSessionMeta("meta_boundary_session", { ws, title: "Must remain scoped" })
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
      driver: "daytona",
    })
    if (!resolvedWorkspace) throw new Error("test workspace was not created")
    const refreshSessionProjection = vi.fn(async () => {
      await putSessionMeta("cloud_refresh_1", {
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
      directory,
      title: "Local navigation one",
    })
    await putSessionMeta("local_navigation_2", {
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

  test("pages the rail past a parent's children without listing one or retiring the cursor early", async () => {
    const directory = `/tmp/local-navigation-children-${randomUUID()}`
    await putSessionMeta("child_parent_1", { directory, title: "First root" })
    await putSessionMeta("child_parent_2", { directory, title: "Second root" })
    for (const parent of ["child_parent_1", "child_parent_2"]) {
      await putSessionMeta(`${parent}_child`, { directory, title: `Child of ${parent}`, parentID: parent })
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

  test("keeps children out of the grouped rail read, which pages from the unbounded store", async () => {
    const directory = `/tmp/local-navigation-grouped-${randomUUID()}`
    await putSessionMeta("grouped_parent", { directory, title: "Grouped root" })
    await putSessionMeta("grouped_child", { directory, title: "Grouped child", parentID: "grouped_parent" })

    const res = await SessionMetaRoutes().request(
      `http://localhost/api/claxedo/session-list?scope=workspace&directory=${encodeURIComponent(directory)}&groupBy=workspace&limit=10`,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { groups: Array<{ items: Array<{ sessionId: string }> }> }
    expect(body.groups.flatMap((group) => group.items.map((item) => item.sessionId))).toEqual(["grouped_parent"])
  })

  test("signed cloud mode rejects missing bearer tokens", async () => {
    const { app } = buildApp()
    const res = await app.request("http://localhost/api/claxedo/session/sess_1/meta")

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: { code: "missing_bearer_token" },
    })
  })

  test("signed project-scoped session lists authorize ws-shaped project identities", async () => {
    const directory = await worktree(path.join(root, `signed-navigation-${randomUUID()}`))
    await ensureWorkspace({
      workspaceId: "ws_signed_navigation",
      project_id: "ws_signed_navigation",
      directory,
    })
    await putSessionMeta("signed_navigation_1", {
      ws: {
        id: "ws_signed_navigation",
        project_id: "ws_signed_navigation",
        directory,
        kind: "local",
        created_at: 1,
        updated_at: 1,
      },
      title: "Signed navigation row",
    })
    const svc = services({ workspaces: [{
      workspace_id: "ws_signed_navigation",
      project_id: "ws_signed_navigation",
    }] })
    const { app } = buildApp(svc)
    const res = await app.request(
      "http://localhost/api/claxedo/session-list?scope=project&projectId=ws_signed_navigation&limit=5",
      {
        headers: {
          Authorization: "Bearer user_1",
          "x-claxedo-directory": "workspace:ws_signed_navigation",
        },
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ sessionId: "signed_navigation_1", workspaceId: "ws_signed_navigation" })],
    })
    expect(svc.authority?.listWorkspaces).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }))
    expect(svc.authority?.openWorkspace).not.toHaveBeenCalled()
  })

  test("signed project-scoped session lists resolve canonical project identities", async () => {
    const directory = await worktree(path.join(root, `signed-project-${randomUUID()}`))
    await ensureWorkspace({
      workspaceId: "ws_signed_project",
      project_id: "proj_signed_project",
      directory,
    })
    await putSessionMeta("signed_project_1", {
      ws: {
        id: "ws_signed_project",
        project_id: "proj_signed_project",
        directory,
        kind: "local",
        created_at: 1,
        updated_at: 1,
      },
      title: "Signed project row",
    })
    const svc = services({ workspaces: [{
      workspace_id: "ws_signed_project",
      project_id: "proj_signed_project",
    }] })
    const { app } = buildApp(svc)
    const res = await app.request(
      "http://localhost/api/claxedo/session-list?scope=project&projectId=proj_signed_project&limit=5",
      { headers: { Authorization: "Bearer user_1" } },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ sessionId: "signed_project_1", workspaceId: "ws_signed_project" })],
    })
    expect(svc.authority?.listWorkspaces).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }))
    expect(svc.authority?.openWorkspace).not.toHaveBeenCalled()
  })

  test("signed project lists exclude sibling workspaces the principal cannot read", async () => {
    const projectId = `proj_signed_siblings_${randomUUID()}`
    const allowedWorkspaceId = `ws_allowed_${randomUUID()}`
    const deniedWorkspaceId = `ws_denied_${randomUUID()}`
    const allowedDirectory = await worktree(path.join(root, allowedWorkspaceId))
    const deniedDirectory = await worktree(path.join(root, deniedWorkspaceId))
    await ensureWorkspace({ workspaceId: allowedWorkspaceId, project_id: projectId, directory: allowedDirectory })
    await ensureWorkspace({ workspaceId: deniedWorkspaceId, project_id: projectId, directory: deniedDirectory })
    await putSessionMeta(`ses_${allowedWorkspaceId}`, {
      ws: { id: allowedWorkspaceId, project_id: projectId, directory: allowedDirectory, kind: "local", created_at: 1, updated_at: 1 },
      title: "Allowed sibling",
    })
    await putSessionMeta(`ses_${deniedWorkspaceId}`, {
      ws: { id: deniedWorkspaceId, project_id: projectId, directory: deniedDirectory, kind: "local", created_at: 1, updated_at: 1 },
      title: "Denied sibling",
    })
    const svc = services({ workspaces: [{
      workspace_id: allowedWorkspaceId,
      project_id: projectId,
    }] })

    const res = await buildApp(svc).app.request(
      `http://localhost/api/claxedo/session-list?scope=project&projectId=${encodeURIComponent(projectId)}&limit=10`,
      { headers: { Authorization: "Bearer user_1" } },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { items: Array<{ sessionId: string; workspaceId?: string }> }
    expect(body.items).toEqual([
      expect.objectContaining({ sessionId: `ses_${allowedWorkspaceId}`, workspaceId: allowedWorkspaceId }),
    ])
    expect(JSON.stringify(body)).not.toContain(deniedWorkspaceId)
  })

  test("signed project lists include every sibling workspace the principal can read", async () => {
    const projectId = `proj_signed_allowed_siblings_${randomUUID()}`
    const workspaceIds = [`ws_first_${randomUUID()}`, `ws_second_${randomUUID()}`]
    for (const [index, workspaceId] of workspaceIds.entries()) {
      const directory = await worktree(path.join(root, workspaceId))
      await ensureWorkspace({ workspaceId, project_id: projectId, directory })
      await putSessionMeta(`ses_${workspaceId}`, {
        ws: { id: workspaceId, project_id: projectId, directory, kind: "local", created_at: index + 1, updated_at: index + 1 },
        title: `Allowed sibling ${index + 1}`,
      })
    }
    const svc = services({ workspaces: workspaceIds.map((workspaceId) => ({
      workspace_id: workspaceId,
      project_id: projectId,
    })) })

    const res = await buildApp(svc).app.request(
      `http://localhost/api/claxedo/session-list?scope=project&projectId=${encodeURIComponent(projectId)}&limit=10`,
      { headers: { Authorization: "Bearer user_1" } },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { items: Array<{ sessionId: string }> }
    expect(new Set(body.items.map((item) => item.sessionId))).toEqual(
      new Set(workspaceIds.map((workspaceId) => `ses_${workspaceId}`)),
    )
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
