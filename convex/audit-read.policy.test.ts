import { describe, expect, test } from "vitest"
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

/**
 * Pre-launch security review §6.11 — the `audit_events` READ path.
 *
 * The write side already refuses to file a row under a workspace the caller
 * cannot read, parking the attempted id under a reserved `metadata` key
 * instead. These tests pin the other half: that reading the table cannot
 * re-open the same cross-tenant hole from the opposite direction, and that
 * the unverified attempted id is never laundered back into attribution.
 *
 * Runs through `convex-test` against the real `authedQuery` wrappers — the
 * previous version of this suite drove a hand-written `db` double and
 * reached past the builders into `_handler`, so it never exercised identity
 * resolution or the real query engine's index/`.unique()` semantics.
 */

/** `user_caller` is always the identity; each test's fixture decides what it can reach. */
async function seedTenants(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const callerId = await ctx.db.insert("users", stamped({ token_identifier: "token_caller" }) as never)
    const victimId = await ctx.db.insert("users", stamped({ token_identifier: "token_victim" }) as never)
    const orgVictimId = await ctx.db.insert("orgs", stamped({ name: "victim", owner_user_id: victimId }) as never)
    const orgCallerId = await ctx.db.insert("orgs", stamped({ name: "caller", owner_user_id: callerId }) as never)
    const workspaceVictimId = await ctx.db.insert(
      "workspaces",
      stamped({
        workspace_id: "ws_victim",
        owner_user_id: victimId,
        org_id: orgVictimId,
        backing: "local-worktree",
        access: "user-hosted",
        display_name: "victim",
      }) as never,
    )
    const workspaceCallerId = await ctx.db.insert(
      "workspaces",
      stamped({
        workspace_id: "ws_caller",
        owner_user_id: callerId,
        org_id: orgCallerId,
        backing: "local-worktree",
        access: "user-hosted",
        display_name: "caller",
      }) as never,
    )
    return { callerId, victimId, orgVictimId, orgCallerId, workspaceVictimId, workspaceCallerId }
  })
}

async function insertAudit(t: ReturnType<typeof convexTest>, row: Record<string, unknown>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("audit_events", { action: "workspaces.open", result: "allow", created_at: 100, ...row } as never)
  )
}

function asCaller(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ tokenIdentifier: "token_caller" })
}

