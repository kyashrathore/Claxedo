import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono, type Context } from "hono"
import type { UpgradeWebSocket, WSEvents, WSContext } from "hono/ws"
import { PtyRoutes } from "./pty"
import { Pty } from "../pty/index"
import { errorBody, JSON_BODY_LIMIT_BYTES } from "./http"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "../session-access-policy"
import { createDiskHistory } from "../pty/history-disk"

const upgradeWebSocket = (() => () => new Response(null, { status: 501 })) as unknown as UpgradeWebSocket
const previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY
const previousHistoryDirectory = process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR

function relayAuth(
  role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"],
  actorId = "user_1",
): NonNullable<RelayHostAuthContext["relayHostAuth"]> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: "workspace-relay",
    aud: "workspace-host-service",
    principal_kind: "user",
    actor_id: actorId,
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

function privateSessionPolicy(owners: Record<string, string>): SessionAccessPolicy {
  const allowed = (actorId: string | undefined, sessionId: string | undefined) =>
    !!sessionId && owners[sessionId] === actorId
  const policy: SessionAccessPolicy = {
    sessionAuthority: "managed-private",
    authorize: async (input) => allowed(input.actor?.actorId, input.sessionId)
      ? { allowed: true }
      : { allowed: false, status: 403, code: "private_session", message: "Session is private" },
    filterSessions: async (input) => input.sessionIds.filter((sessionId) => allowed(input.actor?.actorId, sessionId)),
    authorizePrefix: async () => ({ allowed: true }),
  }
  policy.authorizeStream = async (input, lease) => allowed(input.actor?.actorId, input.sessionId)
    ? { allowed: true, lease: lease ?? "terminal-capability", expiresAt: Date.now() + 15_000 }
    : { allowed: false, status: 403, code: "private_session", message: "Session is private" }
  return policy
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

function appForActor(actorId: string, policy: SessionAccessPolicy) {
  const app = new Hono<{ Variables: RelayHostAuthContext }>()
  app.use("*", async (c, next) => {
    c.set("relayHostAuth", relayAuth("editor", actorId))
    return await next()
  })
  app.route("/", PtyRoutes(upgradeWebSocket, undefined, policy))
  return app
}

afterEach(() => {
  if (previousDirectory === undefined) {
    delete process.env.WORKSPACE_RUNTIME_DIRECTORY
  } else {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = previousDirectory
  }
  if (previousHistoryDirectory === undefined) delete process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR
  else process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = previousHistoryDirectory
})

describe("PtyRoutes", () => {
  test("accepts initialCommand on create requests", () => {
    expect(Pty.CreateInput.safeParse({ title: "Claude", initialCommand: "claude" }).success).toBe(true)
  })

  test("carries the opaque create request id through create and list DTOs", async () => {
    const info = {
      id: "pty_correlated",
      sessionId: "session_a",
      createRequestId: "request-client-a",
      title: "Terminal",
      command: "/bin/sh",
      args: [],
      cwd: "/tmp",
      status: "running" as const,
      pid: 123,
    } satisfies Pty.Info
    const create = spyOn(Pty, "create").mockImplementation(async (input) => ({
      ...info,
      createRequestId: input.createRequestId,
    }))
    const commit = spyOn(Pty, "commit").mockReturnValue(info)
    const list = spyOn(Pty, "list").mockReturnValue([info])
    process.env.WORKSPACE_RUNTIME_DIRECTORY = "/tmp"
    try {
      const created = await PtyRoutes(upgradeWebSocket).request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": "/tmp" },
        body: JSON.stringify({
          sessionId: "session_a",
          createRequestId: "request-client-a",
          title: "Terminal",
        }),
      })

      expect(created.status).toBe(200)
      await expect(created.json()).resolves.toMatchObject({ createRequestId: "request-client-a" })
      expect(create.mock.calls[0]?.[0]).toMatchObject({ createRequestId: "request-client-a" })
      await expect((await PtyRoutes(upgradeWebSocket).request("http://localhost/")).json()).resolves.toEqual([info])
    } finally {
      create.mockRestore()
      commit.mockRestore()
      list.mockRestore()
    }
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

  test("isolates PTY list, detail, scrollback connect, and delete between editors", async () => {
    const info = (id: string, sessionId?: string): Pty.Info => ({
      id,
      ...(sessionId ? { sessionId } : {}),
      title: id,
      command: "/bin/sh",
      args: [],
      cwd: "/workspace",
      status: "running",
      pid: 1,
    })
    const rows = [info("pty_a", "session_a"), info("pty_b", "session_b"), info("pty_local")]
    const list = spyOn(Pty, "list").mockReturnValue(rows)
    const get = spyOn(Pty, "get").mockImplementation((id) => rows.find((row) => row.id === id))
    const remove = spyOn(Pty, "remove").mockResolvedValue(undefined)
    const policy = privateSessionPolicy({ session_a: "editor_a", session_b: "editor_b" })

    try {
      const editorA = appForActor("editor_a", policy)
      const editorB = appForActor("editor_b", policy)

      await expect((await editorA.request("http://localhost/")).json()).resolves.toEqual([rows[0]])
      await expect((await editorB.request("http://localhost/")).json()).resolves.toEqual([rows[1]])

      expect((await editorA.request("http://localhost/pty_b")).status).toBe(403)
      expect((await editorA.request("http://localhost/pty_b/connect", {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      })).status).toBe(403)
      expect((await editorA.request("http://localhost/pty_b", { method: "DELETE" })).status).toBe(403)
      expect(remove).not.toHaveBeenCalled()

      expect((await editorB.request("http://localhost/pty_b")).status).toBe(200)
      expect((await editorB.request("http://localhost/pty_b/connect", {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      })).status).toBe(501)
      expect((await editorB.request("http://localhost/pty_b", { method: "DELETE" })).status).toBe(200)
      expect(remove).toHaveBeenCalledWith("pty_b")
    } finally {
      list.mockRestore()
      get.mockRestore()
      remove.mockRestore()
    }
  })

  test("closes a passive PTY reader within the bounded authorization refresh after access is revoked", async () => {
    let events: WSEvents | undefined
    let allowed = true
    let guardedSocket: Parameters<typeof Pty.connect>[1] | undefined
    const rawSocket = {
      readyState: 1,
      bufferedAmount: 0,
      send: spyOn({ call() {} }, "call"),
      close: spyOn({ call(_code?: number, _reason?: string) {} }, "call"),
    }
    const disconnected = spyOn({ call() {} }, "call")
    const streamLeases: Array<string | undefined> = []
    const upgrade = ((createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => async (c: Context) => {
      events = await createEvents(c)
      return new Response(null, { status: 200 })
    }) as unknown as UpgradeWebSocket
    const info: Pty.Info = {
      id: "pty_private",
      sessionId: "session_private",
      title: "Private terminal",
      command: "/bin/sh",
      args: [],
      cwd: "/workspace",
      status: "running",
      pid: 1,
    }
    const get = spyOn(Pty, "get").mockReturnValue(info)
    const connect = spyOn(Pty, "connect").mockImplementation((_id, socket) => {
      guardedSocket = socket
      return { onMessage() {}, onClose: disconnected }
    })
    const policy: SessionAccessPolicy = {
      sessionAuthority: "managed-private",
      authorize: async () => allowed
        ? { allowed: true }
        : { allowed: false, status: 403, code: "private_session", message: "Session is private" },
      authorizeStream: async (_input, lease) => {
        streamLeases.push(lease)
        return allowed
          ? { allowed: true, lease: "renewable-lease", expiresAt: Date.now() + 1_500 }
          : { allowed: false, status: 403, code: "private_session", message: "Session is private" }
      },
      filterSessions: async (input) => input.sessionIds,
      authorizePrefix: async () => ({ allowed: true }),
    }
    const app = new Hono<{ Variables: RelayHostAuthContext }>()
    app.use("*", async (c, next) => {
      c.set("relayHostAuth", relayAuth("editor", "participant"))
      return await next()
    })
    app.route("/", PtyRoutes(upgrade, undefined, policy))

    try {
      expect((await app.request("http://localhost/pty_private/connect", {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      })).status).toBe(200)
      events?.onOpen?.(new Event("open"), {
        raw: rawSocket,
        close: rawSocket.close,
      } as unknown as WSContext)
      expect(guardedSocket).toBeDefined()

      allowed = false
      await new Promise((resolve) => setTimeout(resolve, 1_050))
      guardedSocket!.send("private output after removal")

      expect(rawSocket.send).not.toHaveBeenCalled()
      expect(rawSocket.close).toHaveBeenCalledWith(1008, "Session access denied")
      expect(disconnected).toHaveBeenCalledTimes(1)
      expect(streamLeases).toEqual([undefined, "renewable-lease"])
    } finally {
      get.mockRestore()
      connect.mockRestore()
    }
  })

  test("requires and authorizes a persisted session identity for managed PTY creation", async () => {
    const create = spyOn(Pty, "create").mockImplementation(async (input) => ({
      id: "pty_created",
      sessionId: input.sessionId,
      title: "Terminal",
      command: "/bin/sh",
      args: [],
      cwd: "/workspace",
      status: "running" as const,
      pid: 1,
    }))
    const bind = spyOn(Pty, "bindAccessOwner").mockReturnValue(true)
    const commit = spyOn(Pty, "commit").mockReturnValue(undefined)
    const app = appForActor("editor_a", privateSessionPolicy({ session_a: "editor_a" }))

    try {
      const missing = await app.request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Terminal" }),
      })
      expect(missing.status).toBe(400)
      expect(create).not.toHaveBeenCalled()

      const denied = await app.request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Terminal", sessionId: "session_b" }),
      })
      expect(denied.status).toBe(403)
      expect(create).not.toHaveBeenCalled()

      const allowed = await app.request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Terminal", sessionId: "session_a" }),
      })
      expect(allowed.status).toBe(200)
      await expect(allowed.json()).resolves.toMatchObject({ sessionId: "session_a" })
      expect(create).toHaveBeenCalledTimes(1)
      expect(create.mock.calls[0]?.[2]).toMatchObject({
        sessionId: "session_a",
        authorityLease: "terminal-capability",
      })
    } finally {
      create.mockRestore()
      bind.mockRestore()
      commit.mockRestore()
    }
  })

  test("mints the terminal agent-hook capability from a canonical managed-private composition", async () => {
    // The composition under test is the one every managed host builds, not a
    // hand-written policy object: a managed runtime whose authority bundle
    // comes from `managedWorkspaceSessionAccessPolicy` must be able to
    // authorize the agent-hook stream, or every managed terminal answers 503
    // `terminal_capability_authority_unavailable`.
    const streamed: Array<{ sessionId: string; operation: string; lease?: string }> = []
    const policy = managedWorkspaceSessionAccessPolicy({
      requireActor: true,
      authority: {
        authorizeSessionRead: () => true,
        authorizeSessionWrite: () => true,
        authorizeSessionStream: (input, lease) => {
          streamed.push({
            sessionId: input.sessionId,
            operation: input.operation,
            ...(lease ? { lease } : {}),
          })
          return { allowed: true, lease: "authority-lease", expiresAt: 1_700_000_000_000 }
        },
        registerSession: () => true,
        acquireTurn: (input) => ({
          allowed: true,
          turnId: input.turnId,
          leaseId: "turn_lease_1",
          fencingToken: 1,
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 15_000,
        }),
        renewTurn: (input) => ({
          allowed: true,
          turnId: input.turnId,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken + 1,
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 15_000,
        }),
        releaseTurn: () => ({ released: true }),
      },
    })
    expect(policy.sessionAuthority).toBe("managed-private")
    const create = spyOn(Pty, "create").mockImplementation(async (input) => ({
      id: "pty_managed",
      sessionId: input.sessionId,
      title: "Terminal",
      command: "/bin/sh",
      args: [],
      cwd: "/workspace",
      status: "running" as const,
      pid: 1,
    }))
    const bind = spyOn(Pty, "bindAccessOwner").mockReturnValue(true)
    const commit = spyOn(Pty, "commit").mockReturnValue(undefined)

    try {
      const created = await appForActor("editor_a", policy).request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Terminal", sessionId: "session_a" }),
      })
      expect(created.status).toBe(200)
      expect(streamed).toEqual([{ sessionId: "session_a", operation: "agent_lifecycle_write" }])
      expect(create.mock.calls[0]?.[2]).toMatchObject({
        sessionId: "session_a",
        authorityLease: "authority-lease",
        authorityExpiresAt: 1_700_000_000_000,
      })
      expect(create.mock.calls[0]?.[0]?.env?.CLAXEDO_AGENT_HOOK_TOKEN).toBeTypeOf("string")
    } finally {
      create.mockRestore()
      bind.mockRestore()
      commit.mockRestore()
    }
  })

  test("prevents an editor from restoring another private session's disk scrollback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pty-private-history-"))
    process.env.WORKSPACE_RUNTIME_DIRECTORY = path.join(root, "workspace")
    process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = path.join(root, "history")
    const history = await createDiskHistory({
      directory: process.env.WORKSPACE_RUNTIME_DIRECTORY,
      id: "pty_private_a",
      limit: 1024,
      sessionId: "session_a",
    })
    history.append("editor A private scrollback")
    await history.close()
    const create = spyOn(Pty, "create").mockImplementation(async (input) => ({
      id: "pty_replacement",
      sessionId: input.sessionId,
      title: "Terminal",
      command: "/bin/sh",
      args: [],
      cwd: process.env.WORKSPACE_RUNTIME_DIRECTORY!,
      status: "running" as const,
      pid: 1,
    }))
    const policy = privateSessionPolicy({ session_a: "editor_a", session_b: "editor_b" })

    try {
      const response = await appForActor("editor_b", policy).request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session_b",
          env: { previousPtyId: "pty_private_a" },
        }),
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "pty_history_forbidden",
          message: "PTY history belongs to another session",
        },
      })
      expect(create).not.toHaveBeenCalled()
    } finally {
      create.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
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

    const escapingArg = await app.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cat", args: ["~/.local/share/opencode/opencode.db"] }),
    })
    expect(escapingArg.status).toBe(400)
    await expect(escapingArg.json()).resolves.toEqual({
      error: {
        code: "pty_invalid_path",
        message: "workspace command path must be relative",
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
