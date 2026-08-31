import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { describe, expect, test } from "vitest"
import { migrateAuthorityTenancySchema, openAuthorityDb } from "./workspace-authority-store"

describe("SQLite workspace authority tenancy migration", () => {
  test("clean installs enforce tenant and actor identity columns", () => {
    const database = openAuthorityDb({ path: ":memory:" })()

    expect(required(database, "users", "public_id")).toBe(true)
    expect(required(database, "projects", "org_id")).toBe(true)
    expect(required(database, "projects", "repo_key")).toBe(true)
    expect(required(database, "projects", "owner_token_identifier")).toBe(true)
    expect(required(database, "workspaces", "org_id")).toBe(true)
    expect(required(database, "workspaces", "project_id")).toBe(true)
    expect(required(database, "workspace_share_grants", "target_key")).toBe(true)
    expect(database.pragma("user_version", { simple: true })).toBe(3)
    database.prepare(`
      INSERT INTO users (token_identifier, public_id, kind, created_at, updated_at)
      VALUES ('owner', 'usr_owner', 'human', 1, 1)
    `).run()
    expect(() => database.prepare(`
      INSERT INTO workspaces
        (workspace_id, org_id, project_id, owner_token_identifier, backing, access, created_at, updated_at)
      VALUES ('ws_mismatch', 'org_one', 'prj_missing', 'owner', 'cloud-vm', 'cloud', 1, 1)
    `).run()).toThrow("workspace_project_tenant_conflict")
  })

  test("canonicalizes duplicate active share grants before enforcing uniqueness", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-share-migrate-")), "authority.db")
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE workspace_share_grants (
        grant_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        granted_to_token_identifier TEXT,
        granted_to_subject TEXT,
        granted_to_org_id TEXT,
        role TEXT NOT NULL,
        created_by_token_identifier TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      INSERT INTO workspace_share_grants
        (grant_id, workspace_id, granted_to_subject, role, created_by_token_identifier, created_at)
      VALUES
        ('grant_old', 'ws_1', 'bob', 'admin', 'owner', 1),
        ('grant_new', 'ws_1', 'bob', 'viewer', 'owner', 2);
    `)
    legacy.close()

    const database = openAuthorityDb({ path: file })()
    expect(database.prepare(`
      SELECT grant_id, target_key, role, revoked_at
      FROM workspace_share_grants ORDER BY created_at
    `).all()).toEqual([
      { grant_id: "grant_old", target_key: "subject:bob", role: "admin", revoked_at: 1 },
      { grant_id: "grant_new", target_key: "subject:bob", role: "viewer", revoked_at: null },
    ])
    expect(() => database.prepare(`
      INSERT INTO workspace_share_grants
        (grant_id, workspace_id, target_key, granted_to_subject, role, created_by_token_identifier, created_at)
      VALUES ('grant_duplicate', 'ws_1', 'subject:bob', 'editor', 'owner', 3)
    `).run()).toThrow()
    database.close()
  })

  test("collapses legacy subject and token grants for one known user", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-share-user-migrate-")), "authority.db")
    const legacy = new Database(file)
    createLegacyAuthorityTables(legacy)
    legacy.exec(`
      CREATE TABLE workspace_share_grants (
        grant_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        granted_to_token_identifier TEXT,
        granted_to_subject TEXT,
        granted_to_org_id TEXT,
        role TEXT NOT NULL,
        created_by_token_identifier TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      INSERT INTO users (token_identifier, subject, issuer, kind, created_at, updated_at)
      VALUES ('issuer|bob', 'bob', 'issuer', 'human', 1, 1);
      INSERT INTO workspace_share_grants
        (grant_id, workspace_id, granted_to_token_identifier, role, created_by_token_identifier, created_at)
      VALUES ('grant_token', 'ws_1', 'issuer|bob', 'admin', 'owner', 1);
      INSERT INTO workspace_share_grants
        (grant_id, workspace_id, granted_to_subject, role, created_by_token_identifier, created_at)
      VALUES ('grant_subject', 'ws_1', 'bob', 'editor', 'owner', 2);
    `)
    legacy.close()

    const database = openAuthorityDb({ path: file })()
    expect(database.prepare(`
      SELECT grant_id, target_key, revoked_at FROM workspace_share_grants ORDER BY created_at
    `).all()).toEqual([
      { grant_id: "grant_token", target_key: "token:issuer|bob", revoked_at: 1 },
      { grant_id: "grant_subject", target_key: "token:issuer|bob", revoked_at: null },
    ])
    database.close()
  })

  test("canonicalizes legacy provider organization share targets", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-share-org-migrate-")), "authority.db")
    const legacy = new Database(file)
    createLegacyAuthorityTables(legacy)
    legacy.exec(`
      CREATE TABLE workspace_share_grants (
        grant_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        granted_to_token_identifier TEXT,
        granted_to_subject TEXT,
        granted_to_org_id TEXT,
        role TEXT NOT NULL,
        created_by_token_identifier TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      INSERT INTO orgs (
        org_id, name, kind, owner_token_identifier, clerk_org_id, created_at, updated_at
      ) VALUES ('org_team', 'Team', 'team', 'owner', 'org_provider_team', 1, 1);
      INSERT INTO workspace_share_grants (
        grant_id, workspace_id, granted_to_org_id, role, created_by_token_identifier, created_at
      ) VALUES ('grant_org', 'ws_1', 'org_provider_team', 'editor', 'owner', 1);
    `)
    legacy.close()

    const database = openAuthorityDb({ path: file })()
    expect(database.prepare(`
      SELECT target_key, granted_to_org_id FROM workspace_share_grants WHERE grant_id = 'grant_org'
    `).get()).toEqual({ target_key: "org:org_team", granted_to_org_id: "org_team" })
    database.close()
  })

  test("upgrades legacy nullable rows, rebuilds constraints, and is idempotent", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-authority-migrate-")), "authority.db")
    const legacy = new Database(file)
    createLegacyAuthorityTables(legacy)
    legacy.exec(`
      INSERT INTO users (token_identifier, subject, issuer, kind, created_at, updated_at)
      VALUES ('owner', 'owner', 'issuer', NULL, 1, 1);
      INSERT INTO orgs (org_id, name, kind, owner_token_identifier, created_at, updated_at)
      VALUES ('org_one', 'One', 'personal', 'owner', 1, 1);
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES ('org_one', 'owner', 'owner', 1, 1);
      INSERT INTO projects (project_id, org_id, owner_token_identifier, created_at, updated_at)
      VALUES ('prj_existing', NULL, NULL, 1, 2);
      INSERT INTO workspaces
        (workspace_id, org_id, project_id, owner_token_identifier, backing, access, display_name,
         second_device_open_at, created_at, updated_at)
      VALUES
        ('ws_existing', 'org_one', 'prj_existing', 'owner', 'cloud-vm', 'cloud', 'Existing', NULL, 1, 2),
        ('ws_missing_project', 'org_one', NULL, 'owner', 'cloud-vm', 'cloud', 'Missing', NULL, 3, 4);
    `)
    legacy.close()

    const database = openAuthorityDb({ path: file })()
    expect(fs.existsSync(`${file}.pre-tenancy-v3.bak`)).toBe(true)
    const backup = new Database(`${file}.pre-tenancy-v3.bak`, { readonly: true })
    expect((backup.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>)
      .some((column) => column.name === "public_id")).toBe(false)
    expect(backup.prepare("SELECT org_id, project_id FROM workspaces WHERE workspace_id = 'ws_missing_project'").get())
      .toEqual({ org_id: "org_one", project_id: null })
    backup.close()
    const firstSnapshot = {
      users: database.prepare("SELECT token_identifier, public_id, kind FROM users").all(),
      projects: database.prepare(`
        SELECT project_id, org_id, repo_key, owner_token_identifier FROM projects ORDER BY project_id
      `).all(),
      workspaces: database.prepare(`
        SELECT workspace_id, org_id, project_id FROM workspaces ORDER BY workspace_id
      `).all(),
    }

    expect(firstSnapshot.users).toEqual([{
      token_identifier: "owner",
      public_id: expect.stringMatching(/^usr_legacy_[0-9a-f]{32}$/),
      kind: "human",
    }])
    expect(firstSnapshot.projects).toEqual([
      {
        project_id: "prj_existing",
        org_id: "org_one",
        repo_key: "workspace:prj_existing",
        owner_token_identifier: "owner",
      },
      {
        project_id: "prj_legacy_ws_missing_project",
        org_id: "org_one",
        repo_key: "workspace:ws_missing_project",
        owner_token_identifier: "owner",
      },
    ])
    expect(firstSnapshot.workspaces).toEqual([
      { workspace_id: "ws_existing", org_id: "org_one", project_id: "prj_existing" },
      {
        workspace_id: "ws_missing_project",
        org_id: "org_one",
        project_id: "prj_legacy_ws_missing_project",
      },
    ])
    expect(required(database, "users", "public_id")).toBe(true)
    expect(required(database, "projects", "org_id")).toBe(true)
    expect(required(database, "projects", "repo_key")).toBe(true)
    expect(required(database, "workspaces", "org_id")).toBe(true)
    expect(required(database, "workspaces", "project_id")).toBe(true)
    database.close()

    const reopened = openAuthorityDb({ path: file })()
    expect({
      users: reopened.prepare("SELECT token_identifier, public_id, kind FROM users").all(),
      projects: reopened.prepare(`
        SELECT project_id, org_id, repo_key, owner_token_identifier FROM projects ORDER BY project_id
      `).all(),
      workspaces: reopened.prepare(`
        SELECT workspace_id, org_id, project_id FROM workspaces ORDER BY workspace_id
      `).all(),
    }).toEqual(firstSnapshot)
  })

  test("ambiguous legacy tenancy aborts without partially rewriting rows", () => {
    const database = new Database(":memory:")
    createLegacyAuthorityTables(database)
    database.exec(`
      INSERT INTO users (token_identifier, subject, issuer, kind, created_at, updated_at)
      VALUES ('owner', 'owner', 'issuer', 'human', 1, 1);
      INSERT INTO orgs (org_id, name, kind, owner_token_identifier, created_at, updated_at)
      VALUES ('org_one', 'One', 'team', NULL, 1, 1), ('org_two', 'Two', 'team', NULL, 1, 1);
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES ('org_one', 'owner', 'owner', 1, 1), ('org_two', 'owner', 'owner', 1, 1);
      INSERT INTO workspaces
        (workspace_id, org_id, project_id, owner_token_identifier, backing, access, display_name,
         second_device_open_at, created_at, updated_at)
      VALUES ('ws_ambiguous', NULL, NULL, 'owner', 'cloud-vm', 'cloud', 'Ambiguous', NULL, 1, 1);
    `)

    expect(() => migrateAuthorityTenancySchema(database))
      .toThrow("workspace_organization_unresolved:ws_ambiguous")
    expect(database.prepare("SELECT org_id, project_id FROM workspaces WHERE workspace_id = 'ws_ambiguous'").get())
      .toEqual({ org_id: null, project_id: null })
    expect((database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>)
      .some((column) => column.name === "public_id")).toBe(false)
  })
})

function required(database: InstanceType<typeof Database>, table: string, column: string) {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>)
    .find((item) => item.name === column)?.notnull === 1
}

function createLegacyAuthorityTables(database: InstanceType<typeof Database>) {
  database.exec(`
    CREATE TABLE users (
      token_identifier TEXT PRIMARY KEY,
      subject TEXT,
      issuer TEXT,
      kind TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE orgs (
      org_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      owner_token_identifier TEXT,
      clerk_org_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE org_memberships (
      org_id TEXT NOT NULL,
      token_identifier TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, token_identifier)
    );
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      org_id TEXT,
      owner_token_identifier TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE workspaces (
      workspace_id TEXT PRIMARY KEY,
      org_id TEXT,
      project_id TEXT,
      owner_token_identifier TEXT NOT NULL,
      backing TEXT NOT NULL,
      access TEXT NOT NULL,
      display_name TEXT,
      second_device_open_at INTEGER,
      home_region TEXT,
      repo_url TEXT,
      repo_name TEXT,
      git_branch TEXT,
      remote_directory TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
}
