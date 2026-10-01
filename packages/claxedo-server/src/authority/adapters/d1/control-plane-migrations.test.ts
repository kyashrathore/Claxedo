import { afterEach, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../../test-support/control-plane-migrations"

const REBUILT_TABLES = ["auth_identities", "user_deployed_owner_bootstrap_claims"]
const RETIRED_ADAPTER = "clerk"
const claimHash = `sha256:${"a".repeat(64)}`
const identityHash = `sha256:${"c".repeat(64)}`
const active: ControlPlaneDatabase[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((instance) => instance.dispose())) })

async function database(): Promise<D1Database> {
  const instance = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  active.push(instance)
  return instance.database
}

async function schemaObjects(target: D1Database) {
  const rows = await target
    .prepare(
      `select type, name from sqlite_master
       where type in ('index', 'trigger') and tbl_name in (${REBUILT_TABLES.map(() => "?").join(", ")})
         and name not like 'sqlite_%'
       order by type, name`,
    )
    .bind(...REBUILT_TABLES)
    .all<{ type: string; name: string }>()
  return rows.results.map((row) => `${row.type}:${row.name}`)
}


describe("control-plane identity schema", () => {
  test("rejects the retired adapter value in the baseline", async () => {
    const target = await database()
    await target.prepare("insert into users values ('user-kept', 'active', 1, 1, null, null)").run()

    await expect(
      target
        .prepare("insert into auth_identities values (?, 'https://issuer.example.test', 's', 'user-kept', 1, null)")
        .bind(RETIRED_ADAPTER)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  test("keeps every index and trigger required by identity and bootstrap contracts", async () => {
    const expected = [
      "index:auth_identities_by_user",
      "trigger:auth_identities_user_immutable",
      "trigger:user_deployed_owner_bootstrap_identity_immutable",
    ]

    const target = await database()
    expect(await schemaObjects(target)).toEqual(expected)
  })

  test("keeps an auth identity pinned to its user in the baseline", async () => {
    const target = await database()
    await target.prepare("insert into users values ('user-a', 'active', 1, 1, null, null)").run()
    await target.prepare("insert into users values ('user-b', 'active', 1, 1, null, null)").run()
    await target
      .prepare("insert into auth_identities values ('better-auth', 'https://issuer.example.test', 's', 'user-a', 1, null)")
      .run()

    await expect(
      target.prepare("update auth_identities set user_id = 'user-b' where subject = 's'").run(),
    ).rejects.toThrow(/auth identity user is immutable/)

    const owner = await target
      .prepare("select user_id from auth_identities where subject = 's'")
      .first<{ user_id: string }>()
    expect(owner?.user_id).toBe("user-a")
  })

  test("keeps the consumed bootstrap identity immutable in the baseline", async () => {
    const target = await database()
    await target
      .prepare(
        `insert into user_deployed_owner_bootstrap_claims
           (deployment_id, claim_hash, admitted_identity_hash, expires_at, consumed_at,
            consumed_adapter, consumed_issuer, consumed_subject, created_at)
         values ('deployment-kept', ?, ?, 9, 5, 'better-auth', 'https://issuer.example.test', 'subject-kept', 1)`,
      )
      .bind(claimHash, identityHash)
      .run()

    await expect(
      target
        .prepare("update user_deployed_owner_bootstrap_claims set consumed_subject = 'other' where deployment_id = 'deployment-kept'")
        .run(),
    ).rejects.toThrow(/bootstrap owner identity is immutable/)
  })
})
