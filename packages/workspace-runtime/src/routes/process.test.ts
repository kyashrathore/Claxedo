import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { ProcessRoutes, createProcessRoutes } from "./process"
import { errorBody, JSON_BODY_LIMIT_BYTES } from "./http"
import { Hono } from "hono"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import type { SessionAccessPolicy } from "../session-access-policy"

let previousDirectory: string | undefined

const state = {
  processes: new Map<string, { ptyId?: string }>(),
  names: new Map<string, { ptyId?: string }>(),
  ptys: new Map<string, { id: string; sessionId?: string }>(),
  snapshots: new Map<string, string>(),
  owners: new Map<string, string>(),
}

const manager = {
  bindWorkspace: mock(() => {}),
  loadConfig: mock(async () => {}),
  watchConfig: mock(() => {}),
  get: mock((_directory: string, id: string) => state.processes.get(id)),
  findByName: mock((_directory: string, name: string) => state.names.get(name)),
  configs: mock(() => []),
  list: mock(() => []),
  addConfig: mock(async () => ({})),
  updateConfig: mock(async () => ({})),
  removeConfig: mock(async () => {}),
  start: mock(async () => ({ kind: "started", process: {} })),
  stop: mock(async () => {}),
  restart: mock(async () => ({ kind: "started", process: {} })),
  startAll: mock(async () => {}),
  stopAll: mock(async () => {}),
  portMap: mock(() => ({})),
}

const pty = {
  get: mock((id: string) => state.ptys.get(id)),
  snapshot: mock((id: string) => state.snapshots.get(id) ?? ""),
  accessOwner: mock((id: string) => state.owners.get(id)),
  listDetailed: mock(() => []),
  remove: mock(async () => {}),
}

