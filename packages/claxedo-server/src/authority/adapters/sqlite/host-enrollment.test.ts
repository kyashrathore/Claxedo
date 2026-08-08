import { generateKeyPairSync, sign as signData, type KeyObject } from "node:crypto"
import { describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"

/**
 * Machine-wide enrollment, against the real SQLite authority.
 *
 * The behaviour worth pinning is not "enrolling works" — it is the set of
 * things that must NOT work, because each of them is how a remote-access
 * mechanism becomes a way into someone else's laptop: a forged signature, a
 * replayed nonce, another user's enrollment, a paused machine that still
 * answers.
 *
 * It also pins the one property that makes this different from the
 * per-workspace links it replaces: enrolling twice from the same machine
 * updates one row rather than accumulating them, and enrolling creates no
 * workspace.
 */

function signedAuth(subject: string): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: `tok_${subject}`,
    user: { subject, tokenIdentifier: `https://idp.example.test|${subject}`, issuer: "https://idp.example.test" },
  }
}

const owner = signedAuth("user_owner")
const other = signedAuth("user_other")

function authority() {
  return createSqliteWorkspaceAuthority({ path: ":memory:" })
}

function hostKeyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  return { publicKey: JSON.stringify(pair.publicKey.export({ format: "jwk" })), privateKey: pair.privateKey }
}

