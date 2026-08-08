import Database from "better-sqlite3"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

function migration(name: string) {
  return readFileSync(path.join(import.meta.dirname, "../../../claxedo-server-core/src/platform/db/claxedo-migration", name, "migration.sql"), "utf8")
}

function legacyTable() {
  const sqlite = new Database(":memory:")
  sqlite.exec(migration("20260411000000_provider_credentials"))
  const insert = sqlite.prepare(`
    INSERT INTO claxedo_provider_credential (
      id, provider_id, kind, source, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run("legacy_openai", "openai", "api_key", "managed", "available", 1, 2)
  insert.run("legacy_anthropic", "anthropic", "api_key", "local_only", "available", 1, 2)
  return sqlite
}

describe("credential org scope migration", () => {
  test("backfills every legacy credential into the named single-tenant partition", () => {
    const sqlite = legacyTable()

    sqlite.exec(migration("20260728000100_credential_org_scope"))

    // An existing self-host user must not lose access on upgrade: the unsigned
    // request path resolves to exactly this partition, so every credential they
    // had stays readable with no re-entry.
    expect(sqlite.prepare("SELECT id, org_id FROM claxedo_provider_credential ORDER BY id").all()).toEqual([
      { id: "legacy_anthropic", org_id: "__local__" },
      { id: "legacy_openai", org_id: "__local__" },
    ])
  })

  test("org_id is NOT NULL, so no row can land in a tenant-less state", () => {
    const sqlite = legacyTable()
    sqlite.exec(migration("20260728000100_credential_org_scope"))

    const column = (sqlite.prepare("PRAGMA table_info(claxedo_provider_credential)").all() as Array<{
      name: string
      notnull: number
      dflt_value: string | null
    }>).find((item) => item.name === "org_id")

    expect(column?.notnull).toBe(1)
    expect(column?.dflt_value).toBe("'__local__'")
    expect(() =>
      sqlite.prepare(`
        INSERT INTO claxedo_provider_credential (
          id, org_id, provider_id, kind, source, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("null_org", null, "openai", "api_key", "managed", "available", 1, 2),
    ).toThrow()
  })

  test("a row written without an explicit org defaults to the single-tenant partition", () => {
    const sqlite = legacyTable()
    sqlite.exec(migration("20260728000100_credential_org_scope"))

    sqlite.prepare(`
      INSERT INTO claxedo_provider_credential (
        id, provider_id, kind, source, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("new_row", "openai", "api_key", "managed", "available", 3, 4)

    expect(sqlite.prepare("SELECT org_id FROM claxedo_provider_credential WHERE id = 'new_row'").get())
      .toEqual({ org_id: "__local__" })
  })

  test("the org lookup indexes exist so scoped reads stay indexed", () => {
    const sqlite = legacyTable()
    sqlite.exec(migration("20260728000100_credential_org_scope"))

    const indexes = (sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'claxedo_provider_credential'",
    ).all() as Array<{ name: string }>).map((item) => item.name)

    expect(indexes).toContain("claxedo_provider_credential_org_idx")
    expect(indexes).toContain("claxedo_provider_credential_org_provider_idx")
  })

  test("repair heals a database whose migration ledger drifted past the org column", async () => {
    const { repair } = await import("@claxedo/server-core/platform/db/repair")
    const sqlite = legacyTable()

    const fixed = repair(sqlite as never)

    expect(fixed).toContain("claxedo_provider_credential.org_id")
    expect(sqlite.prepare("SELECT id, org_id FROM claxedo_provider_credential ORDER BY id").all()).toEqual([
      { id: "legacy_anthropic", org_id: "__local__" },
      { id: "legacy_openai", org_id: "__local__" },
    ])
  })
})
