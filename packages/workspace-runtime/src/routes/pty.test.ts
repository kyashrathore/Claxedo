import { afterEach, describe, expect, test } from "bun:test"
import type { UpgradeWebSocket } from "hono/ws"
import { PtyRoutes } from "./pty"
import { Pty } from "../pty/index"
import { errorBody, JSON_BODY_LIMIT_BYTES } from "./http"

const upgradeWebSocket = (() => () => new Response(null, { status: 501 })) as unknown as UpgradeWebSocket
const previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY

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
