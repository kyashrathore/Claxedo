import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import { realpathSync } from "fs"
import os from "os"
import path from "path"
import { Pty } from "../pty/index"
import { workspaceRuntimeBus, type PtyInfo } from "../bus"

/** Match the real() function in index.ts — resolves symlinks */
function real(dir: string) {
  try {
    return path.resolve(realpathSync.native?.(dir) ?? realpathSync(dir))
  } catch {
    return path.resolve(dir)
  }
}

/**
 * A port that is actually free RIGHT NOW on this machine. The lease tests
 * used hardcoded 198xx ports, which shared CI runners occasionally occupy —
 * and then "uses preferred port when the port is free" fails because it
 * was not free. Lease semantics only need SOME port, so each test takes its
 * own from the OS.
 */
async function freePort(): Promise<number> {
  const net = await import("node:net")
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
    server.once("error", reject)
  })
}

describe("process config file", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "process-config-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("loads process configs from .workspace-runtime", async () => {
    await fs.mkdir(path.join(tmpDir, ".workspace-runtime"), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, ".workspace-runtime", "processes.jsonc"),
      JSON.stringify({
        processes: [
          {
            id: "proc_cfg",
            name: "dev",
            command: "npm run dev",
          },
        ],
      }),
    )

    const { loadConfig } = await import("./manager")
    const configs = await loadConfig(tmpDir)

    expect(configs.map((config) => config.id)).toEqual(["proc_cfg"])
  })

  test("initializes process config and watcher only once", async () => {
    await fs.mkdir(path.join(tmpDir, ".workspace-runtime"), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, ".workspace-runtime", "processes.jsonc"),
      JSON.stringify({ processes: [] }),
    )

    const manager = await import("./manager")
    await manager.initialize(tmpDir)
    await Bun.sleep(50)
    const schema = path.join(tmpDir, ".workspace-runtime", "processes.schema.json")
    const first = (await fs.stat(schema)).mtimeMs

    await Bun.sleep(50)
    await manager.initialize(tmpDir)
    await Bun.sleep(50)

    expect((await fs.stat(schema)).mtimeMs).toBe(first)
    await manager.dispose(tmpDir)
  })

  test("migrates legacy .claxedo configs and persists generated ids", async () => {
    await fs.mkdir(path.join(tmpDir, ".claxedo"), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, ".claxedo", "processes.jsonc"),
      JSON.stringify({
        processes: [
          {
            name: "dev",
            command: "npm run dev",
          },
        ],
      }),
    )

    const { loadConfig } = await import("./manager")
    const configs = await loadConfig(tmpDir)
    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, ".workspace-runtime", "processes.jsonc"), "utf-8"))

    expect(configs[0]!.id).toMatch(/^proc_/)
    expect(persisted.processes[0].id).toBe(configs[0]!.id)
  })

  test("migrates legacy .opencode configs and persists generated ids", async () => {
    await fs.mkdir(path.join(tmpDir, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, ".opencode", "processes.jsonc"),
      JSON.stringify({
        processes: [
          {
            name: "dev",
            command: "npm run dev",
          },
        ],
      }),
    )

    const { loadConfig } = await import("./manager")
    const configs = await loadConfig(tmpDir)
    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, ".workspace-runtime", "processes.jsonc"), "utf-8"))

    expect(configs[0]!.id).toMatch(/^proc_/)
    expect(persisted.processes[0].id).toBe(configs[0]!.id)
  })
})

// ---------------------------------------------------------------------------
// PortLease behaviour assertions
// ---------------------------------------------------------------------------
// Tests run against the real PortLease module with a temp stateDir so no
// interaction with the real ~/.claxedo/state directory.

import * as PortLease from "./port-lease"

