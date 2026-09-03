import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto"
import { describe, expect, test } from "vitest"
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
 * Machine-wide enrollment policy (`convex/hostEnrollments.ts`).
 *
 * The same behaviours the SQLite authority pins in
 * `claxedo-server/src/authority/adapters/sqlite/host-enrollment.test.ts`, run
 * against the real Convex function pipeline including the `authedMutation`
 * wrappers. Two authorities implementing one contract only holds if both are
 * checked against the same claims, and the interesting claims are all negative:
 * a forged signature, a replayed nonce, another user's request, a paused
 * machine that still answers.
 */

function hostKey() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const privateKey = pair.privateKey.export({ format: "jwk" })
  return {
    publicKey: JSON.stringify(pair.publicKey.export({ format: "jwk" })),
    sign(payload: string) {
      return sign("sha256", Buffer.from(payload), {
        key: createPrivateKey({ key: privateKey, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      }).toString("base64url")
    },
  }
}

function enrollmentPayload(input: { hostId: string; requestId: string; nonce: string }) {
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.hostId}`,
    `request_id=${input.requestId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

/**
 * Heartbeat v2: one signature per interval covers the machine's served set
 * (sorted, comma-joined). Deliberately spelled out here rather than imported —
 * the test pins the exact bytes the function must verify.
 */
function heartbeatPayload(input: { hostId: string; ttlMs?: number; workspaceIds?: readonly string[] }) {
  return [
    "claxedo.host-enrollment.heartbeat.v2",
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
    `workspaces=${[...(input.workspaceIds ?? [])].sort().join(",")}`,
  ].join("\n")
}

function asOwner(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ tokenIdentifier: "owner_token", subject: "owner_subject" })
}

function asOther(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ tokenIdentifier: "other_token", subject: "other_subject" })
}

async function enroll(
  as: ReturnType<typeof asOwner>,
  input: { hostId?: string; key?: ReturnType<typeof hostKey>; displayName?: string } = {},
) {
  const hostId = input.hostId ?? "host_laptop"
  const key = input.key ?? hostKey()
  const request = await as.mutation(api.hostEnrollments.createRequest, { host_id: hostId })
  const enrollment = await as.mutation(api.hostEnrollments.enroll, {
    host_id: hostId,
    public_key: key.publicKey,
    request_id: request.request_id,
    signature: key.sign(enrollmentPayload({ hostId, requestId: request.request_id, nonce: request.nonce })),
    ...(input.displayName ? { display_name: input.displayName } : {}),
  })
  return { enrollment, key, hostId, request }
}