describe("auditEvents.listForWorkspace (§6.11)", () => {
  test("another tenant's audit history is refused, and refused the same way a missing id is", async () => {
    const t = convexTest(schema, modules)
    const { victimId, workspaceVictimId } = await seedTenants(t)
    await insertAudit(t, { user_id: victimId, workspace_id: workspaceVictimId, reason: "victim private reason", created_at: 300 })

    // Identical message for "no such workspace" and "not yours": distinguishing
    // them would turn the reader into the id-enumeration oracle the WRITE path
    // deliberately avoided becoming.
    await expect(asCaller(t).query(api.auditEvents.listForWorkspace, { workspace_id: "ws_victim" } as never))
      .rejects.toThrow("Workspace not found")
    await expect(asCaller(t).query(api.auditEvents.listForWorkspace, { workspace_id: "ws_does_not_exist" } as never))
      .rejects.toThrow("Workspace not found")
  })

  test("read access is not enough — the bar is workspace admin", async () => {
    // A viewer can legitimately open the workspace. Audit history is the
    // record of what every OTHER member did in it, so it sits at the admin bar.
    const t = convexTest(schema, modules)
    const { victimId, workspaceVictimId } = await seedTenants(t)
    await insertAudit(t, { user_id: victimId, workspace_id: workspaceVictimId, reason: "victim private reason", created_at: 300 })
    await t.run(async (ctx) => {
      const caller = (await ctx.db
        .query("users")
        .withIndex("by_token_identifier", (q) => q.eq("token_identifier", "token_caller"))
        .unique())!
      await ctx.db.insert(
        "workspace_share_grants",
        { workspace_id: workspaceVictimId, granted_to_user_id: caller._id, role: "viewer", created_by_user_id: victimId, created_at: 1 } as never,
      )
    })

    await expect(asCaller(t).query(api.auditEvents.listForWorkspace, { workspace_id: "ws_victim" } as never))
      .rejects.toThrow("Workspace not found")
  })

  test("an admin share sees that workspace's rows, and only that workspace's", async () => {
    const t = convexTest(schema, modules)
    const { callerId, victimId, workspaceVictimId, workspaceCallerId } = await seedTenants(t)
    const victimAuditId = await insertAudit(t, { user_id: victimId, workspace_id: workspaceVictimId, reason: "victim private reason", created_at: 300 })
    await insertAudit(t, { user_id: callerId, workspace_id: workspaceCallerId })
    // Unattributed: belongs to its author, never to a workspace view.
    await insertAudit(t, { user_id: callerId, metadata: { unattributed_workspace_id: "ws_victim" } })
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "workspace_share_grants",
        { workspace_id: workspaceVictimId, granted_to_user_id: callerId, role: "admin", created_by_user_id: victimId, created_at: 1 } as never,
      )
    })

    const rows = await asCaller(t).query(api.auditEvents.listForWorkspace, { workspace_id: "ws_victim" } as never) as Array<Record<string, unknown>>
    expect(rows.map((row) => row.id)).toEqual([String(victimAuditId)])
    expect(rows[0]).toMatchObject({ workspace_id: "ws_victim", reason: "victim private reason" })
  })

  test("a forged attribution claim in metadata is never surfaced as attribution", async () => {
    // The caller owns `ws_caller` and can write whatever metadata it likes.
    // Planting the reserved key must not make the row look like a real
    // attempted-attribution record to any reader.
    const t = convexTest(schema, modules)
    const { callerId, workspaceCallerId } = await seedTenants(t)
    await insertAudit(t, {
      user_id: callerId,
      workspace_id: workspaceCallerId,
      metadata: { unattributed_workspace_id: "ws_victim", note: "kept" },
    })

    const rows = await asCaller(t).query(api.auditEvents.listForWorkspace, { workspace_id: "ws_caller" } as never) as Array<Record<string, unknown>>
    expect(rows[0]!.unverified_attempted_workspace_id).toBeUndefined()
    expect(rows[0]!.metadata).toEqual({ note: "kept" })
  })

  test("newest first, and the limit is clamped rather than trusted", async () => {
    const t = convexTest(schema, modules)
    const { callerId, workspaceCallerId } = await seedTenants(t)
    const oldId = await insertAudit(t, { user_id: callerId, workspace_id: workspaceCallerId, created_at: 1 })
    const newId = await insertAudit(t, { user_id: callerId, workspace_id: workspaceCallerId, created_at: 9 })

    const rows = await asCaller(t).query(api.auditEvents.listForWorkspace, {
      workspace_id: "ws_caller",
      limit: 100_000,
    } as never) as Array<Record<string, unknown>>
    expect(rows.map((row) => row.id)).toEqual([String(newId), String(oldId)])

    const page = await asCaller(t).query(api.auditEvents.listForWorkspace, {
      workspace_id: "ws_caller",
      limit: 1,
      before: 9,
    } as never) as Array<Record<string, unknown>>
    expect(page.map((row) => row.id)).toEqual([String(oldId)])
  })
})

describe("auditEvents.listMine — the only reader of unattributed rows (§6.11)", () => {
  test("an unattributed row reaches its author, with the claim labelled unverified", async () => {
    // Written exactly the way the guarded write path writes one.
    const t = convexTest(schema, modules)
    await seedTenants(t)
    await asCaller(t).mutation(api.auditEvents.record, {
      action: "workspaces.open.denied",
      result: "deny",
      workspace_id: "ws_victim",
      metadata: { attempt: 1 },
    } as never)
    const written = await t.run(async (ctx) => (await ctx.db.query("audit_events").collect())[0]!)
    expect(written.workspace_id).toBeUndefined()

    const rows = await asCaller(t).query(api.auditEvents.listMine, {} as never) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    // Not `workspace_id`: the reader must never present an unverified claim
    // in the field a UI would treat as real attribution.
    expect(rows[0]!.workspace_id).toBeUndefined()
    expect(rows[0]).toMatchObject({
      unverified_attempted_workspace_id: "ws_victim",
      metadata: { attempt: 1 },
    })
  })

  test("it returns only the caller's own rows", async () => {
    const t = convexTest(schema, modules)
    const { callerId, victimId, workspaceVictimId, workspaceCallerId } = await seedTenants(t)
    await insertAudit(t, { user_id: victimId, workspace_id: workspaceVictimId, reason: "victim private reason", created_at: 300 })
    await insertAudit(t, { user_id: victimId, metadata: { secret: true } })
    const mineId = await insertAudit(t, { user_id: callerId, workspace_id: workspaceCallerId })

    const rows = await asCaller(t).query(api.auditEvents.listMine, {} as never) as Array<Record<string, unknown>>
    expect(rows.map((row) => row.id)).toEqual([String(mineId)])
    expect(rows[0]!.workspace_id).toBe("ws_caller")
  })
})