function signPayload(privateKey: KeyObject, payload: string) {
  return signData("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")
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

/** Runs the whole handshake and returns the enrollment. */
async function enroll(
  api: ReturnType<typeof authority>,
  input: { auth?: SignedControlPlaneAuth; hostId?: string; keys?: ReturnType<typeof hostKeyPair>; displayName?: string } = {},
) {
  const auth = input.auth ?? owner
  const hostId = input.hostId ?? "host_laptop"
  const keys = input.keys ?? hostKeyPair()
  const request = await api.createHostEnrollmentRequest!(auth, { hostId })
  const enrollment = await api.enrollHost!(auth, {
    hostId,
    publicKey: keys.publicKey,
    requestId: request.request_id,
    signature: signPayload(keys.privateKey, enrollmentPayload({ hostId, requestId: request.request_id, nonce: request.nonce })),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  })
  return { enrollment, keys, hostId, request }
}

describe("host enrollment", () => {
  test("enrolls a machine and reports it active", async () => {
    const api = authority()
    const { enrollment, hostId } = await enroll(api, { displayName: "Work laptop" })

    expect(enrollment).toMatchObject({ host_id: hostId, display_name: "Work laptop" })
    expect(await api.activeHostEnrollment!(owner)).toMatchObject({ active: true, host_id: hostId })
  })

  test("never returns the host public key to the owner", async () => {
    // The owner-facing shape carries display state. Key material leaving the
    // authority is how a "show me my machines" screen becomes a key disclosure.
    const api = authority()
    const { enrollment, keys } = await enroll(api)

    expect(JSON.stringify(enrollment)).not.toContain(keys.publicKey)
    expect(JSON.stringify(await api.activeHostEnrollment!(owner))).not.toContain(keys.publicKey)
  })

  test("carries no workspace and creates none", async () => {
    // The point of the change. The per-workspace path it replaces did an
    // implicit INSERT INTO workspaces; enrolling a laptop must own nothing.
    const api = authority()
    const { enrollment } = await enroll(api)

    expect(Object.keys(enrollment)).not.toContain("workspace_id")
    expect(await api.listWorkspaces(owner, {})).toEqual([])
  })

  test("rejects a signature that does not match the request nonce", async () => {
    // The forgery case. Without this check anyone who can call the endpoint
    // enrolls a machine they do not hold the key for.
    const api = authority()
    const keys = hostKeyPair()
    const request = await api.createHostEnrollmentRequest!(owner, { hostId: "host_laptop" })

    await expect(
      api.enrollHost!(owner, {
        hostId: "host_laptop",
        publicKey: keys.publicKey,
        requestId: request.request_id,
        signature: signPayload(keys.privateKey, enrollmentPayload({ hostId: "host_laptop", requestId: request.request_id, nonce: "not-the-nonce" })),
      }),
    ).rejects.toThrow()
  })

  test("rejects a signature made with a different key than the one presented", async () => {
    const api = authority()
    const presented = hostKeyPair()
    const actual = hostKeyPair()
    const request = await api.createHostEnrollmentRequest!(owner, { hostId: "host_laptop" })

    await expect(
      api.enrollHost!(owner, {
        hostId: "host_laptop",
        publicKey: presented.publicKey,
        requestId: request.request_id,
        signature: signPayload(actual.privateKey, enrollmentPayload({ hostId: "host_laptop", requestId: request.request_id, nonce: request.nonce })),
      }),
    ).rejects.toThrow()
  })

  test("a failed signature does not burn the request", async () => {
    // Otherwise anyone able to reach the endpoint can invalidate every
    // enrollment attempt the user makes, simply by answering first with junk.
    const api = authority()
    const keys = hostKeyPair()
    const request = await api.createHostEnrollmentRequest!(owner, { hostId: "host_laptop" })

    await expect(
      api.enrollHost!(owner, { hostId: "host_laptop", publicKey: keys.publicKey, requestId: request.request_id, signature: "bogus" }),
    ).rejects.toThrow()

    await expect(
      api.enrollHost!(owner, {
        hostId: "host_laptop",
        publicKey: keys.publicKey,
        requestId: request.request_id,
        signature: signPayload(keys.privateKey, enrollmentPayload({ hostId: "host_laptop", requestId: request.request_id, nonce: request.nonce })),
      }),
    ).resolves.toMatchObject({ host_id: "host_laptop" })
  })

  test("a request is one-use", async () => {
    const api = authority()
    const { keys, hostId, request } = await enroll(api)

    await expect(
      api.enrollHost!(owner, {
        hostId,
        publicKey: keys.publicKey,
        requestId: request.request_id,
        signature: signPayload(keys.privateKey, enrollmentPayload({ hostId, requestId: request.request_id, nonce: request.nonce })),
      }),
    ).rejects.toThrow(/Invalid host enrollment request/)
  })

  test("another user cannot spend this user's request", async () => {
    const api = authority()
    const keys = hostKeyPair()
    const request = await api.createHostEnrollmentRequest!(owner, { hostId: "host_laptop" })

    await expect(
      api.enrollHost!(other, {
        hostId: "host_laptop",
        publicKey: keys.publicKey,
        requestId: request.request_id,
        signature: signPayload(keys.privateKey, enrollmentPayload({ hostId: "host_laptop", requestId: request.request_id, nonce: request.nonce })),
      }),
    ).rejects.toThrow()
  })

  test("a request is bound to the host it was issued for", async () => {
    const api = authority()
    const keys = hostKeyPair()
    const request = await api.createHostEnrollmentRequest!(owner, { hostId: "host_laptop" })

    await expect(
      api.enrollHost!(owner, {
        hostId: "host_other_machine",
        publicKey: keys.publicKey,
        requestId: request.request_id,
        signature: signPayload(keys.privateKey, enrollmentPayload({ hostId: "host_other_machine", requestId: request.request_id, nonce: request.nonce })),
      }),
    ).rejects.toThrow()
  })

  test("re-enrolling the same machine updates one row rather than adding another", async () => {
    // The rule the UNIQUE constraint exists for. Accumulating rows per attempt
    // is how the per-workspace design ended up with a machine registered
    // twelve times.
    const api = authority()
    const first = await enroll(api, { displayName: "Laptop" })
    const second = await enroll(api, { hostId: first.hostId, displayName: "Laptop renamed" })

    expect(second.enrollment.host_id).toBe(first.hostId)
    expect(second.enrollment.display_name).toBe("Laptop renamed")
    expect(await api.activeHostEnrollment!(owner)).toMatchObject({ active: true, host_id: first.hostId })
  })

  test("two users may enroll the same machine id independently", async () => {
    // Uniqueness is per (owner, host), not per host. A shared machine is not
    // one user's to claim.
    const api = authority()
    await enroll(api, { auth: owner, hostId: "host_shared" })
    await enroll(api, { auth: other, hostId: "host_shared" })

    expect(await api.activeHostEnrollment!(owner)).toMatchObject({ active: true })
    expect(await api.activeHostEnrollment!(other)).toMatchObject({ active: true })
  })

  test("reports not-enrolled for a user with no machines", async () => {
    expect(await authority().activeHostEnrollment!(owner)).toEqual({ active: false, reason: "not-enrolled" })
  })

  test("does not report another user's machine as active", async () => {
    const api = authority()
    await enroll(api, { auth: owner })

    expect(await api.activeHostEnrollment!(other)).toEqual({ active: false, reason: "not-enrolled" })
  })
})

describe("heartbeat", () => {
  test("extends the enrollment when signed with the enrolled key", async () => {
    const api = authority()
    const { keys, hostId, enrollment } = await enroll(api)

    const beat = await api.heartbeatHostEnrollment!(owner, {
      hostId,
      signature: signPayload(keys.privateKey, heartbeatPayload({ hostId })),
    })

    expect(beat.expires_at).toBeGreaterThanOrEqual(enrollment.expires_at)
  })

  test("rejects a heartbeat signed with a different key", async () => {
    // Otherwise anyone can keep a revoked machine's enrollment alive.
    const api = authority()
    const { hostId } = await enroll(api)
    const attacker = hostKeyPair()

    await expect(
      api.heartbeatHostEnrollment!(owner, {
        hostId,
        signature: signPayload(attacker.privateKey, heartbeatPayload({ hostId })),
      }),
    ).rejects.toThrow()
  })

  test("rejects a heartbeat for a machine that was never enrolled", async () => {
    const api = authority()
    const keys = hostKeyPair()

    await expect(
      api.heartbeatHostEnrollment!(owner, {
        hostId: "host_ghost",
        signature: signPayload(keys.privateKey, heartbeatPayload({ hostId: "host_ghost" })),
      }),
    ).rejects.toThrow(/Host enrollment not found/)
  })
})

describe("pause", () => {
  test("a paused machine stops being active, with the reason", async () => {
    const api = authority()
    const { hostId } = await enroll(api)

    await api.pauseHostEnrollment!(owner, { hostId, paused: true })

    expect(await api.activeHostEnrollment!(owner)).toEqual({ active: false, reason: "paused" })
  })

  test("pausing with no host id pauses every machine, which is what the switch means", async () => {
    const api = authority()
    await enroll(api, { hostId: "host_a" })
    await enroll(api, { hostId: "host_b" })

    await api.pauseHostEnrollment!(owner, { paused: true })

    expect(await api.activeHostEnrollment!(owner)).toMatchObject({ active: false, reason: "paused" })
  })

  test("does not reach another user's machines", async () => {
    const api = authority()
    await enroll(api, { auth: owner, hostId: "host_shared" })
    await enroll(api, { auth: other, hostId: "host_shared" })

    await api.pauseHostEnrollment!(owner, { paused: true })

    expect(await api.activeHostEnrollment!(other)).toMatchObject({ active: true })
  })

  test("resuming restores it", async () => {
    const api = authority()
    const { hostId } = await enroll(api)
    await api.pauseHostEnrollment!(owner, { hostId, paused: true })

    await api.pauseHostEnrollment!(owner, { hostId, paused: false })

    expect(await api.activeHostEnrollment!(owner)).toMatchObject({ active: true })
  })

  test("re-enrolling clears a pause, because possession was just re-proved", async () => {
    const api = authority()
    const { hostId, keys } = await enroll(api)
    await api.pauseHostEnrollment!(owner, { hostId, paused: true })

    await enroll(api, { hostId, keys })

    expect(await api.activeHostEnrollment!(owner)).toMatchObject({ active: true })
  })
})
