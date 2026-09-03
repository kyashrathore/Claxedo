import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api, internal } from "./_generated/api"
import {
  finalizeOrgDeletion,
  ORG_CLERK_TABLES,
  ORG_DELETION_BATCH_SIZE,
  ORG_DIRECT_TABLES,
  ORG_PRIVATE_SESSION_CASCADE,
  ORG_PURGED_TABLES,
  ORG_RETAINED_TABLES,
  ORG_WORKSPACE_DOC_TABLES,
  ORG_WORKSPACE_PUBLIC_TABLES,
  prepareOrgDeletion,
  purgeDeletedOrgs,
  releaseOrgDeletion,
} from "./orgs"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

/**
 * Pre-launch security review §6.12 — `organization.deleted` must CASCADE.
 *
 * It used to flip `deleted_at` and stop, which revokes access while retaining
 * every workspace, session, message, audit row, WorkGraph record and usage fact
 * indefinitely. The tests that matter most here are the negative ones: a
 * destructive cascade with a wrong scoping predicate deletes another tenant's
 * data, so "the second org is untouched" is checked on every purged table, not
 * spot-checked.
 *
 * The previous version of this suite drove a hand-written `db` double that
 * validated nothing, so its per-table seeds carried only the one field each
 * plan entry scoped by. Against the real schema nearly every one of the ~40
 * cascade tables has several more REQUIRED fields (the WorkGraph tables alone
 * carry a dozen apiece). Rather than hand-transcribe every table's shape here
 * — 40-odd chances to typo a required field and mask real drift with a second,
 * independently-wrong fixture — `minimalRow` below reads the ACTUAL compiled
 * schema validator for a table at test time and fills in a schema-valid
 * placeholder for every field the plan didn't already specify. It only knows
 * how to satisfy `id(orgs)`, `id(users)` and `id(workspaces)` references (the
 * only referenced tables any required field in this cascade's footprint names,
 * confirmed by inspecting the schema directly), which is intentionally narrow
 * — anything requiring a different anchor throws rather than silently
 * fabricating a plausible-looking id.
 */

type Anchors = { orgId: unknown; userId: unknown; workspaceId: unknown }

function minimalValue(validator: any, anchors: Anchors): unknown {
  switch (validator.kind) {
    case "id": {
      if (validator.tableName === "orgs") return anchors.orgId
      if (validator.tableName === "users") return anchors.userId
      if (validator.tableName === "workspaces") return anchors.workspaceId
      throw new Error(`minimalRow: no anchor for id(${validator.tableName})`)
    }
    case "string":
      return ""
    case "float64":
    case "int64":
      return 0
    case "boolean":
      return false
    case "any":
      return null
    case "array":
      return []
    case "record":
      return {}
    case "object":
      return Object.fromEntries(Object.entries(validator.fields as Record<string, any>)
        .filter(([, field]) => field.isOptional !== "optional")
        .map(([name, field]) => [name, minimalValue(field, anchors)]))
    case "literal":
      return validator.value
    case "union":
      return minimalValue(validator.members[0], anchors)
    default:
      throw new Error(`minimalRow: unhandled validator kind "${validator.kind}"`)
  }
}

/**
 * Every non-optional field of `table` that `overrides` does not already supply,
 * filled from `anchors`.
 *
 * Overridden fields are skipped rather than computed-then-replaced: a caller
 * that passes `project_id` explicitly must not need `minimalValue` to invent an
 * `id(projects)` it would immediately discard. Computing first made the narrow
 * anchor set (orgs/users/workspaces) throw on tables whose only foreign key the
 * caller had already provided.
 */
function minimalRow(table: string, anchors: Anchors, overrides: Record<string, unknown> = {}) {
  const fields = (schema as any).tables[table].validator.fields as Record<string, any>
  const row: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(fields)) {
    if (spec.isOptional === "optional") continue
    if (name in overrides) continue
    row[name] = minimalValue(spec, anchors)
  }
  return { ...row, ...overrides }
}

type Tenant = { key: string; clerkOrgId: string; orgId: unknown; workspaceDocId: unknown; workspacePublicId: string }

const ORG_SESSION_CASCADE = { table: "session_history", index: "by_workspace_updated", field: "workspace_id",
  children: [{ table: "session_messages", index: "by_session_ordinal", field: "session_id", parentKey: "session_id" }] } as const
