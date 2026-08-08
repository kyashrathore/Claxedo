import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto"
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

function heartbeatPayload(input: { hostId: string; ttlMs?: number }) {
  return ["claxedo.host-enrollment.heartbeat.v1", `host_id=${input.hostId}`, `ttl_ms=${input.ttlMs ?? ""}`].join("\n")
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
      signature: key.sign(heartbeatPayload({ hostId })),
    })

    expect(beat.expires_at).toBeGreaterThanOrEqual(enrollment.expires_at)
  })

  test("rejects a heartbeat signed with a different key", async () => {
    const t = convexTest(schema, modules)
    const owner = asOwner(t)
    const { hostId } = await enroll(owner)
    const attacker = hostKey()

    await expect(
      owner.mutation(api.hostEnrollments.heartbeat, {
        host_id: hostId,
        signature: attacker.sign(heartbeatPayload({ hostId })),
      }),
    ).rejects.toThrow()
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
