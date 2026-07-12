import Database from "better-sqlite3"
import { describe, expect, test } from "vitest"
import { readFileSync, readdirSync, rmSync } from "fs"
import { randomUUID } from "crypto"
import os from "os"
import path from "path"
import { repair } from "./repair"

function entries() {
  const dir = path.join(import.meta.dirname, "claxedo-migration")
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name, idx) => ({
      name,
      sql: readFileSync(path.join(dir, name, "migration.sql"), "utf-8"),
      timestamp: idx,
    }))
}

function hasTable(db: InstanceType<typeof Database>, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function hasColumn(db: InstanceType<typeof Database>, table: string, name: string) {
  const rows = db.prepare(`PRAGMA table_info(\`${table}\`)`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === name)
}

function column(db: InstanceType<typeof Database>, table: string, name: string) {
  const rows = db.prepare(`PRAGMA table_info(\`${table}\`)`).all() as Array<{ name: string; notnull: number }>
  return rows.find((row) => row.name === name)
}

function apply(db: InstanceType<typeof Database>) {
  entries().forEach((entry) => {
    entry.sql
      .split("--> statement-breakpoint")
      .map((sql) => sql.trim())
      .filter(Boolean)
      .forEach((sql) => db.exec(sql))
  })
}

function applyMigration(db: InstanceType<typeof Database>, name: string) {
  const entry = entries().find((item) => item.name === name)
  if (!entry) throw new Error(`missing migration ${name}`)
  entry.sql
    .split("--> statement-breakpoint")
    .map((sql) => sql.trim())
    .filter(Boolean)
    .forEach((sql) => db.exec(sql))
}

describe("claxedo schema", () => {
  test("bundled migrations create the full schema", () => {
    const sqlite = new Database(":memory:")

    apply(sqlite)

    expect(hasTable(sqlite, "claxedo_page")).toBe(true)
    expect(hasTable(sqlite, "claxedo_page_status")).toBe(true)
    expect(hasTable(sqlite, "claxedo_page_arena")).toBe(true)
    expect(hasTable(sqlite, "claxedo_terminal_session")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "org_id")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "visibility")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "version")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "source_path")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "commit_status")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "file_path")).toBe(false)
    expect(hasColumn(sqlite, "claxedo_page", "directory")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_session_meta", "host")).toBe(true)
    expect(column(sqlite, "claxedo_session_meta", "directory")?.notnull).toBe(0)
    expect(hasColumn(sqlite, "claxedo_session_meta", "model_provider_id")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_session_meta", "model_id")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_workspace_lease", "driver")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_workspace_lease", "driver_resource_id")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_workspace_lease", "driver_snapshot_id")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_terminal_session", "driver")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_terminal_session", "provider")).toBe(false)
    expect(hasColumn(sqlite, "claxedo_workspace_lease", "provider")).toBe(false)
    expect(hasColumn(sqlite, "claxedo_workspace_lease", "provider_object_id")).toBe(false)
    expect(hasColumn(sqlite, "claxedo_workspace_lease", "provider_snapshot_id")).toBe(false)
    expect(hasColumn(sqlite, "claxedo_runtime_snapshot", "driver_snapshot_id")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_runtime_snapshot", "provider_snapshot_id")).toBe(false)
  })

  test("sandbox driver credential migration renames old sandbox driver credential kind", () => {
    const sqlite = new Database(":memory:")

    applyMigration(sqlite, "20260411000000_provider_credentials")
    const insert = sqlite.prepare(`
      INSERT INTO claxedo_provider_credential (
        id,
        provider_id,
        kind,
        source,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run("cred_1", "daytona", "sandbox_provider", "managed", "available", 1, 1)
    insert.run("cred_2", "modal", "runtime_host_provider", "managed", "available", 1, 1)

    applyMigration(sqlite, "20260702000100_sandbox_driver_credentials")

    expect(sqlite.prepare("SELECT id, kind FROM claxedo_provider_credential ORDER BY id").all()).toEqual([
      { id: "cred_1", kind: "sandbox_driver" },
      { id: "cred_2", kind: "sandbox_driver" },
    ])
  })

  test("hybrid placement migration preserves workspace rows and permits directory-less sessions", () => {
    const sqlite = new Database(":memory:")

    applyMigration(sqlite, "20260320190000_session_meta")
    sqlite.prepare(`
      INSERT INTO claxedo_session_meta (
        session_id,
        workspace_id,
        project_id,
        directory,
        title,
        parent_session_id,
        archived_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy", "ws_1", "proj_1", "", "Legacy", null, null, 1, 2)
    sqlite.prepare(`
      INSERT INTO claxedo_session_meta (
        session_id,
        workspace_id,
        project_id,
        directory,
        title,
        parent_session_id,
        archived_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy_dir", "ws_1", "proj_1", "/tmp/project", "Legacy Dir", null, null, 3, 4)
    applyMigration(sqlite, "20260603000100_hybrid_session_placement")

    expect(sqlite.prepare("SELECT * FROM claxedo_session_meta WHERE session_id = ?").get("legacy")).toMatchObject({
      session_id: "legacy",
      workspace_id: "ws_1",
      project_id: "proj_1",
      host: "workspace",
      directory: null,
      title: "Legacy",
      created_at: 1,
      updated_at: 2,
    })
    expect(sqlite.prepare("SELECT host, directory FROM claxedo_session_meta WHERE session_id = ?").get("legacy_dir")).toEqual({
      host: "workspace",
      directory: "/tmp/project",
    })
    sqlite.prepare(`
      INSERT INTO claxedo_session_meta (
        session_id,
        host,
        directory,
        title,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("central", "central", null, "Central", 3, 4)
    expect(sqlite.prepare("SELECT host, directory FROM claxedo_session_meta WHERE session_id = ?").get("central")).toEqual({
      host: "central",
      directory: null,
    })
  })

  test("connection scoping migrates a pre-feature database file and preserves credential metadata", () => {
    const file = path.join(os.tmpdir(), `claxedo-connection-migration-${randomUUID()}.db`)
    const sqlite = new Database(file)
    const target = "20260710000400_connection_scoping"
    try {
      for (const entry of entries()) {
        if (entry.name === target) break
        applyMigration(sqlite, entry.name)
      }
      sqlite.prepare(`
        INSERT INTO claxedo_connection (
          integration_id, account_label, granted_capabilities, fields, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run("notion", "Legacy Notion", JSON.stringify(["docs"]), JSON.stringify({ workspace: "acme" }), 1, 2)
      sqlite.prepare(`
        INSERT INTO claxedo_provider_credential (
          id, provider_id, kind, source, secure_ref, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("credential_1", "integration:notion", "api_key", "managed", "secret-ref-1", "available", 1, 2)

      applyMigration(sqlite, target)

      const connection = sqlite.prepare("SELECT * FROM claxedo_connection WHERE integration_id = 'notion'").get() as {
        id: string
        owner: string | null
        account_label: string
        granted_capabilities: string
      }
      expect(connection.id).toMatch(/^[a-f0-9]{32}$/)
      expect(connection.owner).toBeNull()
      expect(connection.account_label).toBe("Legacy Notion")
      expect(JSON.parse(connection.granted_capabilities)).toEqual(["docs"])
      expect(sqlite.prepare("SELECT provider_id, secure_ref FROM claxedo_provider_credential WHERE id = 'credential_1'").get())
        .toEqual({ provider_id: `integration:${connection.id}`, secure_ref: "secret-ref-1" })
      expect(() => sqlite.prepare(`
        INSERT INTO claxedo_connection (id, integration_id, owner, granted_capabilities, fields, created_at, updated_at)
        VALUES ('duplicate-team', 'notion', NULL, '[]', '{}', 3, 3)
      `).run()).toThrow()
      expect(() => sqlite.prepare(`
        INSERT INTO claxedo_connection (id, integration_id, owner, granted_capabilities, fields, created_at, updated_at)
        VALUES ('personal-notion', 'notion', 'user-a', '[]', '{}', 3, 3)
      `).run()).not.toThrow()
    } finally {
      sqlite.close()
      rmSync(file, { force: true })
    }
  })

  test("message event ordinal migrations backfill monotonic ordinals", () => {
    const sqlite = new Database(":memory:")
    const target = "20260502000100_message_event_ordinal"
    for (const entry of entries()) {
      if (entry.name === target) break
      applyMigration(sqlite, entry.name)
    }

    const insert = sqlite.prepare(`
      INSERT INTO claxedo_cloud_message
        (message_id, session_id, workspace_id, role, ordinal, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    ;[
      ["msg_a2", "sess_a", 1, 200],
      ["msg_a1", "sess_a", 0, 100],
      ["msg_b1", "sess_b", 0, 150],
      ["msg_a3", "sess_a", 2, 300],
      ["msg_b2", "sess_b", 1, 250],
    ].forEach(([messageId, sessionId, ordinal, createdAt]) => {
      insert.run(messageId, sessionId, sessionId, "assistant", ordinal, JSON.stringify({ info: { id: messageId }, parts: [] }), createdAt, createdAt)
    })

    applyMigration(sqlite, target)
    applyMigration(sqlite, "20260502000200_cloud_message_event_log")

    const messageRows = sqlite.prepare(`
      SELECT session_id, event_ordinal
      FROM claxedo_cloud_message
      ORDER BY session_id, event_ordinal
    `).all() as { session_id: string; event_ordinal: number }[]
    const eventRows = sqlite.prepare(`
      SELECT session_id, event_ordinal
      FROM claxedo_cloud_message_event
      ORDER BY session_id, event_ordinal
    `).all() as { session_id: string; event_ordinal: number }[]

    expect(Map.groupBy(messageRows, (row) => row.session_id)).toEqual(new Map([
      ["sess_a", [
        { session_id: "sess_a", event_ordinal: 1 },
        { session_id: "sess_a", event_ordinal: 2 },
        { session_id: "sess_a", event_ordinal: 3 },
      ]],
      ["sess_b", [
        { session_id: "sess_b", event_ordinal: 1 },
        { session_id: "sess_b", event_ordinal: 2 },
      ]],
    ]))
    expect(Map.groupBy(eventRows, (row) => row.session_id)).toEqual(Map.groupBy(messageRows, (row) => row.session_id))
  })

  test("repair heals partial migrations", () => {
    const sqlite = new Database(":memory:")

    sqlite.exec(
      "CREATE TABLE `claxedo_page` (`id` text PRIMARY KEY NOT NULL, `project_id` text NOT NULL, `title` text NOT NULL DEFAULT 'Untitled', `content` text NOT NULL DEFAULT '', `status` text NOT NULL DEFAULT 'draft', `session_id` text, `created_at` text NOT NULL, `updated_at` text NOT NULL, `file_path` text)",
    )

    const fixed = repair(sqlite)

    expect(fixed).toContain("claxedo_page_status")
    expect(fixed).toContain("claxedo_page")
    expect(hasTable(sqlite, "claxedo_page_status")).toBe(true)
    expect(hasTable(sqlite, "claxedo_page_arena")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "org_id")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "version")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "file_path")).toBe(false)
    expect(hasColumn(sqlite, "claxedo_page", "directory")).toBe(true)
  })

  test("repair drops page children before rebuilding legacy page schema", () => {
    const sqlite = new Database(":memory:")
    sqlite.pragma("foreign_keys = ON")

    sqlite.exec(`
      CREATE TABLE claxedo_page (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL,
        title text NOT NULL DEFAULT 'Untitled',
        content text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'draft',
        created_at text NOT NULL,
        updated_at text NOT NULL,
        file_path text
      );
      CREATE TABLE claxedo_page_arena (
        id text PRIMARY KEY NOT NULL,
        page_id text NOT NULL REFERENCES claxedo_page(id) ON DELETE CASCADE,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      );
      INSERT INTO claxedo_page (id, project_id, title, content, created_at, updated_at, file_path)
      VALUES ('page_1', 'project_1', 'Old', '', '1', '1', 'old.md');
      INSERT INTO claxedo_page_arena (id, page_id, created_at, updated_at)
      VALUES ('arena_1', 'page_1', 1, 1);
    `)

    const fixed = repair(sqlite)

    expect(fixed).toEqual(expect.arrayContaining(["claxedo_page_arena", "claxedo_page"]))
    expect(hasColumn(sqlite, "claxedo_page", "org_id")).toBe(true)
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM claxedo_page_arena").get()).toEqual({ count: 0 })
  })

  test("repair upgrades legacy session meta placement schema", () => {
    const sqlite = new Database(":memory:")

    applyMigration(sqlite, "20260320190000_session_meta")
    sqlite.prepare(`
      INSERT INTO claxedo_session_meta (
        session_id,
        workspace_id,
        project_id,
        directory,
        title,
        parent_session_id,
        archived_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy", "ws_1", "proj_1", "", "Legacy", null, null, 1, 2)
    sqlite.prepare(`
      INSERT INTO claxedo_session_meta (
        session_id,
        workspace_id,
        project_id,
        directory,
        title,
        parent_session_id,
        archived_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy_dir", "ws_1", "proj_1", "/tmp/project", "Legacy Dir", null, null, 3, 4)

    const fixed = repair(sqlite)

    expect(fixed).toContain("claxedo_session_meta.placement")
    expect(hasColumn(sqlite, "claxedo_session_meta", "host")).toBe(true)
    expect(column(sqlite, "claxedo_session_meta", "directory")?.notnull).toBe(0)
    expect(sqlite.prepare("SELECT * FROM claxedo_session_meta WHERE session_id = ?").get("legacy")).toMatchObject({
      session_id: "legacy",
      workspace_id: "ws_1",
      project_id: "proj_1",
      host: "workspace",
      directory: null,
      title: "Legacy",
    })
    expect(sqlite.prepare("SELECT host, directory FROM claxedo_session_meta WHERE session_id = ?").get("legacy_dir")).toEqual({
      host: "workspace",
      directory: "/tmp/project",
    })
    expect(hasTable(sqlite, "claxedo_session_meta_old_repair")).toBe(false)
    expect(repair(sqlite)).toEqual([])
  })

  test("repair preserves session meta hosts during placement rebuilds", () => {
    const sqlite = new Database(":memory:")

    sqlite.exec(`
      CREATE TABLE claxedo_session_meta (
        session_id text PRIMARY KEY NOT NULL,
        workspace_id text,
        project_id text,
        host text NOT NULL DEFAULT 'workspace',
        directory text NOT NULL,
        title text,
        parent_session_id text,
        archived_at integer,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )
    `)
    sqlite.prepare(`
      INSERT INTO claxedo_session_meta (
        session_id,
        workspace_id,
        project_id,
        host,
        directory,
        title,
        parent_session_id,
        archived_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("central", null, null, "central", "", "Central", null, null, 3, 4)

    const fixed = repair(sqlite)

    expect(fixed).toContain("claxedo_session_meta.placement")
    expect(column(sqlite, "claxedo_session_meta", "directory")?.notnull).toBe(0)
    expect(sqlite.prepare("SELECT host, directory FROM claxedo_session_meta WHERE session_id = ?").get("central")).toEqual({
      host: "central",
      directory: null,
    })
  })

  test("repair upgrades legacy sandbox driver column names", () => {
    const sqlite = new Database(":memory:")

    applyMigration(sqlite, "20260411100000_workspace_lease")
    applyMigration(sqlite, "20260411100001_prepared_image")
    sqlite.prepare(`
      INSERT INTO claxedo_workspace_lease (
        workspace_id,
        lease_id,
        epoch,
        status,
        provider,
        provider_object_id,
        provider_snapshot_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("ws_1", "lease_1", 1, "ready", "daytona", "sandbox_1", "snapshot_1", 1, 2)
    sqlite.prepare(`
      INSERT INTO claxedo_runtime_snapshot (
        id,
        workspace_id,
        runtime_snapshot_id,
        provider_snapshot_id,
        reason,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("snap_1", "ws_1", "runtime_snap_1", "driver_snap_1", "manual", "ready", 3)

    const fixed = repair(sqlite)

    expect(fixed).toEqual(expect.arrayContaining([
      "claxedo_workspace_lease.driver",
      "claxedo_workspace_lease.driver_resource_id",
      "claxedo_workspace_lease.driver_snapshot_id",
      "claxedo_runtime_snapshot.driver_snapshot_id",
    ]))
    expect(hasColumn(sqlite, "claxedo_workspace_lease", "provider")).toBe(false)
    expect(hasColumn(sqlite, "claxedo_workspace_lease", "provider_object_id")).toBe(false)
    expect(hasColumn(sqlite, "claxedo_workspace_lease", "provider_snapshot_id")).toBe(false)
    expect(hasColumn(sqlite, "claxedo_runtime_snapshot", "provider_snapshot_id")).toBe(false)
    expect(sqlite.prepare("SELECT driver, driver_resource_id, driver_snapshot_id FROM claxedo_workspace_lease WHERE workspace_id = ?").get("ws_1")).toEqual({
      driver: "daytona",
      driver_resource_id: "sandbox_1",
      driver_snapshot_id: "snapshot_1",
    })
    expect(sqlite.prepare("SELECT driver_snapshot_id FROM claxedo_runtime_snapshot WHERE id = ?").get("snap_1")).toEqual({
      driver_snapshot_id: "driver_snap_1",
    })
  })

  test("repair upgrades cloud session driver column name", () => {
    const sqlite = new Database(":memory:")

    applyMigration(sqlite, "20260320120000_cloud_session")
    sqlite.prepare(`
      INSERT INTO claxedo_cloud_session (
        session_id,
        workspace_id,
        directory,
        title,
        provider,
        data,
        created_at,
        updated_at,
        deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("sess_1", "ws_1", "/workspace", "Cloud", "daytona", "{}", 1, 2, null)

    const fixed = repair(sqlite)

    expect(fixed).toContain("claxedo_cloud_session.driver")
    expect(hasColumn(sqlite, "claxedo_cloud_session", "provider")).toBe(false)
    expect(sqlite.prepare("SELECT driver FROM claxedo_cloud_session WHERE session_id = ?").get("sess_1")).toEqual({
      driver: "daytona",
    })
  })

  test("repair upgrades terminal session driver column name", () => {
    const sqlite = new Database(":memory:")

    applyMigration(sqlite, "20260310000000_initial")
    sqlite.prepare(`
      INSERT INTO claxedo_terminal_session (
        terminal_id,
        tab_id,
        workspace_id,
        provider,
        session_id,
        transcript_path,
        ref_name,
        prompt,
        last_assistant_message,
        event_type,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("term_1", "tab_1", "ws_1", "daytona", "sess_1", null, null, null, null, null, 1)

    const fixed = repair(sqlite)

    expect(fixed).toContain("claxedo_terminal_session.driver")
    expect(hasColumn(sqlite, "claxedo_terminal_session", "provider")).toBe(false)
    expect(sqlite.prepare("SELECT driver FROM claxedo_terminal_session WHERE terminal_id = ?").get("term_1")).toEqual({
      driver: "daytona",
    })
  })

  test("repair rolls back failed session meta placement rebuilds", () => {
    const sqlite = new Database(":memory:")

    sqlite.exec(`
      CREATE TABLE claxedo_session_meta (
        session_id text PRIMARY KEY NOT NULL,
        directory text NOT NULL
      )
    `)
    sqlite.prepare("INSERT INTO claxedo_session_meta (session_id, directory) VALUES (?, ?)").run("broken", "/tmp/project")

    expect(() => repair(sqlite)).toThrow()
    expect(hasTable(sqlite, "claxedo_session_meta")).toBe(true)
    expect(hasTable(sqlite, "claxedo_session_meta_old_repair")).toBe(false)
    expect(sqlite.prepare("SELECT session_id, directory FROM claxedo_session_meta WHERE session_id = ?").get("broken")).toEqual({
      session_id: "broken",
      directory: "/tmp/project",
    })
  })
})
