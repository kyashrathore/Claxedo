import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api, internal } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

/**
 * The lease-attribution gap left open by the per-org concurrent sandbox cap.
 *
 * `runtime_leases.org_id` holds the CLERK org claim, and a personal-account
 * token carries none — so `productIdentity` returned undefined, nothing was
 * stamped, `countActiveForOrg` saw an unattributed row, and the cap could not
 * bind for those callers at all. `owner_subject` is the attribution key that
 * closes it: present on every signed request, and deliberately outside the W5
 * metering pair so a fabricated org is never invented to make the count work.
 *
 * Runs against the real function pipeline via `convex-test`, including the
 * `serviceMutation`/`serviceQuery`/`cronMutation` wrappers from `model.ts`.
 * The previous version of this suite lived in claxedo-server, imported
 * `sandboxLeases.ts` across five directory levels, reached past the builders
 * into `_handler`, and drove a hand-written `db` double — so it exercised the
 * handler bodies while skipping both the service-token gate and the real
 * Convex indexes `countActiveForOrg` depends on (`by_org_status`,
 * `by_owner_subject_status`).
 */

const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
})
afterEach(() => {
  if (prevServiceToken === undefined) {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    return
  }
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken
})

const SVC = { service_token: "svc_secret" }

async function seedLease(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  return t.run(async (ctx) => ctx.db.insert("runtime_leases", {
    workspace_id: "ws_1",
    home_region: "us-east",
    driver: "fetch",
    epoch: 1,
    status: "ready",
    retry_count: 0,
    created_at: 1_000,
    updated_at: 1_000,
    ...overrides,
  } as never))
}

async function leases(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.query("runtime_leases").collect())
}

describe("sandboxLeases.recordTenant — two independent stamps", () => {
  test("a personal-account caller stamps an owner, and no metering identity", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1" })

    await expect(t.mutation(api.sandboxLeases.recordTenant, {
      ...SVC,
      workspace_id: "ws_1",
      owner_subject: "user_personal",
    } as never)).resolves.toEqual({ stamped: true, reason: null })

    const row = (await leases(t))[0]!
    expect(row.owner_subject).toBe("user_personal")
    // The W5 pair stays absent: a fact keyed on half a tenant — or on an
    // invented org — corrupts every per-org aggregate downstream.
    expect(row.org_id).toBeUndefined()
    expect(row.user_id).toBeUndefined()
  })

  test("an org caller stamps both, and each stamp is independently write-once", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1" })

    await t.mutation(api.sandboxLeases.recordTenant, {
      ...SVC,
      workspace_id: "ws_1",
      owner_subject: "user_1",
      org_id: "org_1",
      user_id: "user_1",
    } as never)
    expect((await leases(t))[0]).toMatchObject({
      owner_subject: "user_1",
      org_id: "org_1",
      user_id: "user_1",
    })

    // A retried create must not re-attribute a running sandbox.
    await expect(t.mutation(api.sandboxLeases.recordTenant, {
      ...SVC,
      workspace_id: "ws_1",
      owner_subject: "attacker",
      org_id: "org_attacker",
      user_id: "attacker",
    } as never)).resolves.toEqual({ stamped: false, reason: "already_attributed" })
    expect((await leases(t))[0]).toMatchObject({ owner_subject: "user_1", org_id: "org_1" })
  })

  test("an owner already stamped does not block a later metering stamp", async () => {
    // The upgrade path: a personal lease whose caller later carries an org
    // claim. The two stamps are independent, so the second one still lands.
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1", owner_subject: "user_1" })

    await expect(t.mutation(api.sandboxLeases.recordTenant, {
      ...SVC,
      workspace_id: "ws_1",
      owner_subject: "user_1",
      org_id: "org_1",
      user_id: "user_1",
    } as never)).resolves.toEqual({ stamped: true, reason: null })
    expect((await leases(t))[0]).toMatchObject({ org_id: "org_1", user_id: "user_1" })
  })

  test("a call carrying no identity writes nothing", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1" })
    await expect(t.mutation(api.sandboxLeases.recordTenant, { ...SVC, workspace_id: "ws_1" } as never))
      .resolves.toEqual({ stamped: false, reason: "no_identity" })
    // A half-pair is also no identity: `user_id` alone must never be written.
    await expect(t.mutation(api.sandboxLeases.recordTenant, {
      ...SVC,
      workspace_id: "ws_1",
      user_id: "user_1",
    } as never)).resolves.toEqual({ stamped: false, reason: "no_identity" })
    expect((await leases(t))[0]!.user_id).toBeUndefined()
  })
})

