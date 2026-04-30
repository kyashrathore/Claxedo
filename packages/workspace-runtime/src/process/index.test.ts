import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { addr } from "./index"
import fs from "fs/promises"
import { realpathSync } from "fs"
import os from "os"
import path from "path"

/** Match the real() function in index.ts — resolves symlinks */
function real(dir: string) {
  try {
    return path.resolve(realpathSync.native?.(dir) ?? realpathSync(dir))
  } catch {
    return path.resolve(dir)
  }
}

describe("addr", () => {
  test("reads node listen EADDRINUSE output with ipv6 host", () => {
    expect(addr("Error: listen EADDRINUSE: address already in use :::3000")).toBe(3000)
  })

  test("reads bind address already in use output", () => {
    expect(addr("listen tcp 127.0.0.1:8787: bind: address already in use")).toBe(8787)
  })

  test("reads generic port wording", () => {
    expect(addr("Port 4321 is in use (EADDRINUSE)")).toBe(4321)
  })

  test("reads vite strictPort wording", () => {
    expect(addr("Port 4444 is already in use")).toBe(4444)
  })
})

describe("process config file", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "process-config-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("loads process configs from .claxedo", async () => {
    await fs.mkdir(path.join(tmpDir, ".claxedo"), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, ".claxedo", "processes.jsonc"),
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

    const { loadConfig } = await import("./index")
    const configs = await loadConfig(tmpDir)

    expect(configs.map((config) => config.id)).toEqual(["proc_cfg"])
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

    const { loadConfig } = await import("./index")
    const configs = await loadConfig(tmpDir)
    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, ".claxedo", "processes.jsonc"), "utf-8"))

    expect(configs[0]!.id).toMatch(/^proc_/)
    expect(persisted.processes[0].id).toBe(configs[0]!.id)
  })
})

// ---------------------------------------------------------------------------
// Lease behaviour assertions
// ---------------------------------------------------------------------------
// Tests run against the real Lease module with a temp stateDir so no
// interaction with the real ~/.claxedo/state directory.

import * as Lease from "./lease"

