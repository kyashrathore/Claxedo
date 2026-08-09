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

function services(): ControlPlaneServicesContract {
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