describe("sandboxLeases.countActiveForOrg — the cap binds for every caller", () => {
  test("a personal-account lease is counted, so the cap can bind on it", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1", owner_subject: "user_personal", status: "ready" })
    await seedLease(t, { workspace_id: "ws_2", owner_subject: "user_personal", status: "acquiring" })
    // Someone else's personal lease — never in this caller's budget.
    await seedLease(t, { workspace_id: "ws_3", owner_subject: "user_other", status: "ready" })
    // Terminal and already-closed leases hold nothing.
    await seedLease(t, { workspace_id: "ws_4", owner_subject: "user_personal", status: "stopped" })
    await seedLease(t, { workspace_id: "ws_5", owner_subject: "user_personal", status: "ready", ended_at: 9 })

    await expect(t.query(api.sandboxLeases.countActiveForOrg, { ...SVC, owner_subject: "user_personal" } as never))
      .resolves.toEqual({ owner_subject: "user_personal", active: 2 })
  })

  test("org and owner scopes are a union, and a row matching both counts once", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1", org_id: "org_1", owner_subject: "user_1", status: "ready" })
    await seedLease(t, { workspace_id: "ws_2", org_id: "org_1", owner_subject: "colleague", status: "ready" })
    await seedLease(t, { workspace_id: "ws_3", owner_subject: "user_1", status: "ready" })
    await seedLease(t, { workspace_id: "ws_4", org_id: "org_2", owner_subject: "stranger", status: "ready" })

    await expect(t.query(api.sandboxLeases.countActiveForOrg, {
      ...SVC,
      org_id: "org_1",
      owner_subject: "user_1",
    } as never)).resolves.toEqual({ org_id: "org_1", owner_subject: "user_1", active: 3 })
  })

  test("counting with no scope at all is refused rather than counting everything", async () => {
    // The dangerous default: an unscoped count would hand one tenant a number
    // derived from every other tenant's live leases.
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1", org_id: "org_1" })
    await expect(t.query(api.sandboxLeases.countActiveForOrg, { ...SVC } as never))
      .rejects.toThrow("A lease count needs an org_id or an owner_subject")
    await expect(t.query(api.sandboxLeases.countActiveForOrg, { ...SVC, org_id: "  " } as never))
      .rejects.toThrow("A lease count needs an org_id or an owner_subject")
  })

  test("the existing org-scoped contract is unchanged", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1", org_id: "org_1", status: "ready" })
    await seedLease(t, { workspace_id: "ws_2", org_id: "org_2", status: "ready" })
    await seedLease(t, { workspace_id: "ws_3", owner_subject: "user_1", status: "ready" })
    await expect(t.query(api.sandboxLeases.countActiveForOrg, { ...SVC, org_id: "org_1" } as never))
      .resolves.toEqual({ org_id: "org_1", active: 1 })
  })
})

describe("owner_subject survives the whole lease lifecycle", () => {
  test("acquire, update and the reaper all rewrite the document without dropping it", async () => {
    // Every one of these writes the CANONICAL document through `db.replace`, so
    // a field the canonicaliser forgets is a field the next heartbeat erases —
    // and an erased owner is a cap that silently stops binding mid-lease.
    const t = convexTest(schema, modules)
    await seedLease(t, { workspace_id: "ws_1", owner_subject: "user_personal", status: "stopped" })

    await t.mutation(api.sandboxLeases.acquire, {
      ...SVC,
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "fetch",
      stale_after_ms: 1_000,
      now: 2_000,
    } as never)
    expect((await leases(t))[0]!.owner_subject).toBe("user_personal")

    await t.mutation(api.sandboxLeases.update, {
      ...SVC,
      workspace_id: "ws_1",
      expected_epoch: 2,
      patch: { status: "ready", last_heartbeat_at: 2_100 },
    } as never)
    expect((await leases(t))[0]!.owner_subject).toBe("user_personal")

    await t.mutation(internal.sandboxLeases.sweepStaleLeases, {
      acquiring_stale_after_ms: 1,
      ready_heartbeat_stale_after_ms: 1,
      now: 9_000_000,
    } as never)
    expect((await leases(t))[0]).toMatchObject({ status: "stopped", owner_subject: "user_personal" })
  })

  test("metering is untouched: an owner-only lease still records no usage fact", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, {
      workspace_id: "ws_1",
      owner_subject: "user_personal",
      started_at: 1_000,
      status: "ready",
    })

    const released = await t.mutation(api.sandboxLeases.release, {
      ...SVC,
      workspace_id: "ws_1",
      now: 5_000,
    } as never) as { released: boolean; usage: unknown }

    expect(released.released).toBe(true)
    expect(released.usage).toBeNull()
    // The whole point of a separate column: no fabricated org reaches the
    // authoritative usage facts.
    await expect(t.run(async (ctx) => ctx.db.query("sandbox_lease_events").collect())).resolves.toEqual([])
  })

  test("an org-attributed lease still records its usage fact", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, {
      workspace_id: "ws_1",
      owner_subject: "user_1",
      org_id: "org_1",
      user_id: "user_1",
      started_at: 1_000,
      status: "ready",
    })

    await t.mutation(api.sandboxLeases.release, { ...SVC, workspace_id: "ws_1", now: 5_000 } as never)

    const events = await t.run(async (ctx) => ctx.db.query("sandbox_lease_events").collect())
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      org_id: "org_1",
      user_id: "user_1",
      active_ms: 4_000,
      reason: "explicit_release",
    })
    // `owner_subject` is a cap key, not a metering column, and never leaks into
    // the fact row. `in` rather than property access: the schema type has no
    // such field, which is the point — the check is against the raw row.
    expect("owner_subject" in events[0]!).toBe(false)
  })
})
