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
    expect(tableExists(database, "workspace_share_grants")).toBe(false)
    expect(database.pragma("user_version", { simple: true })).toBe(5)
    database.prepare(`
      INSERT INTO users (token_identifier, public_id, kind, created_at, updated_at)
      VALUES ('owner', 'usr_owner', 'human', 1, 1)
    `).run()
    expect(() => database.prepare(`
      INSERT INTO workspaces
        (workspace_id, org_id, project_id, owner_token_identifier, backing, created_at, updated_at)
      VALUES ('ws_mismatch', 'org_one', 'prj_missing', 'owner', 'cloud-vm', 1, 1)
    `).run()).toThrow("workspace_project_tenant_conflict")
  })

  test("a populated workspace share table is dropped on open and stays dropped", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-share-drop-")), "authority.db")
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
      INSERT INTO workspace_share_grants
        (grant_id, workspace_id, granted_to_subject, granted_to_org_id, role, created_by_token_identifier, created_at)
      VALUES
        ('grant_user', 'ws_1', 'bob', NULL, 'editor', 'owner', 1),
        ('grant_org', 'ws_1', NULL, 'org_one', 'viewer', 'owner', 2);
    `)
    legacy.close()

    const database = openAuthorityDb({ path: file })()
    expect(tableExists(database, "workspace_share_grants")).toBe(false)
    database.close()

    const reopened = openAuthorityDb({ path: file })()
    expect(tableExists(reopened, "workspace_share_grants")).toBe(false)
    reopened.close()
  })

  test("a legacy database upgrades without the access mode, keeping every row and its normalized directory", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-access-drop-")), "authority.db")
    const legacy = new Database(file)
    createLegacyAuthorityTables(legacy)
    legacy.exec(`
      INSERT INTO users (token_identifier, subject, issuer, kind, created_at, updated_at)
      VALUES ('owner', 'owner', 'issuer', 'human', 1, 1);
      INSERT INTO orgs (org_id, name, kind, owner_token_identifier, created_at, updated_at)
      VALUES ('org_one', 'One', 'personal', 'owner', 1, 1);
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES ('org_one', 'owner', 'owner', 1, 1);
      INSERT INTO projects (project_id, org_id, owner_token_identifier, created_at, updated_at)
      VALUES ('prj_one', 'org_one', 'owner', 1, 1);
      INSERT INTO workspaces
        (workspace_id, org_id, project_id, owner_token_identifier, backing, access, display_name,
         second_device_open_at, remote_directory, created_at, updated_at)
      VALUES
        ('ws_machine', 'org_one', 'prj_one', 'owner', 'local-worktree', 'user-hosted', 'Machine', NULL, '/srv/app/../code/', 1, 1),
        ('ws_vm', 'org_one', 'prj_one', 'owner', 'cloud-vm', 'cloud', 'VM', NULL, NULL, 2, 2);
    `)
    legacy.close()

    const database = openAuthorityDb({ path: file })()
    expect((database.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>)
      .map((column) => column.name)).not.toContain("access")
    expect(database.prepare("SELECT workspace_id, backing, remote_directory FROM workspaces ORDER BY workspace_id").all())
      .toEqual([
        { workspace_id: "ws_machine", backing: "local-worktree", remote_directory: "/srv/code" },
        { workspace_id: "ws_vm", backing: "cloud-vm", remote_directory: null },
      ])
    database.close()

    const reopened = openAuthorityDb({ path: file })()
    expect(reopened.prepare("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 2 })
    reopened.close()
  })

  // The tenancy rebuild drops the column as a side effect of rewriting the
  // table, and it runs only for a database whose tenancy columns are still
  // nullable. Every deployed database is already past that point, so this is
  // the shape the drop actually has to handle.
  test("a database already on the current tenancy shape loses the access mode on open", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-access-drop-current-")), "authority.db")
    const legacy = new Database(file)
    createLegacyAuthorityTables(legacy)
    legacy.exec(`
      INSERT INTO users (token_identifier, subject, issuer, kind, created_at, updated_at)
      VALUES ('owner', 'owner', 'issuer', 'human', 1, 1);
      INSERT INTO orgs (org_id, name, kind, owner_token_identifier, created_at, updated_at)
      VALUES ('org_one', 'One', 'personal', 'owner', 1, 1);
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES ('org_one', 'owner', 'owner', 1, 1);
      INSERT INTO projects (project_id, org_id, owner_token_identifier, created_at, updated_at)
      VALUES ('prj_one', 'org_one', 'owner', 1, 1);
    `)
    legacy.close()

    const current = openAuthorityDb({ path: file })()
    expect(required(current, "workspaces", "org_id")).toBe(true)
    current.exec(`
      ALTER TABLE workspaces ADD COLUMN access TEXT NOT NULL DEFAULT 'cloud';
      INSERT INTO workspaces
        (workspace_id, org_id, project_id, owner_token_identifier, backing, access, display_name,
         remote_directory, created_at, updated_at)
      VALUES
        ('ws_machine', 'org_one', 'prj_one', 'owner', 'local-worktree', 'user-hosted', 'Machine', '/srv/app/../code/', 1, 1),
        ('ws_vm', 'org_one', 'prj_one', 'owner', 'cloud-vm', 'cloud', 'VM', NULL, 2, 2);
    `)
    current.close()

    const upgraded = openAuthorityDb({ path: file })()
    expect((upgraded.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>)
      .map((column) => column.name)).not.toContain("access")
    expect(upgraded.prepare("SELECT workspace_id, backing, remote_directory FROM workspaces ORDER BY workspace_id").all())
      .toEqual([
        { workspace_id: "ws_machine", backing: "local-worktree", remote_directory: "/srv/code" },
        { workspace_id: "ws_vm", backing: "cloud-vm", remote_directory: null },
      ])
    upgraded.prepare(`
      INSERT INTO workspaces (workspace_id, org_id, project_id, owner_token_identifier, backing, created_at, updated_at)
      VALUES ('ws_new', 'org_one', 'prj_one', 'owner', 'local-worktree', 3, 3)
    `).run()
    upgraded.close()
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
    expect(fs.existsSync(`${file}.pre-tenancy-v5.bak`)).toBe(true)
    const backup = new Database(`${file}.pre-tenancy-v5.bak`, { readonly: true })
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

  test("adds the last-human-turn column to a registered session in place and leaves it unprompted", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-human-turn-migrate-")), "authority.db")
    const existing = new Database(file)
    existing.exec(`
      CREATE TABLE session_registration_operations (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        creator_actor_id TEXT NOT NULL,
        operation_kind TEXT NOT NULL,
        parent_session_id TEXT,
        requested_title TEXT,
        state TEXT NOT NULL,
        state_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_history (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        creator_actor_id TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        max_event_ordinal INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );
      INSERT INTO session_history VALUES ('session_before', 'ws_one', 'actor_one', 'operation_one', 'Kept', 1, 2, 0, NULL);
    `)
    existing.close()

    const database = openAuthorityDb({ path: file })()

    expect(database.prepare("SELECT * FROM session_history").all()).toEqual([
      expect.objectContaining({ session_id: "session_before", updated_at: 2, last_human_turn_at: null }),
    ])
  })

  test("a session share written before levels existed reads as follow and rejects nothing else", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-share-level-migrate-")), "authority.db")
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE session_share_grants (
        grant_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        granted_to_user_token_identifier TEXT,
        granted_to_org_id TEXT,
        granted_to_team_id TEXT,
        created_by_token_identifier TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      INSERT INTO session_share_grants
        (grant_id, session_id, workspace_id, granted_to_user_token_identifier,
         created_by_token_identifier, created_at)
      VALUES ('ssg_before', 'ses_1', 'ws_1', 'bob', 'owner', 1);
    `)
    legacy.close()

    const database = openAuthorityDb({ path: file })()

    expect(database.prepare("SELECT grant_id, level FROM session_share_grants").all())
      .toEqual([{ grant_id: "ssg_before", level: "follow" }])
    // SQLite cannot add a CHECK to an existing table, so an upgraded database
    // holds the column without the constraint a clean install carries. The
    // authority is the gate on the way in; a reopen must not add one here.
    expect(() => openAuthorityDb({ path: file })()).not.toThrow()
    database.close()
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

function tableExists(database: InstanceType<typeof Database>, table: string) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(table).length === 1
}

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
      -- The retired identity-provider org alias. Seeded under its real column
      -- name because that is what a pre-migration database on disk still has.
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