const ORG_PROJECT_CASCADE = { table: "projects", index: "by_org", field: "org_id",
  children: [{ table: "project_memberships", index: "by_project_user", field: "project_id", parentKey: "_id" }] } as const
const ORG_CONNECTION_CASCADE = { table: "workgraph_connection_metadata", index: "by_organization_connection", field: "organization_id",
  children: [{ table: "workgraph_webhook_deliveries", index: "by_delivery", field: "connection_id", parentKey: "connection_id" }] } as const

/**
 * Seeds one row in EVERY table the cascade enumerates, driven by the exported
 * plan constants (`ORG_DIRECT_TABLES` etc.) rather than a hand-written list —
 * so a table added to a plan is automatically covered by both the purge and
 * the isolation assertions below.
 */
async function seedTenant(ctx: any, key: string, ownerId: unknown, leaseStatus = "stopped"): Promise<Tenant> {
  const clerkOrgId = `clerk_org_${key}`
  const workspacePublicId = `ws_${key}`
  const orgId = await ctx.db.insert("orgs", minimalRow("orgs", { orgId: undefined, userId: ownerId, workspaceId: undefined },
    { clerk_org_id: clerkOrgId, kind: "clerk", name: key }))
  const anchors: Anchors = { orgId, userId: ownerId, workspaceId: undefined }
  const workspaceDocId = await ctx.db.insert("workspaces", minimalRow("workspaces", anchors, {
    org_id: orgId, workspace_id: workspacePublicId, owner_user_id: ownerId,
    backing: "local-worktree", access: "user-hosted", display_name: key,
  }))
  const full: Anchors = { orgId, userId: ownerId, workspaceId: workspaceDocId }

  for (const plan of ORG_DIRECT_TABLES) {
    await ctx.db.insert(plan.table, minimalRow(plan.table, full, { [plan.field]: orgId }))
  }
  for (const plan of ORG_CLERK_TABLES) {
    await ctx.db.insert(plan.table, minimalRow(plan.table, full, { [plan.field]: clerkOrgId }))
  }
  for (const plan of ORG_WORKSPACE_DOC_TABLES) {
    await ctx.db.insert(plan.table, minimalRow(plan.table, full, { [plan.field]: workspaceDocId }))
  }
  for (const plan of ORG_WORKSPACE_PUBLIC_TABLES) {
    await ctx.db.insert(plan.table, minimalRow(plan.table, full, {
      [plan.field]: workspacePublicId,
      ...(plan.table === "runtime_leases" ? { status: leaseStatus, epoch: 1 } : {}),
    }))
  }

  // Parent/child cascades: the child is only reachable through its parent.
  const sessionId = `session_${key}`
  await ctx.db.insert("session_history", minimalRow("session_history", full, { workspace_id: workspaceDocId, session_id: sessionId }))
  await ctx.db.insert("session_messages", minimalRow("session_messages", full, { session_id: sessionId, workspace_id: workspaceDocId, ordinal: 1 }))
  const privateSessionId = `private_session_${key}`
  await ctx.db.insert("private_sessions", minimalRow("private_sessions", full, {
    session_id: privateSessionId,
    workspace_id: workspaceDocId,
    workspace_public_id: workspacePublicId,
    creator_actor_id: ownerId,
    operation_id: `private_operation_${key}`,
    max_event_ordinal: 1,
  }))
  for (const child of ORG_PRIVATE_SESSION_CASCADE.children) {
    await ctx.db.insert(child.table, minimalRow(child.table, full, {
      [child.field]: privateSessionId,
      workspace_id: workspaceDocId,
    }))
  }
  const projectId = await ctx.db.insert("projects", minimalRow("projects", full, { org_id: orgId }))
  await ctx.db.insert("project_memberships", minimalRow("project_memberships", full, { project_id: projectId, user_id: ownerId }))
  const connectionId = `connection_${key}`
  await ctx.db.insert("workgraph_connection_metadata", minimalRow("workgraph_connection_metadata", full, { organization_id: orgId, connection_id: connectionId }))
  await ctx.db.insert("workgraph_webhook_deliveries", minimalRow("workgraph_webhook_deliveries", full, { connection_id: connectionId, provider: "github", delivery_id: `delivery_${key}` }))

  return { key, clerkOrgId, orgId, workspaceDocId, workspacePublicId }
}

