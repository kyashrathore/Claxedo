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
  "0023_agent_plugin_sources.sql",
  "0024_session_last_human_turn.sql",
  "0025_claxedo_tasks.sql",
  "0026_agent_cross_machine_writes.sql",
  "0027_sandbox_pass_revocations.sql",
  "0028_workspace_org_member_visible.sql",
  "0029_host_connect.sql",
  "0030_workspace_host_assignment_revision.sql",
  "0031_normalize_user_hosted_directories.sql",
  "0032_task_attachments.sql",
  "0033_task_child_number.sql",
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

async function statements(name: string) {
  const path = fileURLToPath(new URL(`../../../../migrations/control-plane/${name}`, import.meta.url))
  const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
  return migration
    .split(/;\s*\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
}

async function apply(target: D1Database, names: readonly string[]) {
  for (const name of names) {
    for (const statement of await statements(name)) {
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

  test("stores an account's agent setting as one row that is off until written", async () => {
    const target = await database()
    await apply(target, CONTROL_PLANE_MIGRATIONS)

    await target.prepare("insert into user_agent_settings (user_id, updated_at) values ('user-a', 1)").run()
    const row = await target
      .prepare("select cross_machine_writes from user_agent_settings where user_id = 'user-a'")
      .first<{ cross_machine_writes: number }>()
    expect(row).toEqual({ cross_machine_writes: 0 })

    await expect(
      target.prepare("update user_agent_settings set cross_machine_writes = 2 where user_id = 'user-a'").run(),
    ).rejects.toThrow(/CHECK constraint failed/)
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

async function seedOwnerAndProject(target: D1Database) {
  await target.prepare("insert into users values ('user-a', 'active', 1, 1, null, null)").run()
  await target.prepare(
    "insert into actors (actor_id, user_id, kind, state, created_at, updated_at) values ('actor-a', 'user-a', 'human', 'active', 1, 1)",
  ).run()
  await target.prepare(
    "insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org-a', 'A', 'personal', 'user-a', 1, 1)",
  ).run()
  await target.prepare(
    "insert into projects (project_id, org_id, repo_key, owner_user_id, created_at, updated_at) values ('prj-a', 'org-a', 'a', 'user-a', 1, 1)",
  ).run()
}

async function seedWorkspace(target: D1Database, id: string, access: "user-hosted" | "cloud", remoteDirectory: string | null) {
  await target.prepare(
    `insert into workspaces (workspace_id, org_id, project_id, owner_user_id, backing, access, display_name, remote_directory, created_at, updated_at)
     values (?, 'org-a', 'prj-a', 'user-a', ?, ?, ?, ?, 1, 1)`,
  ).bind(id, access === "cloud" ? "cloud-vm" : "local-worktree", access, id, remoteDirectory).run()
}

describe("workspace assignment revision counter", () => {
  async function seeded() {
    const target = await database()
    await apply(target, CONTROL_PLANE_MIGRATIONS.slice(
      0,
      CONTROL_PLANE_MIGRATIONS.indexOf("0030_workspace_host_assignment_revision.sql"),
    ))
    await seedOwnerAndProject(target)
    for (const id of ["ws-assigned", "ws-free"]) await seedWorkspace(target, id, "user-hosted", null)
    await target.prepare(
      `insert into host_workspace_assignments
         (workspace_id, host_id, org_id, owner_user_id, owner_actor_id, second_device_open_at, assigned_at, updated_at, revision)
       values ('ws-assigned', 'host-a', 'org-a', 'user-a', 'actor-a', null, 1, 1, 3)`,
    ).run()
    return target
  }

  async function counters(target: D1Database) {
    const rows = await target
      .prepare("select workspace_id, host_assignment_revision from workspaces order by workspace_id")
      .all<{ workspace_id: string; host_assignment_revision: number }>()
    return rows.results
  }

  test("starts an assigned workspace at its assignment's revision and an unassigned one at 0", async () => {
    const target = await seeded()
    await apply(target, ["0030_workspace_host_assignment_revision.sql"])
    expect(await counters(target)).toEqual([
      { workspace_id: "ws-assigned", host_assignment_revision: 3 },
      { workspace_id: "ws-free", host_assignment_revision: 0 },
    ])
  })

  test("the backfill run again never lowers a counter that has moved past the live assignment's revision", async () => {
    const target = await seeded()
    const [addColumn, backfill] = await statements("0030_workspace_host_assignment_revision.sql")
    await target.prepare(addColumn).run()
    await target.prepare("update workspaces set host_assignment_revision = 5 where workspace_id = 'ws-assigned'").run()
    await target.prepare(backfill).run()
    expect(await counters(target)).toEqual([
      { workspace_id: "ws-assigned", host_assignment_revision: 5 },
      { workspace_id: "ws-free", host_assignment_revision: 0 },
    ])
  })
})

describe("user-hosted directory normalization", () => {
  test("rewrites every absolute POSIX directory of a user-hosted row to its normalized form and nothing else", async () => {
    const target = await database()
    await apply(target, CONTROL_PLANE_MIGRATIONS.slice(
      0,
      CONTROL_PLANE_MIGRATIONS.indexOf("0031_normalize_user_hosted_directories.sql"),
    ))
    await seedOwnerAndProject(target)
    const rows: Array<[string, "user-hosted" | "cloud", string | null, string | null]> = [
      ["ws-escape", "user-hosted", "/srv/allowed/../secret", "/srv/secret"],
      ["ws-trailing", "user-hosted", "/srv/app/", "/srv/app"],
      ["ws-dots", "user-hosted", "/srv/./a/./b/", "/srv/a/b"],
      ["ws-double", "user-hosted", "//srv//app", "/srv/app"],
      ["ws-above-root", "user-hosted", "/../../etc", "/etc"],
      ["ws-root", "user-hosted", "/", "/"],
      ["ws-root-dots", "user-hosted", "/a/..", "/"],
      ["ws-clean", "user-hosted", "/srv/clean", "/srv/clean"],
      ["ws-windows", "user-hosted", "C:\\Users\\dev\\app\\", "C:\\Users\\dev\\app\\"],
      ["ws-relative", "user-hosted", "srv/app/", "srv/app/"],
      ["ws-none", "user-hosted", null, null],
      ["ws-cloud", "cloud", "/srv/cloud/../x/", "/srv/cloud/../x/"],
    ]
    for (const [id, access, directory] of rows) await seedWorkspace(target, id, access, directory)

    await apply(target, ["0031_normalize_user_hosted_directories.sql"])

    const stored = await target
      .prepare("select workspace_id, remote_directory from workspaces order by workspace_id")
      .all<{ workspace_id: string; remote_directory: string | null }>()
    expect(stored.results).toEqual(
      rows.map(([workspace_id, , , remote_directory]) => ({ workspace_id, remote_directory }))
        .sort((a, b) => (a.workspace_id < b.workspace_id ? -1 : 1)),
    )
    // Re-running over normalized rows changes nothing.
    await apply(target, ["0031_normalize_user_hosted_directories.sql"])
    expect((await target.prepare("select workspace_id, remote_directory from workspaces order by workspace_id").all()).results)
      .toEqual(stored.results)
  })
})
