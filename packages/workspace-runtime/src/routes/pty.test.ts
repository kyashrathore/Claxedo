import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono, type Context } from "hono"
import type { UpgradeWebSocket, WSEvents, WSContext } from "hono/ws"
import { PtyRoutes } from "./pty"
import { installedTerminalAgents } from "../pty/terminal-agents"
import { Pty } from "../pty/index"
import {
  errorBody,
  JSON_BODY_LIMIT_BYTES,
  remoteWorkspaceSessionAccessPolicy,
  type SessionAccessPolicy,
} from "@claxedo/session-core"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"
import { withWorkspaceTarget } from "../target"
import { withSessionCore } from "../session-context"
import { testSessionCore } from "@claxedo/session-core/testing"

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
    scope: "workspace",
    backing: "cloud-vm",
    exp: now + 60,
    iat: now,
    jti: "jti_1",
    parent_jti: "rat_jti_1",
  }
}

type HostCall = { action: string; lease?: string; authorization?: string }

/** The real remote composition every managed host builds, answering host authority over a scripted control plane. */
function hostPolicy(state: { active: boolean; calls: HostCall[] } = { active: true, calls: [] }) {
  let leases = 0
  return remoteWorkspaceSessionAccessPolicy({
    url: "http://control-plane.test/runtime/session-authority",
    fetch: async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { action: string; lease?: string }
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined
      state.calls.push({ action: body.action, ...(body.lease ? { lease: body.lease } : {}), ...(authorization ? { authorization } : {}) })
      if (!state.active) {
        return Response.json({ error: { code: "runtime_access_token_inactive", message: "Runtime Access Token is inactive" } }, { status: 401 })
      }
      leases += 1
      return Response.json({ allowed: true, lease: `host-lease-${leases}`, expiresAt: Date.now() + 15_000 })
    },
  })
}

/** The PTY routes inside a session core rooted where the test pins the runtime, as a host serves them. */
function ptyRoutes(policy?: SessionAccessPolicy, root?: string) {
  return new Hono<{ Variables: RelayHostAuthContext }>()
    .use("*", (_c, next) => withSessionCore(testSessionCore(root ?? process.env.WORKSPACE_RUNTIME_DIRECTORY ?? path.join(os.tmpdir(), "pty-routes-unserved-root")), next))
    .route("/", PtyRoutes(upgradeWebSocket, policy))
}

