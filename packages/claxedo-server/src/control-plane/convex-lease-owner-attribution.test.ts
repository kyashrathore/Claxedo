import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { acquire, countActiveForOrg, recordTenant, release, sweepStaleLeases, update } from "../../../../convex/sandboxLeases"

/**
 * The lease-attribution gap left open by the per-org concurrent sandbox cap.
 *
 * `runtime_leases.org_id` holds the CLERK org claim, and a personal-account
 * token carries none — so `productIdentity` returned undefined, nothing was
 * stamped, `countActiveForOrg` saw an unattributed row, and the cap could not
 * bind for those callers at all. `owner_subject` is the attribution key that
 * closes it: present on every signed request, and deliberately outside the W5
 * metering pair so a fabricated org is never invented to make the count work.
 */

type Row = Record<string, unknown> & { _id: string }

function db(seed: Row[] = []) {
  const rows: Record<string, Row[]> = { runtime_leases: [...seed], sandbox_lease_events: [] }
  let sequence = 0
  return {
    rows,
    query(table: string) {
      const equals: Array<[string, unknown]> = []
      const matching = () => (rows[table] ?? []).filter((row) => equals.every(([key, value]) => row[key] === value))
      const query = {
        withIndex(_name: string, build: (q: unknown) => unknown) {
          const builder = {
            eq(key: string, value: unknown) {
              equals.push([key, value])
              return builder
            },
          }
          build(builder)
          return query
        },
        async first() {
          return matching()[0] ?? null
        },
        async collect() {
          return matching()
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
    async patch(id: unknown, patch: Record<string, unknown>) {
      const index = rows.runtime_leases!.findIndex((row) => row._id === id)
      rows.runtime_leases![index] = { ...rows.runtime_leases![index]!, ...patch }
    },
    async replace(id: unknown, value: Record<string, unknown>) {
      const index = rows.runtime_leases!.findIndex((row) => row._id === id)
      rows.runtime_leases![index] = { _id: String(id), ...value } as Row
    },
    async delete(id: unknown) {
      const index = rows.runtime_leases!.findIndex((row) => row._id === id)
      rows.runtime_leases!.splice(index, 1)
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

const TOKEN = { service_token: "svc_secret" }

function lease(input: Record<string, unknown>): Row {
  return {
    _id: `lease_${String(input.workspace_id ?? "x")}`,
    workspace_id: "ws_1",
    home_region: "us-east",
    driver: "fetch",
    epoch: 1,
    status: "ready",
    retry_count: 0,
    created_at: 1_000,
    updated_at: 1_000,
    ...input,
  }
}

let previousToken: string | undefined
beforeEach(() => {
  previousToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
})
afterEach(() => {
  if (previousToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousToken
})

describe("sandboxLeases.recordTenant — two independent stamps", () => {
  test("a personal-account caller stamps an owner, and no metering identity", async () => {
    const store = db([lease({ workspace_id: "ws_1" })])

    await expect(handler(recordTenant)({ db: store }, {
      ...TOKEN,
      workspace_id: "ws_1",
      owner_subject: "user_personal",
    })).resolves.toEqual({ stamped: true, reason: null })

    const row = store.rows.runtime_leases![0]!
    expect(row.owner_subject).toBe("user_personal")
    // The W5 pair stays absent: a fact keyed on half a tenant — or on an
    // invented org — corrupts every per-org aggregate downstream.
    expect(row.org_id).toBeUndefined()
    expect(row.user_id).toBeUndefined()
  })

  test("an org caller stamps both, and each stamp is independently write-once", async () => {
    const store = db([lease({ workspace_id: "ws_1" })])

    await handler(recordTenant)({ db: store }, {
      ...TOKEN,
      workspace_id: "ws_1",
      owner_subject: "user_1",
      org_id: "org_1",
      user_id: "user_1",
    })
    expect(store.rows.runtime_leases![0]).toMatchObject({
      owner_subject: "user_1",
      org_id: "org_1",
      user_id: "user_1",
    })

    // A retried create must not re-attribute a running sandbox.
    await expect(handler(recordTenant)({ db: store }, {
      ...TOKEN,
      workspace_id: "ws_1",
      owner_subject: "attacker",
      org_id: "org_attacker",
      user_id: "attacker",
    })).resolves.toEqual({ stamped: false, reason: "already_attributed" })
    expect(store.rows.runtime_leases![0]).toMatchObject({ owner_subject: "user_1", org_id: "org_1" })
  })

  test("an owner already stamped does not block a later metering stamp", async () => {
    // The upgrade path: a personal lease whose caller later carries an org
    // claim. The two stamps are independent, so the second one still lands.
    const store = db([lease({ workspace_id: "ws_1", owner_subject: "user_1" })])

    await expect(handler(recordTenant)({ db: store }, {
      ...TOKEN,
      workspace_id: "ws_1",
      owner_subject: "user_1",
      org_id: "org_1",
      user_id: "user_1",
    })).resolves.toEqual({ stamped: true, reason: null })
    expect(store.rows.runtime_leases![0]).toMatchObject({ org_id: "org_1", user_id: "user_1" })
  })

  test("a call carrying no identity writes nothing", async () => {
    const store = db([lease({ workspace_id: "ws_1" })])
    await expect(handler(recordTenant)({ db: store }, { ...TOKEN, workspace_id: "ws_1" }))
      .resolves.toEqual({ stamped: false, reason: "no_identity" })
    // A half-pair is also no identity: `user_id` alone must never be written.
    await expect(handler(recordTenant)({ db: store }, { ...TOKEN, workspace_id: "ws_1", user_id: "user_1" }))
      .resolves.toEqual({ stamped: false, reason: "no_identity" })
    expect(store.rows.runtime_leases![0]!.user_id).toBeUndefined()
  })
})

describe("sandboxLeases.countActiveForOrg — the cap binds for every caller", () => {
  test("a personal-account lease is counted, so the cap can bind on it", async () => {
    const store = db([
      lease({ _id: "l1", workspace_id: "ws_1", owner_subject: "user_personal", status: "ready" }),
      lease({ _id: "l2", workspace_id: "ws_2", owner_subject: "user_personal", status: "acquiring" }),
      // Someone else's personal lease — never in this caller's budget.
      lease({ _id: "l3", workspace_id: "ws_3", owner_subject: "user_other", status: "ready" }),
      // Terminal and already-closed leases hold nothing.
      lease({ _id: "l4", workspace_id: "ws_4", owner_subject: "user_personal", status: "stopped" }),
      lease({ _id: "l5", workspace_id: "ws_5", owner_subject: "user_personal", status: "ready", ended_at: 9 }),
    ])

    await expect(handler(countActiveForOrg)({ db: store }, { ...TOKEN, owner_subject: "user_personal" }))
      .resolves.toEqual({ owner_subject: "user_personal", active: 2 })
  })

  test("org and owner scopes are a union, and a row matching both counts once", async () => {
    const store = db([
      lease({ _id: "l1", workspace_id: "ws_1", org_id: "org_1", owner_subject: "user_1", status: "ready" }),
      lease({ _id: "l2", workspace_id: "ws_2", org_id: "org_1", owner_subject: "colleague", status: "ready" }),
      lease({ _id: "l3", workspace_id: "ws_3", owner_subject: "user_1", status: "ready" }),
      lease({ _id: "l4", workspace_id: "ws_4", org_id: "org_2", owner_subject: "stranger", status: "ready" }),
    ])

    await expect(handler(countActiveForOrg)({ db: store }, { ...TOKEN, org_id: "org_1", owner_subject: "user_1" }))
      .resolves.toEqual({ org_id: "org_1", owner_subject: "user_1", active: 3 })
  })

  test("counting with no scope at all is refused rather than counting everything", async () => {
    // The dangerous default: an unscoped count would hand one tenant a number
    // derived from every other tenant's live leases.
    const store = db([lease({ workspace_id: "ws_1", org_id: "org_1" })])
    await expect(handler(countActiveForOrg)({ db: store }, { ...TOKEN }))
      .rejects.toThrow("A lease count needs an org_id or an owner_subject")
    await expect(handler(countActiveForOrg)({ db: store }, { ...TOKEN, org_id: "  " }))
      .rejects.toThrow("A lease count needs an org_id or an owner_subject")
  })

  test("the existing org-scoped contract is unchanged", async () => {
    const store = db([
      lease({ _id: "l1", workspace_id: "ws_1", org_id: "org_1", status: "ready" }),
      lease({ _id: "l2", workspace_id: "ws_2", org_id: "org_2", status: "ready" }),
      lease({ _id: "l3", workspace_id: "ws_3", owner_subject: "user_1", status: "ready" }),
    ])
    await expect(handler(countActiveForOrg)({ db: store }, { ...TOKEN, org_id: "org_1" }))
      .resolves.toEqual({ org_id: "org_1", active: 1 })
  })
})

describe("owner_subject survives the whole lease lifecycle", () => {
  test("acquire, update and the reaper all rewrite the document without dropping it", async () => {
    // Every one of these writes the CANONICAL document through `db.replace`, so
    // a field the canonicaliser forgets is a field the next heartbeat erases —
    // and an erased owner is a cap that silently stops binding mid-lease.
    const store = db([lease({ workspace_id: "ws_1", owner_subject: "user_personal", status: "stopped" })])
    const ctx = { db: store }

    await handler(acquire)(ctx, {
      ...TOKEN,
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "fetch",
      stale_after_ms: 1_000,
      now: 2_000,
    })
    expect(store.rows.runtime_leases![0]!.owner_subject).toBe("user_personal")

    await handler(update)(ctx, {
      ...TOKEN,
      workspace_id: "ws_1",
      expected_epoch: 2,
      patch: { status: "ready", last_heartbeat_at: 2_100 },
    })
    expect(store.rows.runtime_leases![0]!.owner_subject).toBe("user_personal")

    await handler(sweepStaleLeases)(ctx, {
      acquiring_stale_after_ms: 1,
      ready_heartbeat_stale_after_ms: 1,
      now: 9_000_000,
    })
    expect(store.rows.runtime_leases![0]).toMatchObject({ status: "stopped", owner_subject: "user_personal" })
  })

  test("metering is untouched: an owner-only lease still records no usage fact", async () => {
    const store = db([lease({
      workspace_id: "ws_1",
      owner_subject: "user_personal",
      started_at: 1_000,
      status: "ready",
    })])

    const released = await handler(release)({ db: store }, {
      ...TOKEN,
      workspace_id: "ws_1",
      now: 5_000,
    }) as { released: boolean; usage: unknown }

    expect(released.released).toBe(true)
    expect(released.usage).toBeNull()
    // The whole point of a separate column: no fabricated org reaches the
    // authoritative usage facts.
    expect(store.rows.sandbox_lease_events).toEqual([])
  })

  test("an org-attributed lease still records its usage fact", async () => {
    const store = db([lease({
      workspace_id: "ws_1",
      owner_subject: "user_1",
      org_id: "org_1",
      user_id: "user_1",
      started_at: 1_000,
      status: "ready",
    })])

    await handler(release)({ db: store }, { ...TOKEN, workspace_id: "ws_1", now: 5_000 })

    expect(store.rows.sandbox_lease_events).toHaveLength(1)
    expect(store.rows.sandbox_lease_events![0]).toMatchObject({
      org_id: "org_1",
      user_id: "user_1",
      active_ms: 4_000,
      reason: "explicit_release",
    })
    // `owner_subject` is a cap key, not a metering column, and never leaks into
    // the fact row.
    expect(store.rows.sandbox_lease_events![0]!.owner_subject).toBeUndefined()
  })
})
