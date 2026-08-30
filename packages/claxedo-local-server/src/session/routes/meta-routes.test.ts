import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { localOnlyAuthAdapter, type ClerkVerifier } from "@claxedo/server-core/platform/auth/auth"
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
const { putSessionMeta, sessionMeta } = await import("@claxedo/server-core/session/meta/index")
const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")
const { SessionMetaRoutes } = await import("./meta-routes")
ClaxedoDB.Drizzle()

const authConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
} as const

const verifier: ClerkVerifier = async (token, config) => ({
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
    extensionPolicy: {},
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: true },
    authority: {
      usersMe: vi.fn(async () => ({})),
      authorizeSessionRead: vi.fn(async () => {}),
      listWorkspaces: vi.fn(async () => input.workspaces ?? []),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "member",
        workspace: {
          workspace_id: "ws_1",
          backing: "cloud-vm" as const,
          access: "cloud" as const,
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

  test("refreshes a resolved workspace snapshot before serving its first session list", async () => {
    const directory = path.join(root, `local-refresh-${randomUUID()}`)
    await fs.mkdir(directory, { recursive: true })
    const workspaceId = `ws_local_refresh_${randomUUID()}`
    const resolvedWorkspace = await ensureWorkspace({
      workspaceId,
      directory,
      kind: "cloud",
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
    await expect(res.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ sessionId: "local_refresh_1", sessionRef: `workspace:${workspaceId}:session:local_refresh_1` })],
    })
    expect(refreshSessionProjection).toHaveBeenCalledWith(expect.objectContaining({
      id: workspaceId,
      directory,
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

  test("signed cloud mode rejects missing bearer tokens", async () => {
    const { app } = buildApp()
    const res = await app.request("http://localhost/api/claxedo/session/sess_1/meta")

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: { code: "missing_bearer_token" },
    })
  })

  test("signed project-scoped session lists authorize ws-shaped project identities", async () => {
    const directory = path.join(root, `signed-navigation-${randomUUID()}`)
    await fs.mkdir(directory, { recursive: true })
    await ensureWorkspace({
      workspaceId: "ws_signed_navigation",
      project_id: "ws_signed_navigation",
      directory,
      kind: "cloud",
    })
    await putSessionMeta("signed_navigation_1", {
      ws: {
        id: "ws_signed_navigation",
        project_id: "ws_signed_navigation",
        directory,
        kind: "cloud",
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
          "x-opencode-directory": "workspace:ws_signed_navigation",
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
    const directory = path.join(root, `signed-project-${randomUUID()}`)
    await fs.mkdir(directory, { recursive: true })
    await ensureWorkspace({
      workspaceId: "ws_signed_project",
      project_id: "proj_signed_project",
      directory,
      kind: "cloud",
    })
    await putSessionMeta("signed_project_1", {
      ws: {
        id: "ws_signed_project",
        project_id: "proj_signed_project",
        directory,
        kind: "cloud",
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
    const allowedDirectory = path.join(root, allowedWorkspaceId)
    const deniedDirectory = path.join(root, deniedWorkspaceId)
    await Promise.all([
      fs.mkdir(allowedDirectory, { recursive: true }),
      fs.mkdir(deniedDirectory, { recursive: true }),
    ])
    await ensureWorkspace({ workspaceId: allowedWorkspaceId, project_id: projectId, directory: allowedDirectory, kind: "cloud" })
    await ensureWorkspace({ workspaceId: deniedWorkspaceId, project_id: projectId, directory: deniedDirectory, kind: "cloud" })
    await putSessionMeta(`ses_${allowedWorkspaceId}`, {
      ws: { id: allowedWorkspaceId, project_id: projectId, directory: allowedDirectory, kind: "cloud", created_at: 1, updated_at: 1 },
      title: "Allowed sibling",
    })
    await putSessionMeta(`ses_${deniedWorkspaceId}`, {
      ws: { id: deniedWorkspaceId, project_id: projectId, directory: deniedDirectory, kind: "cloud", created_at: 1, updated_at: 1 },
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
      const directory = path.join(root, workspaceId)
      await fs.mkdir(directory, { recursive: true })
      await ensureWorkspace({ workspaceId, project_id: projectId, directory, kind: "cloud" })
      await putSessionMeta(`ses_${workspaceId}`, {
        ws: { id: workspaceId, project_id: projectId, directory, kind: "cloud", created_at: index + 1, updated_at: index + 1 },
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

  test("signed cloud mode honors environment auth config without injected options", async () => {
    const old = {
      CLAXEDO_SIGNED_CLOUD_AUTH: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
      CLERK_JWT_ISSUER: process.env.CLERK_JWT_ISSUER,
      CLERK_JWKS_URL: process.env.CLERK_JWKS_URL,
      CLAXEDO_WORKSPACE_AUTHORITY_URL: process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL,
    }
    process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
    process.env.CLERK_JWT_ISSUER = "https://clerk.example.test"
    process.env.CLERK_JWKS_URL = "https://clerk.example.test/.well-known/jwks.json"
    process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = "https://convex.example.test"
    try {
      const res = await SessionMetaRoutes({
        services: services(),
        verifier,
      }).request("http://localhost/api/claxedo/session/sess_env/meta")
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({
        error: { code: "missing_bearer_token" },
      })
    } finally {
      restoreEnv(old)
    }
  })

  test("signed reads require Convex session visibility", async () => {
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

  test("signed writes resolve directory and authorize workspace through Convex", async () => {
    const dir = path.join(root, "repo")
    await fs.mkdir(dir, { recursive: true })
    await ensureWorkspace({
      workspaceId: "ws_1",
      project_id: "proj_1",
      directory: dir,
      kind: "cloud",
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
