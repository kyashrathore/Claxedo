import Database from "better-sqlite3"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

function migration(name: string) {
  return readFileSync(path.join(import.meta.dirname, "claxedo-migration", name, "migration.sql"), "utf8")
}

describe("credential scope migration", () => {
  test("backfills managed credentials as shared and every other source as local", () => {
    const sqlite = new Database(":memory:")
    sqlite.exec(migration("20260411000000_provider_credentials"))
    sqlite.prepare(`
      INSERT INTO claxedo_provider_credential (
        id, provider_id, kind, source, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("managed", "openai", "api_key", "managed", "available", 1, 2)
    sqlite.prepare(`
      INSERT INTO claxedo_provider_credential (
        id, provider_id, kind, source, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("local", "anthropic", "api_key", "local_only", "available", 1, 2)

    sqlite.exec(migration("20260717000200_credential_scope"))

    expect(sqlite.prepare(`
      SELECT id, scope, consent_json, last_used_at
      FROM claxedo_provider_credential ORDER BY id
    `).all()).toEqual([
      { id: "local", scope: "local", consent_json: null, last_used_at: null },
      { id: "managed", scope: "shared", consent_json: null, last_used_at: null },
    ])
  })
})