async function scopedRows(ctx: any, plan: { table: string; index: string; field: string }, value: unknown) {
  return ctx.db.query(plan.table).withIndex(plan.index, (q: any) => q.eq(plan.field, value)).collect()
}

async function cascadeRows(
  ctx: any,
  cascade: { table: string; index: string; field: string; children: readonly { table: string; index: string; field: string; parentKey: string }[] },
  value: unknown,
) {
  const parents = await scopedRows(ctx, cascade, value)
  const rows: any[] = [...parents]
  for (const parent of parents) {
    for (const child of cascade.children) {
      rows.push(...await scopedRows(ctx, child, parent[child.parentKey]))
    }
  }
  return rows
}

/** Every row this cascade would enumerate for one tenant — mirrors `deleteOrgRecordBatch`'s own traversal. */
async function tenantRows(ctx: any, item: Tenant) {
  const rows: any[] = []
  for (const plan of ORG_DIRECT_TABLES) rows.push(...await scopedRows(ctx, plan, item.orgId))
  for (const plan of ORG_CLERK_TABLES) rows.push(...await scopedRows(ctx, plan, item.clerkOrgId))
  for (const plan of ORG_WORKSPACE_DOC_TABLES) rows.push(...await scopedRows(ctx, plan, item.workspaceDocId))
  for (const plan of ORG_WORKSPACE_PUBLIC_TABLES) rows.push(...await scopedRows(ctx, plan, item.workspacePublicId))
  rows.push(...await cascadeRows(ctx, ORG_SESSION_CASCADE, item.workspaceDocId))
  rows.push(...await cascadeRows(ctx, ORG_PRIVATE_SESSION_CASCADE, item.workspaceDocId))
  rows.push(...await cascadeRows(ctx, ORG_PROJECT_CASCADE, item.orgId))
  rows.push(...await cascadeRows(ctx, ORG_CONNECTION_CASCADE, item.orgId))
  const workspace = await ctx.db.get(item.workspaceDocId)
  if (workspace) rows.push(workspace)
  const org = await ctx.db.get(item.orgId)
  if (org) rows.push(org)
  return rows
}

async function store(t: ReturnType<typeof convexTest>, options: { leaseStatus?: string; purgeRequestedAt?: number; deletedAt?: number } = {}) {
  return t.run(async (ctx: any) => {
    const ownerId = await ctx.db.insert("users", minimalRow("users", { orgId: undefined, userId: undefined, workspaceId: undefined }, { token_identifier: "owner_token" }))
    const target = await seedTenant(ctx, "target", ownerId, options.leaseStatus)
    const other = await seedTenant(ctx, "other", ownerId)
    await ctx.db.patch(target.orgId, {
      deleted_at: options.deletedAt ?? 1_000,
      purge_requested_at: options.purgeRequestedAt ?? 1_000,
    })
    return { ownerId, target, other }
  })
}

/** Drives prepare + finalize to completion, returning how many batches it took. */
async function purge(t: ReturnType<typeof convexTest>, target: Tenant, now = 2_000) {
  const prepared = await t.run((ctx: any) => prepareOrgDeletion(ctx, target.orgId, target.clerkOrgId, "operation_1", now)) as any
  if (!prepared.ok) return { prepared, batches: 0 }
  let batches = 0
  for (;;) {
    batches += 1
    if (batches > 500) throw new Error("purge did not converge")
    const finalized = await t.run((ctx: any) =>
      finalizeOrgDeletion(ctx, target.orgId, target.clerkOrgId, "operation_1", prepared.scopeHash, now)) as any
    if (!finalized.ok) return { prepared, finalized, batches }
    if (finalized.result) return { prepared, finalized, batches }
  }
}

