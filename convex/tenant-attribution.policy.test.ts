import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import { requireControlPlaneService } from "./model"
import schema from "./schema"
import { timingSafeEqualStrings } from "../packages/claxedo-server-core/src/platform/auth/web-crypto"

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
 * Pre-launch security review §4.1 and §4.4 — cross-tenant WRITE attribution.
 *
 * Both mutations exercised here take a caller-supplied public `workspace_id`,
 * and both are `authedMutation`s, which means they are reachable directly
 * through the public Convex SDK using the deployment URL that ships in the app
 * bundle as `VITE_CONVEX_URL`. Hardening the Worker HTTP routes in front of
 * them does not close either hole — these tests run through `convex-test`'s
 * real function pipeline, including the `authedMutation` wrapper, for exactly
 * that reason. The previous version of this suite lived in claxedo-server,
 * imported these modules across five directory levels, reached past the
 * builders into `_handler`, and drove a hand-written `db` double.
 *
 * Public workspace ids are `ws_${Date.now().toString(36)}`: a bare millisecond
 * timestamp with no random component, so "attacker guesses a victim's id" is
 * the assumed starting position throughout, not a stretch.
 */
async function seedVictimWorkspace(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const callerId = await ctx.db.insert("users", stamped({ token_identifier: "token_caller" }) as never)
    const victimId = await ctx.db.insert("users", stamped({ token_identifier: "token_victim" }) as never)
    const orgId = await ctx.db.insert("orgs", stamped({ name: "Victim Org", owner_user_id: victimId }) as never)
    const workspaceId = await ctx.db.insert(
      "workspaces",
      stamped({
        workspace_id: "ws_victim",
        owner_user_id: victimId,
        org_id: orgId,
        backing: "cloud-vm",
        access: "cloud",
        display_name: "victim cloud workspace",
        repo_url: "https://github.com/victim/private.git",
      }) as never,
    )
    return { callerId, victimId, orgId, workspaceId }
  })
}

async function seedOwnedWorkspace(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => {
    const callerId = await ctx.db.insert("users", stamped({ token_identifier: "token_caller" }) as never)
    const orgId = await ctx.db.insert("orgs", stamped({ name: "Caller Org", owner_user_id: callerId }) as never)
    const workspaceId = await ctx.db.insert(
      "workspaces",
      stamped({
        workspace_id: "ws_victim",
        owner_user_id: callerId,
        org_id: orgId,
        backing: "cloud-vm",
        access: "cloud",
        display_name: "victim cloud workspace",
        repo_url: "https://github.com/victim/private.git",
        ...overrides,
      }) as never,
    )
    return { callerId, orgId, workspaceId }
  })
}

function asCaller(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ tokenIdentifier: "token_caller", subject: "caller_subject" })
}

