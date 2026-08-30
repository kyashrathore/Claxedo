import { describe, expect, test } from "vitest"
import { workspaceRoleForUser } from "./model"

type Fixture = {
  unique: Record<string, unknown>
  collect: Record<string, unknown[]>
  documents: Record<string, unknown>
}

function roleDb(fixture: Fixture) {
  const calls = new Map<string, number>()
  const count = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1)
  const db = {
    query(table: string) {
      return {
        withIndex(index: string, _apply: unknown) {
          const key = `${table}:${index}`
          count(key)
          return {
            unique: async () => fixture.unique[key],
            collect: async () => fixture.collect[key] ?? [],
          }
        },
      }
    },
    get: async (id: string) => fixture.documents[id],
  }
  return { db, calls }
}

const workspace = {
  _id: "workspace_1",
  org_id: "org_1",
  project_id: "project_1",
}
const user = { _id: "user_1" }

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    unique: {
      "projects:by_project_id": { project_id: "project_1", org_id: "org_1" },
      "workspace_memberships:by_workspace_user": undefined,
      "project_memberships:by_project_user": { role: "editor" },
      "org_memberships:by_org_user": { role: "member" },
      "team_project_grants:by_team_project": { role: "editor" },
    },
    collect: {
      "workspace_share_grants:by_workspace": [
        { granted_to_user_id: "user_1", role: "viewer" },
        { granted_to_org_id: "org_1", role: "admin" },
        { granted_to_team_id: "team_1", role: "editor" },
      ],
      "org_memberships:by_user": [{ org_id: "org_1" }],
      "team_memberships:by_user": [{ team_id: "team_1" }, { team_id: "team_other_org" }],
    },
    documents: {
      team_1: { org_id: "org_1" },
      team_other_org: { org_id: "org_other" },
      org_1: { owner_user_id: "user_other" },
    },
    ...overrides,
  }
}

describe("workspace role resolution", () => {
  test.each([
    ["missing", undefined],
    ["deleted", { owner_user_id: "user_1", deleted_at: 1 }],
  ])("denies every role when the owning organization is %s", async (_state, org) => {
    const { db, calls } = roleDb(fixture({
      documents: {
        team_1: { org_id: "org_1" },
        team_other_org: { org_id: "org_other" },
        ...(org ? { org_1: org } : {}),
      },
    }))

    await expect(workspaceRoleForUser(
      { db: db as never },
      { ...workspace, owner_user_id: "user_1" },
      user,
    )).resolves.toBeUndefined()

    expect(calls.size).toBe(0)
  })

  test("reuses one workspace-grant read across direct, org, and team shares", async () => {
    const { db, calls } = roleDb(fixture())

    await expect(workspaceRoleForUser({ db: db as never }, workspace, user)).resolves.toBe("admin")

    expect(calls.get("workspace_share_grants:by_workspace")).toBe(1)
    expect(calls.get("workspace_share_grants:by_workspace_user") ?? 0).toBe(0)
  })

  test("keeps revoked grants and deleted teams out of role precedence", async () => {
    const { db } = roleDb(fixture({
      unique: {
        "projects:by_project_id": { project_id: "project_1", org_id: "org_1" },
        "workspace_memberships:by_workspace_user": { role: "viewer" },
        "project_memberships:by_project_user": undefined,
        "org_memberships:by_org_user": undefined,
        "team_project_grants:by_team_project": { role: "owner" },
      },
      collect: {
        "workspace_share_grants:by_workspace": [
          { granted_to_org_id: "org_1", role: "owner", revoked_at: 1 },
          { granted_to_team_id: "team_1", role: "owner", revoked_at: 1 },
        ],
        "org_memberships:by_user": [{ org_id: "org_1" }],
        "team_memberships:by_user": [{ team_id: "team_1" }],
      },
      documents: {
        team_1: { org_id: "org_1", deleted_at: 1 },
        org_1: { owner_user_id: "user_other" },
      },
    }))

    await expect(workspaceRoleForUser({ db: db as never }, workspace, user)).resolves.toBe("viewer")
  })
})