describe("Convex host enrollment", () => {
  test("enrolls a machine, reports it active, and creates no workspace", async () => {
    // The point of the change: the per-workspace path this replaces did an
    // implicit workspace insert. Enrolling a laptop must own nothing.
    const t = convexTest(schema, modules)
    const owner = asOwner(t)

    const { enrollment, hostId } = await enroll(owner, { displayName: "Work laptop" })

    expect(enrollment).toMatchObject({ host_id: hostId, display_name: "Work laptop" })
    expect(await owner.query(api.hostEnrollments.active, {})).toMatchObject({ active: true, host_id: hostId })
    expect(await t.run(async (ctx) => ctx.db.query("workspaces").collect())).toEqual([])
  })

  test("never returns the host public key", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { enrollment, key } = await enroll(owner)

    expect(JSON.stringify(enrollment)).not.toContain(key.publicKey)
    expect(JSON.stringify(await owner.query(api.hostEnrollments.active, {}))).not.toContain(key.publicKey)
  })

  test("rejects a forged signature", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const presented = hostKey()
    const attacker = hostKey()
    const request = await owner.mutation(api.hostEnrollments.createRequest, { host_id: "host_laptop" })

    await expect(
      owner.mutation(api.hostEnrollments.enroll, {
        host_id: "host_laptop",
        public_key: presented.publicKey,
        request_id: request.request_id,
        signature: attacker.sign(
          enrollmentPayload({ hostId: "host_laptop", requestId: request.request_id, nonce: request.nonce }),
        ),
      }),
    ).rejects.toThrow()
  })

  test("a failed signature does not burn the request", async () => {
    // Otherwise anyone able to call this can invalidate every enrollment
    // attempt the user makes, by answering first with junk.
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const key = hostKey()
    const request = await owner.mutation(api.hostEnrollments.createRequest, { host_id: "host_laptop" })

    await expect(
      owner.mutation(api.hostEnrollments.enroll, {
        host_id: "host_laptop",
        public_key: key.publicKey,
        request_id: request.request_id,
        signature: "bogus",
      }),
    ).rejects.toThrow()

    await expect(
      owner.mutation(api.hostEnrollments.enroll, {
        host_id: "host_laptop",
        public_key: key.publicKey,
        request_id: request.request_id,
        signature: key.sign(enrollmentPayload({ hostId: "host_laptop", requestId: request.request_id, nonce: request.nonce })),
      }),
    ).resolves.toMatchObject({ host_id: "host_laptop" })
  })

  test("a request is one-use", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { key, hostId, request } = await enroll(owner)

    await expect(
      owner.mutation(api.hostEnrollments.enroll, {
        host_id: hostId,
        public_key: key.publicKey,
        request_id: request.request_id,
        signature: key.sign(enrollmentPayload({ hostId, requestId: request.request_id, nonce: request.nonce })),
      }),
    ).rejects.toThrow(/Invalid host enrollment request/)
  })

  test("another user cannot spend this user's request", async () => {
    const t = convexTest(schema, modules)
    const key = hostKey()
    const request = await asOwner(t).mutation(api.hostEnrollments.createRequest, { host_id: "host_laptop" })

    await expect(
      asOther(t).mutation(api.hostEnrollments.enroll, {
        host_id: "host_laptop",
        public_key: key.publicKey,
        request_id: request.request_id,
        signature: key.sign(enrollmentPayload({ hostId: "host_laptop", requestId: request.request_id, nonce: request.nonce })),
      }),
    ).rejects.toThrow()
  })

  test("re-enrolling the same machine keeps exactly one row", async () => {
    // Convex has no unique constraint, so the one-row-per-machine rule lives in
    // a read-then-patch. This is the assertion that holds it.
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const first = await enroll(owner, { displayName: "Laptop" })
    await enroll(owner, { hostId: first.hostId, displayName: "Laptop renamed" })

    const rows = await t.run(async (ctx) => ctx.db.query("host_enrollments").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ host_id: first.hostId, display_name: "Laptop renamed" })
  })

  test("two users may enroll the same machine id independently", async () => {
    // Uniqueness is per (owner, host). A shared machine is not one user's to
    // claim.
    const t = convexTest(schema, modules)
    await enroll(asOwner(t), { hostId: "host_shared" })
    await enroll(asOther(t), { hostId: "host_shared" })

    expect(await asOwner(t).query(api.hostEnrollments.active, {})).toMatchObject({ active: true })
    expect(await asOther(t).query(api.hostEnrollments.active, {})).toMatchObject({ active: true })
  })

  test("reports not-enrolled rather than failing for a user with no machines", async () => {
    const t = convexTest(schema, modules)

    expect(await asOwner(t).query(api.hostEnrollments.active, {})).toEqual({ active: false, reason: "not-enrolled" })
  })

  test("does not report another user's machine as active", async () => {
    const t = convexTest(schema, modules)
    await enroll(asOwner(t))

    expect(await asOther(t).query(api.hostEnrollments.active, {})).toEqual({ active: false, reason: "not-enrolled" })
  })
})

describe("Convex host enrollment heartbeat", () => {
  test("extends when signed with the enrolled key", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { key, hostId, enrollment } = await enroll(owner)

    const beat = await owner.mutation(api.hostEnrollments.heartbeat, {
      host_id: hostId,
      workspace_ids: [],
      signature: key.sign(heartbeatPayload({ hostId })),
    })

    expect(beat.expires_at).toBeGreaterThanOrEqual(enrollment.expires_at)
    expect(beat.assigned_workspace_ids).toEqual([])
  })

  test("rejects a heartbeat signed with a different key", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { hostId } = await enroll(owner)
    const attacker = hostKey()

    await expect(
      owner.mutation(api.hostEnrollments.heartbeat, {
        host_id: hostId,
        workspace_ids: [],
        signature: attacker.sign(heartbeatPayload({ hostId })),
      }),
    ).rejects.toThrow()
  })

  test("rejects a signature over a different served set than the one claimed", async () => {
    // The set IS the consent. Accepting a mismatch would let a caller ack
    // workspaces the machine never signed for.
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { key, hostId } = await enroll(owner)

    await expect(
      owner.mutation(api.hostEnrollments.heartbeat, {
        host_id: hostId,
        workspace_ids: ["ws_claimed"],
        signature: key.sign(heartbeatPayload({ hostId, workspaceIds: [] })),
      }),
    ).rejects.toThrow(/Invalid host attestation/)
  })

  test("stores the verified served set on the enrollment", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { key, hostId } = await enroll(owner)

    await owner.mutation(api.hostEnrollments.heartbeat, {
      host_id: hostId,
      workspace_ids: ["ws_beta", "ws_alpha"],
      signature: key.sign(heartbeatPayload({ hostId, workspaceIds: ["ws_alpha", "ws_beta"] })),
    })

    const [row] = await t.run(async (ctx) => ctx.db.query("host_enrollments").collect())
    expect(row!.acked_workspace_ids).toEqual(["ws_alpha", "ws_beta"])
    expect(row!.acked_at).toBeDefined()
  })
})

