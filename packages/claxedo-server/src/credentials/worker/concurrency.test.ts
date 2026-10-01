import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { hostedOrgCredentials, HOSTED_CREDENTIALS_FLAG, type HostedCredentialDatabase } from "./index"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"

test("concurrent credential writes use the stored id without interpreting a database error message", async () => {
  const sqlite = new Database(":memory:")
  const migration = readFileSync(new URL("../../../migrations/control-plane/0044_hosted_provider_credentials_by_person.sql", import.meta.url), "utf8")
  sqlite.exec(migration.slice(migration.indexOf("create table hosted_provider_credentials")))
  const database: HostedCredentialDatabase = {
    prepare(sql) {
      let bindings: unknown[] = []
      return {
        bind(...values) { bindings = values; return this },
        async first() {
          try {
            return sqlite.prepare(sql).get(...bindings as never[]) as Record<string, unknown> | null
          } catch (error) {
            if (error instanceof Error) error.message = "Opaque database refusal"
            throw error
          }
        },
        async all() { return { results: sqlite.prepare(sql).all(...bindings as never[]) as Record<string, unknown>[] } },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...bindings as never[]).changes } } },
      }
    },
  }
  try {
    const credentials = hostedOrgCredentials("org_1", { database, env: {
      [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 3).toString("base64"),
    } })
    const write = { owner: null, provider_id: "github", kind: "api_key" as const, source: "managed" as const }
    const results = await Promise.all([
      credentials.putCredential({ ...write, secret: "first" }),
      credentials.putCredential({ ...write, secret: "second" }),
    ])
    expect(results[0].id).toBe(results[1].id)
    expect(await credentials.listCredentials()).toHaveLength(1)
    const secret = await credentials.resolveCredentialSecret!("github")
    expect(secret === "first" || secret === "second").toBe(true)
  } finally {
    sqlite.close()
  }
})
