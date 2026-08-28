import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { PtyRoutes } from "./pty"
import { Pty } from "../pty/index"
import { errorBody, JSON_BODY_LIMIT_BYTES } from "./http"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"

const upgradeWebSocket = (() => () => new Response(null, { status: 501 })) as unknown as UpgradeWebSocket
const previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY

function relayAuth(role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"]): NonNullable<RelayHostAuthContext["relayHostAuth"]> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: "workspace-relay",
    aud: "workspace-host-service",
    principal_kind: "user",
    actor_id: "user_1",
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

function appForRole(role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"]) {
  const app = new Hono<{ Variables: RelayHostAuthContext }>()
  app.use("*", async (c, next) => {
    c.set("relayHostAuth", relayAuth(role))
    return await next()
  })
  app.route("/", PtyRoutes(upgradeWebSocket))
  return app
}

afterEach(() => {
  if (previousDirectory === undefined) {
    delete process.env.WORKSPACE_RUNTIME_DIRECTORY
  } else {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = previousDirectory
  }
})

describe("PtyRoutes", () => {
  test("accepts initialCommand on create requests", () => {
    expect(Pty.CreateInput.safeParse({ title: "Claude", initialCommand: "claude" }).success).toBe(true)
  })

  test("commits a PTY only after the public create path succeeds", async () => {
    const info = {
      id: "pty_committed",
      title: "Terminal",
      command: "/bin/sh",
      args: [],
      cwd: "/tmp",
      status: "running" as const,
      pid: 123,
    }
    const create = spyOn(Pty, "create").mockResolvedValue(info)
    const commit = spyOn(Pty, "commit").mockReturnValue(info)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = "/tmp"
    try {
      const response = await PtyRoutes(upgradeWebSocket).request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": "/tmp" },
        body: JSON.stringify({ title: "Terminal" }),
      })

      expect(response.status).toBe(200)
      expect(create).toHaveBeenCalledTimes(1)
      expect(commit).toHaveBeenCalledWith(info.id)
    } finally {
      create.mockRestore()
      commit.mockRestore()
    }
  })

  test("returns structured validation and not-found errors", async () => {
    const app = PtyRoutes(upgradeWebSocket)

    const create = await app.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: { BAD: 1 } }),
    })
    expect(create.status).toBe(400)
    const createBody = await create.json() as { error?: { code?: string; message?: string; details?: unknown } }
    expect(createBody.error?.code).toBe("pty_invalid_input")
    expect(createBody.error?.message).toBe("Invalid PTY request body")
    expect(createBody.error?.details).toBeDefined()

    const get = await app.request("http://localhost/pty_missing")
    expect(get.status).toBe(404)
    await expect(get.json()).resolves.toEqual({
      error: {
        code: "pty_session_not_found",
        message: "Session not found",
      },
    })

    const update = await app.request("http://localhost/pty_missing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(update.status).toBe(404)
    await expect(update.json()).resolves.toEqual({
      error: {
        code: "pty_session_not_found",
        message: "Session not found",
      },
    })
  })

  test("denies every terminal route to authenticated viewers", async () => {
    const app = appForRole("viewer")

    const list = await app.request("http://localhost/")
    const connect = await app.request("http://localhost/pty_1/connect", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
      },
    })

    expect(list.status).toBe(403)
    expect(connect.status).toBe(403)
    await expect(connect.json()).resolves.toEqual({
      error: {
        code: "relay_role_denied",
        message: "Workspace role does not allow terminal access",
      },
    })
  })

  test("allows terminal routes for authenticated editors", async () => {
    const res = await appForRole("editor").request("http://localhost/")

    expect(res.status).toBe(200)
  })

  test("rejects create requests outside the pinned workspace before spawning", async () => {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = "/tmp/workspace-runtime-pty"
    const app = PtyRoutes(upgradeWebSocket)

    const wrongDirectory = await app.request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": "/tmp/other",
      },
      body: JSON.stringify({ title: "bad" }),
    })
    expect(wrongDirectory.status).toBe(400)
    await expect(wrongDirectory.json()).resolves.toEqual({
      error: {
        code: "pty_invalid_directory",
        message: "PTY directory must match configured workspace",
      },
    })

    const absoluteCwd = await app.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp/workspace-runtime-pty" }),
    })
    expect(absoluteCwd.status).toBe(400)
    await expect(absoluteCwd.json()).resolves.toEqual({
      error: {
        code: "pty_invalid_path",
        message: "workspace path must be relative",
      },
    })
  })

  test("rejects oversized PTY request bodies before validation", async () => {
    const app = PtyRoutes(upgradeWebSocket)
    const res = await app.request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(JSON_BODY_LIMIT_BYTES + 1),
      },
      body: JSON.stringify({ title: "big" }),
    })

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toEqual(errorBody("request_body_too_large", "Request body is too large"))
  })
})
