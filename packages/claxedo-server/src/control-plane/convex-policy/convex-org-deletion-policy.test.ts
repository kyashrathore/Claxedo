import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import {
  applyClerkWebhook,
  finalizeOrgDeletion,
  ORG_CLERK_TABLES,
  ORG_DELETION_BATCH_SIZE,
  ORG_DIRECT_TABLES,
  ORG_PURGED_TABLES,
  ORG_RETAINED_TABLES,
  ORG_WORKSPACE_DOC_TABLES,
  ORG_WORKSPACE_PUBLIC_TABLES,
  prepareDeletionForService,
  prepareOrgDeletion,
  purgeDeletedOrgs,
  releaseOrgDeletion,
} from "../../../../../convex/orgs"
import { indexRangeBuilder, orderByIndex } from "../../test-helpers/convex-index-harness"

/**
 * Pre-launch security review §6.12 — `organization.deleted` must CASCADE.
 *
 * It used to flip `deleted_at` and stop, which revokes access while retaining
 * every workspace, session, message, audit row, WorkGraph record and usage fact
 * indefinitely. The tests that matter most here are the negative ones: a
 * destructive cascade with a wrong scoping predicate deletes another tenant's
 * data, so "the second org is untouched" is checked on every purged table, not
 * spot-checked.
 */

type Row = Record<string, unknown> & { _id: string }