function appFor(
  policy: SessionAccessPolicy,
  role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"] = "editor",
  options: { actorId?: string; sessionScope?: string; upgrade?: UpgradeWebSocket } = {},
) {
  const app = new Hono<{ Variables: RelayHostAuthContext }>()
  app.use("*", async (c, next) => {
    c.set("relayHostAuth", {
      ...relayAuth(role, options.actorId),
      ...(options.sessionScope ? { session_id: options.sessionScope } : {}),
    })
    return await next()
  })
  app.route("/", new Hono<{ Variables: RelayHostAuthContext }>()
    .use("*", (_c, next) => withSessionCore(testSessionCore(process.env.WORKSPACE_RUNTIME_DIRECTORY ?? path.join(os.tmpdir(), "pty-routes-unserved-root")), next))
    .route("/", PtyRoutes(options.upgrade ?? upgradeWebSocket, policy)))
  return {
    request: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
      app.request(url, { ...init, headers: { ...init.headers, authorization: "Bearer relay-token" } }),
  }
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
  test("terminal identity comes from the runtime target rather than caller headers or environment", async () => {
    const directory = await fs.realpath(os.tmpdir())
    const info = {
      id: "pty_workspace_identity",
      title: "Terminal",
      command: "/bin/sh",
      args: [],
      cwd: directory,
      status: "running",
      pid: 123,
    } satisfies Pty.Info
    const create = spyOn(Pty, "create").mockResolvedValue(info)
    const commit = spyOn(Pty, "commit").mockReturnValue(info)
    const previousWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    try {
      const response = await withWorkspaceTarget({ workspaceId: "ws_actual", directory }, () =>
        ptyRoutes(undefined, directory).request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "application/json", "x-workspace-id": "ws_header_forged" },
          body: JSON.stringify({ env: { CLAXEDO_WORKSPACE_ID: "ws_env_forged", USER_VALUE: "kept" } }),
        }),
      )
      expect(response.status).toBe(200)
      expect(create.mock.calls[0]?.[0]?.env).toMatchObject({ CLAXEDO_WORKSPACE_ID: "ws_actual", USER_VALUE: "kept" })

      delete process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
      process.env.WORKSPACE_RUNTIME_DIRECTORY = directory
      const withoutIdentity = await ptyRoutes().request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-workspace-id": "ws_header_forged" },
        body: JSON.stringify({ env: { CLAXEDO_WORKSPACE_ID: "ws_env_forged", USER_VALUE: "kept" } }),
      })
      expect(withoutIdentity.status).toBe(200)
      expect(create.mock.calls[1]?.[0]?.env?.CLAXEDO_WORKSPACE_ID).toBeUndefined()
      expect(create.mock.calls[1]?.[0]?.env?.USER_VALUE).toBe("kept")
    } finally {
      if (previousWorkspaceId === undefined) delete process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
      else process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = previousWorkspaceId
      create.mockRestore()
      commit.mockRestore()
    }
  })

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
      cwd: os.tmpdir(),
      status: "running" as const,
      pid: 123,
    } satisfies Pty.Info
    const create = spyOn(Pty, "create").mockImplementation(async (input) => ({
      ...info,
      createRequestId: input.createRequestId,
    }))
    const commit = spyOn(Pty, "commit").mockReturnValue(info)
    const list = spyOn(Pty, "list").mockReturnValue([info])
    process.env.WORKSPACE_RUNTIME_DIRECTORY = os.tmpdir()
    try {
      const created = await ptyRoutes().request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-claxedo-directory": os.tmpdir() },
        body: JSON.stringify({
          sessionId: "session_a",
          createRequestId: "request-client-a",
          title: "Terminal",
        }),
      })

      expect(created.status).toBe(200)
      await expect(created.json()).resolves.toMatchObject({ createRequestId: "request-client-a" })
      expect(create.mock.calls[0]?.[0]).toMatchObject({ createRequestId: "request-client-a" })
      await expect((await ptyRoutes().request("http://localhost/")).json()).resolves.toEqual([info])
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
      cwd: os.tmpdir(),
      status: "running" as const,
      pid: 123,
    }
    const create = spyOn(Pty, "create").mockResolvedValue(info)
    const commit = spyOn(Pty, "commit").mockReturnValue(info)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = os.tmpdir()
    try {
      const response = await ptyRoutes().request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-claxedo-directory": os.tmpdir() },
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

  test("every terminal on the workspace reaches an editor, whatever session labels it", async () => {
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
    const rows = [info("pty_a", "session_in_session_host"), info("pty_b")]
    const list = spyOn(Pty, "list").mockReturnValue(rows)
    const get = spyOn(Pty, "get").mockImplementation((id) => rows.find((row) => row.id === id))
    const remove = spyOn(Pty, "remove").mockResolvedValue(undefined)
    const state = { active: true, calls: [] as HostCall[] }

    try {
      const editor = appFor(hostPolicy(state))
      await expect((await editor.request("http://localhost/")).json()).resolves.toEqual(rows)
      expect((await editor.request("http://localhost/pty_a")).status).toBe(200)
      expect((await editor.request("http://localhost/pty_a/connect", {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      })).status).toBe(501)
      expect((await editor.request("http://localhost/pty_a", { method: "DELETE" })).status).toBe(200)
      expect(remove).toHaveBeenCalledWith("pty_a")
      expect(state.calls.every((call) => call.action === "host_read" && call.authorization === "Bearer relay-token")).toBe(true)
    } finally {
      list.mockRestore()
      get.mockRestore()
      remove.mockRestore()
    }
  })

  test("a viewer, a session-scoped token and a revoked workspace token reach no terminal", async () => {
    const rows: Pty.Info[] = [{ id: "pty_a", title: "a", command: "/bin/sh", args: [], cwd: "/workspace", status: "running", pid: 1 }]
    const list = spyOn(Pty, "list").mockReturnValue(rows)
    const get = spyOn(Pty, "get").mockReturnValue(rows[0])
    const remove = spyOn(Pty, "remove").mockResolvedValue(undefined)
    const revoked = { active: false, calls: [] as HostCall[] }

    try {
      const refusals = [
        { app: appFor(hostPolicy(), "viewer"), status: 403, code: "terminal_role_denied" },
        { app: appFor(hostPolicy(), "editor", { sessionScope: "session_shared" }), status: 403, code: "relay_scope_denied" },
        { app: appFor(hostPolicy(revoked)), status: 401, code: "runtime_access_token_inactive" },
      ]
      for (const { app, status, code } of refusals) {
        for (const request of [
          app.request("http://localhost/"),
          app.request("http://localhost/pty_a"),
          app.request("http://localhost/pty_a", { method: "DELETE" }),
          app.request("http://localhost/pty_a/connect", { headers: { connection: "Upgrade", upgrade: "websocket" } }),
          app.request("http://localhost/", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
        ]) {
          const response = await request
          expect(response.status).toBe(status)
          expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code)
        }
      }
      expect(remove).not.toHaveBeenCalled()
    } finally {
      list.mockRestore()
      get.mockRestore()
      remove.mockRestore()
    }
  })

  test("attaches the route's socket on the host lease and closes it when the workspace token is revoked", async () => {
    let events: WSEvents | undefined
    let guardedSocket: Parameters<typeof Pty.connect>[1] | undefined
    const rawSocket = {
      readyState: 1,
      bufferedAmount: 0,
      send: spyOn({ call() {} }, "call"),
      close: spyOn({ call(_code?: number, _reason?: string) {} }, "call"),
    }
    const disconnected = spyOn({ call() {} }, "call")
    const upgrade = ((createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => async (c: Context) => {
      events = await createEvents(c)
      return new Response(null, { status: 200 })
    }) as unknown as UpgradeWebSocket
    const info: Pty.Info = {
      id: "pty_workspace",
      title: "Workspace terminal",
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
    const state = { active: true, calls: [] as HostCall[] }
    const policy = hostPolicy(state)
    const host = hostPolicy(state)
    policy.authorizeHost = async (input) => {
      const decision = await host.authorizeHost!(input)
      return decision.allowed ? { ...decision, expiresAt: Date.now() + 1_500 } : decision
    }

    try {
      expect((await appFor(policy, "editor", { upgrade }).request("http://localhost/pty_workspace/connect", {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      })).status).toBe(200)
      events?.onOpen?.(new Event("open"), { raw: rawSocket, close: rawSocket.close } as unknown as WSContext)
      expect(guardedSocket).toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(guardedSocket).toBeDefined()

      state.active = false
      await new Promise((resolve) => setTimeout(resolve, 1_050))
      guardedSocket!.send("output after revocation")

      expect(rawSocket.send).not.toHaveBeenCalled()
      expect(rawSocket.close).toHaveBeenCalledWith(1008, "Terminal access denied")
      expect(disconnected).toHaveBeenCalledTimes(1)
      expect(state.calls.map((call) => call.lease)).toEqual([undefined, "host-lease-1"])
      expect(state.calls[1]?.authorization).toBeUndefined()
    } finally {
      get.mockRestore()
      connect.mockRestore()
    }
  })

  test("names the agent CLIs installed on this runtime for the terminal picker", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pty-agents-"))
    const previousPath = process.env.PATH
    try {
      await fs.writeFile(path.join(root, "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 })
      process.env.PATH = root
      const response = await appFor(hostPolicy()).request("http://localhost/agents")
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ agents: installedTerminalAgents(process.env) })
      expect(installedTerminalAgents({ PATH: root }, root)).toEqual(["cursor"])
      const refused = await appFor(hostPolicy(), "viewer").request("http://localhost/agents")
      expect(refused.status).toBe(403)
    } finally {
      process.env.PATH = previousPath
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("creates a terminal with no session and binds the agent hook to the host lease", async () => {
    const create = spyOn(Pty, "create").mockImplementation(async (input) => ({
      id: "pty_created",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      title: "Terminal",
      command: "/bin/sh",
      args: [],
      cwd: "/workspace",
      status: "running" as const,
      pid: 1,
    }))
    const bind = spyOn(Pty, "bindAccessOwner").mockReturnValue(true)
    const commit = spyOn(Pty, "commit").mockReturnValue(undefined)
    process.env.WORKSPACE_RUNTIME_DIRECTORY = os.tmpdir()

    try {
      const created = await appFor(hostPolicy(), "editor", { actorId: "editor_a" }).request("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Terminal" }),
      })
      expect(created.status).toBe(200)
      expect(create.mock.calls[0]?.[2]).toMatchObject({
        context: { actor: { actorId: "editor_a" }, authority: { workspaceId: "ws_1", role: "editor" } },
        authorityLease: "host-lease-1",
      })
      expect(create.mock.calls[0]?.[0]?.env?.CLAXEDO_AGENT_HOOK_TOKEN).toBe(create.mock.calls[0]?.[2]?.token)
      expect(bind).toHaveBeenCalledWith("pty_created", "editor_a")
    } finally {
      create.mockRestore()
      bind.mockRestore()
      commit.mockRestore()
    }
  })

  test("rejects create requests outside the pinned workspace before spawning", async () => {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = path.join(os.tmpdir(), "workspace-runtime-pty")
    const app = ptyRoutes()

    const wrongDirectory = await app.request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-claxedo-directory": path.join(os.tmpdir(), "other"),
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
      body: JSON.stringify({ cwd: path.join(os.tmpdir(), "workspace-runtime-pty") }),
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
