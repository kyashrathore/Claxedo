import Database from "better-sqlite3"
import { afterEach, expect, test } from "vitest"
import { currentControlPlaneBaseline } from "../../../../scripts/control-plane-schema"

const open: Database.Database[] = []
afterEach(() => open.splice(0).forEach((database) => database.close()))

function baseline() {
  const database = new Database(":memory:")
  open.push(database)
  database.pragma("foreign_keys = ON")
  database.exec(currentControlPlaneBaseline())
  database.exec(`insert into users values ('user-a', 'active', 1, 1, null, null), ('user-b', 'active', 1, 1, null, null);
    insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org-a', 'A', 'shared', 'user-a', 1, 1)`)
  return database
}

test("an auth identity accepts only current adapters and stays pinned to its user", () => {
  const database = baseline()
  expect(() => database.exec("insert into auth_identities values ('clerk', 'https://issuer.test', 's', 'user-a', 1, null)")).toThrow(/CHECK constraint failed/)
  database.exec("insert into auth_identities values ('better-auth', 'https://issuer.test', 's', 'user-a', 1, null)")
  expect(() => database.exec("update auth_identities set user_id = 'user-b' where subject = 's'")).toThrow(/auth identity user is immutable/)
})

test("a consumed bootstrap owner claim keeps its identity", () => {
  const database = baseline()
  database.exec(`insert into user_deployed_owner_bootstrap_claims
    (deployment_id, claim_hash, admitted_identity_hash, expires_at, consumed_at, consumed_adapter, consumed_issuer, consumed_subject, created_at)
    values ('deployment-a', 'sha256:${"a".repeat(64)}', 'sha256:${"c".repeat(64)}', 9, 5, 'better-auth', 'https://issuer.test', 'subject-a', 1)`)
  expect(() => database.exec("update user_deployed_owner_bootstrap_claims set consumed_subject = 'other'")).toThrow(/bootstrap owner identity is immutable/)
})

test("org-wide scopes refuse 'team', which names only a group inside an org", () => {
  const database = baseline()
  expect(() => database.exec("insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org-old', 'Old', 'team', 'user-a', 1, 1)")).toThrow(/CHECK/)
  expect(() => database.exec(`insert into hosted_connection_attempts (state, verifier, integration_id, scope, status, expires_at, created_at, updated_at)
    values ('state', 'verifier', 'github', 'team', 'pending', 10, 1, 1)`)).toThrow(/CHECK/)
  expect(() => database.exec(`insert into hosted_provider_account_sources (org_id, user_id, provider_id, source, updated_at)
    values ('org-a', 'user-a', 'anthropic', 'team', 1)`)).toThrow(/CHECK/)
})

test("has no account agent settings table and keeps the task start policy columns", () => {
  const database = baseline()
  expect(database.prepare("select name from sqlite_master where type = 'table' and name like '%_agent_settings'").all()).toEqual([])
  const columns = (table: string) => database.prepare(`pragma table_info(${table})`).all().map((column) => (column as { name: string }).name)
  expect(columns("task_presets")).toContain("agent_startable")
  expect(columns("task_session_links")).toEqual(expect.arrayContaining(["started_from_session_id", "started_from_workspace_id", "placement", "started_by"]))
})
