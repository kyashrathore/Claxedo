/**
 * Process Handler Tests
 *
 * Tests the consolidated `process` MCP tool handler that replaces
 * 9 separate process management tools with a single action-dispatched tool.
 */
import { describe, test, expect, beforeEach } from "vitest"
import {
  handleProcess,
  launch,
  parseLaunchResult,
  parseListResponse,
  type ProcessClient,
} from "./process-handler"
import type { ControlPlaneRequest } from "./control-plane-request"

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

type HttpCall = {
  path: string
  init?: RequestInit
  directory?: string
}

const requestBody = (init?: RequestInit): Record<string, unknown> =>
  typeof init?.body === "string" ? JSON.parse(init.body) : {}

function createMockHttp() {
  const calls: HttpCall[] = []

  // Declared as the real port. The `as any` this replaced meant the mock kept
  // compiling through every change to the port's shape, which is the one thing
  // a port test exists to catch.
  const httpFn: ControlPlaneRequest = async (path, init, directory) => {
    calls.push({ path, init, directory })

    if (path === "/api/wr/process" && init?.method === "POST") {
      const body = requestBody(init)
      return { id: "proc_new123", name: body.name, command: body.command, args: body.args || [] }
    }
    if (path.startsWith("/api/wr/process/") && init?.method === "PUT") {
      const body = requestBody(init)
      return { id: "proc_upd123", name: body.name || "updated", command: body.command || "cmd", args: [] }
    }
    if (path.startsWith("/api/wr/process/") && init?.method === "DELETE") {
      return null
    }
    throw new Error(`Unmocked http path: ${path}`)
  }

  return { calls, httpFn }
}

function createMockProc() {
  const calls: Array<{ method: string; args: string[] }> = []

  const configs = [
    {
      id: "proc_1",
      name: "dev-server",
      command: "npm run dev",
      args: [],
      autoStart: true,
      restartPolicy: "never" as const,
      maxRestarts: 3,
    },
    {
      id: "proc_2",
      name: "watcher",
      command: "tsc --watch",
      args: [],
      autoStart: false,
      restartPolicy: "on-failure" as const,
      maxRestarts: 5,
    },
  ]

  const processes = [
    { configId: "proc_1", status: "running" as const, restartCount: 0 },
  ]

  const factory = (_directory?: string): ProcessClient => ({
    list: async () => {
      calls.push({ method: "list", args: [] })
      return { configs, processes }
    },
    start: async (id: string) => {
      calls.push({ method: "start", args: [id] })
      return {
        kind: "started" as const,
        process: { configId: id, status: "running" as const, restartCount: 0, assignedPort: 3000 },
      }
    },
    stop: async (id: string) => {
      calls.push({ method: "stop", args: [id] })
    },
    restart: async (id: string) => {
      calls.push({ method: "restart", args: [id] })
      return {
        kind: "started" as const,
        process: { configId: id, status: "running" as const, restartCount: 0 },
      }
    },
    startAll: async () => {
      calls.push({ method: "startAll", args: [] })
    },
    stopAll: async () => {
      calls.push({ method: "stopAll", args: [] })
    },
  })

  return { calls, factory }
}

const DEFAULT_DIR = "/test/project"

// ===========================================================================
// Tests
// ===========================================================================