describe("Convex workspace assignments", () => {
  test("routes a workspace through owner assignment AND the machine's acked set", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { key, hostId } = await enroll(owner, { displayName: "Laptop B" })

    // Assigning a never-registered workspace cold-registers it, exactly as
    // the retired per-workspace registration did.
    await expect(
      owner.mutation(api.hostEnrollments.assignWorkspace, { workspace_id: "ws_alpha", host_id: hostId }),
    ).resolves.toEqual({ assigned: true, workspace_id: "ws_alpha", host_id: hostId })
    const workspaces = await t.run(async (ctx) => ctx.db.query("workspaces").collect())
    expect(workspaces.map((workspace) => workspace.workspace_id)).toContain("ws_alpha")

    // Owner intent alone is not routable: no ack yet.
    expect(await owner.query(api.hostEnrollments.activeWorkspaceHost, { workspace_id: "ws_alpha" }))
      .toEqual({ active: false })

    // Ack the set: now routable, and the response reconciles owner intent.
    const beat = await owner.mutation(api.hostEnrollments.heartbeat, {
      host_id: hostId,
      workspace_ids: ["ws_alpha"],
      signature: key.sign(heartbeatPayload({ hostId, workspaceIds: ["ws_alpha"] })),
    })
    expect(beat.assigned_workspace_ids).toEqual(["ws_alpha"])
    expect(await owner.query(api.hostEnrollments.activeWorkspaceHost, { workspace_id: "ws_alpha" }))
      .toMatchObject({ active: true, host_id: hostId, workspace_id: "ws_alpha", display_name: "Laptop B" })
    expect(await owner.query(api.hostEnrollments.listAssignments, {})).toMatchObject([
      { host_id: hostId, display_name: "Laptop B", workspace_ids: ["ws_alpha"], acked_workspace_ids: ["ws_alpha"] },
    ])
  })

  test("assigning requires a live enrollment for that machine", async () => {
    const t = convexTest(schema, modules)
    await enroll(asOwner(t))

    await expect(
      asOther(t).mutation(api.hostEnrollments.assignWorkspace, { workspace_id: "ws_alpha", host_id: "host_laptop" }),
    ).rejects.toThrow(/Host enrollment not found/)
  })

  test("unassign wins over a still-acked set: routing is intent AND consent", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { key, hostId } = await enroll(owner)
    await owner.mutation(api.hostEnrollments.assignWorkspace, { workspace_id: "ws_alpha", host_id: hostId })
    await owner.mutation(api.hostEnrollments.heartbeat, {
      host_id: hostId,
      workspace_ids: ["ws_alpha"],
      signature: key.sign(heartbeatPayload({ hostId, workspaceIds: ["ws_alpha"] })),
    })
    expect(await owner.query(api.hostEnrollments.activeWorkspaceHost, { workspace_id: "ws_alpha" }))
      .toMatchObject({ active: true })

    await expect(owner.mutation(api.hostEnrollments.unassignWorkspace, { workspace_id: "ws_alpha" }))
      .resolves.toEqual({ unassigned: true })

    expect(await owner.query(api.hostEnrollments.activeWorkspaceHost, { workspace_id: "ws_alpha" }))
      .toEqual({ active: false })
  })

  test("an expired lease makes the assignment inert without touching it", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { key, hostId } = await enroll(owner)
    await owner.mutation(api.hostEnrollments.assignWorkspace, { workspace_id: "ws_alpha", host_id: hostId })
    await owner.mutation(api.hostEnrollments.heartbeat, {
      host_id: hostId,
      workspace_ids: ["ws_alpha"],
      signature: key.sign(heartbeatPayload({ hostId, workspaceIds: ["ws_alpha"] })),
    })

    // convex-test cannot advance the module's clock, so lapse the lease the
    // way time would: by moving the row's expiry into the past.
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("host_enrollments").collect()
      await ctx.db.patch(row!._id, { expires_at: Date.now() - 1 })
    })

    expect(await owner.query(api.hostEnrollments.activeWorkspaceHost, { workspace_id: "ws_alpha" }))
      .toEqual({ active: false })
    expect(await owner.query(api.hostEnrollments.listAssignments, {})).toEqual([])
    expect(await t.run(async (ctx) => ctx.db.query("host_workspace_assignments").collect())).toHaveLength(1)
  })

  test("marking a second device open lands on the assignment", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { key, hostId } = await enroll(owner)
    await owner.mutation(api.hostEnrollments.assignWorkspace, { workspace_id: "ws_alpha", host_id: hostId })
    await owner.mutation(api.hostEnrollments.heartbeat, {
      host_id: hostId,
      workspace_ids: ["ws_alpha"],
      signature: key.sign(heartbeatPayload({ hostId, workspaceIds: ["ws_alpha"] })),
    })

    const marked = await owner.mutation(api.hostEnrollments.markSecondDeviceOpen, { workspace_id: "ws_alpha" })

    expect(marked.recorded).toBe(true)
    expect(await owner.query(api.hostEnrollments.activeWorkspaceHost, { workspace_id: "ws_alpha" }))
      .toMatchObject({ active: true, second_device_open_at: marked.second_device_open_at })
  })
})