describe("workspaces.createCloud existing-row guard (§4.1)", () => {
  test("a guessed id belonging to another tenant is refused and inserts nothing", async () => {
    const t = convexTest(schema, modules)
    await seedVictimWorkspace(t)
    const caller = asCaller(t)

    await expect(
      caller.mutation(api.workspaces.createCloud, {
        workspace_id: "ws_victim",
        display_name: "hijacked",
        repo_url: "https://github.com/attacker/evil.git",
      } as never),
    ).rejects.toThrow("Workspace not found")

    // The decisive assertion: no SECOND row carrying the victim's public id.
    // Two rows sharing one `workspace_id` permanently bricks the workspace for
    // everybody, because every lookup goes through `workspaceByPublicId` and
    // its `.unique()` throws the moment the id is ambiguous.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("workspaces").collect()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        display_name: "victim cloud workspace",
        repo_url: "https://github.com/victim/private.git",
        updated_at: 1,
      })
    })
  })

  test("an admin SHARE grant does not authorize writing through the create path", async () => {
    // Proves the guard is ownership-based, not merely `authorizeWorkspace`:
    // this caller genuinely holds workspace-admin via a legitimate share.
    const t = convexTest(schema, modules)
    const { callerId, victimId, workspaceId } = await seedVictimWorkspace(t)
    await t.run(async (ctx) => {
      await ctx.db.insert("workspace_share_grants", {
        workspace_id: workspaceId,
        granted_to_user_id: callerId,
        role: "admin",
        created_by_user_id: victimId,
        created_at: 1,
      } as never)
    })
    const caller = asCaller(t)

    await expect(
      caller.mutation(api.workspaces.createCloud, {
        workspace_id: "ws_victim",
        display_name: "hijacked",
      } as never),
    ).rejects.toThrow("Workspace not found")
    await t.run(async (ctx) => {
      expect(await ctx.db.query("workspaces").collect()).toHaveLength(1)
    })
  })

  test("the owner re-creating their own cloud workspace is an idempotent no-op", async () => {
    // The create-retry path: the caller reuses an id it already owns. It must
    // neither duplicate the row nor patch it from the retry's arguments.
    const t = convexTest(schema, modules)
    const { workspaceId } = await seedOwnedWorkspace(t)
    const caller = asCaller(t)

    await expect(
      caller.mutation(api.workspaces.createCloud, {
        workspace_id: "ws_victim",
        display_name: "renamed by retry",
      } as never),
    ).resolves.toEqual({ workspace_doc_id: workspaceId })

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("workspaces").collect()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ display_name: "victim cloud workspace", updated_at: 1 })
    })
  })

  test("the owner cannot flip their own user-hosted workspace to cloud", async () => {
    const t = convexTest(schema, modules)
    const { workspaceId } = await seedOwnedWorkspace(t, { backing: "local-worktree", access: "user-hosted" })
    const caller = asCaller(t)

    await expect(
      caller.mutation(api.workspaces.createCloud, {
        workspace_id: "ws_victim",
        display_name: "now cloud",
      } as never),
    ).rejects.toThrow("workspace_backing_conflict")
    await t.run(async (ctx) => {
      const row = await ctx.db.get(workspaceId)
      expect(row).toMatchObject({ backing: "local-worktree", access: "user-hosted", updated_at: 1 })
    })
  })

  test("a soft-deleted id is not recycled, even by its own owner", async () => {
    const t = convexTest(schema, modules)
    await seedOwnedWorkspace(t, { deleted_at: 5 })
    const caller = asCaller(t)

    await expect(
      caller.mutation(api.workspaces.createCloud, {
        workspace_id: "ws_victim",
        display_name: "resurrected",
      } as never),
    ).rejects.toThrow("Workspace not found")
    await t.run(async (ctx) => {
      expect(await ctx.db.query("workspaces").collect()).toHaveLength(1)
    })
  })

  test("an unused id still creates normally", async () => {
    const t = convexTest(schema, modules)
    const callerId = await t.run(async (ctx) =>
      ctx.db.insert("users", stamped({ token_identifier: "token_caller" }) as never),
    )
    const caller = asCaller(t)

    await expect(
      caller.mutation(api.workspaces.createCloud, {
        workspace_id: "ws_fresh",
        display_name: "mine",
      } as never),
    ).resolves.toMatchObject({ workspace_doc_id: expect.anything() })

    await t.run(async (ctx) => {
      const created = (await ctx.db.query("workspaces").collect()).find((row) => row.workspace_id === "ws_fresh")
      expect(created).toMatchObject({
        owner_user_id: callerId,
        backing: "cloud-vm",
        access: "cloud",
        display_name: "mine",
      })
    })
  })
})