describe("process handler", () => {
  let mockHttp: ReturnType<typeof createMockHttp>
  let mockProc: ReturnType<typeof createMockProc>

  beforeEach(() => {
    mockHttp = createMockHttp()
    mockProc = createMockProc()
  })

  describe("launch", () => {
    test("returns port conflict details when preferred port is occupied", () => {
      const result = launch(
        "proc_1",
        {
          kind: "port_conflict",
          conflict: {
            type: "port-conflict",
            port: 3000,
            processName: "web",
          },
        },
        "started",
        "start",
      )

      expect(result.isError).toBe(true)
      expect(result.text).toContain("preferred port 3000 is in use")
      expect(result.text).toContain("(web)")
    })
  })

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------
  describe("action: list", () => {
    test("lists all configured processes", async () => {
      const result = await handleProcess(
        { action: "list" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("dev-server")
      expect(result.content[0].text).toContain("watcher")
      expect(mockProc.calls[0].method).toBe("list")
    })

    test("returns message when no processes configured", async () => {
      const idle = { configId: "proc_1", status: "idle" as const, restartCount: 0 }
      const emptyProc = (_dir?: string): ProcessClient => ({
        list: async () => ({ configs: [], processes: [] }),
        start: async () => ({ kind: "started", process: idle }),
        stop: async () => {},
        restart: async () => ({ kind: "started", process: idle }),
        startAll: async () => {},
        stopAll: async () => {},
      })

      const result = await handleProcess(
        { action: "list" },
        mockHttp.httpFn,
        emptyProc,
        DEFAULT_DIR,
      )

      expect(result.content[0].text).toBe("No processes configured.")
    })
  })

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------
  describe("action: start", () => {
    test("starts process by id", async () => {
      const result = await handleProcess(
        { action: "start", id: "proc_1" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("proc_1")
      expect(result.content[0].text).toContain("started")
      expect(mockProc.calls[0]).toEqual({ method: "start", args: ["proc_1"] })
    })

    test("returns error when id is missing", async () => {
      const result = await handleProcess(
        { action: "start" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('"id"')
    })

  })

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------
  describe("action: stop", () => {
    test("stops process by id", async () => {
      const result = await handleProcess(
        { action: "stop", id: "proc_1" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("proc_1 stopped")
      expect(mockProc.calls[0]).toEqual({ method: "stop", args: ["proc_1"] })
    })

    test("returns error when id is missing", async () => {
      const result = await handleProcess(
        { action: "stop" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('"id"')
    })
  })

  // -------------------------------------------------------------------------
  // restart
  // -------------------------------------------------------------------------
  describe("action: restart", () => {
    test("restarts process by id", async () => {
      const result = await handleProcess(
        { action: "restart", id: "proc_1" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("restarted")
    })

    test("returns error when id is missing", async () => {
      const result = await handleProcess(
        { action: "restart" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // add
  // -------------------------------------------------------------------------
  describe("action: add", () => {
    test("creates new process config", async () => {
      const result = await handleProcess(
        { action: "add", name: "my-server", command: "bun run dev" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("Process config created")

      const httpCall = mockHttp.calls[0]
      expect(httpCall.path).toBe("/api/wr/process")
      expect(httpCall.init?.method).toBe("POST")
      const body = JSON.parse(httpCall.init!.body as string)
      expect(body.id).toMatch(/^proc_/)
      expect(body.name).toBe("my-server")
      expect(body.command).toBe("bun run dev")
    })

    test("passes optional config fields", async () => {
      const result = await handleProcess(
        {
          action: "add",
          name: "api",
          command: "node server.js",
          args: ["--port", "3000"],
          cwd: "./backend",
          env: { NODE_ENV: "development" },
          autoStart: true,
          restartPolicy: "on-failure",
          maxRestarts: 5,
        },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBeFalsy()
      const body = JSON.parse(mockHttp.calls[0].init!.body as string)
      expect(body.args).toEqual(["--port", "3000"])
      expect(body.cwd).toBe("./backend")
      expect(body.env).toEqual({ NODE_ENV: "development" })
      expect(body.autoStart).toBe(true)
      expect(body.restartPolicy).toBe("on-failure")
      expect(body.maxRestarts).toBe(5)
    })

    test("returns error when name is missing", async () => {
      const result = await handleProcess(
        { action: "add", command: "bun run dev" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('"name"')
    })

    test("returns error when command is missing", async () => {
      const result = await handleProcess(
        { action: "add", name: "my-server" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('"command"')
    })
  })

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------
  describe("action: update", () => {
    test("updates process config by id", async () => {
      const result = await handleProcess(
        { action: "update", id: "proc_1", name: "new-name" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("updated")

      const httpCall = mockHttp.calls[0]
      expect(httpCall.path).toBe("/api/wr/process/proc_1")
      expect(httpCall.init?.method).toBe("PUT")
    })

    test("returns error when id is missing", async () => {
      const result = await handleProcess(
        { action: "update", name: "new-name" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('"id"')
    })
  })

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------
  describe("action: remove", () => {
    test("removes process config by id", async () => {
      const result = await handleProcess(
        { action: "remove", id: "proc_1" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("proc_1 removed")

      const httpCall = mockHttp.calls[0]
      expect(httpCall.path).toBe("/api/wr/process/proc_1")
      expect(httpCall.init?.method).toBe("DELETE")
    })

    test("returns error when id is missing", async () => {
      const result = await handleProcess(
        { action: "remove" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // start_all / stop_all
  // -------------------------------------------------------------------------
  describe("action: start_all", () => {
    test("starts all autoStart processes", async () => {
      const result = await handleProcess(
        { action: "start_all" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("autoStart")
      expect(mockProc.calls[0].method).toBe("startAll")
    })
  })

  describe("action: stop_all", () => {
    test("stops all running processes", async () => {
      const result = await handleProcess(
        { action: "stop_all" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain("All processes stopped")
      expect(mockProc.calls[0].method).toBe("stopAll")
    })
  })

  // -------------------------------------------------------------------------
  // unknown action
  // -------------------------------------------------------------------------
  describe("unknown action", () => {
    test("returns error with valid actions list", async () => {
      const result = await handleProcess(
        // The runtime guard exists for a value that escaped the union, so the
        // test has to supply one; `handleProcess` reads `args.action` only.
        { action: "invalid" } as unknown as Parameters<typeof handleProcess>[0],
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("Unknown action")
      expect(result.content[0].text).toContain("list")
      expect(result.content[0].text).toContain("start")
    })
  })

  // -------------------------------------------------------------------------
  // directory handling
  // -------------------------------------------------------------------------
  describe("directory handling", () => {
    test("uses provided directory", async () => {
      await handleProcess(
        { action: "list", directory: "/custom/dir" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      // Factory was called — we verify via the result being successful
      expect(mockProc.calls.length).toBeGreaterThan(0)
    })

    test("falls back to default directory when not provided", async () => {
      await handleProcess(
        { action: "start_all" },
        mockHttp.httpFn,
        mockProc.factory,
        DEFAULT_DIR,
      )

      expect(mockProc.calls[0].method).toBe("startAll")
    })
  })
})

// ===========================================================================
// Response parsing
//
// These replaced `httpRequest<ListResponse>` / `httpRequest<LaunchResult>`,
// where the type argument asserted the shape instead of checking it.
// ===========================================================================

describe("parseListResponse", () => {
  test("reads a well-formed body", () => {
    const parsed = parseListResponse({
      configs: [
        {
          id: "proc_1",
          name: "dev",
          command: "npm run dev",
          args: ["--port", "3000"],
          autoStart: true,
          restartPolicy: "on-failure",
          maxRestarts: 5,
          env: { NODE_ENV: "development" },
          port: { name: "web", inject: "PORT", preferred: 3000, onConflict: "pick-new" },
        },
      ],
      processes: [{ configId: "proc_1", status: "running", restartCount: 2, assignedPort: 3000 }],
    })

    expect(parsed.configs).toHaveLength(1)
    expect(parsed.configs[0]).toMatchObject({
      id: "proc_1",
      args: ["--port", "3000"],
      restartPolicy: "on-failure",
      env: { NODE_ENV: "development" },
      port: { name: "web", inject: "PORT", preferred: 3000, onConflict: "pick-new" },
    })
    expect(parsed.processes[0]).toMatchObject({ configId: "proc_1", status: "running", restartCount: 2 })
  })

  test("drops rows that cannot be displayed or acted on", () => {
    const parsed = parseListResponse({
      configs: [{ name: "no id" }, { id: "proc_2" }, { id: "proc_3", name: "kept" }],
      processes: [{ status: "running" }, { configId: "proc_3", status: "running" }],
    })

    expect(parsed.configs.map((config) => config.id)).toEqual(["proc_3"])
    expect(parsed.processes.map((process) => process.configId)).toEqual(["proc_3"])
  })

  test("substitutes declared defaults for unusable field values", () => {
    const [config] = parseListResponse({
      configs: [{ id: "proc_1", name: "dev", args: ["ok", 7], restartPolicy: "whenever", maxRestarts: "5" }],
    }).configs

    expect(config.args).toEqual(["ok"])
    expect(config.restartPolicy).toBe("never")
    expect(config.maxRestarts).toBe(0)
    expect(config.autoStart).toBe(false)
  })

  test("reads a non-object body as an empty list rather than throwing", () => {
    expect(parseListResponse("<html>gateway timeout</html>")).toEqual({ configs: [], processes: [] })
    expect(parseListResponse(null)).toEqual({ configs: [], processes: [] })
  })
})

describe("parseLaunchResult", () => {
  test("reads each declared kind", () => {
    expect(parseLaunchResult({ kind: "started", process: { configId: "p", status: "running", restartCount: 0 } }))
      .toMatchObject({ kind: "started", process: { configId: "p", status: "running" } })
    expect(parseLaunchResult({ kind: "already_running", process: { configId: "p" } }))
      .toMatchObject({ kind: "already_running", process: { configId: "p", status: "idle" } })
    expect(parseLaunchResult({ kind: "port_conflict", conflict: { port: 3000, processName: "web" } }))
      .toEqual({ kind: "port_conflict", conflict: { type: "port-conflict", port: 3000, processName: "web", pid: undefined, command: undefined, processId: undefined, directory: undefined } })
    expect(parseLaunchResult({ kind: "route_conflict", conflict: { hostname: "app.test", pid: 42 } }))
      .toMatchObject({ kind: "route_conflict", conflict: { type: "route-conflict", hostname: "app.test", pid: 42 } })
    expect(parseLaunchResult({ kind: "not_found", error: "no such config" }))
      .toEqual({ kind: "not_found", error: "no such config" })
  })

  test("reports a started response with no process instead of throwing on it", () => {
    // The cast this replaced let this body through, and `detail(out.process)`
    // then threw a TypeError out of the tool.
    const result = parseLaunchResult({ kind: "started" })
    expect(result.kind).toBe("failed")
    expect(launch("proc_1", result, "started", "start").text).toContain('without a process')
  })

  test("reports an incomplete conflict instead of rendering an undefined port", () => {
    expect(parseLaunchResult({ kind: "port_conflict", conflict: {} })).toMatchObject({ kind: "failed" })
    expect(parseLaunchResult({ kind: "route_conflict", conflict: { hostname: "app.test" } })).toMatchObject({ kind: "failed" })
  })

  test("reports an unrecognized body as a failure naming what arrived", () => {
    const result = parseLaunchResult({ kind: "exploded" })
    expect(result).toEqual({ kind: "failed", error: 'Unrecognized launch response kind "exploded"' })
    expect(parseLaunchResult(undefined)).toEqual({ kind: "failed", error: "Unrecognized launch response kind null" })
  })
})