describe("auditEvents.listForOrg — org authority, not a workspace share (§6.11 / §4.2)", () => {
  test("a workspace admin SHARE does not become an org-wide export", async () => {
    // The §4.2 escalation chain in reverse: an outsider handed admin over one
    // workspace passes `authorizeWorkspace(..., "admin")` with no org
    // membership at all. An org-wide read must not accept that.
    const t = convexTest(schema, modules)
    const { callerId, victimId, orgVictimId, workspaceVictimId } = await seedTenants(t)
    await insertAudit(t, { user_id: victimId, workspace_id: workspaceVictimId, reason: "victim private reason", created_at: 300 })
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "workspace_share_grants",
        { workspace_id: workspaceVictimId, granted_to_user_id: callerId, role: "admin", created_by_user_id: victimId, created_at: 1 } as never,
      )
    })

    await expect(asCaller(t).query(api.auditEvents.listForOrg, { org_id: orgVictimId } as never))
      .rejects.toThrow("Organization not found")
  })

  test("a plain org member is refused; an org admin gets that org's rows only", async () => {
    const member = convexTest(schema, modules)
    const memberFixture = await seedTenants(member)
    await insertAudit(member, { user_id: memberFixture.victimId, workspace_id: memberFixture.workspaceVictimId, reason: "victim private reason", created_at: 300 })
    await member.run(async (ctx) => {
      await ctx.db.insert("org_memberships", stamped({ org_id: memberFixture.orgVictimId, user_id: memberFixture.callerId, role: "member" }) as never)
    })
    await expect(asCaller(member).query(api.auditEvents.listForOrg, { org_id: memberFixture.orgVictimId } as never))
      .rejects.toThrow("Organization not found")

    const admin = convexTest(schema, modules)
    const adminFixture = await seedTenants(admin)
    const victimAuditId = await insertAudit(admin, { user_id: adminFixture.victimId, workspace_id: adminFixture.workspaceVictimId, reason: "victim private reason", created_at: 300 })
    await insertAudit(admin, { user_id: adminFixture.callerId, workspace_id: adminFixture.workspaceCallerId })
    // Unattributed rows carry no verified org linkage, so they are absent
    // from an org export by construction — including this caller's own.
    await insertAudit(admin, { user_id: adminFixture.callerId, metadata: { unattributed_workspace_id: "x" } })
    await admin.run(async (ctx) => {
      await ctx.db.insert("org_memberships", stamped({ org_id: adminFixture.orgVictimId, user_id: adminFixture.callerId, role: "admin" }) as never)
    })

    const rows = await asCaller(admin).query(api.auditEvents.listForOrg, { org_id: adminFixture.orgVictimId } as never) as Array<Record<string, unknown>>
    expect(rows.map((row) => row.id)).toEqual([String(victimAuditId)])
  })

  test("a deleted org exports nothing", async () => {
    const t = convexTest(schema, modules)
    const { callerId, victimId, orgVictimId, workspaceVictimId } = await seedTenants(t)
    await insertAudit(t, { user_id: victimId, workspace_id: workspaceVictimId, reason: "victim private reason", created_at: 300 })
    await t.run(async (ctx) => {
      await ctx.db.patch(orgVictimId, { deleted_at: 5, owner_user_id: callerId })
    })

    await expect(asCaller(t).query(api.auditEvents.listForOrg, { org_id: orgVictimId } as never))
      .rejects.toThrow("Organization not found")
  })
})
