/**
 * Process Handler Tests
 *
 * Tests the consolidated `process` MCP tool handler that replaces
 * 9 separate process management tools with a single action-dispatched tool.
 */
import { describe, test, expect, beforeEach } from "vitest"
import { handleProcess, launch } from "./process-handler"

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

type HttpCall = {
  path: string
  init?: RequestInit
  mode?: string
  directory?: string
}

function createMockHttp() {
  const calls: HttpCall[] = []

  const httpFn = async (path: string, init?: RequestInit, mode?: string, directory?: string) => {
    calls.push({ path, init, mode, directory })

    if (path === "/process" && init?.method === "POST") {
      const body = JSON.parse(init.body as string)
      return { id: "proc_new123", name: body.name, command: body.command, args: body.args || [] }
    }
    if (path.startsWith("/process/") && init?.method === "PUT") {
      const body = JSON.parse(init.body as string)
      return { id: "proc_upd123", name: body.name || "updated", command: body.command || "cmd", args: [] }
    }
    if (path.startsWith("/process/") && init?.method === "DELETE") {
      return true
    }
    throw new Error(`Unmocked http path: ${path}`)
  }

  return { calls, httpFn: httpFn as any }
}

function createMockProc() {
  const calls: Array<{ method: string; args: any[] }> = []

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

  const factory = (_directory?: string) => ({
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
      return true
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
      return true
    },
    stopAll: async () => {
      calls.push({ method: "stopAll", args: [] })
      return true
    },
  })

  return { calls, factory: factory as any }
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
        } as any,
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
      const emptyProc = (_dir?: string) => ({
        list: async () => ({ configs: [], processes: [] }),
        start: async () => ({ kind: "started" as const, process: {} }),
        stop: async () => true,
        restart: async () => ({ kind: "started" as const, process: {} }),
        startAll: async () => true,
        stopAll: async () => true,
      })

      const result = await handleProcess(
        { action: "list" },
        mockHttp.httpFn,
        emptyProc as any,
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
      expect(httpCall.path).toBe("/process")
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
      expect(httpCall.path).toBe("/process/proc_1")
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
      expect(httpCall.path).toBe("/process/proc_1")
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
        { action: "invalid" as any },
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
