import { afterEach, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../../test-support/control-plane-migrations"

const IDENTITY_TABLES = ["auth_identities", "user_deployed_owner_bootstrap_claims"]
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
       where type in ('index', 'trigger') and tbl_name in (${IDENTITY_TABLES.map(() => "?").join(", ")})
         and name not like 'sqlite_%'
       order by type, name`,
    )
    .bind(...IDENTITY_TABLES)
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

describe("session share levels", () => {
  test("a grant defaults to follow, may be raised to send, and refuses any other level", async () => {
    const target = await database()
    await target.batch([
      target.prepare("insert into users values ('user-a', 'active', 1, 1, null, null)"),
      target.prepare("insert into users values ('user-b', 'active', 1, 1, null, null)"),
      target.prepare("insert into actors (actor_id, user_id, kind, state, created_at, updated_at) values ('actor-a', 'user-a', 'human', 'active', 1, 1)"),
      target.prepare("insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org-a', 'A', 'personal', 'user-a', 1, 1)"),
      target.prepare("insert into org_memberships (org_id, user_id, role, created_at, updated_at) values ('org-a', 'user-b', 'member', 1, 1)"),
      target.prepare("insert into projects (project_id, org_id, repo_key, owner_user_id, created_at, updated_at) values ('prj-a', 'org-a', 'a', 'user-a', 1, 1)"),
      target.prepare(
        `insert into workspaces (workspace_id, org_id, project_id, owner_user_id, backing, display_name, remote_directory, created_at, updated_at)
         values ('ws-a', 'org-a', 'prj-a', 'user-a', 'local-worktree', 'ws-a', '/srv/app', 1, 1)`,
      ),
      target.prepare(
        `insert into session_registration_operations
           (operation_id, session_id, workspace_id, org_id, project_id, creator_actor_id,
            operation_kind, parent_session_id, requested_title, state, state_reason, created_at, updated_at)
         values ('op-a', 'ses-a', 'ws-a', 'org-a', 'prj-a', 'actor-a', 'create', null, null, 'registered', null, 1, 1)`,
      ),
      target.prepare(
        `insert into sessions (session_id, operation_id, workspace_id, org_id, project_id, creator_actor_id,
           lifecycle_generation, title, created_at, updated_at)
         values ('ses-a', 'op-a', 'ws-a', 'org-a', 'prj-a', 'actor-a', 1, null, 1, 1)`,
      ),
      target.prepare(
        `insert into session_share_grants
           (grant_id, session_id, workspace_id, org_id, project_id, target_user_id, target_org_id,
            target_team_id, granted_by_actor_id, granted_at, revoked_at)
         values ('share-a', 'ses-a', 'ws-a', 'org-a', 'prj-a', 'user-b', null, null, 'actor-a', 1, null)`,
      ),
    ])
    const level = async () => (await target.prepare("select level from session_share_grants where grant_id = 'share-a'").first<{ level: string }>())?.level

    expect(await level()).toBe("follow")
    await target.prepare("update session_share_grants set level = 'send' where grant_id = 'share-a'").run()
    expect(await level()).toBe("send")
    await expect(
      target.prepare("update session_share_grants set level = 'broadcast' where grant_id = 'share-a'").run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })
})