describe("PortLease", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lease-test-"))
    process.env.WORKSPACE_RUNTIME_STATE_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.WORKSPACE_RUNTIME_STATE_DIR
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const leaseKey = {
    project_id: "/tmp/test-project",
    workspace: "ws-1",
    process_id: "proc_001",
  }

  const entry = {
    ...leaseKey,
    port_name: "http",
    preferred: 4444,
    port: 4444,
  }

  test("read returns undefined when no lease exists", async () => {
    const result = await PortLease.read(leaseKey)
    expect(result).toBeUndefined()
  })

  test("write persists and read retrieves a lease", async () => {
    await PortLease.write(entry)
    const result = await PortLease.read(leaseKey)
    expect(result).toBeDefined()
    expect(result!.port).toBe(4444)
    expect(result!.port_name).toBe("http")
    expect(result!.preferred).toBe(4444)
    expect(result!.project_id).toBe(leaseKey.project_id)
    expect(result!.workspace).toBe(leaseKey.workspace)
    expect(result!.process_id).toBe(leaseKey.process_id)
    expect(result!.updated_at).toBeGreaterThan(0)
  })

  test("write overwrites an existing lease", async () => {
    await PortLease.write(entry)
    await PortLease.write({ ...entry, port: 4445 })
    const result = await PortLease.read(leaseKey)
    expect(result!.port).toBe(4445)
  })

  test("lease remembers a different port than preferred", async () => {
    // Simulates: preferred was 4444 but process was started on 4445
    await PortLease.write({ ...entry, port: 4445 })
    const result = await PortLease.read(leaseKey)
    expect(result!.preferred).toBe(4444)
    expect(result!.port).toBe(4445)
  })

  test("drop removes a lease", async () => {
    await PortLease.write(entry)
    await PortLease.drop(leaseKey)
    const result = await PortLease.read(leaseKey)
    expect(result).toBeUndefined()
  })

  test("drop is idempotent on missing lease", async () => {
    // Should not throw
    await PortLease.drop(leaseKey)
  })

  test("prune removes leases for unknown process IDs", async () => {
    await PortLease.write(entry)
    await PortLease.write({
      ...entry,
      process_id: "proc_002",
      port: 3001,
    })

    // Keep proc_001, prune proc_002
    await PortLease.prune({
      project_id: leaseKey.project_id,
      workspace: leaseKey.workspace,
      process_ids: new Set(["proc_001"]),
    })

    const kept = await PortLease.read(leaseKey)
    expect(kept).toBeDefined()
    expect(kept!.port).toBe(4444)

    const pruned = await PortLease.read({ ...leaseKey, process_id: "proc_002" })
    expect(pruned).toBeUndefined()
  })

  test("prune keeps all when every ID is known", async () => {
    await PortLease.write(entry)
    await PortLease.write({ ...entry, process_id: "proc_002", port: 3001 })

    await PortLease.prune({
      project_id: leaseKey.project_id,
      workspace: leaseKey.workspace,
      process_ids: new Set(["proc_001", "proc_002"]),
    })

    expect(await PortLease.read(leaseKey)).toBeDefined()
    expect(await PortLease.read({ ...leaseKey, process_id: "proc_002" })).toBeDefined()
  })

  test("prune removes all when no IDs are known", async () => {
    await PortLease.write(entry)
    await PortLease.prune({
      project_id: leaseKey.project_id,
      workspace: leaseKey.workspace,
      process_ids: new Set(),
    })
    expect(await PortLease.read(leaseKey)).toBeUndefined()
  })

  test("read ignores malformed JSON files", async () => {
    // Write a bad file at the lease path
    const stateDir = tmpDir
    const tag = (v: string) => Buffer.from(v).toString("base64url")
    const dir = path.join(stateDir, "managed-processes/port-leases", tag(leaseKey.project_id), tag(leaseKey.workspace))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${tag(leaseKey.process_id)}.json`), "not json")
    const result = await PortLease.read(leaseKey)
    expect(result).toBeUndefined()
  })

  test("prune cleans up malformed JSON files", async () => {
    const tag = (v: string) => Buffer.from(v).toString("base64url")
    const dir = path.join(tmpDir, "managed-processes/port-leases", tag(leaseKey.project_id), tag(leaseKey.workspace))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "garbage.json"), "not json")

    await PortLease.prune({
      project_id: leaseKey.project_id,
      workspace: leaseKey.workspace,
      process_ids: new Set(),
    })

    const files = await fs.readdir(dir)
    expect(files).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// resolvePort behaviour (exercised through start())
// ---------------------------------------------------------------------------
// These tests verify the lease-aware port resolution logic:
//   1. PortLease hit + matching port_name/preferred → use leased port
//   2. PortLease miss → use preferred port
//   3. PortLease hit but port_name mismatch → fall back to preferred
//   4. Port occupied + no strategy → return port_conflict
//   5. Port occupied + pick-new strategy → find next free port
//   6. Successful start writes lease

describe("resolvePort via start()", () => {
  let tmpDir: string
  let ptyCreate: ReturnType<typeof spyOn> | undefined
  let ptySeq = 0

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-port-test-"))
    process.env.WORKSPACE_RUNTIME_STATE_DIR = tmpDir
    // These tests assert PORT RESOLUTION, not PTY behavior. A real Pty.create
    // boots a login shell that exits immediately on CI runners (no profile),
    // and the exit handler then clears proc.assignedPort before the
    // assertions — the command string cannot prevent that. Stub the PTY as a
    // process that never exits; dispose() still tears state down.
    ptyCreate = spyOn(Pty, "create").mockImplementation(async (input) => ({
      id: `pty_resolve_port_${++ptySeq}`,
      title: input.title ?? "dev-server",
      command: input.command ?? "/bin/sh",
      args: input.args ?? [],
      cwd: input.cwd ?? tmpDir,
      status: "running",
      pid: 1,
    }))
  })

  afterEach(async () => {
    ptyCreate?.mockRestore()
    ptyCreate = undefined
    delete process.env.WORKSPACE_RUNTIME_STATE_DIR
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // Helper: write a processes.jsonc config and load it
  async function setupConfig(
    dir: string,
    config: {
      id: string
      name: string
      command: string
      env?: Record<string, string>
      restartPolicy?: string
      maxRestarts?: number
      port?: { name: string; preferred: number; inject: string; onConflict?: string }
    },
  ) {
    await setupConfigs(dir, [config])
  }

  async function setupConfigs(
    dir: string,
    configs: Array<{
      id: string
      name: string
      command: string
      env?: Record<string, string>
      restartPolicy?: string
      maxRestarts?: number
      port?: { name: string; preferred: number; inject: string; onConflict?: string }
    }>,
  ) {
    const cfgDir = path.join(dir, ".workspace-runtime")
    await fs.mkdir(cfgDir, { recursive: true })
    await fs.writeFile(
      path.join(cfgDir, "processes.jsonc"),
      JSON.stringify({
        $schema: "",
        processes: configs.map((config) => ({
          id: config.id,
          name: config.name,
          command: config.command,
          env: config.env,
          restartPolicy: config.restartPolicy,
          maxRestarts: config.maxRestarts,
          port: config.port,
        })),
      }),
    )
    // loadConfig reads the file and populates the state
    const { loadConfig } = await import("./manager")
    await loadConfig(dir)
  }

  test("uses preferred port when no lease exists and port is free", async () => {
    const dir = path.join(tmpDir, "proj-a")
    await fs.mkdir(dir, { recursive: true })

    const preferred = await freePort()
    await setupConfig(dir, {
      id: "proc_a",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred, inject: "PORT" },
    })

    // No lease written — start should try the preferred port
    const { start, dispose } = await import("./manager")
    try {
      const result = await start(dir, "proc_a")
      expect(result.kind).toBe("started")
      if (result.kind === "started") {
        expect(result.process.assignedPort).toBe(preferred)
      }

      // Verify lease was written
      const lease = await PortLease.read({
        project_id: real(dir),
        workspace: real(dir),
        process_id: "proc_a",
      })
      expect(lease).toBeDefined()
      expect(lease!.port).toBe(preferred)
      expect(lease!.preferred).toBe(preferred)
      expect(lease!.port_name).toBe("http")
    } finally {
      await dispose(dir)
    }
  })

  test("uses leased port when it differs from preferred and is free", async () => {
    const dir = path.join(tmpDir, "proj-b")
    await fs.mkdir(dir, { recursive: true })

    // Pre-write a lease remembering a different previously-assigned port
    const preferred = await freePort()
    const leased = await freePort()
    await PortLease.write({
      project_id: real(dir),
      workspace: real(dir),
      process_id: "proc_b",
      port_name: "http",
      preferred,
      port: leased,
    })

    await setupConfig(dir, {
      id: "proc_b",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred, inject: "PORT" },
    })

    const { start, dispose } = await import("./manager")
    try {
      const result = await start(dir, "proc_b")
      expect(result.kind).toBe("started")
      if (result.kind === "started") {
        // Should use the LEASED port, not preferred
        expect(result.process.assignedPort).toBe(leased)
      }

      // PortLease should be updated (same port)
      const lease = await PortLease.read({
        project_id: real(dir),
        workspace: real(dir),
        process_id: "proc_b",
      })
      expect(lease!.port).toBe(leased)
    } finally {
      await dispose(dir)
    }
  })

  test("falls back to preferred when lease port_name does not match", async () => {
    const dir = path.join(tmpDir, "proj-c")
    await fs.mkdir(dir, { recursive: true })

    // PortLease has port_name "ws" but config port_name is "http" → mismatch
    const preferred = await freePort()
    const leased = await freePort()
    await PortLease.write({
      project_id: real(dir),
      workspace: real(dir),
      process_id: "proc_c",
      port_name: "ws",
      preferred,
      port: leased,
    })

    await setupConfig(dir, {
      id: "proc_c",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred, inject: "PORT" },
    })

    const { start, dispose } = await import("./manager")
    try {
      const result = await start(dir, "proc_c")
      expect(result.kind).toBe("started")
      if (result.kind === "started") {
        // Should fall back to preferred since port_name doesn't match
        expect(result.process.assignedPort).toBe(preferred)
      }
    } finally {
      await dispose(dir)
    }
  })

  test("falls back to preferred when lease preferred does not match", async () => {
    const dir = path.join(tmpDir, "proj-d")
    await fs.mkdir(dir, { recursive: true })

    // PortLease remembers a different preferred than the config → mismatch
    const preferred = await freePort()
    const leased = await freePort()
    await PortLease.write({
      project_id: real(dir),
      workspace: real(dir),
      process_id: "proc_d",
      port_name: "http",
      preferred: 3000,
      port: leased,
    })

    await setupConfig(dir, {
      id: "proc_d",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred, inject: "PORT" },
    })

    const { start, dispose } = await import("./manager")
    try {
      const result = await start(dir, "proc_d")
      expect(result.kind).toBe("started")
      if (result.kind === "started") {
        // Should fall back to preferred since lease.preferred doesn't match
        expect(result.process.assignedPort).toBe(preferred)
      }
    } finally {
      await dispose(dir)
    }
  })

  test("writes lease after successful start", async () => {
    const dir = path.join(tmpDir, "proj-e")
    await fs.mkdir(dir, { recursive: true })

    const preferred = await freePort()
    await setupConfig(dir, {
      id: "proc_e",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred, inject: "PORT" },
    })

    const { start, dispose } = await import("./manager")
    try {
      const result = await start(dir, "proc_e")
      expect(result.kind).toBe("started")

      const lease = await PortLease.read({
        project_id: real(dir),
        workspace: real(dir),
        process_id: "proc_e",
      })
      expect(lease).toBeDefined()
      expect(lease!.port).toBe(preferred)
      expect(lease!.preferred).toBe(preferred)
      expect(lease!.port_name).toBe("http")
      expect(lease!.updated_at).toBeGreaterThan(0)
    } finally {
      await dispose(dir)
    }
  })

  test("dedupes concurrent starts for the same config before port assignment completes", async () => {
    const dir = path.join(tmpDir, "proj-concurrent-same")
    await fs.mkdir(dir, { recursive: true })

    await setupConfig(dir, {
      id: "proc_once",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred: 19881, inject: "PORT" },
    })

    const { start, dispose } = await import("./manager")
    const created: Pty.CreateInput[] = []
    const create = spyOn(Pty, "create").mockImplementation(async (input) => {
      created.push(input)
      await new Promise((resolve) => setTimeout(resolve, 25))
      return {
        id: `pty_proc_once_${created.length}`,
        title: input.title ?? "dev-server",
        command: input.command ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? dir,
        status: "running",
        pid: 1,
      }
    })
    try {
      const results = await Promise.all([start(dir, "proc_once"), start(dir, "proc_once")])
      expect(results.map((result) => result.kind)).toEqual(["started", "started"])
      expect(created).toHaveLength(1)
      expect(results[0].kind === "started" ? results[0].process.ptyId : undefined).toBe("pty_proc_once_1")
      expect(results[1].kind === "started" ? results[1].process.ptyId : undefined).toBe("pty_proc_once_1")
    } finally {
      create.mockRestore()
      await dispose(dir)
    }
  })

  test("reserves assigned ports across concurrent starts before child processes bind", async () => {
    const dir = path.join(tmpDir, "proj-concurrent-ports")
    await fs.mkdir(dir, { recursive: true })

    await setupConfigs(dir, [
      {
        id: "proc_a",
        name: "api",
        command: "echo api",
        port: { name: "http", preferred: 19882, inject: "PORT", onConflict: "pick-new" },
      },
      {
        id: "proc_b",
        name: "web",
        command: "echo web",
        port: { name: "http", preferred: 19882, inject: "PORT", onConflict: "pick-new" },
      },
    ])

    const { start, dispose } = await import("./manager")
    const create = spyOn(Pty, "create").mockImplementation(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return {
        id: `pty_${input.title}`,
        title: input.title ?? "process",
        command: input.command ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? dir,
        status: "running",
        pid: 1,
      }
    })
    try {
      const results = await Promise.all([start(dir, "proc_a"), start(dir, "proc_b")])
      expect(results.map((result) => result.kind)).toEqual(["started", "started"])
      const ports = results.map((result) => result.kind === "started" ? result.process.assignedPort : undefined)
      expect(new Set(ports).size).toBe(2)
      expect(ports).toContain(19882)
    } finally {
      create.mockRestore()
      await dispose(dir)
    }
  })

  test("passes managed command as initialCommand instead of websocket-gated write", async () => {
    const dir = path.join(tmpDir, "proj-initial-command")
    await fs.mkdir(dir, { recursive: true })

    await setupConfig(dir, {
      id: "proc_initial",
      name: "initial",
      command: "bun dev",
      port: { name: "http", preferred: 19887, inject: "--port" },
    })

    const { start, dispose } = await import("./manager")
    const created: Pty.CreateInput[] = []
    const create = spyOn(Pty, "create").mockImplementation(async (input) => {
      created.push(input)
      return {
        id: "pty_initial",
        title: input.title ?? "initial",
        command: input.command ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? dir,
        status: "running",
        pid: 1,
      }
    })
    const write = spyOn(Pty, "write").mockImplementation(() => {})
    try {
      const result = await start(dir, "proc_initial")
      expect(result.kind).toBe("started")

      expect(created).toHaveLength(1)
      expect(created[0]!.initialCommand).toBe("bun dev --port 19887; printf '\\033]777;process-exit;%d\\007' $?")
      expect(write).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
      create.mockRestore()
      await dispose(dir)
    }
  })

  test("cleans a PTY created by an in-flight start after dispose wins the race", async () => {
    const dir = path.join(tmpDir, "proj-starting-dispose")
    await fs.mkdir(dir, { recursive: true })

    await setupConfig(dir, {
      id: "proc_starting",
      name: "starting",
      command: "echo hi",
      port: { name: "http", preferred: 19886, inject: "PORT" },
    })

    const { start, dispose } = await import("./manager")
    let releaseCreate: (() => void) | undefined
    let createEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      createEntered = resolve
    })
    const create = spyOn(Pty, "create").mockImplementation(async (input) => {
      createEntered?.()
      await new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      return {
        id: "pty_starting",
        title: input.title ?? "starting",
        command: input.command ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? dir,
        status: "running",
        pid: 1,
      }
    })
    const remove = spyOn(Pty, "remove").mockImplementation(async () => {})
    try {
      const pendingStart = start(dir, "proc_starting")
      await entered

      await dispose(dir)
      releaseCreate?.()
      const result = await pendingStart

      expect(result.kind).toBe("failed")
      expect(remove).toHaveBeenCalledWith("pty_starting")
    } finally {
      remove.mockRestore()
      create.mockRestore()
      releaseCreate?.()
      await dispose(dir)
    }
  })

  test("dispose stops active managed PTYs and clears loaded state", async () => {
    const dir = path.join(tmpDir, "proj-dispose-running")
    await fs.mkdir(dir, { recursive: true })

    await setupConfigs(dir, [
      {
        id: "proc_running",
        name: "running",
        command: "echo running",
      },
      {
        id: "proc_stopping",
        name: "stopping",
        command: "echo stopping",
      },
    ])

    const active = new Map<string, PtyInfo>()
    const { start, stop, dispose, list, configs } = await import("./manager")
    const create = spyOn(Pty, "create").mockImplementation(async (input) => {
      const info = {
        id: `pty_${input.title}`,
        title: input.title ?? "process",
        command: input.command ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? dir,
        status: "running" as const,
        pid: active.size + 1,
      }
      active.set(info.id, info)
      return info
    })
    const get = spyOn(Pty, "get").mockImplementation((id) => active.get(id))
    const write = spyOn(Pty, "write").mockImplementation((id) => {
      queueMicrotask(() => {
        active.delete(id)
        workspaceRuntimeBus.publish({ type: "pty.exited", id, exitCode: 0 })
      })
    })
    const remove = spyOn(Pty, "remove").mockImplementation(async (id) => {
      active.delete(id)
    })
    try {
      expect((await start(dir, "proc_running")).kind).toBe("started")
      expect((await start(dir, "proc_stopping")).kind).toBe("started")
      const stopping = stop(dir, "proc_stopping")
      await Promise.resolve()

      await dispose(dir)
      await stopping

      expect([...active.keys()]).toEqual([])
      expect(write.mock.calls.map((call) => call[0]).sort()).toEqual(["pty_running", "pty_stopping"])
      expect(list(dir)).toEqual([])
      expect(configs(dir)).toEqual([])
    } finally {
      remove.mockRestore()
      write.mockRestore()
      get.mockRestore()
      create.mockRestore()
      await dispose(dir)
    }
  })

  test("dispose clears scheduled restarts before replacement PTYs are created", async () => {
    const dir = path.join(tmpDir, "proj-dispose-restarting")
    await fs.mkdir(dir, { recursive: true })

    await setupConfig(dir, {
      id: "proc_restart",
      name: "restart",
      command: "echo restart",
      restartPolicy: "always",
      maxRestarts: 3,
    })

    const active = new Map<string, PtyInfo>()
    const { start, dispose, get } = await import("./manager")
    const create = spyOn(Pty, "create").mockImplementation(async (input) => {
      const info = {
        id: `pty_${active.size + 1}`,
        title: input.title ?? "restart",
        command: input.command ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? dir,
        status: "running" as const,
        pid: active.size + 1,
      }
      active.set(info.id, info)
      return info
    })
    const getPty = spyOn(Pty, "get").mockImplementation((id) => active.get(id))
    const remove = spyOn(Pty, "remove").mockImplementation(async (id) => {
      active.delete(id)
    })
    try {
      const started = await start(dir, "proc_restart")
      expect(started.kind).toBe("started")

      active.delete("pty_1")
      workspaceRuntimeBus.publish({ type: "pty.exited", id: "pty_1", exitCode: 1 })
      await Promise.resolve()
      await Promise.resolve()
      expect(get(dir, "proc_restart")?.status).toBe("restarting")

      await dispose(dir)
      await new Promise((resolve) => setTimeout(resolve, 1100))

      expect(create).toHaveBeenCalledTimes(1)
      expect([...active.keys()]).toEqual([])
    } finally {
      remove.mockRestore()
      getPty.mockRestore()
      create.mockRestore()
      await dispose(dir)
    }
  })

  test("dispose clears crashed managed process state", async () => {
    const dir = path.join(tmpDir, "proj-dispose-crashed")
    await fs.mkdir(dir, { recursive: true })

    await setupConfig(dir, {
      id: "proc_crashed",
      name: "crashed",
      command: "echo crashed",
    })

    const { start, dispose, get, list, configs } = await import("./manager")
    const create = spyOn(Pty, "create").mockImplementation(async () => {
      throw new Error("spawn failed")
    })
    try {
      const failed = await start(dir, "proc_crashed")
      expect(failed.kind).toBe("failed")
      expect(get(dir, "proc_crashed")?.status).toBe("crashed")

      await dispose(dir)

      expect(list(dir)).toEqual([])
      expect(configs(dir)).toEqual([])
    } finally {
      create.mockRestore()
      await dispose(dir)
    }
  })

  test("releases an assigned port when PTY startup fails", async () => {
    const dir = path.join(tmpDir, "proj-failed-start")
    await fs.mkdir(dir, { recursive: true })

    await setupConfig(dir, {
      id: "proc_fail",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred: 19884, inject: "PORT" },
    })

    const { start, dispose } = await import("./manager")
    const create = spyOn(Pty, "create")
      .mockImplementationOnce(async () => {
        throw new Error("spawn failed")
      })
      .mockImplementationOnce(async (input) => ({
        id: "pty_proc_fail",
        title: input.title ?? "dev-server",
        command: input.command ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? dir,
        status: "running",
        pid: 1,
      }))
    try {
      const failed = await start(dir, "proc_fail")
      expect(failed.kind).toBe("failed")

      const started = await start(dir, "proc_fail")
      expect(started.kind).toBe("started")
      if (started.kind === "started") {
        expect(started.process.assignedPort).toBe(19884)
      }
    } finally {
      create.mockRestore()
      await dispose(dir)
    }
  })

  test("cleans registered port and PTY when lease persistence fails during start", async () => {
    const dir = path.join(tmpDir, "proj-lease-fail")
    await fs.mkdir(dir, { recursive: true })

    await setupConfig(dir, {
      id: "proc_lease_fail",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred: 19885, inject: "PORT" },
    })

    const { start, dispose } = await import("./manager")
    const create = spyOn(Pty, "create").mockImplementation(async (input) => ({
      id: `pty_lease_fail_${input.env?.PORT ?? "missing"}`,
      title: input.title ?? "dev-server",
      command: input.command ?? "/bin/sh",
      args: input.args ?? [],
      cwd: input.cwd ?? dir,
      status: "running",
      pid: 1,
    }))
    const remove = spyOn(Pty, "remove").mockImplementation(async () => {})
    const write = spyOn(PortLease, "write")
      .mockImplementationOnce(async () => {
        throw new Error("lease write failed")
      })
      .mockImplementationOnce(async () => {})
    try {
      const failed = await start(dir, "proc_lease_fail")
      expect(failed.kind).toBe("failed")
      expect(remove).toHaveBeenCalledWith("pty_lease_fail_19885")

      const started = await start(dir, "proc_lease_fail")
      expect(started.kind).toBe("started")
      if (started.kind === "started") {
        expect(started.process.assignedPort).toBe(19885)
        expect(started.process.ptyId).toBe("pty_lease_fail_19885")
      }
    } finally {
      write.mockRestore()
      remove.mockRestore()
      create.mockRestore()
      await dispose(dir)
    }
  })

  test("filters managed process env through the PTY safe-env policy", async () => {
    const dir = path.join(tmpDir, "proj-env")
    await fs.mkdir(dir, { recursive: true })

    await setupConfig(dir, {
      id: "proc_env",
      name: "env-check",
      command: "echo hi",
      env: {
        NODE_OPTIONS: "--require /definitely-missing-workspace-runtime-module",
        SECRET_TOKEN: "nope",
        OPENCODE_ALLOWED: "yes",
        CLAXEDO_ALLOWED: "yes",
      },
      port: { name: "http", preferred: 19878, inject: "PORT" },
    })

    const { start, dispose } = await import("./manager")
    const created: Pty.CreateInput[] = []
    const create = spyOn(Pty, "create").mockImplementation(async (input) => {
      created.push(input)
      return {
        id: "pty_proc_env",
        title: input.title ?? "env-check",
        command: input.command ?? "/bin/sh",
        args: input.args ?? [],
        cwd: input.cwd ?? dir,
        status: "running",
        pid: 1,
      }
    })
    try {
      const result = await start(dir, "proc_env")
      expect(result.kind).toBe("started")
      if (result.kind !== "started") return

      expect(created).toHaveLength(1)
      expect(created[0]!.env?.NODE_OPTIONS).toBeUndefined()
      expect(created[0]!.env?.SECRET_TOKEN).toBeUndefined()
      expect(created[0]!.env).toMatchObject({
        OPENCODE_ALLOWED: "yes",
        CLAXEDO_ALLOWED: "yes",
        PORT: "19878",
      })
    } finally {
      create.mockRestore()
      await dispose(dir)
    }
  })
})
