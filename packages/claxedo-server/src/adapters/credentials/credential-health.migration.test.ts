import Database from "better-sqlite3"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

function migration(name: string) {
  return readFileSync(path.join(import.meta.dirname, "../../platform/db/claxedo-migration", name, "migration.sql"), "utf8")
}

describe("credential health migration", () => {
  test("adds nullable health without changing existing credential lifecycle state", () => {
    const sqlite = new Database(":memory:")
    sqlite.exec(migration("20260411000000_provider_credentials"))
    sqlite.prepare(`
      INSERT INTO claxedo_provider_credential (
        id, provider_id, kind, source, status, last_validated_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cred_1", "openai", "api_key", "managed", "available", 10, null, 1, 2)

    sqlite.exec(migration("20260717000100_credential_health"))

    expect(sqlite.prepare(`
      SELECT id, status, health, last_validated_at, last_error
      FROM claxedo_provider_credential
    `).get()).toEqual({
      id: "cred_1",
      status: "available",
      health: null,
      last_validated_at: 10,
      last_error: null,
    })
  })
})