describe("auditEvents.record workspace attribution (§4.4)", () => {
  test("a workspace the caller cannot read is never attributed", async () => {
    const t = convexTest(schema, modules)
    const { callerId } = await seedVictimWorkspace(t)
    const caller = asCaller(t)

    await caller.mutation(api.auditEvents.record, {
      action: "credentials.export",
      result: "allow",
      reason: "forged",
      workspace_id: "ws_victim",
      metadata: { note: "attacker supplied" },
    } as never)

    // `audit_events` is indexed `by_workspace_created`, so an unset
    // `workspace_id` is precisely what keeps this row out of the victim's log.
    await t.run(async (ctx) => {
      const [event] = await ctx.db.query("audit_events").collect()
      expect(event!.workspace_id).toBeUndefined()
      expect(event!.user_id).toBe(callerId)
      expect(event!.metadata).toEqual({
        note: "attacker supplied",
        unattributed_workspace_id: "ws_victim",
      })
    })
  })

  test("a workspace the caller can read is attributed as before", async () => {
    const t = convexTest(schema, modules)
    const { callerId, workspaceId } = await seedVictimWorkspace(t)
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "workspace_memberships",
        stamped({ workspace_id: workspaceId, user_id: callerId, role: "viewer" }) as never,
      )
    })
    const caller = asCaller(t)

    await caller.mutation(api.auditEvents.record, {
      action: "workspaces.open",
      result: "allow",
      workspace_id: "ws_victim",
      metadata: { host: "edge" },
    } as never)

    await t.run(async (ctx) => {
      const [event] = await ctx.db.query("audit_events").collect()
      expect(event).toMatchObject({
        user_id: callerId,
        workspace_id: workspaceId,
        action: "workspaces.open",
        metadata: { host: "edge" },
      })
    })
  })

  test("the denied-access audit write still succeeds — it must never throw", async () => {
    // Regression pin for the shape of the fix, not just its effect. The literal
    // `throw` the review proposed breaks `workspaceOpenAuthorizationError`
    // (packages/claxedo-server/src/routes/workspace-runtime-token-guards.ts),
    // which records `workspaces.open.denied` for a workspace whose
    // authorization JUST failed and awaits the write with no catch: a throw
    // turns a clean 403 into a 500 and loses the denial. An audit write
    // embedded in a request guard has to be total.
    const t = convexTest(schema, modules)
    const { callerId } = await seedVictimWorkspace(t)
    const caller = asCaller(t)

    await expect(
      caller.mutation(api.auditEvents.record, {
        action: "workspaces.open.denied",
        result: "deny",
        reason: "workspace_authorization_denied",
        workspace_id: "ws_victim",
      } as never),
    ).resolves.toBeDefined()

    await t.run(async (ctx) => {
      const [event] = await ctx.db.query("audit_events").collect()
      expect(event).toMatchObject({
        user_id: callerId,
        result: "deny",
        reason: "workspace_authorization_denied",
        metadata: { unattributed_workspace_id: "ws_victim" },
      })
      expect(event!.workspace_id).toBeUndefined()
    })
  })

  test("an unresolvable id is indistinguishable from an unauthorized one (no enumeration oracle)", async () => {
    const unauthorized = convexTest(schema, modules)
    await seedVictimWorkspace(unauthorized)
    const missing = convexTest(schema, modules)
    await seedVictimWorkspace(missing)

    await asCaller(unauthorized).mutation(api.auditEvents.record, {
      action: "probe",
      result: "deny",
      workspace_id: "ws_victim",
    } as never)
    await asCaller(missing).mutation(api.auditEvents.record, {
      action: "probe",
      result: "deny",
      workspace_id: "ws_does_not_exist",
    } as never)

    // Same outcome (success) and same row shape either way: the caller learns
    // nothing about whether the id exists. Rejecting only the unauthorized case
    // would have turned this mutation into an id oracle.
    for (const [t, expectedId] of [
      [unauthorized, "ws_victim"],
      [missing, "ws_does_not_exist"],
    ] as const) {
      await t.run(async (ctx) => {
        const events = await ctx.db.query("audit_events").collect()
        expect(events).toHaveLength(1)
        expect(events[0]!.workspace_id).toBeUndefined()
        expect(events[0]!.metadata).toEqual({ unattributed_workspace_id: expectedId })
      })
    }
  })

  test("an event with no workspace_id is unchanged", async () => {
    const t = convexTest(schema, modules)
    await seedVictimWorkspace(t)
    const caller = asCaller(t)

    await caller.mutation(api.auditEvents.record, {
      action: "session.start",
      result: "allow",
      metadata: { a: 1 },
    } as never)

    await t.run(async (ctx) => {
      const [event] = await ctx.db.query("audit_events").collect()
      expect(event).toMatchObject({ metadata: { a: 1 } })
      expect(event!.workspace_id).toBeUndefined()
    })
  })
})

describe("convex timingSafeEqual matches the server implementation", () => {
  const CURRENT = "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN"
  afterEach(() => delete process.env[CURRENT])

  const accepts = (token: string) => {
    try {
      requireControlPlaneService(token)
      return true
    } catch {
      return false
    }
  }

  test("no modulo-wraparound: the loop shape mirrors web-crypto.ts", () => {
    // Behaviour-preserving normalization, so only a source assertion can fail
    // without the fix. The point is drift: `convex/model.ts` cannot import from
    // packages/claxedo-server, so the two copies are kept aligned by review,
    // and `i % b.length` was a gratuitously different shape with a latent
    // `i % 0` NaN on an empty expected value.
    const source = fs.readFileSync(path.join(import.meta.dirname, "model.ts"), "utf8")
    const body = source.slice(source.indexOf("function timingSafeEqual("))
    const loop = body.slice(0, body.indexOf("return diff === 0"))
    expect(loop).not.toMatch(/%\s*b\.length/)
    expect(loop).toMatch(/Math\.max\(a\.length,\s*b\.length\)/)
  })

  test("agrees with timingSafeEqualStrings across the edge cases", () => {
    const secret = "token-current"
    process.env[CURRENT] = secret
    for (
      const candidate of [
        secret,
        "",
        "t",
        "token-curren",
        "token-currentt",
        "token-currenT",
        "\0".repeat(secret.length),
        "tokentokentok",
      ]
    ) {
      expect(accepts(candidate)).toBe(timingSafeEqualStrings(candidate, secret))
    }
  })
})
