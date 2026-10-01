import { afterEach, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"

import {
  applyControlPlaneMigration,
  controlPlaneMigrations,
  miniflareControlPlaneDatabase,
  type ControlPlaneDatabase,
} from "../../../test-support/control-plane-migrations"

const MIGRATION = "0045_org_scope_means_org.sql"
const ALL_MIGRATIONS = controlPlaneMigrations()
const BEFORE = ALL_MIGRATIONS.slice(0, ALL_MIGRATIONS.indexOf(MIGRATION))

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function seededBeforeMigration(): Promise<D1Database> {
  const instance = await miniflareControlPlaneDatabase(BEFORE)
  active.push(instance)
  const database = instance.database
  await database.batch([
    database.prepare(`insert into users (user_id, state, created_at, updated_at) values ('user-owner', 'active', 1, 1)`),
    database.prepare(`insert into users (user_id, state, created_at, updated_at) values ('user-member', 'active', 1, 1)`),
    database.prepare(`insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org-personal', 'Owner', 'personal', 'user-owner', 1, 1)`),
    database.prepare(`insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org-acme', 'Acme', 'team', 'user-owner', 1, 1)`),
    database.prepare(`insert into org_memberships (org_id, user_id, role, created_at, updated_at) values ('org-acme', 'user-member', 'member', 1, 1)`),
    database.prepare(`insert into projects (project_id, org_id, repo_key, owner_user_id, created_at, updated_at) values ('project-acme', 'org-acme', 'github.com/acme/app', 'user-owner', 1, 1)`),
    database.prepare(`insert into teams (team_id, org_id, name, is_default, created_by_user_id, created_at, updated_at) values ('team-everyone', 'org-acme', 'Everyone', 1, 'user-owner', 1, 1)`),
    database.prepare(`
      insert into hosted_connection_attempts (state, verifier, integration_id, owner, scope, status, expires_at, created_at, updated_at)
      values ('state-org', 'verifier-org', 'github', 'org:org-acme', 'team', 'pending', 10, 1, 1),
             ('state-personal', 'verifier-personal', 'github', 'user:user-member', 'personal', 'pending', 10, 1, 1)
    `),
    database.prepare(`
      insert into hosted_provider_account_sources (org_id, user_id, provider_id, source, updated_at)
      values ('org-acme', 'user-member', 'anthropic', 'team', 1), ('org-acme', 'user-member', 'openai', 'own', 1)
    `),
  ])
  await applyControlPlaneMigration(database, MIGRATION)
  return database
}

async function rows(database: D1Database, sql: string) {
  return (await database.prepare(sql).all()).results
}

describe("0045: org-wide values say org", () => {
  test("rewrites stored 'team' values and keeps every row that references an org", async () => {
    const database = await seededBeforeMigration()

    expect(await rows(database, "select org_id, kind from orgs order by org_id")).toEqual([
      { org_id: "org-acme", kind: "shared" },
      { org_id: "org-personal", kind: "personal" },
    ])
    expect(await rows(database, "select user_id, role from org_memberships where org_id = 'org-acme'"))
      .toEqual([{ user_id: "user-member", role: "member" }])
    expect(await rows(database, "select project_id from projects where org_id = 'org-acme'"))
      .toEqual([{ project_id: "project-acme" }])
    expect(await rows(database, "select team_id from teams where org_id = 'org-acme'"))
      .toEqual([{ team_id: "team-everyone" }])
    expect(await rows(database, "select state, scope from hosted_connection_attempts order by state")).toEqual([
      { state: "state-org", scope: "org" },
      { state: "state-personal", scope: "personal" },
    ])
    expect(await rows(database, "select provider_id, source from hosted_provider_account_sources order by provider_id")).toEqual([
      { provider_id: "anthropic", source: "org" },
      { provider_id: "openai", source: "own" },
    ])
  })

  test("the rebuilt tables refuse 'team' and keep their constraints and indexes", async () => {
    const database = await seededBeforeMigration()

    await expect(database.prepare(`insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org-old', 'Old', 'team', 'user-owner', 1, 1)`).run())
      .rejects.toThrow(/CHECK/)
    await database.prepare(`insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org-new', 'New', 'shared', 'user-member', 1, 1)`).run()
    await expect(database.prepare(`insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org-second-personal', 'Owner', 'personal', 'user-owner', 1, 1)`).run())
      .rejects.toThrow(/UNIQUE/)
    await expect(database.prepare(`insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org-orphan', 'Orphan', 'shared', 'user-missing', 1, 1)`).run())
      .rejects.toThrow(/FOREIGN KEY/)
    await expect(database.prepare(`insert into org_memberships (org_id, user_id, role, created_at, updated_at) values ('org-missing', 'user-member', 'member', 1, 1)`).run())
      .rejects.toThrow(/FOREIGN KEY/)

    await expect(database.prepare(`
      insert into hosted_connection_attempts (state, verifier, integration_id, scope, status, expires_at, created_at, updated_at)
      values ('state-old', 'verifier', 'github', 'team', 'pending', 10, 1, 1)
    `).run()).rejects.toThrow(/CHECK/)
    await expect(database.prepare(`
      insert into hosted_provider_account_sources (org_id, user_id, provider_id, source, updated_at)
      values ('org-acme', 'user-owner', 'anthropic', 'team', 1)
    `).run()).rejects.toThrow(/CHECK/)
    expect(await rows(database, "select name from sqlite_master where type = 'index' and name in ('orgs_one_personal_per_owner', 'orgs_one_org_per_deployment', 'hosted_connection_attempts_by_status_expiry') order by name"))
      .toEqual([
        { name: "hosted_connection_attempts_by_status_expiry" },
        { name: "orgs_one_org_per_deployment" },
        { name: "orgs_one_personal_per_owner" },
      ])
    expect(await rows(database, "select name from sqlite_master where name like '%_previous' or name like '%_next'")).toEqual([])
  })
})