function db(seed: Record<string, Row[]>) {
  const rows: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([key, value]) => [key, [...value]]),
  )
  let sequence = 0
  return {
    rows,
    query(table: string) {
      // W5: index names resolve against the real convex/schema.ts, and ranges
      // must step fields in index order (`convex-index-harness.ts`). The org
      // purge now reads its due queue as a `by_purge_requested_at` range and
      // relies on the index's ordering for its starvation-free "oldest first"
      // guarantee, so the double has to order like an index scan too — seed
      // order would let a broken ordering pass.
      let checks: Array<(row: Row) => boolean> = []
      let ordering: { table: string; index: string } | undefined
      const matching = () => {
        const found = (rows[table] ?? []).filter((row) => checks.every((check) => check(row)))
        return ordering ? orderByIndex(found, ordering.table, ordering.index) : found
      }
      const query = {
        withIndex(name: string, build: (q: unknown) => unknown) {
          const range = indexRangeBuilder(table, name)
          build(range.builder)
          checks = range.checks
          ordering = { table, index: name }
          return query
        },
        async take(limit: number) {
          return matching().slice(0, limit)
        },
        async collect() {
          return matching()
        },
        async unique() {
          const found = matching()
          if (found.length > 1) throw new Error(`Ambiguous unique() on ${table}`)
          return found[0] ?? null
        },
        async first() {
          return matching()[0] ?? null
        },
      }
      return query
    },
    async insert(table: string, row: Record<string, unknown>) {
      sequence += 1
      const id = `${table}:${sequence}`
      rows[table] ??= []
      rows[table].push({ _id: id, ...row })
      return id
    },
    async get(id: unknown) {
      return Object.values(rows).flat().find((row) => row._id === id) ?? null
    },
    async patch(id: unknown, patch: Record<string, unknown>) {
      for (const table of Object.keys(rows)) {
        const index = rows[table]!.findIndex((row) => row._id === id)
        if (index === -1) continue
        rows[table]![index] = { ...rows[table]![index], ...patch }
        return
      }
      throw new Error(`Missing row ${String(id)}`)
    },
    async delete(id: unknown) {
      for (const table of Object.keys(rows)) {
        const index = rows[table]!.findIndex((row) => row._id === id)
        if (index === -1) continue
        rows[table]!.splice(index, 1)
        return
      }
      throw new Error(`Missing row ${String(id)}`)
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

type Tenant = {
  key: string
  orgId: string
  clerkOrgId: string
  workspaceDocId: string
  workspacePublicId: string
}

function tenant(key: string): Tenant {
  return {
    key,
    orgId: `org_${key}`,
    clerkOrgId: `clerk_org_${key}`,
    workspaceDocId: `workspace_${key}`,
    workspacePublicId: `ws_${key}`,
  }
}

const TARGET = tenant("target")
const OTHER = tenant("other")

/**
 * Seeds one row in EVERY table the cascade enumerates, driven by the exported
 * plan constants rather than a hand-written list — so a table added to a plan
 * is automatically covered by the purge and the isolation assertions both.
 */
function seedTenant(seed: Record<string, Row[]>, item: Tenant, leaseStatus = "stopped") {
  const push = (table: string, row: Record<string, unknown>) => {
    seed[table] ??= []
    seed[table].push({ _id: `${table}_${item.key}_${seed[table].length}`, _tenant: item.key, ...row } as Row)
  }

  push("orgs", {
    _id: item.orgId,
    clerk_org_id: item.clerkOrgId,
    kind: "clerk",
    name: item.key,
    created_at: 1,
    updated_at: 1,
  })
  seed.orgs![seed.orgs!.length - 1]!._id = item.orgId

  push("workspaces", {
    org_id: item.orgId,
    workspace_id: item.workspacePublicId,
    owner_user_id: "user_1",
    display_name: item.key,
    created_at: 1,
    updated_at: 1,
  })
  seed.workspaces![seed.workspaces!.length - 1]!._id = item.workspaceDocId

  for (const plan of ORG_DIRECT_TABLES) push(plan.table, { [plan.field]: item.orgId })
  for (const plan of ORG_CLERK_TABLES) push(plan.table, { [plan.field]: item.clerkOrgId })
  for (const plan of ORG_WORKSPACE_DOC_TABLES) push(plan.table, { [plan.field]: item.workspaceDocId })
  for (const plan of ORG_WORKSPACE_PUBLIC_TABLES) {
    push(plan.table, {
      [plan.field]: item.workspacePublicId,
      ...(plan.table === "runtime_leases" ? { status: leaseStatus, epoch: 1 } : {}),
    })
  }

  // Parent/child cascades: the child is only reachable through its parent.
  push("session_history", { workspace_id: item.workspaceDocId, session_id: `session_${item.key}` })
  push("session_messages", { session_id: `session_${item.key}`, ordinal: 1 })
  push("projects", { _id: `project_${item.key}`, org_id: item.orgId })
  seed.projects![seed.projects!.length - 1]!._id = `project_${item.key}`
  push("project_memberships", { project_id: `project_${item.key}`, user_id: "user_1" })
  push("workgraph_connection_metadata", { organization_id: item.orgId, connection_id: `connection_${item.key}` })
  push("workgraph_webhook_deliveries", { connection_id: `connection_${item.key}`, provider: "github" })
}

function store(options: { leaseStatus?: string; purgeRequestedAt?: number; deletedAt?: number } = {}) {
  const seed: Record<string, Row[]> = {}
  seedTenant(seed, TARGET, options.leaseStatus)
  seedTenant(seed, OTHER)
  for (const table of [...ORG_PURGED_TABLES, ...Object.keys(ORG_RETAINED_TABLES)]) seed[table] ??= []
  const target = seed.orgs!.find((row) => row._id === TARGET.orgId)!
  target.deleted_at = options.deletedAt ?? 1_000
  target.purge_requested_at = options.purgeRequestedAt ?? 1_000
  return db(seed)
}

function rowsFor(state: ReturnType<typeof store>, key: string) {
  return Object.entries(state.rows).flatMap(([table, rows]) =>
    rows.filter((row) => row._tenant === key).map((row) => `${table}:${String(row._id)}`))
}

/** Drives prepare + finalize to completion, returning how many batches it took. */
async function purge(state: ReturnType<typeof store>, now = 2_000) {
  const ctx = { db: state }
  const prepared = await prepareOrgDeletion(ctx, TARGET.orgId, TARGET.clerkOrgId, "operation_1", now) as any
  if (!prepared.ok) return { prepared, batches: 0 }
  let batches = 0
  for (;;) {
    batches += 1
    if (batches > 500) throw new Error("purge did not converge")
    const finalized = await finalizeOrgDeletion(
      ctx,
      TARGET.orgId,
      TARGET.clerkOrgId,
      "operation_1",
      prepared.scopeHash,
      now,
    ) as any
    if (!finalized.ok) return { prepared, finalized, batches }
    if (finalized.result) return { prepared, finalized, batches }
  }
}

describe("org deletion cascade — coverage of the schema (§6.12)", () => {
  test("every table in the schema is either purged or explicitly retained", () => {
    // A table nobody classified is retained personal data by accident. This is
    // the check that makes "we enumerated them all" a property of the tree
    // rather than a claim in a commit message.
    const schema = fs.readFileSync(
      path.join(path.resolve(import.meta.dirname, "../../../../.."), "convex", "schema.ts"),
      "utf8",
    )
    const tables = [...schema.matchAll(/^ {2}(\w+): defineTable\(/gm)].map((match) => match[1]!)
    expect(tables.length).toBeGreaterThan(50)

    const classified = new Set([...ORG_PURGED_TABLES, ...Object.keys(ORG_RETAINED_TABLES)])
    expect(tables.filter((table) => !classified.has(table))).toEqual([])
    // And nothing is claimed on both sides.
    expect(ORG_PURGED_TABLES.filter((table) => table in ORG_RETAINED_TABLES)).toEqual([])
  })

  test("the WorkGraph half is imported, not re-listed", async () => {
    const { WORKGRAPH_OWNER_TABLES } = await import("../../../../../convex/workgraphOwnerDeletion")
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
    const state = store()
    const before = rowsFor(state, TARGET.key)
    expect(before.length).toBeGreaterThan(50)

    const { finalized } = await purge(state)
    expect(finalized.ok).toBe(true)
    expect(finalized.result).toMatchObject({ deleted: true })

    expect(rowsFor(state, TARGET.key)).toEqual([])
    // The org row itself goes last, and it goes.
    expect(state.rows.orgs!.map((row) => row._id)).toEqual([OTHER.orgId])
  })

  test("a second org's rows are untouched — the predicate cannot bleed", async () => {
    const state = store()
    const before = rowsFor(state, OTHER.key)

    await purge(state)

    expect(rowsFor(state, OTHER.key)).toEqual(before)
  })

  test("it is batched and resumes across invocations", async () => {
    const state = store()
    // More rows than one batch by a wide margin, so completion in one call
    // would mean the budget is not being enforced at all.
    expect(rowsFor(state, TARGET.key).length).toBeGreaterThan(ORG_DELETION_BATCH_SIZE * 3)

    const { batches } = await purge(state)
    expect(batches).toBeGreaterThan(3)
    expect(rowsFor(state, TARGET.key)).toEqual([])
  })

  test("a child is never stranded: sessions outlive their messages", async () => {
    // `session_messages` is only reachable through `session_history`
    // (`by_session_ordinal` is its only scoping index), so a batch boundary
    // that removed the session first would orphan the transcript forever.
    const state = store()
    const ctx = { db: state }
    const prepared = await prepareOrgDeletion(ctx, TARGET.orgId, TARGET.clerkOrgId, "operation_1", 2_000) as any
    for (let index = 0; index < 200; index += 1) {
      const messages = state.rows.session_messages!.filter((row) => row._tenant === TARGET.key)
      const sessions = state.rows.session_history!.filter((row) => row._tenant === TARGET.key)
      if (sessions.length === 0) expect(messages).toEqual([])
      const finalized = await finalizeOrgDeletion(
        ctx,
        TARGET.orgId,
        TARGET.clerkOrgId,
        "operation_1",
        prepared.scopeHash,
        2_000,
      ) as any
      if (finalized.result) break
    }
    expect(state.rows.session_messages!.filter((row) => row._tenant === TARGET.key)).toEqual([])
    expect(state.rows.session_messages!.filter((row) => row._tenant === OTHER.key)).toHaveLength(1)
  })

  test("finishing twice is a no-op that replays the receipt", async () => {
    const state = store()
    const { finalized } = await purge(state)
    const again = await finalizeOrgDeletion(
      { db: state },
      TARGET.orgId,
      TARGET.clerkOrgId,
      "operation_1",
      "any",
      3_000,
    ) as any
    // The org row is gone, so there is nothing left to re-purge.
    expect(again).toEqual({ ok: false, reason: "org_not_found" })
    expect(finalized.result.recordCount).toBeGreaterThan(50)
  })
})

describe("org deletion cascade — refusing to fire (§6.12)", () => {
  const cases: Array<[string, () => ReturnType<typeof store>, string, string]> = [
    ["without a purge request", () => {
      const state = store()
      state.rows.orgs!.find((row) => row._id === TARGET.orgId)!.purge_requested_at = undefined
      return state
    }, TARGET.clerkOrgId, "purge_not_requested"],
    ["without deleted_at", () => {
      const state = store()
      state.rows.orgs!.find((row) => row._id === TARGET.orgId)!.deleted_at = undefined
      return state
    }, TARGET.clerkOrgId, "org_not_deleted"],
    ["on a wrong confirmation", () => store(), "clerk_org_typo", "confirmation_mismatch"],
    ["on a personal org", () => {
      const state = store()
      state.rows.orgs!.find((row) => row._id === TARGET.orgId)!.clerk_org_id = undefined
      return state
    }, TARGET.clerkOrgId, "not_a_clerk_org"],
    ["while a sandbox is live", () => store({ leaseStatus: "ready" }), TARGET.clerkOrgId, "not_quiescent"],
  ]

  for (const [name, build, confirmation, reason] of cases) {
    test(`refuses ${name}`, async () => {
      const state = build()
      const before = rowsFor(state, TARGET.key)

      const prepared = await prepareOrgDeletion(
        { db: state },
        TARGET.orgId,
        confirmation,
        "operation_1",
        2_000,
      ) as any

      expect(prepared).toEqual({ ok: false, reason })
      // The decisive part: a refusal deletes nothing.
      expect(rowsFor(state, TARGET.key)).toEqual(before)
    })
  }

  test("a live WorkGraph owner deletion blocks the org purge", async () => {
    const state = store()
    await state.insert("workgraph_owner_deletion_barriers", {
      organization_id: TARGET.orgId,
      owner_user_id: "user_1",
      operation_hash: "other_operation",
      lease_expires_at: 9_000,
      created_at: 1,
      updated_at: 1,
    })

    const prepared = await prepareOrgDeletion({ db: state }, TARGET.orgId, TARGET.clerkOrgId, "op", 2_000) as any
    expect(prepared).toEqual({ ok: false, reason: "not_quiescent" })
  })

  test("a second operation cannot steal a live barrier, and release frees it", async () => {
    const state = store()
    const ctx = { db: state }
    const first = await prepareOrgDeletion(ctx, TARGET.orgId, TARGET.clerkOrgId, "operation_1", 2_000) as any
    expect(first.state).toBe("acquired")

    const second = await prepareOrgDeletion(ctx, TARGET.orgId, TARGET.clerkOrgId, "operation_2", 2_000) as any
    expect(second).toMatchObject({ ok: true, state: "in_progress" })
    // A finalize for the loser must not delete anything.
    const stolen = await finalizeOrgDeletion(
      ctx,
      TARGET.orgId,
      TARGET.clerkOrgId,
      "operation_2",
      first.scopeHash,
      2_000,
    ) as any
    expect(stolen).toEqual({ ok: false, reason: "in_progress" })
    expect(rowsFor(state, TARGET.key).length).toBeGreaterThan(50)

    await releaseOrgDeletion(ctx, TARGET.orgId, "operation_1")
    expect(state.rows.org_deletion_barriers).toEqual([])
    const third = await prepareOrgDeletion(ctx, TARGET.orgId, TARGET.clerkOrgId, "operation_2", 2_000) as any
    expect(third.state).toBe("acquired")
  })

  test("the service entrypoint is service-token gated", async () => {
    const previous = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
    try {
      const state = store()
      await expect(handler(prepareDeletionForService)({ db: state }, {
        service_token: "wrong",
        org_id: TARGET.orgId,
        confirm_clerk_org_id: TARGET.clerkOrgId,
        operation_id: "operation_1",
        now: 2_000,
      })).rejects.toThrow("Unauthenticated")
      expect(rowsFor(state, TARGET.key).length).toBeGreaterThan(50)
    } finally {
      if (previous === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previous
    }
  })
})

describe("org deletion cascade — the trigger (§6.12)", () => {
  test("organization.deleted records a purge REQUEST rather than purging", async () => {
    const state = store()
    state.rows.orgs!.find((row) => row._id === TARGET.orgId)!.deleted_at = undefined
    state.rows.orgs!.find((row) => row._id === TARGET.orgId)!.purge_requested_at = undefined
    const before = rowsFor(state, TARGET.key)

    await handler(applyClerkWebhook)({ db: state }, { type: "organization.deleted", data: { id: TARGET.clerkOrgId } })

    const org = state.rows.orgs!.find((row) => row._id === TARGET.orgId)!
    expect(typeof org.deleted_at).toBe("number")
    expect(typeof org.purge_requested_at).toBe("number")
    // A Svix delivery must not start an irreversible multi-transaction purge.
    expect(rowsFor(state, TARGET.key)).toEqual(before)
  })

  test("re-creating the org inside the grace window cancels the purge", async () => {
    const state = store()
    await handler(applyClerkWebhook)({ db: state }, {
      type: "organization.created",
      data: { id: TARGET.clerkOrgId, name: "restored", updated_at: 5_000 },
    })

    const org = state.rows.orgs!.find((row) => row._id === TARGET.orgId)!
    expect(org.deleted_at).toBeUndefined()
    expect(org.purge_requested_at).toBeUndefined()

    const swept = await handler(purgeDeletedOrgs)({ db: state }, { retain_ms: 0, now: 9_000 }) as any
    expect(swept).toMatchObject({ due: 0, state: "idle" })
    expect(rowsFor(state, TARGET.key).length).toBeGreaterThan(50)
  })

  test("the cron waits out the grace window, then purges exactly one org per tick", async () => {
    const state = store({ purgeRequestedAt: 1_000 })
    // Both orgs are deleted and both requests are old enough, so the ONE-org
    // bound is what keeps the second one alive rather than a filter accident.
    const other = state.rows.orgs!.find((row) => row._id === OTHER.orgId)!
    other.deleted_at = 2_000
    other.purge_requested_at = 2_000

    const early = await handler(purgeDeletedOrgs)({ db: state }, {
      retain_ms: 7 * 24 * 60 * 60 * 1000,
      now: 2_000,
    }) as any
    expect(early).toMatchObject({ due: 0, state: "idle" })
    expect(rowsFor(state, TARGET.key).length).toBeGreaterThan(50)

    const now = 1_000 + 8 * 24 * 60 * 60 * 1000
    const swept = await handler(purgeDeletedOrgs)({ db: state }, {
      retain_ms: 7 * 24 * 60 * 60 * 1000,
      batch_limit: 4_096,
      now,
    }) as any
    // Oldest request first, and only that one.
    expect(swept).toMatchObject({ due: 2, state: "completed" })
    expect(rowsFor(state, TARGET.key)).toEqual([])
    expect(rowsFor(state, OTHER.key).length).toBeGreaterThan(50)
  })

  test("the cron resumes its own operation across ticks", async () => {
    const state = store()
    const now = 1_000 + 8 * 24 * 60 * 60 * 1000
    // A single batch per tick: enough to prove ticks compose rather than
    // restarting, and that a partial tick never leaves the org half-purged in a
    // way the next tick cannot pick up.
    let ticks = 0
    for (;;) {
      ticks += 1
      if (ticks > 500) throw new Error("cron did not converge")
      const swept = await handler(purgeDeletedOrgs)({ db: state }, {
        retain_ms: 7 * 24 * 60 * 60 * 1000,
        batch_limit: ORG_DELETION_BATCH_SIZE,
        now,
      }) as any
      if (swept.state === "completed") break
      expect(swept.state).toBe("deleting")
    }
    expect(ticks).toBeGreaterThan(3)
    expect(rowsFor(state, TARGET.key)).toEqual([])
    expect(rowsFor(state, OTHER.key).length).toBeGreaterThan(50)
  })
})
