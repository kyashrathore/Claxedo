import Database from "better-sqlite3"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

function migration(name: string) {
  return readFileSync(path.join(import.meta.dirname, "../../../claxedo-server-core/src/platform/db/claxedo-migration", name, "migration.sql"), "utf8")
}

function migrated() {
  const sqlite = new Database(":memory:")
  sqlite.exec(migration("20260411000000_provider_credentials"))
  sqlite.prepare(`
    INSERT INTO claxedo_provider_credential (
      id, provider_id, kind, source, status, last_validated_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("cred_1", "codex-app-server", "oauth_token", "managed", "available", 10, null, 1, 2)
  sqlite.exec(migration("20260913000300_credential_usage_windows"))
  return sqlite
}

describe("credential usage windows migration", () => {
  test("adds both nullable columns, leaving a stored credential as it was", () => {
    const sqlite = migrated()

    expect(sqlite.prepare(`
      SELECT id, status, usage_windows, usage_at, last_validated_at, created_at, updated_at
      FROM claxedo_provider_credential
    `).get()).toEqual({
      id: "cred_1",
      status: "available",
      usage_windows: null,
      usage_at: null,
      last_validated_at: 10,
      created_at: 1,
      updated_at: 2,
    })
  })

  test("gives machine logins their own table, one row per harness and address", () => {
    const sqlite = migrated()
    const insert = sqlite.prepare(`
      INSERT INTO claxedo_machine_login_usage (harness, account, usage_windows, usage_at)
      VALUES (?, ?, ?, ?)
    `)

    insert.run("codex", "person@example.com", '[{"window":"session","usedPercent":20,"resetsAt":null}]', 7)
    // A harness that names no address is a row, not an absence, so a second
    // read replaces it instead of accumulating beside it.
    insert.run("codex", "", "[]", 8)

    expect(sqlite.prepare("SELECT harness, account, usage_at FROM claxedo_machine_login_usage ORDER BY account").all())
      .toEqual([
        { harness: "codex", account: "", usage_at: 8 },
        { harness: "codex", account: "person@example.com", usage_at: 7 },
      ])
    expect(() => insert.run("codex", "", "[]", 9)).toThrow(/UNIQUE constraint failed/)
  })
})
