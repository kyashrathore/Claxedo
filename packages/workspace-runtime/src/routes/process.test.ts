import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { ProcessRoutes, createProcessRoutes } from "./process"
import { errorBody, JSON_BODY_LIMIT_BYTES } from "./http"

let previousDirectory: string | undefined

const state = {
  processes: new Map<string, { ptyId?: string }>(),
  names: new Map<string, { ptyId?: string }>(),
  ptys: new Map<string, { id: string }>(),
  snapshots: new Map<string, string>(),
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
      new Request("http://localhost/diagnostics?directory=/tmp/other"),
      new Request("http://localhost/diagnostics/terminate?directory=/tmp/other", { method: "POST", body: "{}" }),
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
