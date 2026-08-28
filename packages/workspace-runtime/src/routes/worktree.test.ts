import { describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import type { WorkspaceWorktreeRecord } from "../store"
import type { WorkspaceWorktreeManager } from "../worktree"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { managedWorkspaceSessionAccessPolicy } from "../session-access-policy"
import { WorktreeRoutes } from "./worktree"

function record(sessionId: string): WorkspaceWorktreeRecord {
  return {
    workspaceId: "ws_1",
    sessionId,
    branch: `claxedo/session/${sessionId}`,
    baseCommit: "a".repeat(40),
    path: `/worktrees/${sessionId}`,
    state: "active",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  }
}

function relayAuth(role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"] = "editor"):
  NonNullable<RelayHostAuthContext["relayHostAuth"]> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: "workspace-relay",
    aud: "workspace-host-service",
    principal_kind: "user",
    actor_id: "actor_1",
    actor_kind: "human",
    org_id: "org_1",
    workspace_id: "ws_1",
    host_id: "host_1",
    role,
    access: "cloud",
    backing: "cloud-vm",
    exp: now + 60,
    iat: now,
    jti: "jti_1",
    parent_jti: "rat_jti_1",
  }
}

function fixture() {
  const records = [record("ses_visible"), record("ses_private")]
  const manager = {
    list: mock(() => records),
    get: mock((sessionId: string) => records.find((item) => item.sessionId === sessionId)),
    ensure: mock(async ({ sessionId }: { sessionId: string }) => record(sessionId)),
  } as unknown as WorkspaceWorktreeManager
  return { manager }
}

function managedApp(
  manager: WorkspaceWorktreeManager,
  options: { role?: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"]; withPolicy?: boolean } = {},
) {
  const app = new Hono<{ Variables: RelayHostAuthContext }>()
  app.use("*", async (c, next) => {
    c.set("relayHostAuth", relayAuth(options.role))
    return await next()
  })
  const policy = managedWorkspaceSessionAccessPolicy({
    requireActor: true,
    authorizeSessionRead: ({ sessionId }) => sessionId === "ses_visible",
    authorizeSessionWrite: ({ sessionId }) => sessionId === "ses_visible",
    registerSession: () => true,
  })
  app.route("/", WorktreeRoutes(manager, options.withPolicy === false ? {} : { sessionAccessPolicy: policy }))
  return app
}

describe("WorktreeRoutes managed private-session access", () => {
  test("filters list results and authorizes exact get targets", async () => {
    const { manager } = fixture()
    const app = managedApp(manager)

    const list = await app.request("http://localhost/")
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toEqual({ worktrees: [record("ses_visible")] })

    expect((await app.request("http://localhost/ses_visible")).status).toBe(200)
    const denied = await app.request("http://localhost/ses_private")
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "session_private" } })
  })

  test("authorizes create before manager mutation and denies viewer writes", async () => {
    const { manager } = fixture()
    const ensure = manager.ensure as ReturnType<typeof mock>
    const denied = await managedApp(manager).request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_private" }),
    })
    expect(denied.status).toBe(403)
    expect(ensure).not.toHaveBeenCalled()

    const viewer = await managedApp(manager, { role: "viewer" }).request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_visible" }),
    })
    expect(viewer.status).toBe(403)
    expect(ensure).not.toHaveBeenCalled()

    const created = await managedApp(manager).request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_visible" }),
    })
    expect(created.status).toBe(201)
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  test("fails closed for a verified remote caller when the selected policy is unavailable", async () => {
    const { manager } = fixture()
    const response = await managedApp(manager, { withPolicy: false }).request("http://localhost/")
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_authority_required" } })
  })

  test("preserves unmanaged local list, get, and create behavior", async () => {
    const { manager } = fixture()
    const app = WorktreeRoutes(manager)
    expect((await app.request("http://localhost/")).status).toBe(200)
    expect((await app.request("http://localhost/ses_private")).status).toBe(200)
    expect((await app.request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_private" }),
    })).status).toBe(201)
  })
})
