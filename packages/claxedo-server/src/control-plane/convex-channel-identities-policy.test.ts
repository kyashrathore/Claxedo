import { afterAll, afterEach, describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { authorizeProject, authorizeWorkspace } from "../../../../convex/channelIdentities"

type Row = Record<string, unknown> & { _id: string }
const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

function db(input: {
  projectRole?: "viewer" | "editor" | "admin" | "owner"
  linked?: boolean
}) {
  const rows: Record<string, Row[]> = {
    users: [{ _id: "user_1", token_identifier: "tok_1" }],
    orgs: [{ _id: "org_1" }],
    projects: [{ _id: "project_1", project_id: "project_1", org_id: "org_1", owner_user_id: "owner_1" }],
    project_memberships: input.projectRole
      ? [{ _id: "project_membership_1", project_id: "project_1", user_id: "user_1", role: input.projectRole }]
      : [],
    org_memberships: [],
    workspaces: [{
      _id: "workspace_1",
      workspace_id: "ws_1",
      org_id: "org_1",
      owner_user_id: "owner_1",
      project_id: "project_1",
    }],
    workspace_memberships: [],
    workspace_share_grants: [],
    channel_identities: input.linked === false
      ? []
      : [{
          _id: "channel_identity_1",
          channel: "github",
          external_user_id: "octocat",
          user_id: "user_1",
          created_at: 1,
          updated_at: 1,
        }],
  }
  return {
    rows,
    query(table: string) {
      const filters: Array<[string, unknown]> = []
      const query = {
        withIndex(_name: string, build: (q: { eq: (key: string, value: unknown) => unknown }) => unknown) {
          build({
            eq(key, value) {
              filters.push([key, value])
              return this
            },
          })
          return query
        },
        async collect() {
          return (rows[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value))
        },
        async unique() {
          return (await query.collect())[0]
        },
      }
      return query
    },
    async get(id: string) {
      return Object.values(rows).flat().find((row) => row._id === id)
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

afterEach(() => {
  if (prevServiceToken === undefined) {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    return
  }
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken
})

afterAll(() => {
  fs.rmSync(path.resolve(process.cwd(), "convex"), { force: true, recursive: true })
})

describe("Convex channel identity policy", () => {
  test("authorizes linked channel users through project roles", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"

    await expect(handler(authorizeProject)({ db: db({ projectRole: "editor" }) } as never, {
      service_token: "svc_secret",
      channel: "github",
      external_user_id: "octocat",
      thread_key: "github:install:repo:issue-1",
      project_id: "project_1",
      action: "write",
    })).resolves.toEqual({ ok: true, role: "editor", org_id: "org_1" })
  })

  test("denies unlinked channel users", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"

    await expect(handler(authorizeProject)({ db: db({ linked: false, projectRole: "owner" }) } as never, {
      service_token: "svc_secret",
      channel: "github",
      external_user_id: "octocat",
      thread_key: "github:install:repo:issue-1",
      project_id: "project_1",
      action: "write",
    })).resolves.toEqual({ ok: false })
  })

  test("authorizes workspace access through linked project membership", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"

    await expect(handler(authorizeWorkspace)({ db: db({ projectRole: "editor" }) } as never, {
      service_token: "svc_secret",
      channel: "github",
      external_user_id: "octocat",
      thread_key: "github:install:repo:issue-1",
      workspace_id: "ws_1",
      action: "write",
    })).resolves.toEqual({ allowed: true, role: "editor" })
  })

  test("requires the control plane service token", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"

    await expect(handler(authorizeProject)({ db: db({ projectRole: "owner" }) } as never, {
      service_token: "wrong",
      channel: "github",
      external_user_id: "octocat",
      thread_key: "github:install:repo:issue-1",
      project_id: "project_1",
      action: "write",
    })).rejects.toThrow("Unauthenticated")
  })
})
