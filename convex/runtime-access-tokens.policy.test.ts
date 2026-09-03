import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")
const SERVICE_TOKEN = "runtime-token-service"
const service = { service_token: SERVICE_TOKEN }
const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

beforeEach(() => vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", SERVICE_TOKEN))
afterEach(() => vi.unstubAllEnvs())

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", stamped({
      token_identifier: "owner-token",
      clerk_subject: "owner-subject",
      kind: "human",
    }) as never)
    const memberId = await ctx.db.insert("users", stamped({
      token_identifier: "member-token",
      clerk_subject: "member-subject",
      kind: "human",
    }) as never)
    const orgId = await ctx.db.insert("orgs", stamped({ name: "Acme", owner_user_id: ownerId }) as never)
    const workspaceId = await ctx.db.insert("workspaces", stamped({
      workspace_id: "ws-runtime-policy",
      org_id: orgId,
      owner_user_id: ownerId,
      backing: "cloud-vm",
      access: "cloud",
      display_name: "Runtime policy",
    }) as never)
    const grantId = await ctx.db.insert("workspace_share_grants", {
      workspace_id: workspaceId,
      granted_to_user_id: memberId,
      role: "editor",
      created_by_user_id: ownerId,
      created_at: 1,
    } as never)
    return { workspaceId, memberId, grantId }
  })
}

describe("Convex runtime access token principal policy", () => {
  test("accepts only an explicit owner-role agent service principal", async () => {
    const t = convexTest(schema, modules)
    await seed(t)

    await expect(t.mutation(api.runtimeAccessTokens.recordMintForService, {
      ...service,
      jti: "service-ok",
      workspace_id: "ws-runtime-policy",
      host_id: "host-1",
      actor_id: "control-plane",
      actor_kind: "agent",
      principal_kind: "service",
      role: "owner",
      expires_at: Date.now() + 60_000,
    } as never)).resolves.toEqual({ ok: true })
    await expect(t.query(api.runtimeAccessTokens.active, {
      ...service,
      jti: "service-ok",
      workspace_id: "ws-runtime-policy",
      host_id: "host-1",
    } as never)).resolves.toEqual({ active: true })

    for (const principal of [
      { jti: "service-human", actor_kind: "human", role: "owner" },
      { jti: "service-editor", actor_kind: "agent", role: "editor" },
    ] as const) {
      await expect(t.mutation(api.runtimeAccessTokens.recordMintForService, {
        ...service,
        workspace_id: "ws-runtime-policy",
        host_id: "host-1",
        actor_id: "control-plane",
        principal_kind: "service",
        expires_at: Date.now() + 60_000,
        ...principal,
      } as never)).rejects.toThrow("Workspace not found")
    }

    await t.run(async (ctx) => {
      const workspace = await ctx.db
        .query("workspaces")
        .withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws-runtime-policy"))
        .unique()
      await ctx.db.patch(workspace!._id, { deleted_at: Date.now() })
    })
    await expect(t.query(api.runtimeAccessTokens.active, {
      ...service,
      jti: "service-ok",
      workspace_id: "ws-runtime-policy",
      host_id: "host-1",
    } as never)).resolves.toMatchObject({ active: false, code: "runtime_access_token_revoked" })
  })

  test("service-minted user tokens retain live role validation", async () => {
    const t = convexTest(schema, modules)
    const ids = await seed(t)

    await t.mutation(api.runtimeAccessTokens.recordMintForService, {
      ...service,
      jti: "member-editor",
      workspace_id: "ws-runtime-policy",
      host_id: "host-1",
      actor_id: String(ids.memberId),
      actor_kind: "human",
      principal_kind: "user",
      role: "editor",
      expires_at: Date.now() + 60_000,
    } as never)
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.grantId, { role: "viewer" })
    })

    await expect(t.query(api.runtimeAccessTokens.active, {
      ...service,
      jti: "member-editor",
      workspace_id: "ws-runtime-policy",
      host_id: "host-1",
    } as never)).resolves.toMatchObject({
      active: false,
      code: "runtime_access_token_revoked",
      reason: "Runtime Access Token authorization has changed",
    })
  })

  test("rejects legacy rows without an explicit principal kind at the schema boundary", async () => {
    const t = convexTest(schema, modules)
    const ids = await seed(t)
    await expect(t.run(async (ctx) => {
      await ctx.db.insert("runtime_access_tokens", {
        jti: "legacy-token",
        workspace_id: ids.workspaceId,
        host_id: "host-1",
        minted_for_user_id: ids.memberId,
        workspace_role: "editor",
        expires_at: Date.now() + 60_000,
        created_at: 1,
      } as never)
    })).rejects.toThrow("Missing required field `principal_kind`")
  })
})
