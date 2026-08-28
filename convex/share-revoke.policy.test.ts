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
 * Every table here requires `created_at`/`updated_at` (workspace_share_grants
 * and runtime_access_tokens are the two exceptions below — neither declares
 * `updated_at` in convex/schema.ts). The hand-rolled `db` double this suite
 * used to run against enforced nothing, so its seeds were missing them and the
 * schema drift went unnoticed.
 */
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Workspace share revoke policy (`convex/workspaceShares.ts`).
 *
 * Runs against the real function pipeline via `convex-test` — including the
 * `authedMutation` wrapper from `model.ts`, which is where identity is
 * resolved and `authorizeWorkspace(ctx, workspace, "admin")` decides who may
 * revoke a share at all. The previous version of this suite lived in
 * claxedo-server, imported `workspaceShares.ts` across five directory levels,
 * reached past the builder into `_handler`, and drove a hand-written `db`
 * double — so it exercised the handler body while skipping the auth wrapper
 * that makes it safe.
 */
describe("Convex workspace share revoke policy", () => {
  test("grants only to canonical users in the workspace organization", async () => {
    const t = convexTest(schema, modules)
    const ids = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never)
      const targetId = await ctx.db.insert("users", stamped({ token_identifier: "target_token" }) as never)
      const workspaceOrgId = await ctx.db.insert("orgs", stamped({ name: "Workspace org", owner_user_id: ownerId }) as never)
      const otherOrgId = await ctx.db.insert("orgs", stamped({ name: "Other org" }) as never)
      await ctx.db.insert("org_memberships", stamped({
        org_id: otherOrgId,
        user_id: targetId,
        role: "member",
      }) as never)
      await ctx.db.insert("workspaces", stamped({
        workspace_id: "ws_scoped",
        org_id: workspaceOrgId,
        owner_user_id: ownerId,
        backing: "cloud-vm",
        access: "cloud",
        display_name: "Scoped",
      }) as never)
      return { targetId, workspaceOrgId }
    })

    const asOwner = t.withIdentity({ tokenIdentifier: "owner_token", subject: "owner_subject" })
    await expect(asOwner.mutation(api.workspaceShares.grant, {
      workspace_id: "ws_scoped",
      role: "editor",
      target_user_id: ids.targetId,
    })).rejects.toThrow("Workspace share target belongs to another organization")

    await t.run(async (ctx) => {
      await ctx.db.insert("org_memberships", stamped({
        org_id: ids.workspaceOrgId,
        user_id: ids.targetId,
        role: "member",
      }) as never)
    })
    await expect(asOwner.mutation(api.workspaceShares.grant, {
      workspace_id: "ws_scoped",
      role: "editor",
      target_user_id: ids.targetId,
    })).resolves.toBeDefined()
  })

  test("revoking a user share revokes only that user's active Runtime Access Tokens", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456)
    const t = convexTest(schema, modules)

    const targetId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", stamped({ token_identifier: "owner_token" }) as never)
      const targetId = await ctx.db.insert("users", stamped({ token_identifier: "target_token" }) as never)
      const otherId = await ctx.db.insert("users", stamped({ token_identifier: "other_token" }) as never)

      const workspaceId = await ctx.db.insert("workspaces", stamped({
        workspace_id: "ws_1",
        owner_user_id: ownerId,
        backing: "cloud-vm",
        access: "cloud",
        display_name: "Workspace 1",
      }) as never)

      await ctx.db.insert("workspace_share_grants", {
        workspace_id: workspaceId,
        granted_to_user_id: targetId,
        role: "editor",
        created_by_user_id: ownerId,
        created_at: 1,
      } as never)

      await ctx.db.insert("runtime_access_tokens", {
        jti: "jti_target_active",
        workspace_id: workspaceId,
        host_id: "host_1",
        minted_for_user_id: targetId,
        expires_at: 999_999,
        created_at: 1,
      } as never)
      await ctx.db.insert("runtime_access_tokens", {
        jti: "jti_target_revoked",
        workspace_id: workspaceId,
        host_id: "host_1",
        minted_for_user_id: targetId,
        expires_at: 999_999,
        revoked_at: 42,
        created_at: 1,
      } as never)
      await ctx.db.insert("runtime_access_tokens", {
        jti: "jti_other_active",
        workspace_id: workspaceId,
        host_id: "host_1",
        minted_for_user_id: otherId,
        expires_at: 999_999,
        created_at: 1,
      } as never)
      return targetId
    })

    const asOwner = t.withIdentity({ tokenIdentifier: "owner_token", subject: "owner_subject" })
    await expect(asOwner.mutation(api.workspaceShares.revoke, {
      workspace_id: "ws_1",
      target_user_id: targetId,
    })).resolves.toEqual({
      revoked: true,
      runtime_tokens_revoked: 1,
    })

    await t.run(async (ctx) => {
      const grant = (await ctx.db.query("workspace_share_grants").collect())[0]
      expect(grant).toMatchObject({ revoked_at: 123_456 })

      const tokens = await ctx.db.query("runtime_access_tokens").collect()
      expect(tokens.find((row) => row.jti === "jti_target_active")).toMatchObject({ revoked_at: 123_456 })
      expect(tokens.find((row) => row.jti === "jti_target_revoked")).toMatchObject({ revoked_at: 42 })
      expect(tokens.find((row) => row.jti === "jti_other_active")).not.toHaveProperty("revoked_at")
    })
  })
})
