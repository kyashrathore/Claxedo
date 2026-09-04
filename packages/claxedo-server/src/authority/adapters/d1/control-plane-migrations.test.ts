import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

// Every control-plane migration, in order. 0017 rebuilds the two tables that
// carried the retired identity-provider adapter value, so the rebuild has to be
// exercised against a database that already holds rows written under it.
const CONTROL_PLANE_MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0004_host_access_and_sharing.sql",
  "0005_agent_extensions_and_audit.sql",
  "0006_channel_identity_and_canonical_runtime.sql",
  "0007_paired_recovery_epoch.sql",
  "0008_user_deployed_owner_bootstrap.sql",
  "0009_optional_service_deployment.sql",
  "0010_session_turn_leases.sql",
  "0011_session_turn_producers.sql",
  "0012_cold_local_host_challenges.sql",
  "0013_org_team_session_sharing.sql",
  "0014_host_workspace_assignments.sql",
  "0015_drop_local_host_links.sql",
  "0016_host_session_authority.sql",
  "0017_adapter_custom.sql",
  "0018_drop_agent_extensions.sql",
  "0019_agent_plugin_activations.sql",
  "0020_hosted_connections.sql",
  "0021_mcp_oauth_clients.sql",
  "0022_sandbox_leases.sql",
]

const BEFORE_ADAPTER_REBUILD = CONTROL_PLANE_MIGRATIONS.slice(
  0,
  CONTROL_PLANE_MIGRATIONS.indexOf("0017_adapter_custom.sql"),
)

// The two rebuilt tables and the migrations that defined the indexes and
// triggers guarding them. 0017 drops both tables, so every object below has to
// come back.
const REBUILT_TABLES = ["auth_identities", "user_deployed_owner_bootstrap_claims"]
const DEFINING_MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0008_user_deployed_owner_bootstrap.sql",
]

const RETIRED_ADAPTER = "clerk"
const claimHash = `sha256:${"a".repeat(64)}`
const otherClaimHash = `sha256:${"b".repeat(64)}`
const identityHash = `sha256:${"c".repeat(64)}`

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  return await instance.getD1Database("CONTROL_PLANE_DB")
}

async function apply(target: D1Database, names: readonly string[]) {
  for (const name of names) {
    const path = fileURLToPath(new URL(`../../../../migrations/control-plane/${name}`, import.meta.url))
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration
      .split(/;\s*\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
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

async function seedRetiredAndSurvivingRows(target: D1Database) {
  await target.prepare("insert into users values (?, 'active', 1, 1, null, null)").bind("user-retired").run()
  await target.prepare("insert into users values (?, 'active', 1, 1, null, null)").bind("user-kept").run()
  await target
    .prepare("insert into auth_identities values (?, 'https://issuer.example.test', 'subject-retired', ?, 1, null)")
    .bind(RETIRED_ADAPTER, "user-retired")
    .run()
  await target
    .prepare("insert into auth_identities values ('better-auth', 'https://issuer.example.test', 'subject-kept', ?, 1, null)")
    .bind("user-kept")
    .run()
  await target
    .prepare(
      `insert into user_deployed_owner_bootstrap_claims
         (deployment_id, claim_hash, admitted_identity_hash, expires_at, consumed_at,
          consumed_adapter, consumed_issuer, consumed_subject, created_at)
       values ('deployment-retired', ?, ?, 9, 5, ?, 'https://issuer.example.test', 'subject-retired', 1)`,
    )
    .bind(claimHash, identityHash, RETIRED_ADAPTER)
    .run()
  await target
    .prepare(
      `insert into user_deployed_owner_bootstrap_claims
         (deployment_id, claim_hash, admitted_identity_hash, expires_at, consumed_at,
          consumed_adapter, consumed_issuer, consumed_subject, created_at)
       values ('deployment-kept', ?, ?, 9, 5, 'better-auth', 'https://issuer.example.test', 'subject-kept', 1)`,
    )
    .bind(otherClaimHash, identityHash)
    .run()
}

describe("control-plane adapter rebuild", () => {
  test("removes rows written under the retired adapter value and keeps the rest", async () => {
    const target = await database()
    await apply(target, BEFORE_ADAPTER_REBUILD)
    await seedRetiredAndSurvivingRows(target)

    await apply(target, ["0017_adapter_custom.sql"])

    const identities = await target
      .prepare("select adapter, subject from auth_identities order by subject")
      .all<{ adapter: string; subject: string }>()
    expect(identities.results).toEqual([{ adapter: "better-auth", subject: "subject-kept" }])

    const claims = await target
      .prepare("select deployment_id, consumed_adapter from user_deployed_owner_bootstrap_claims order by deployment_id")
      .all<{ deployment_id: string; consumed_adapter: string }>()
    expect(claims.results).toEqual([{ deployment_id: "deployment-kept", consumed_adapter: "better-auth" }])
  })

  test("rejects the retired adapter value after the rebuild", async () => {
    const target = await database()
    await apply(target, CONTROL_PLANE_MIGRATIONS)
    await target.prepare("insert into users values ('user-kept', 'active', 1, 1, null, null)").run()

    await expect(
      target
        .prepare("insert into auth_identities values (?, 'https://issuer.example.test', 's', 'user-kept', 1, null)")
        .bind(RETIRED_ADAPTER)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  test("keeps every index and trigger the defining migrations created on the rebuilt tables", async () => {
    const reference = await database()
    await apply(reference, DEFINING_MIGRATIONS)
    const expected = await schemaObjects(reference)
    expect(expected).toContain("index:auth_identities_by_user")
    expect(expected).toContain("trigger:auth_identities_user_immutable")
    expect(expected).toContain("trigger:user_deployed_owner_bootstrap_identity_immutable")

    const target = await database()
    await apply(target, CONTROL_PLANE_MIGRATIONS)
    expect(await schemaObjects(target)).toEqual(expected)
  })

  test("keeps an auth identity pinned to its user after the rebuild", async () => {
    const target = await database()
    await apply(target, CONTROL_PLANE_MIGRATIONS)
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

  test("keeps the consumed bootstrap identity immutable after the rebuild", async () => {
    const target = await database()
    await apply(target, CONTROL_PLANE_MIGRATIONS)
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