describe("Convex host enrollment pause", () => {
  test("a paused machine stops being active, with the reason", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { hostId } = await enroll(owner)

    await owner.mutation(api.hostEnrollments.pause, { host_id: hostId, paused: true })

    expect(await owner.query(api.hostEnrollments.active, {})).toEqual({ active: false, reason: "paused" })
  })

  test("pausing with no host id pauses every machine this owner enrolled", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    await enroll(owner, { hostId: "host_a" })
    await enroll(owner, { hostId: "host_b" })

    const result = await owner.mutation(api.hostEnrollments.pause, { paused: true })

    expect(result.count).toBe(2)
    expect(await owner.query(api.hostEnrollments.active, {})).toMatchObject({ active: false, reason: "paused" })
  })

  test("pausing does not reach another user's machines", async () => {
    const t = convexTest(schema, modules)
    await enroll(asOwner(t), { hostId: "host_shared" })
    await enroll(asOther(t), { hostId: "host_shared" })

    await asOwner(t).mutation(api.hostEnrollments.pause, { paused: true })

    expect(await asOther(t).query(api.hostEnrollments.active, {})).toMatchObject({ active: true })
  })

  test("re-enrolling clears a pause, because possession was just re-proved", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { hostId, key } = await enroll(owner)
    await owner.mutation(api.hostEnrollments.pause, { host_id: hostId, paused: true })

    await enroll(owner, { hostId, key })

    expect(await owner.query(api.hostEnrollments.active, {})).toMatchObject({ active: true })
  })
})

/**
 * Retention bounds for `host_enrollment_requests` — the Convex half of one
 * policy. `packages/claxedo-server/src/authority/adapters/sqlite/host-enrollment.test.ts`
 * makes the same claims against the SQLite authority, and
 * `host-enrollment-policy-drift.policy.test.ts` fails if the two files stop
 * agreeing on the numbers.
 *
 * These read the TABLE, not the API. Nothing this module returns is a function
 * of how many request rows exist, which is exactly why the table grew forever
 * without anyone noticing: every behavioural test above passed throughout.
 *
 * convex-test does not run crons, so the sweep is invoked directly — the
 * documented way to exercise a scheduled function, and the same thing
 * `idempotency` and `connectionAttempts` do.
 */
