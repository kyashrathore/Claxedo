import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
// The engine directly: these tests exercise the boot pipeline (migrations,
// repair gate) against both the real journal and synthetic ones.
import { ClaxedoDB, configureClaxedoSchema, queryRows, textColumns } from "./db"
import { CLAXEDO_MIGRATION_JOURNAL } from "./journal"

const previousDataDir = process.env.CLAXEDO_DATA_DIR
let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "claxedo-db-boot-"))
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
  configureClaxedoSchema({ journals: [CLAXEDO_MIGRATION_JOURNAL] })
})

afterEach(() => {
  ClaxedoDB.close()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  configureClaxedoSchema({ journals: [CLAXEDO_MIGRATION_JOURNAL] })
  rmSync(root, { recursive: true, force: true })
})

function boot() {
  return ClaxedoDB.raw()
}

function reboot() {
  ClaxedoDB.close()
  return ClaxedoDB.raw()
}

function hasTable(sqlite: ReturnType<typeof boot>, name: string) {
  return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/**
 * A row only repair's unconditional org backfill would touch: the schema
 * around it is fully migrated, so healing it proves repair RAN, and it staying
 * empty proves repair was SKIPPED. (Migrations never revisit it — its own
 * backfill UPDATE is already journalled as applied.)
 */
function plantDriftedCredential(sqlite: ReturnType<typeof boot>) {
  sqlite
    .prepare(
      `INSERT INTO claxedo_provider_credential (id, provider_id, kind, source, org_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("cred_gate", "prov", "api_key", "managed", "", "available", 1, 1)
}

function credentialOrg(sqlite: ReturnType<typeof boot>) {
  return (sqlite.prepare("SELECT org_id FROM claxedo_provider_credential WHERE id = 'cred_gate'").get() as {
    org_id: string
  }).org_id
}

describe("repair gate", () => {
  test("first boot runs repair and persists a schema fingerprint", () => {
    const sqlite = boot()

    const row = sqlite
      .prepare("SELECT value FROM __claxedo_meta WHERE key = 'repair_fingerprint'")
      .get() as { value: string } | undefined
    expect(row?.value).toMatch(/^[a-f0-9]{64}$/)
  })

  test("second boot with an unchanged schema skips repair", () => {
    const first = boot()
    plantDriftedCredential(first)

    const second = reboot()

    // Repair's unconditional full-table UPDATE would have rewritten '' to
    // '__local__'; the row surviving untouched proves repair did not run.
    expect(credentialOrg(second)).toBe("")
  })

  test("schema drift re-runs repair in full", () => {
    const first = boot()
    plantDriftedCredential(first)
    first.exec("DROP TABLE claxedo_usage_turn_owner")

    const second = reboot()

    expect(hasTable(second, "claxedo_usage_turn_owner")).toBe(true)
    expect(credentialOrg(second)).toBe("__local__")
  })

  test("a missing fingerprint fails open into a repair pass", () => {
    const first = boot()
    plantDriftedCredential(first)
    first.prepare("DELETE FROM __claxedo_meta WHERE key = 'repair_fingerprint'").run()

    const second = reboot()

    expect(credentialOrg(second)).toBe("__local__")
  })
})

describe("migrations", () => {
  test("apply once and only once", () => {
    const journalled = (sqlite: ReturnType<typeof boot>) =>
      sqlite.prepare("SELECT name, applied_at FROM __claxedo_migrations ORDER BY name").all() as {
        name: string
        applied_at: number
      }[]

    const first = journalled(boot())
    expect(first.length).toBe(
      readdirSync(CLAXEDO_MIGRATION_JOURNAL, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length,
    )

    const second = journalled(reboot())

    // Identical applied_at values prove no entry was re-applied or re-journalled.
    expect(second).toEqual(first)
  })

  test("a warm boot never reads applied migration SQL from disk", () => {
    const journal = path.join(root, "journal")
    const sqlFile = path.join(journal, "20990101000000_lazy_probe", "migration.sql")
    mkdirSync(path.dirname(sqlFile), { recursive: true })
    writeFileSync(sqlFile, "CREATE TABLE claxedo_lazy_probe (id text PRIMARY KEY)")
    configureClaxedoSchema({ journals: [journal] })

    expect(hasTable(boot(), "claxedo_lazy_probe")).toBe(true)

    // Make the applied migration's SQL unreadable: a directory at the file's
    // path still passes the existence probe, but any readFileSync would throw
    // EISDIR. The reboot only survives if the SQL is never loaded.
    ClaxedoDB.close()
    rmSync(sqlFile)
    mkdirSync(sqlFile)

    expect(hasTable(boot(), "claxedo_lazy_probe")).toBe(true)
  })

  test("dropping the credential network grants spares user rows", () => {
    const sqlite = boot()
    // Unjournalling the entry is the only way to observe a migration that the
    // boot under test has already applied against the finished schema.
    sqlite
      .prepare("DELETE FROM __claxedo_migrations WHERE name = ?")
      .run("20260913000100_drop_credential_network_grants")
    const plant = (id: string, target: string, kind: string, constraints: string) =>
      sqlite
        .prepare(
          `INSERT INTO claxedo_network_policy (id, workspace_id, harness, target, kind, constraints_json, created_at, updated_at)
           VALUES (?, NULL, NULL, ?, ?, ?, 1, 1)`,
        )
        .run(id, target, kind, constraints)
    plant("granted", "openai", "group", JSON.stringify({ auto: true, source: "credential:openai" }))
    plant("chosen", "openai", "group", "{}")
    plant("mcp", "search.example.com", "host", JSON.stringify({ auto: true, source: "mcp:search" }))

    const rebooted = reboot()

    expect(rebooted.prepare("SELECT id FROM claxedo_network_policy ORDER BY id").all()).toEqual([
      { id: "chosen" },
      { id: "mcp" },
    ])
  })

  const USAGE_LOCATION_MIGRATION = "20260920000100_usage_location_machine_placed"

  function plantUsageTurn(sqlite: ReturnType<typeof boot>, messageId: string, location: string) {
    for (const table of ["claxedo_usage_turn_revision", "claxedo_usage_turn_current"]) {
      sqlite
        .prepare(
          `INSERT INTO ${table}
             (host_id, session_ref, session_id, message_id, revision, payload_hash, observed_at,
              settlement, status, location, harness, provider_id, model_id, quality_json)
           VALUES ('host_1', 'ref_1', 'ses_1', ?, 1, 'hash', 1, 'final', 'completed', ?, 'pi', 'prov', 'model', '{}')`,
        )
        .run(messageId, location)
    }
  }

  function usageLocations(sqlite: ReturnType<typeof boot>, table: string) {
    return sqlite.prepare(`SELECT message_id, location FROM ${table} ORDER BY message_id`).all()
  }

  test("a machine-placed turn is remetered at the attached server's location", () => {
    const sqlite = boot()
    // Unjournalling the entry is the only way to observe a migration that the
    // boot under test has already applied against the finished schema.
    sqlite.prepare("DELETE FROM __claxedo_migrations WHERE name = ?").run(USAGE_LOCATION_MIGRATION)
    plantUsageTurn(sqlite, "msg_machine", "user-hosted")
    plantUsageTurn(sqlite, "msg_cloud", "cloud-workspace")

    const rebooted = reboot()

    for (const table of ["claxedo_usage_turn_revision", "claxedo_usage_turn_current"]) {
      expect(usageLocations(rebooted, table)).toEqual([
        { message_id: "msg_cloud", location: "cloud-workspace" },
        { message_id: "msg_machine", location: "local" },
      ])
    }
  })

  test("the rewrite is the migration's, not the boot's", () => {
    const sqlite = boot()
    plantUsageTurn(sqlite, "msg_machine", "user-hosted")

    const rebooted = reboot()

    expect(usageLocations(rebooted, "claxedo_usage_turn_current")).toEqual([
      { message_id: "msg_machine", location: "user-hosted" },
    ])
  })

  test("journals compose into one order by timestamp, so a plugin's migration lands between the host's", () => {
    const write = (journal: string, name: string, sql: string) => {
      mkdirSync(path.join(root, journal, name), { recursive: true })
      writeFileSync(path.join(root, journal, name, "migration.sql"), sql)
    }
    write("host", "20990101000000_host_first", "CREATE TABLE claxedo_order (step text)")
    write("host", "20990103000000_host_last", "INSERT INTO claxedo_order VALUES ('host-last')")
    write("plugin", "20990102000000_plugin_middle", "INSERT INTO claxedo_order VALUES ('plugin-middle')")
    configureClaxedoSchema({ journals: [path.join(root, "host"), path.join(root, "plugin")] })

    const sqlite = boot()
    expect(textColumns(queryRows(sqlite, "SELECT name FROM __claxedo_migrations ORDER BY rowid"), "name"))
      .toEqual(["20990101000000_host_first", "20990102000000_plugin_middle", "20990103000000_host_last"])
    expect(textColumns(queryRows(sqlite, "SELECT step FROM claxedo_order ORDER BY rowid"), "step")).toEqual(["plugin-middle", "host-last"])
  })

  test("a migration name two journals both claim refuses the boot", () => {
    for (const journal of ["host", "plugin"]) {
      mkdirSync(path.join(root, journal, "20990101000000_shared"), { recursive: true })
      writeFileSync(path.join(root, journal, "20990101000000_shared", "migration.sql"), "SELECT 1")
    }
    configureClaxedoSchema({ journals: [path.join(root, "host"), path.join(root, "plugin")] })

    expect(() => boot()).toThrow(/20990101000000_shared is in two journals/)
  })

  test("an empty plugin journal, or none configured, refuses the boot rather than open a database without its tables", () => {
    mkdirSync(path.join(root, "empty"), { recursive: true })
    configureClaxedoSchema({ journals: [CLAXEDO_MIGRATION_JOURNAL, path.join(root, "empty")] })
    expect(() => boot()).toThrow(/is empty or missing/)
    configureClaxedoSchema({ journals: [] })
    expect(() => boot()).toThrow(/before its migration journals were configured/)
  })

  test("a pending migration whose SQL cannot be read fails the boot", () => {
    const journal = path.join(root, "journal")
    mkdirSync(path.join(journal, "20990101000000_broken", "migration.sql"), { recursive: true })
    configureClaxedoSchema({ journals: [journal] })

    expect(() => boot()).toThrow(/EISDIR/)
  })
})

describe("close", () => {
  // The suite runs under Node, whose better-sqlite3 finalizes its statements on
  // close; the products that run under Bun open bun:sqlite, which does not.
  test("under Bun, closes the file even while a statement prepared on it is still reachable", () => {
    const script = `
      const { ClaxedoDB, configureClaxedoSchema } = await import(${JSON.stringify(fileURLToPath(new URL("./db.ts", import.meta.url)))})
      configureClaxedoSchema({ journals: [${JSON.stringify(CLAXEDO_MIGRATION_JOURNAL)}] })
      const kept = ClaxedoDB.raw().prepare("SELECT 1")
      kept.get()
      ClaxedoDB.close()
      let ranAfterClose = true
      try { kept.get() } catch { ranAfterClose = false }
      require("node:fs").rmSync(process.env.CLAXEDO_DATA_DIR, { recursive: true })
      console.log("close-result " + JSON.stringify({ ranAfterClose }))
    `
    const child = spawnSync("bun", ["--eval", script], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: { ...process.env, CLAXEDO_DATA_DIR: path.join(root, "bun-data") },
      encoding: "utf8",
    })

    expect(child.status, child.stderr).toBe(0)
    const result = child.stdout.split("\n").find((line) => line.startsWith("close-result "))
    expect(JSON.parse(result?.slice("close-result ".length) ?? "null")).toEqual({ ranAfterClose: false })
  })
})
