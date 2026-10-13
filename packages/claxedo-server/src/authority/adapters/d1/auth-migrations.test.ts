import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

import { CERTIFIED_ADAPTER_PROFILES } from "../../../deployments/hosted-shared/deployment-profile"
import {
  betterAuthDatabaseSchemaInspectionSql,
  betterAuthNativeClientProvisioningStatements,
  betterAuthNativeResource,
  verifyBetterAuthDatabaseSchemaInspection,
} from "../../../platform/auth/better-auth-native-clients"

// Read from the directory rather than listed: a migration added and not
// listed would never be applied here, and the drift would be green.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations/auth/", import.meta.url))
const AUTH_MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function freshDatabase(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["AUTH_DB"],
  })
  active.push(instance)
  const target = await instance.getD1Database("AUTH_DB")
  await target.prepare("pragma foreign_keys = on").run()
  for (const name of AUTH_MIGRATIONS) {
    const migration = (await readFile(`${MIGRATIONS_DIR}${name}`, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration
      .split(/;\s*\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
  return target
}

describe("auth D1 migrations", () => {
  test("the Worker compiles exactly the certified adapter profile", () => {
    expect([...CERTIFIED_ADAPTER_PROFILES]).toEqual(["better-auth-d1"])
  })

  test("apply in order to a fresh database and satisfy the schema contract the deploy verifies", async () => {
    expect(AUTH_MIGRATIONS).toEqual(["0001_better_auth.sql", "0003_authentication_evidence.sql"])
    const target = await freshDatabase()
    verifyBetterAuthDatabaseSchemaInspection(await target.prepare(betterAuthDatabaseSchemaInspectionSql()).first())
    const danglingForeignKeys = await target.prepare("pragma foreign_key_check").all()
    expect(danglingForeignKeys.results).toEqual([])
  })

  test("a deploy to a moved API origin replaces the control-plane resource and links the native clients to it", async () => {
    const target = await freshDatabase()
    const ciphertext = "c".repeat(64)
    for (const origin of ["https://api-old.example.com", "https://api.example.com"]) {
      for (const statement of betterAuthNativeClientProvisioningStatements(origin, ciphertext)) await target.prepare(statement).run()
    }
    const resources = await target.prepare(`select "id", "identifier" from "oauthResource"`).all()
    expect(resources.results).toEqual([{ id: "resource_control_plane", identifier: betterAuthNativeResource("https://api.example.com") }])
    const links = await target.prepare(`select "id", "resourceId" from "oauthClientResource" order by "id"`).all()
    expect(links.results).toEqual(
      ["client_resource_cli", "client_resource_control_plane", "client_resource_desktop"].map((id) => ({ id, resourceId: betterAuthNativeResource("https://api.example.com") })),
    )
    expect((await target.prepare("pragma foreign_key_check").all()).results).toEqual([])
  })
})