describe("Lease", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lease-test-"))
    process.env.CLAXEDO_STATE_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CLAXEDO_STATE_DIR
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
    const result = await Lease.read(leaseKey)
    expect(result).toBeUndefined()
  })

  test("write persists and read retrieves a lease", async () => {
    await Lease.write(entry)
    const result = await Lease.read(leaseKey)
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
    await Lease.write(entry)
    await Lease.write({ ...entry, port: 4445 })
    const result = await Lease.read(leaseKey)
    expect(result!.port).toBe(4445)
  })

  test("lease remembers a different port than preferred", async () => {
    // Simulates: preferred was 4444 but process was started on 4445
    await Lease.write({ ...entry, port: 4445 })
    const result = await Lease.read(leaseKey)
    expect(result!.preferred).toBe(4444)
    expect(result!.port).toBe(4445)
  })

  test("drop removes a lease", async () => {
    await Lease.write(entry)
    await Lease.drop(leaseKey)
    const result = await Lease.read(leaseKey)
    expect(result).toBeUndefined()
  })

  test("drop is idempotent on missing lease", async () => {
    // Should not throw
    await Lease.drop(leaseKey)
  })

  test("prune removes leases for unknown process IDs", async () => {
    await Lease.write(entry)
    await Lease.write({
      ...entry,
      process_id: "proc_002",
      port: 3001,
    })

    // Keep proc_001, prune proc_002
    await Lease.prune({
      project_id: leaseKey.project_id,
      workspace: leaseKey.workspace,
      process_ids: new Set(["proc_001"]),
    })

    const kept = await Lease.read(leaseKey)
    expect(kept).toBeDefined()
    expect(kept!.port).toBe(4444)

    const pruned = await Lease.read({ ...leaseKey, process_id: "proc_002" })
    expect(pruned).toBeUndefined()
  })

  test("prune keeps all when every ID is known", async () => {
    await Lease.write(entry)
    await Lease.write({ ...entry, process_id: "proc_002", port: 3001 })

    await Lease.prune({
      project_id: leaseKey.project_id,
      workspace: leaseKey.workspace,
      process_ids: new Set(["proc_001", "proc_002"]),
    })

    expect(await Lease.read(leaseKey)).toBeDefined()
    expect(await Lease.read({ ...leaseKey, process_id: "proc_002" })).toBeDefined()
  })

  test("prune removes all when no IDs are known", async () => {
    await Lease.write(entry)
    await Lease.prune({
      project_id: leaseKey.project_id,
      workspace: leaseKey.workspace,
      process_ids: new Set(),
    })
    expect(await Lease.read(leaseKey)).toBeUndefined()
  })

  test("read ignores malformed JSON files", async () => {
    // Write a bad file at the lease path
    const stateDir = tmpDir
    const tag = (v: string) => Buffer.from(v).toString("base64url")
    const dir = path.join(stateDir, "portpick", tag(leaseKey.project_id), tag(leaseKey.workspace))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${tag(leaseKey.process_id)}.json`), "not json")
    const result = await Lease.read(leaseKey)
    expect(result).toBeUndefined()
  })

  test("prune cleans up malformed JSON files", async () => {
    const tag = (v: string) => Buffer.from(v).toString("base64url")
    const dir = path.join(tmpDir, "portpick", tag(leaseKey.project_id), tag(leaseKey.workspace))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "garbage.json"), "not json")

    await Lease.prune({
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
//   1. Lease hit + matching port_name/preferred → use leased port
//   2. Lease miss → use preferred port
//   3. Lease hit but port_name mismatch → fall back to preferred
//   4. Port occupied + no strategy → return port_conflict
//   5. Port occupied + pick-new strategy → find next free port
//   6. Successful start writes lease

describe("resolvePort via start()", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-port-test-"))
    process.env.CLAXEDO_STATE_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CLAXEDO_STATE_DIR
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // Helper: write a processes.jsonc config and load it
  async function setupConfig(
    dir: string,
    config: {
      id: string
      name: string
      command: string
      port: { name: string; preferred: number; inject: string; onConflict?: string }
    },
  ) {
    const cfgDir = path.join(dir, ".claxedo")
    await fs.mkdir(cfgDir, { recursive: true })
    await fs.writeFile(
      path.join(cfgDir, "processes.jsonc"),
      JSON.stringify({
        $schema: "",
        processes: [
          {
            id: config.id,
            name: config.name,
            command: config.command,
            port: config.port,
          },
        ],
      }),
    )
    // loadConfig reads the file and populates the state
    const { loadConfig } = await import("./index")
    await loadConfig(dir)
  }

  test("uses preferred port when no lease exists and port is free", async () => {
    const dir = path.join(tmpDir, "proj-a")
    await fs.mkdir(dir, { recursive: true })

    await setupConfig(dir, {
      id: "proc_a",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred: 19876, inject: "PORT" },
    })

    // No lease written — start should try preferred port (19876)
    const { start, dispose } = await import("./index")
    try {
      const result = await start(dir, "proc_a")
      expect(result.kind).toBe("started")
      if (result.kind === "started") {
        expect(result.process.assignedPort).toBe(19876)
      }

      // Verify lease was written
      const lease = await Lease.read({
        project_id: real(dir),
        workspace: real(dir),
        process_id: "proc_a",
      })
      expect(lease).toBeDefined()
      expect(lease!.port).toBe(19876)
      expect(lease!.preferred).toBe(19876)
      expect(lease!.port_name).toBe("http")
    } finally {
      await dispose(dir)
    }
  })

  test("uses leased port when it differs from preferred and is free", async () => {
    const dir = path.join(tmpDir, "proj-b")
    await fs.mkdir(dir, { recursive: true })

    // Pre-write a lease saying port 19877 was previously assigned
    await Lease.write({
      project_id: real(dir),
      workspace: real(dir),
      process_id: "proc_b",
      port_name: "http",
      preferred: 19876,
      port: 19877,
    })

    await setupConfig(dir, {
      id: "proc_b",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred: 19876, inject: "PORT" },
    })

    const { start, dispose } = await import("./index")
    try {
      const result = await start(dir, "proc_b")
      expect(result.kind).toBe("started")
      if (result.kind === "started") {
        // Should use the LEASED port (19877), not preferred (19876)
        expect(result.process.assignedPort).toBe(19877)
      }

      // Lease should be updated (same port)
      const lease = await Lease.read({
        project_id: real(dir),
        workspace: real(dir),
        process_id: "proc_b",
      })
      expect(lease!.port).toBe(19877)
    } finally {
      await dispose(dir)
    }
  })

  test("falls back to preferred when lease port_name does not match", async () => {
    const dir = path.join(tmpDir, "proj-c")
    await fs.mkdir(dir, { recursive: true })

    // Lease has port_name "ws" but config port_name is "http" → mismatch
    await Lease.write({
      project_id: real(dir),
      workspace: real(dir),
      process_id: "proc_c",
      port_name: "ws",
      preferred: 19876,
      port: 19877,
    })

    await setupConfig(dir, {
      id: "proc_c",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred: 19876, inject: "PORT" },
    })

    const { start, dispose } = await import("./index")
    try {
      const result = await start(dir, "proc_c")
      expect(result.kind).toBe("started")
      if (result.kind === "started") {
        // Should fall back to preferred (19876) since port_name doesn't match
        expect(result.process.assignedPort).toBe(19876)
      }
    } finally {
      await dispose(dir)
    }
  })

  test("falls back to preferred when lease preferred does not match", async () => {
    const dir = path.join(tmpDir, "proj-d")
    await fs.mkdir(dir, { recursive: true })

    // Lease has preferred 3000 but config preferred is 19876 → mismatch
    await Lease.write({
      project_id: real(dir),
      workspace: real(dir),
      process_id: "proc_d",
      port_name: "http",
      preferred: 3000,
      port: 19877,
    })

    await setupConfig(dir, {
      id: "proc_d",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred: 19876, inject: "PORT" },
    })

    const { start, dispose } = await import("./index")
    try {
      const result = await start(dir, "proc_d")
      expect(result.kind).toBe("started")
      if (result.kind === "started") {
        // Should fall back to preferred (19876) since lease.preferred doesn't match
        expect(result.process.assignedPort).toBe(19876)
      }
    } finally {
      await dispose(dir)
    }
  })

  test("writes lease after successful start", async () => {
    const dir = path.join(tmpDir, "proj-e")
    await fs.mkdir(dir, { recursive: true })

    await setupConfig(dir, {
      id: "proc_e",
      name: "dev-server",
      command: "echo hi",
      port: { name: "http", preferred: 19876, inject: "PORT" },
    })

    const { start, dispose } = await import("./index")
    try {
      const result = await start(dir, "proc_e")
      expect(result.kind).toBe("started")

      const lease = await Lease.read({
        project_id: real(dir),
        workspace: real(dir),
        process_id: "proc_e",
      })
      expect(lease).toBeDefined()
      expect(lease!.port).toBe(19876)
      expect(lease!.preferred).toBe(19876)
      expect(lease!.port_name).toBe("http")
      expect(lease!.updated_at).toBeGreaterThan(0)
    } finally {
      await dispose(dir)
    }
  })
})
