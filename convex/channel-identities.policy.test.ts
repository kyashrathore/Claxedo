import { afterEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

/**
 * Every table here requires `created_at`/`updated_at`. The hand-rolled `db`
 * double this suite used to run against enforced nothing, so its seeds were
 * missing them and the schema drift went unnoticed.
 */
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

type ProjectRole = "viewer" | "editor" | "admin" | "owner"

/**
 * Seeds a project + workspace pair reachable only through a linked channel
 * identity, mirroring the fixture the old hand-rolled `db` double built.
 */
async function seedLinkedProject(t: ReturnType<typeof convexTest>, opts: { projectRole?: ProjectRole; linked?: boolean }) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", stamped({ token_identifier: "tok_1" }) as never)
    const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "tok_owner" }) as never)
    const orgId = await ctx.db.insert("orgs", stamped({ name: "Acme" }) as never)
    const projectDocId = await ctx.db.insert(
      "projects",
      stamped({ project_id: "project_1", org_id: orgId, owner_user_id: ownerId }) as never,
    )
    if (opts.projectRole) {
      await ctx.db.insert(
        "project_memberships",
        stamped({ project_id: projectDocId, user_id: userId, role: opts.projectRole }) as never,
      )
    }
    await ctx.db.insert(
      "workspaces",
      stamped({
        workspace_id: "ws_1",
        org_id: orgId,
        owner_user_id: ownerId,
        project_id: "project_1",
        backing: "local-worktree",
        access: "local",
        display_name: "Workspace 1",
      }) as never,
    )
    if (opts.linked !== false) {
      await ctx.db.insert(
        "channel_identities",
        stamped({ channel: "github", external_user_id: "octocat", user_id: userId }) as never,
      )
    }
    return { orgId }
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * Channel bot (GitHub/Slack/Telegram) authorization policy — these run
 * through the real `serviceQuery` builder (`model.ts`), so the control-plane
 * service-token check and the identity→project/workspace role resolution are
 * both exercised, not just the handler body.
 */
describe("Convex channel identity policy", () => {
  test("authorizes linked channel users through project roles", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "svc_secret")
    const t = convexTest(schema, modules)
    const { orgId } = await seedLinkedProject(t, { projectRole: "editor" })

    await expect(
      t.query(api.channelIdentities.authorizeProject, {
        service_token: "svc_secret",
        channel: "github",
        external_user_id: "octocat",
        thread_key: "github:install:repo:issue-1",
        project_id: "project_1",
        action: "write",
      } as never),
    ).resolves.toEqual({ ok: true, role: "editor", org_id: orgId })
  })

  test("denies unlinked channel users", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "svc_secret")
    const t = convexTest(schema, modules)
    await seedLinkedProject(t, { linked: false, projectRole: "owner" })

    await expect(
      t.query(api.channelIdentities.authorizeProject, {
        service_token: "svc_secret",
        channel: "github",
        external_user_id: "octocat",
        thread_key: "github:install:repo:issue-1",
        project_id: "project_1",
        action: "write",
      } as never),
    ).resolves.toEqual({ ok: false })
  })

  test("authorizes workspace access through linked project membership", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "svc_secret")
    const t = convexTest(schema, modules)
    await seedLinkedProject(t, { projectRole: "editor" })

    await expect(
      t.query(api.channelIdentities.authorizeWorkspace, {
        service_token: "svc_secret",
        channel: "github",
        external_user_id: "octocat",
        thread_key: "github:install:repo:issue-1",
        workspace_id: "ws_1",
        action: "write",
      } as never),
    ).resolves.toEqual({ allowed: true, role: "editor" })
  })

  test("requires the control plane service token", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "svc_secret")
    const t = convexTest(schema, modules)
    await seedLinkedProject(t, { projectRole: "owner" })

    await expect(
      t.query(api.channelIdentities.authorizeProject, {
        service_token: "wrong",
        channel: "github",
        external_user_id: "octocat",
        thread_key: "github:install:repo:issue-1",
        project_id: "project_1",
        action: "write",
      } as never),
    ).rejects.toThrow("Unauthenticated")
  })
})
