import { describe, expect, test } from "vitest"
import {
  migrateProjectTenantIdentity,
  migrateWorkspaceTenantIdentity,
} from "../../../../convex/migrations"

describe("Convex tenant identity migrations", () => {
  test("normalizes the legacy project shape without deleting rollback fields", async () => {
    const database = new MigrationDatabase({
      users: [{ _id: "users:owner" }],
      orgs: [{ _id: "orgs:one", owner_user_id: "users:owner" }],
      projects: [{
        _id: "projects:legacy",
        externalId: "prj_public",
        organizationId: "orgs:one",
        repo_key: "HTTPS://github.com/Claxedo/OpenCode.git/",
        repoUrl: "HTTPS://github.com/Claxedo/OpenCode.git/",
        createdAt: 10,
        updatedAt: 20,
        _creationTime: 5,
      }],
    })
    const project = database.row("projects", "projects:legacy")

    await migrateProjectTenantIdentity({ db: database }, project)
    await migrateProjectTenantIdentity({ db: database }, project)

    expect(project).toMatchObject({
      externalId: "prj_public",
      organizationId: "orgs:one",
      repoUrl: "HTTPS://github.com/Claxedo/OpenCode.git/",
      project_id: "prj_public",
      org_id: "orgs:one",
      repo_key: "github.com/Claxedo/OpenCode",
      owner_user_id: "users:owner",
      created_at: 10,
      updated_at: 20,
    })
  })

  test("creates one deterministic project for an unambiguous legacy workspace", async () => {
    const database = new MigrationDatabase({
      users: [{ _id: "users:owner" }],
      orgs: [{ _id: "orgs:one", owner_user_id: "users:owner" }],
      org_memberships: [{ _id: "org_memberships:one", org_id: "orgs:one", user_id: "users:owner" }],
      projects: [],
      workspaces: [{
        _id: "workspaces:one",
        workspace_id: "ws_one",
        owner_user_id: "users:owner",
        repo_url: "https://github.com/claxedo/opencode.git",
        created_at: 10,
        updated_at: 20,
        _creationTime: 5,
      }],
    })
    const workspace = database.row("workspaces", "workspaces:one")

    await migrateWorkspaceTenantIdentity({ db: database }, workspace)
    await migrateWorkspaceTenantIdentity({ db: database }, workspace)

    expect(workspace).toMatchObject({ org_id: "orgs:one", project_id: "prj_legacy_ws_one" })
    expect(database.rows("projects")).toEqual([{
      _id: "projects:1",
      project_id: "prj_legacy_ws_one",
      org_id: "orgs:one",
      repo_key: "github.com/claxedo/opencode",
      owner_user_id: "users:owner",
      created_at: 10,
      updated_at: 20,
    }])
  })

  test("refuses to guess a workspace tenant from multiple memberships", async () => {
    const database = new MigrationDatabase({
      users: [{ _id: "users:owner" }],
      orgs: [{ _id: "orgs:one" }, { _id: "orgs:two" }],
      org_memberships: [
        { _id: "org_memberships:one", org_id: "orgs:one", user_id: "users:owner" },
        { _id: "org_memberships:two", org_id: "orgs:two", user_id: "users:owner" },
      ],
      projects: [],
      workspaces: [{
        _id: "workspaces:ambiguous",
        workspace_id: "ws_ambiguous",
        owner_user_id: "users:owner",
        created_at: 10,
        updated_at: 10,
      }],
    })

    await expect(migrateWorkspaceTenantIdentity(
      { db: database },
      database.row("workspaces", "workspaces:ambiguous"),
    )).rejects.toThrow("workspace_organization_unresolved:workspaces:ambiguous")
    expect(database.rows("projects")).toEqual([])
  })
})

class MigrationDatabase {
  private data: Record<string, Array<Record<string, unknown>>>

  constructor(data: Record<string, Array<Record<string, unknown>>>) {
    this.data = structuredClone(data)
  }

  rows(table: string) {
    return this.data[table] ?? []
  }

  row(table: string, id: string) {
    const row = this.rows(table).find((item) => item._id === id)
    if (!row) throw new Error(`missing fixture row:${table}:${id}`)
    return row
  }

  normalizeId(table: string, value: string) {
    return this.rows(table).some((row) => row._id === value) ? value : null
  }

  async get(id: string) {
    return Object.values(this.data).flat().find((row) => row._id === id) ?? null
  }

  async patch(id: string, patch: Record<string, unknown>) {
    const row = Object.values(this.data).flat().find((item) => item._id === id)
    if (!row) throw new Error(`missing patch row:${id}`)
    Object.assign(row, patch)
  }

  async insert(table: string, value: Record<string, unknown>) {
    const rows = this.data[table] ??= []
    const id = `${table}:${rows.length + 1}`
    rows.push({ _id: id, ...value })
    return id
  }

  query(table: string) {
    return {
      withIndex: (_index: string, build: (query: IndexQuery) => unknown) => {
        const filters: Record<string, unknown> = {}
        const query: IndexQuery = {
          eq: (field, value) => {
            filters[field] = value
            return query
          },
        }
        build(query)
        const matches = () => this.rows(table).filter((row) => (
          Object.entries(filters).every(([field, value]) => row[field] === value)
        ))
        return {
          unique: async () => {
            const rows = matches()
            if (rows.length > 1) throw new Error(`fixture_not_unique:${table}`)
            return rows[0] ?? null
          },
          collect: async () => matches(),
        }
      },
    }
  }
}

type IndexQuery = {
  eq(field: string, value: unknown): IndexQuery
}