describe("host_enrollment_requests retention", () => {
  const CHALLENGE_TTL_MS = 60_000
  const CONSUMED_RETENTION_MS = 10 * 60_000

  function requestRows(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => ctx.db.query("host_enrollment_requests").collect())
  }

  test("an unconsumed request is signable for exactly the canonical challenge TTL", async () => {
    const t = convexTest(schema, modules)
    const before = Date.now()

    const request = await asOwner(t).mutation(api.hostEnrollments.createRequest, { host_id: "host_ttl" })

    // A window, because the module reads its own clock: the assertion is on the
    // TTL, not on the instant.
    expect(request.expires_at - before).toBeGreaterThanOrEqual(CHALLENGE_TTL_MS)
    expect(request.expires_at - before).toBeLessThan(CHALLENGE_TTL_MS + 5_000)
  })

  test("the sweep retires requests past their challenge TTL", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    for (const host_id of ["host_a", "host_b", "host_c"]) {
      await owner.mutation(api.hostEnrollments.createRequest, { host_id })
    }
    expect(await requestRows(t)).toHaveLength(3)

    const swept = await t.mutation(internal.hostEnrollments.sweepExpired, { now: Date.now() + CHALLENGE_TTL_MS + 1 })

    expect(swept).toEqual({ swept: 3 })
    expect(await requestRows(t)).toEqual([])
  })

  test("the sweep leaves a live request alone", async () => {
    const t = convexTest(schema, modules)
    await asOwner(t).mutation(api.hostEnrollments.createRequest, { host_id: "host_live" })

    // A sweep that collected un-expired nonces would break enrollment for
    // anyone whose handshake straddled a tick.
    const swept = await t.mutation(internal.hostEnrollments.sweepExpired, { now: Date.now() })

    expect(swept).toEqual({ swept: 0 })
    expect(await requestRows(t)).toHaveLength(1)
  })

  test("consumed evidence survives the sweep for the full retention window", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { request } = await enroll(owner, { hostId: "host_consumed" })

    // Consumption rewrites `expires_at` from challenge deadline to
    // collectable-at. That rewrite IS the retention window.
    const [consumed] = await requestRows(t)
    expect(consumed!.used_at).toBeDefined()
    expect(consumed!.expires_at - consumed!.used_at!).toBe(CONSUMED_RETENTION_MS)

    // Well past the challenge TTL, well inside retention: sweeping here would
    // destroy the evidence an exact retry has to be answered from.
    const inside = await t.mutation(internal.hostEnrollments.sweepExpired, {
      now: consumed!.used_at! + CONSUMED_RETENTION_MS - 1,
    })
    expect(inside).toEqual({ swept: 0 })
    expect((await requestRows(t)).map((row) => row.request_id)).toContain(request.request_id)

    const after = await t.mutation(internal.hostEnrollments.sweepExpired, {
      now: consumed!.used_at! + CONSUMED_RETENTION_MS + 1,
    })
    expect(after).toEqual({ swept: 1 })
    expect(await requestRows(t)).toEqual([])
  })

  test("a consumed request is still refused inside its retention window", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const key = hostKey()
    const { request, hostId } = await enroll(owner, { hostId: "host_replay", key })

    // The extended `expires_at` must not read as extended VALIDITY. `used_at`
    // is the gate, and it is checked before the expiry.
    await expect(
      owner.mutation(api.hostEnrollments.enroll, {
        host_id: hostId,
        public_key: key.publicKey,
        request_id: request.request_id,
        signature: key.sign(enrollmentPayload({ hostId, requestId: request.request_id, nonce: request.nonce })),
      }),
    ).rejects.toThrow(/Invalid host enrollment request/)
  })

  test("one tick retires at most `limit` rows, and the rest drain on the next", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    for (const host_id of ["host_a", "host_b", "host_c"]) {
      await owner.mutation(api.hostEnrollments.createRequest, { host_id })
    }
    const now = Date.now() + CHALLENGE_TTL_MS + 1

    // Level-triggered, not fire-and-forget: a saturated tick must leave the
    // remainder collectable rather than skipping it forever.
    expect(await t.mutation(internal.hostEnrollments.sweepExpired, { now, limit: 2 })).toEqual({ swept: 2 })
    expect(await requestRows(t)).toHaveLength(1)
    expect(await t.mutation(internal.hostEnrollments.sweepExpired, { now, limit: 2 })).toEqual({ swept: 1 })
    expect(await requestRows(t)).toEqual([])
  })
})