/**
 * Org deletion cascade (`convex/orgs.ts`, §6.12).
 *
 * Runs against the real function pipeline via `convex-test`. The previous
 * version of this suite lived in claxedo-server, imported `orgs.ts` across
 * five directory levels, reached past the builders into `_handler` for the
 * cron/webhook entrypoints, and drove a hand-written `db` double for
 * everything else — so it exercised the plain deletion functions directly
 * (which this suite still does, deliberately: see below) while skipping the
 * auth wrappers around the entrypoints that make them safe.
 *
 * `prepareOrgDeletion` / `finalizeOrgDeletion` / `releaseOrgDeletion` are
 * plain exported functions taking a bare `ctx`, not Convex function objects —
 * they are called directly here too, via `t.run`, exactly as the old test
 * called them directly against its double. Each `t.run` is its own
 * transaction, which is the correct analog: in production these are invoked
 * from inside a `serviceMutation` handler, one call per client round-trip.
 * The entrypoint wrappers themselves (`prepareDeletionForService`,
 * `applyClerkWebhook`, `purgeDeletedOrgs`) are exercised through the real
 * `api.*` / `internal.*` pipeline in their own tests below.
 */
describe("org deletion cascade — coverage of the schema (§6.12)", () => {
  test("every table in the schema is either purged or explicitly retained", () => {
    // A table nobody classified is retained personal data by accident. This is
    // the check that makes "we enumerated them all" a property of the tree
    // rather than a claim in a commit message.
    const source = fs.readFileSync(path.join(import.meta.dirname, "schema.ts"), "utf8")
    const tables = [...source.matchAll(/^ {2}(\w+): defineTable\(/gm)].map((match) => match[1]!)
    expect(tables.length).toBeGreaterThan(50)

    const classified = new Set([...ORG_PURGED_TABLES, ...Object.keys(ORG_RETAINED_TABLES)])
    expect(tables.filter((table) => !classified.has(table))).toEqual([])
    // And nothing is claimed on both sides.
    expect(ORG_PURGED_TABLES.filter((table) => table in ORG_RETAINED_TABLES)).toEqual([])
  })

  test("the WorkGraph half is imported, not re-listed", async () => {
    const { WORKGRAPH_OWNER_TABLES } = await import("./workgraphOwnerDeletion")
    // The tenancy-migration quarantine is the one deliberate exception: its
    // organization is ambiguous by construction and it has no by_tenant index,
    // so the org cascade retains it while the per-owner purge (which scopes it
    // by_owner exactly) still deletes it.
    for (const table of WORKGRAPH_OWNER_TABLES.filter((name) => name !== "workgraph_tenancy_migration_quarantine")) {
      expect(ORG_PURGED_TABLES).toContain(table)
    }
    expect(ORG_PURGED_TABLES).not.toContain("workgraph_tenancy_migration_quarantine")
    // Org+owner scoped, so the per-owner purge owns it and the org cascade
    // inherits it. A second copy here would be exactly the list that rots.
    expect(WORKGRAPH_OWNER_TABLES as readonly string[]).toContain("workgraph_master_mailbox")
    expect(ORG_PURGED_TABLES.filter((table) => table === "workgraph_master_mailbox"))
      .toEqual(["workgraph_master_mailbox"])
  })
})

describe("org deletion cascade — the purge (§6.12)", () => {
  test("every enumerated table is emptied for the target org", async () => {
    const t = convexTest(schema, modules)
    const { target } = await store(t)
    const before = await t.run((ctx: any) => tenantRows(ctx, target))
    expect(before.length).toBeGreaterThan(50)

    const { finalized } = await purge(t, target)
    expect(finalized.ok).toBe(true)
    expect(finalized.result).toMatchObject({ deleted: true })

    expect(await t.run((ctx: any) => tenantRows(ctx, target))).toEqual([])
    // The org row itself goes last, and it goes.
    expect(await t.run((ctx: any) => ctx.db.get(target.orgId))).toBeNull()
  })

  test("a second org's rows are untouched — the predicate cannot bleed", async () => {
    const t = convexTest(schema, modules)
    const { target, other } = await store(t)
    const before = await t.run((ctx: any) => tenantRows(ctx, other))

    await purge(t, target)

    expect(await t.run((ctx: any) => tenantRows(ctx, other))).toHaveLength(before.length)
    expect(await t.run((ctx: any) => ctx.db.get(other.orgId))).not.toBeNull()
  })

  test("it is batched and resumes across invocations", async () => {
    const t = convexTest(schema, modules)
    const { target } = await store(t)
    // More rows than one batch by a wide margin, so completion in one call
    // would mean the budget is not being enforced at all.
    const before = await t.run((ctx: any) => tenantRows(ctx, target))
    expect(before.length).toBeGreaterThan(ORG_DELETION_BATCH_SIZE * 3)

    const { batches } = await purge(t, target)
    expect(batches).toBeGreaterThan(3)
    expect(await t.run((ctx: any) => tenantRows(ctx, target))).toEqual([])
  })

  test("a child is never stranded: sessions outlive their messages", async () => {
    // `session_messages` is only reachable through `session_history`
    // (`by_session_ordinal` is its only scoping index), so a batch boundary
    // that removed the session first would orphan the transcript forever.
    const t = convexTest(schema, modules)
    const { target, other } = await store(t)
    const targetSessionId = `session_${target.key}`
    const otherSessionId = `session_${other.key}`
    const prepared = await t.run((ctx: any) => prepareOrgDeletion(ctx, target.orgId, target.clerkOrgId, "operation_1", 2_000)) as any
    for (let index = 0; index < 200; index += 1) {
      const { sessions, messages } = await t.run(async (ctx: any) => ({
        sessions: await ctx.db.query("session_history").withIndex("by_workspace_updated", (q: any) => q.eq("workspace_id", target.workspaceDocId)).collect(),
        messages: await ctx.db.query("session_messages").withIndex("by_session_ordinal", (q: any) => q.eq("session_id", targetSessionId)).collect(),
      }))
      if (sessions.length === 0) expect(messages).toEqual([])
      const finalized = await t.run((ctx: any) =>
        finalizeOrgDeletion(ctx, target.orgId, target.clerkOrgId, "operation_1", prepared.scopeHash, 2_000)) as any
      if (finalized.result) break
    }
    const remainingTargetMessages = await t.run((ctx: any) =>
      ctx.db.query("session_messages").withIndex("by_session_ordinal", (q: any) => q.eq("session_id", targetSessionId)).collect())
    expect(remainingTargetMessages).toEqual([])
    const remainingOtherMessages = await t.run((ctx: any) =>
      ctx.db.query("session_messages").withIndex("by_session_ordinal", (q: any) => q.eq("session_id", otherSessionId)).collect())
    expect(remainingOtherMessages).toHaveLength(1)
  })

  test("finishing twice is a no-op that replays the receipt", async () => {
    const t = convexTest(schema, modules)
    const { target } = await store(t)
    const { finalized } = await purge(t, target)
    const again = await t.run((ctx: any) =>
      finalizeOrgDeletion(ctx, target.orgId, target.clerkOrgId, "operation_1", "any", 3_000)) as any
    // The org row is gone, so there is nothing left to re-purge.
    expect(again).toEqual({ ok: false, reason: "org_not_found" })
    expect(finalized.result.recordCount).toBeGreaterThan(50)
  })
})

describe("org deletion cascade — refusing to fire (§6.12)", () => {
  const cases: Array<[string, (target: Tenant) => Record<string, unknown>, (target: Tenant) => string, string]> = [
    ["without a purge request", () => ({ purge_requested_at: undefined }), (target) => target.clerkOrgId, "purge_not_requested"],
    ["without deleted_at", () => ({ deleted_at: undefined }), (target) => target.clerkOrgId, "org_not_deleted"],
    ["on a wrong confirmation", () => ({}), () => "clerk_org_typo", "confirmation_mismatch"],
    ["on a personal org", () => ({ clerk_org_id: undefined }), (target) => target.clerkOrgId, "not_a_clerk_org"],
  ]

  for (const [name, patch, confirmation, reason] of cases) {
    test(`refuses ${name}`, async () => {
      const t = convexTest(schema, modules)
      const { target } = await store(t)
      await t.run((ctx: any) => ctx.db.patch(target.orgId, patch(target)))
      const before = await t.run((ctx: any) => tenantRows(ctx, target))

      const prepared = await t.run((ctx: any) => prepareOrgDeletion(ctx, target.orgId, confirmation(target), "operation_1", 2_000)) as any

      expect(prepared).toEqual({ ok: false, reason })
      // The decisive part: a refusal deletes nothing.
      expect(await t.run((ctx: any) => tenantRows(ctx, target))).toHaveLength(before.length)
    })
  }

  test("refuses while a sandbox is live", async () => {
    const t = convexTest(schema, modules)
    const { target } = await store(t, { leaseStatus: "ready" })
    const before = await t.run((ctx: any) => tenantRows(ctx, target))

    const prepared = await t.run((ctx: any) => prepareOrgDeletion(ctx, target.orgId, target.clerkOrgId, "operation_1", 2_000)) as any

    expect(prepared).toEqual({ ok: false, reason: "not_quiescent" })
    expect(await t.run((ctx: any) => tenantRows(ctx, target))).toHaveLength(before.length)
  })

  test("a live WorkGraph owner deletion blocks the org purge", async () => {
    const t = convexTest(schema, modules)
    const { target, ownerId } = await store(t)
    await t.run((ctx: any) => ctx.db.insert("workgraph_owner_deletion_barriers", {
      organization_id: target.orgId,
      owner_user_id: ownerId,
      operation_hash: "other_operation",
      lease_expires_at: 9_000,
      created_at: 1,
      updated_at: 1,
    }))

    const prepared = await t.run((ctx: any) => prepareOrgDeletion(ctx, target.orgId, target.clerkOrgId, "op", 2_000)) as any
    expect(prepared).toEqual({ ok: false, reason: "not_quiescent" })
  })

  test("a second operation cannot steal a live barrier, and release frees it", async () => {
    const t = convexTest(schema, modules)
    const { target } = await store(t)
    const first = await t.run((ctx: any) => prepareOrgDeletion(ctx, target.orgId, target.clerkOrgId, "operation_1", 2_000)) as any
    expect(first.state).toBe("acquired")

    const second = await t.run((ctx: any) => prepareOrgDeletion(ctx, target.orgId, target.clerkOrgId, "operation_2", 2_000)) as any
    expect(second).toMatchObject({ ok: true, state: "in_progress" })
    // A finalize for the loser must not delete anything.
    const stolen = await t.run((ctx: any) =>
      finalizeOrgDeletion(ctx, target.orgId, target.clerkOrgId, "operation_2", first.scopeHash, 2_000)) as any
    expect(stolen).toEqual({ ok: false, reason: "in_progress" })
    expect((await t.run((ctx: any) => tenantRows(ctx, target))).length).toBeGreaterThan(50)

    await t.run((ctx: any) => releaseOrgDeletion(ctx, target.orgId, "operation_1"))
    expect(await t.run((ctx: any) => ctx.db.query("org_deletion_barriers").collect())).toEqual([])
    const third = await t.run((ctx: any) => prepareOrgDeletion(ctx, target.orgId, target.clerkOrgId, "operation_2", 2_000)) as any
    expect(third.state).toBe("acquired")
  })

  test("the service entrypoint is service-token gated", async () => {
    const previous = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
    try {
      const t = convexTest(schema, modules)
      const { target } = await store(t)
      await expect(t.mutation(api.orgs.prepareDeletionForService, {
        service_token: "wrong",
        org_id: target.orgId,
        confirm_clerk_org_id: target.clerkOrgId,
        operation_id: "operation_1",
        now: 2_000,
      } as never)).rejects.toThrow("Unauthenticated")
      expect((await t.run((ctx: any) => tenantRows(ctx, target))).length).toBeGreaterThan(50)
    } finally {
      if (previous === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previous
    }
  })

  // The happy path for the gate proven above: a correct token reaches
  // `prepareOrgDeletion` and acquires the barrier through the real
  // `serviceMutation`-wrapped entrypoint.
  test("prepareDeletionForService delegates to prepareOrgDeletion with a valid token", async () => {
    const previous = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
    try {
      const t = convexTest(schema, modules)
      const { target } = await store(t)
      const result = await t.mutation(api.orgs.prepareDeletionForService, {
        service_token: "svc_secret",
        org_id: target.orgId,
        confirm_clerk_org_id: target.clerkOrgId,
        operation_id: "operation_1",
        now: 2_000,
      } as never) as any
      expect(result).toMatchObject({ ok: true, state: "acquired" })
    } finally {
      if (previous === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previous
    }
  })
})

describe("org deletion cascade — the trigger (§6.12)", () => {
  test("organization.deleted records a purge REQUEST rather than purging", async () => {
    const t = convexTest(schema, modules)
    const { target } = await store(t)
    await t.run((ctx: any) => ctx.db.patch(target.orgId, { deleted_at: undefined, purge_requested_at: undefined }))
    const before = await t.run((ctx: any) => tenantRows(ctx, target))

    await t.mutation(internal.orgs.applyClerkWebhook, {
      type: "organization.deleted",
      data: { id: target.clerkOrgId },
    } as never)

    const org = await t.run((ctx: any) => ctx.db.get(target.orgId)) as any
    expect(typeof org.deleted_at).toBe("number")
    expect(typeof org.purge_requested_at).toBe("number")
    // A Svix delivery must not start an irreversible multi-transaction purge.
    expect(await t.run((ctx: any) => tenantRows(ctx, target))).toHaveLength(before.length)
  })

  test("re-creating the org inside the grace window cancels the purge", async () => {
    const t = convexTest(schema, modules)
    const { target } = await store(t)

    await t.mutation(internal.orgs.applyClerkWebhook, {
      type: "organization.created",
      data: { id: target.clerkOrgId, name: "restored", updated_at: 5_000 },
    } as never)

    const org = await t.run((ctx: any) => ctx.db.get(target.orgId)) as any
    expect(org.deleted_at).toBeUndefined()
    expect(org.purge_requested_at).toBeUndefined()

    const swept = await t.mutation(internal.orgs.purgeDeletedOrgs, { retain_ms: 0, now: 9_000 } as never) as any
    expect(swept).toMatchObject({ due: 0, state: "idle" })
    expect((await t.run((ctx: any) => tenantRows(ctx, target))).length).toBeGreaterThan(50)
  })

  test("the cron waits out the grace window, then purges exactly one org per tick", async () => {
    const t = convexTest(schema, modules)
    const { target, other } = await store(t, { purgeRequestedAt: 1_000 })
    // Both orgs are deleted and both requests are old enough, so the ONE-org
    // bound is what keeps the second one alive rather than a filter accident.
    await t.run((ctx: any) => ctx.db.patch(other.orgId, { deleted_at: 2_000, purge_requested_at: 2_000 }))

    const early = await t.mutation(internal.orgs.purgeDeletedOrgs, {
      retain_ms: 7 * 24 * 60 * 60 * 1000,
      now: 2_000,
    } as never) as any
    expect(early).toMatchObject({ due: 0, state: "idle" })
    expect((await t.run((ctx: any) => tenantRows(ctx, target))).length).toBeGreaterThan(50)

    const now = 1_000 + 8 * 24 * 60 * 60 * 1000
    const swept = await t.mutation(internal.orgs.purgeDeletedOrgs, {
      retain_ms: 7 * 24 * 60 * 60 * 1000,
      batch_limit: 4_096,
      now,
    } as never) as any
    // Oldest request first, and only that one.
    expect(swept).toMatchObject({ due: 2, state: "completed" })
    expect(await t.run((ctx: any) => tenantRows(ctx, target))).toEqual([])
    expect((await t.run((ctx: any) => tenantRows(ctx, other))).length).toBeGreaterThan(50)
  })

  test("the cron resumes its own operation across ticks", async () => {
    const t = convexTest(schema, modules)
    const { target, other } = await store(t)
    const now = 1_000 + 8 * 24 * 60 * 60 * 1000
    // A single batch per tick: enough to prove ticks compose rather than
    // restarting, and that a partial tick never leaves the org half-purged in a
    // way the next tick cannot pick up.
    let ticks = 0
    for (;;) {
      ticks += 1
      if (ticks > 500) throw new Error("cron did not converge")
      const swept = await t.mutation(internal.orgs.purgeDeletedOrgs, {
        retain_ms: 7 * 24 * 60 * 60 * 1000,
        batch_limit: ORG_DELETION_BATCH_SIZE,
        now,
      } as never) as any
      if (swept.state === "completed") break
      expect(swept.state).toBe("deleting")
    }
    expect(ticks).toBeGreaterThan(3)
    expect(await t.run((ctx: any) => tenantRows(ctx, target))).toEqual([])
    expect((await t.run((ctx: any) => tenantRows(ctx, other))).length).toBeGreaterThan(50)
  })
})