describe("ProcessRoutes logs", () => {
  beforeEach(() => {
    previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY
    delete process.env.WORKSPACE_RUNTIME_DIRECTORY
    state.processes.clear()
    state.names.clear()
    state.ptys.clear()
    state.snapshots.clear()
    state.owners.clear()
  })

  afterEach(() => {
    if (previousDirectory === undefined) {
      delete process.env.WORKSPACE_RUNTIME_DIRECTORY
    } else {
      process.env.WORKSPACE_RUNTIME_DIRECTORY = previousDirectory
    }
  })

  test("returns the requested tail from a process PTY snapshot", async () => {
    state.processes.set("proc_1", { ptyId: "pty_1" })
    state.ptys.set("pty_1", { id: "pty_1" })
    state.snapshots.set("pty_1", "one\ntwo\nthree\nfour")

    const res = await createProcessRoutes({ manager, pty }).request("http://localhost/logs?process_id=proc_1&lines=2")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("three\nfour")
  })

  test("authorizes every PTY log alias against the owning private session", async () => {
    state.processes.set("proc_1", { ptyId: "pty_1" })
    state.names.set("dev", { ptyId: "pty_1" })
    state.ptys.set("pty_1", { id: "pty_1", sessionId: "session_private" })
    state.snapshots.set("pty_1", "private output")
    const calls: Array<{ sessionId?: string; operation: string }> = []
    const policy: SessionAccessPolicy = {
      sessionAuthority: "managed-private",
      authorize: async (input) => {
        calls.push({ sessionId: input.sessionId, operation: input.operation })
        return {
          allowed: false,
          status: 403,
          code: "session_private",
          message: "Session access denied",
        }
      },
      filterSessions: async () => [],
      authorizePrefix: async () => ({ allowed: true }),
    }
    const app = new Hono<{ Variables: RelayHostAuthContext }>()
    app.use("*", async (c, next) => {
      const now = Math.floor(Date.now() / 1000)
      c.set("relayHostAuth", {
        iss: "workspace-relay",
        aud: "workspace-host-service",
        principal_kind: "user",
        actor_id: "actor_1",
        actor_kind: "human",
        org_id: "org_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        role: "editor",
        access: "cloud",
        backing: "cloud-vm",
        exp: now + 60,
        iat: now,
        jti: "jti_1",
        parent_jti: "rat_jti_1",
      })
      return await next()
    })
    app.route("/", createProcessRoutes({ manager, pty }, policy))

    for (const query of ["pty_id=pty_1", "terminal_id=pty_1", "process_id=proc_1", "name=dev"]) {
      const response = await app.request(`http://localhost/logs?${query}`)
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual(errorBody("session_private", "Session access denied"))
    }
    expect(calls).toEqual(Array.from({ length: 4 }, () => ({
      sessionId: "session_private",
      operation: "pty_read",
    })))
  })

  test("resolves logs by process name and clamps invalid line counts", async () => {
    state.names.set("dev", { ptyId: "pty_dev" })
    state.ptys.set("pty_dev", { id: "pty_dev" })
    state.snapshots.set("pty_dev", "first\nsecond")

    const res = await createProcessRoutes({ manager, pty }).request("http://localhost/logs?name=dev&lines=0")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("second")
  })

  test("caps oversized process log line counts", async () => {
    state.processes.set("proc_1", { ptyId: "pty_1" })
    state.ptys.set("pty_1", { id: "pty_1" })
    state.snapshots.set(
      "pty_1",
      Array.from({ length: 10002 }, (_, index) => `line-${index + 1}`).join("\n"),
    )

    const res = await createProcessRoutes({ manager, pty }).request("http://localhost/logs?process_id=proc_1&lines=20000")
    const lines = (await res.text()).split("\n")

    expect(res.status).toBe(200)
    expect(lines.length).toBe(10000)
    expect(lines[0]).toBe("line-3")
    expect(lines.at(-1)).toBe("line-10002")
  })

  test("rejects process log requests without a target", async () => {
    const res = await createProcessRoutes({ manager, pty }).request("http://localhost/logs")

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "process_log_target_required",
        message: "Provide one of: pty_id, terminal_id, process_id, name",
      },
    })
  })

  test("returns structured process log lookup errors", async () => {
    const app = createProcessRoutes({ manager, pty })

    const missingProcess = await app.request("http://localhost/logs?process_id=proc_missing")
    expect(missingProcess.status).toBe(404)
    await expect(missingProcess.json()).resolves.toEqual({
      error: {
        code: "process_log_target_not_found",
        message: "Process proc_missing not found or has no PTY",
        details: {
          process_id: "proc_missing",
        },
      },
    })

    state.processes.set("proc_1", { ptyId: "pty_missing" })
    const missingPty = await app.request("http://localhost/logs?process_id=proc_1")
    expect(missingPty.status).toBe(404)
    await expect(missingPty.json()).resolves.toEqual({
      error: {
        code: "process_log_target_not_found",
        message: "PTY pty_missing not found",
        details: {
          pty_id: "pty_missing",
        },
      },
    })
  })

  test("rejects log directories outside the pinned workspace", async () => {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = "/tmp/workspace-runtime-process"

    const res = await createProcessRoutes({ manager, pty }).request(
      "http://localhost/logs?directory=/tmp/other&process_id=proc_1",
    )

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "process_invalid_directory",
        message: "Process directory must match configured workspace",
      },
    })
  })

  test("rejects production process route directories outside the pinned workspace", async () => {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = "/tmp/workspace-runtime-process"

    const app = ProcessRoutes()

    for (const request of [
      new Request("http://localhost/?directory=/tmp/other"),
      new Request("http://localhost/?directory=/tmp/other", { method: "POST", body: "{}" }),
      new Request("http://localhost/proc_1?directory=/tmp/other", { method: "PUT", body: "{}" }),
      new Request("http://localhost/proc_1?directory=/tmp/other", { method: "DELETE" }),
      new Request("http://localhost/proc_1/start?directory=/tmp/other", { method: "POST", body: "{}" }),
      new Request("http://localhost/proc_1/stop?directory=/tmp/other", { method: "POST" }),
      new Request("http://localhost/proc_1/restart?directory=/tmp/other", { method: "POST" }),
      new Request("http://localhost/start-all?directory=/tmp/other", { method: "POST" }),
      new Request("http://localhost/stop-all?directory=/tmp/other", { method: "POST" }),
      new Request("http://localhost/port-map?directory=/tmp/other"),
    ]) {
      const res = await app.request(request)
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "process_invalid_directory",
          message: "Process directory must match configured workspace",
        },
      })
    }
  })

  test("does not expose local diagnostics or PID termination over workspace HTTP", async () => {
    const app = ProcessRoutes()
    expect((await app.request("http://localhost/diagnostics")).status).toBe(404)
    expect(
      (
        await app.request("http://localhost/diagnostics/terminate", {
          method: "POST",
          body: JSON.stringify({ pid: process.pid }),
        })
      ).status,
    ).toBe(404)
  })

  test("denies process routes to authenticated viewers", async () => {
    const app = new Hono<{ Variables: RelayHostAuthContext }>()
    app.use("*", async (c, next) => {
      const now = Math.floor(Date.now() / 1000)
      c.set("relayHostAuth", {
        iss: "workspace-relay",
        aud: "workspace-host-service",
        principal_kind: "user",
        actor_id: "user_1",
        actor_kind: "human",
        org_id: "org_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        role: "viewer",
        access: "cloud",
        backing: "cloud-vm",
        exp: now + 60,
        iat: now,
        jti: "jti_1",
        parent_jti: "rat_jti_1",
      })
      return await next()
    })
    app.route("/", ProcessRoutes())

    const response = await app.request("http://localhost/")
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual(errorBody(
      "relay_role_denied",
      "Workspace role does not allow process access",
    ))
  })

  test("rejects managed-process cwd and args outside the workspace", async () => {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = "/tmp/workspace-runtime-process"
    const request = (body: Record<string, unknown>) => ProcessRoutes().request(
      "http://localhost/?directory=/tmp/workspace-runtime-process",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "blocked", command: "cat", ...body }),
      },
    )

    expect((await request({ cwd: "/tmp" })).status).toBe(400)
    expect((await request({ args: ["~/.local/share/opencode/opencode.db"] })).status).toBe(400)
    expect((await request({ command: "cat ~/.local/share/opencode/opencode.db" })).status).toBe(400)
  })

  test("rejects oversized process route bodies", async () => {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = "/tmp/workspace-runtime-process"
    const res = await ProcessRoutes().request("http://localhost/?directory=/tmp/workspace-runtime-process", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(JSON_BODY_LIMIT_BYTES + 1),
      },
      body: JSON.stringify({ name: "web", command: "npm run dev" }),
    })

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toEqual(errorBody("request_body_too_large", "Request body is too large"))
  })
})
