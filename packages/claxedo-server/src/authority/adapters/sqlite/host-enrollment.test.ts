import { generateKeyPairSync, sign as signData, type KeyObject } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, test, vi } from "vitest"
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

/**
 * Heartbeat v2: one signature per interval covers the machine's served set
 * (sorted, comma-joined). Deliberately spelled out here rather than imported —
 * the test pins the exact bytes the adapter must verify.
 */
function heartbeatPayload(input: { hostId: string; ttlMs?: number; workspaceIds?: readonly string[] }) {
  return [
    "claxedo.host-enrollment.heartbeat.v2",
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
    `workspaces=${[...(input.workspaceIds ?? [])].sort().join(",")}`,
  ].join("\n")
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
    expect(await api.listWorkspaces(owner)).toEqual([])
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
      workspaceIds: [],
      signature: signPayload(keys.privateKey, heartbeatPayload({ hostId })),
    })

    expect(beat.expires_at).toBeGreaterThanOrEqual(enrollment.expires_at)
    expect(beat.assigned_workspace_ids).toEqual([])
  })

  test("rejects a heartbeat signed with a different key", async () => {
    // Otherwise anyone can keep a revoked machine's enrollment alive.
    const api = authority()
    const { hostId } = await enroll(api)
    const attacker = hostKeyPair()

    await expect(
      api.heartbeatHostEnrollment!(owner, {
        hostId,
        workspaceIds: [],
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
        workspaceIds: [],
        signature: signPayload(keys.privateKey, heartbeatPayload({ hostId: "host_ghost" })),
      }),
    ).rejects.toThrow(/Host enrollment not found/)
  })

  test("rejects a signature over a different served set than the one claimed", async () => {
    // The set IS the consent. Accepting a mismatch would let a caller ack
    // workspaces the machine never signed for.
    const api = authority()
    const { keys, hostId } = await enroll(api)

    await expect(
      api.heartbeatHostEnrollment!(owner, {
        hostId,
        workspaceIds: ["ws_claimed"],
        signature: signPayload(keys.privateKey, heartbeatPayload({ hostId, workspaceIds: [] })),
      }),
    ).rejects.toThrow(/Invalid host attestation/)
  })
})

/** Signs and sends a heartbeat that acks exactly `workspaceIds`. */
async function ackHeartbeat(
  api: ReturnType<typeof authority>,
  input: {
    auth?: SignedControlPlaneAuth
    hostId: string
    keys: ReturnType<typeof hostKeyPair>
    workspaceIds: readonly string[]
    ttlMs?: number
    sessionAuthority?: "local" | "managed-private"
  },
) {
  return api.heartbeatHostEnrollment!(input.auth ?? owner, {
    hostId: input.hostId,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    workspaceIds: [...input.workspaceIds],
    ...(input.sessionAuthority ? { sessionAuthority: input.sessionAuthority } : {}),
    signature: signPayload(
      input.keys.privateKey,
      heartbeatPayload({ hostId: input.hostId, ttlMs: input.ttlMs, workspaceIds: input.workspaceIds }),
    ),
  })
}

describe("workspace assignments", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("assigning an existing workspace records the machine's description of it", async () => {
    const api = authority()
    const { hostId } = await enroll(api, { displayName: "Laptop B" })
    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_desc", hostId })
    await api.assignWorkspaceHost!(owner, {
      workspaceId: "ws_desc",
      hostId,
      displayName: "Claxedo",
      repoName: "Claxedo",
      gitBranch: "dev",
      remoteDirectory: "/Users/me/test/opencode",
    })
    const rows = await api.listWorkspaces(owner) as Array<Record<string, unknown>>
    expect(rows.find((w) => w.workspace_id === "ws_desc")).toMatchObject({
      display_name: "Claxedo",
      remote_directory: "/Users/me/test/opencode",
    })
    expect((await api.openWorkspace(owner, { workspaceId: "ws_desc" })).workspace).toMatchObject({
      display_name: "Claxedo",
      repo_name: "Claxedo",
      git_branch: "dev",
    })
    // A later assignment that says nothing leaves the description alone.
    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_desc", hostId })
    const again = await api.listWorkspaces(owner) as Array<Record<string, unknown>>
    expect(again.find((w) => w.workspace_id === "ws_desc")).toMatchObject({ display_name: "Claxedo", remote_directory: "/Users/me/test/opencode" })
  })

  test("a user-hosted workspace lives exactly as long as its host assignment", async () => {
    const api = authority()
    const { hostId } = await enroll(api, { displayName: "Laptop B" })
    const listed = async () => (await api.listWorkspaces(owner) as Array<{ workspace_id: string }>)
      .map((row) => row.workspace_id).sort()

    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_shared", hostId, displayName: "Shared" })
    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_kept", hostId })
    expect(await listed()).toEqual(["ws_kept", "ws_shared"])

    await expect(api.unassignWorkspaceHost!(owner, { workspaceId: "ws_shared" })).resolves.toEqual({ unassigned: true })
    expect(await listed()).toEqual(["ws_kept"])
    await expect(api.openWorkspace(owner, { workspaceId: "ws_shared" })).rejects.toThrow()

    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_shared", hostId })
    expect(await listed()).toEqual(["ws_kept", "ws_shared"])
    expect((await api.openWorkspace(owner, { workspaceId: "ws_shared" })).workspace).toMatchObject({ display_name: "Shared" })

    await api.revokeHostEnrollment!(owner, { hostId })
    expect(await listed()).toEqual([])
  })

  /**
   * The rail must be able to say "host offline" for a shared workspace before
   * any pane opens it, so reachability rides the workspace LIST rather than a
   * per-workspace probe. Same lease `activeWorkspaceHost` routes on.
   */
  test("stamps host reachability on every user-hosted row of the workspace list", async () => {
    const api = authority()
    const { keys, hostId } = await enroll(api, { displayName: "Laptop B" })
    const listed = async () => Object.fromEntries(
      (await api.listWorkspaces(owner) as Array<{ workspace_id: string; host_online?: boolean }>)
        .map((row) => [row.workspace_id, row.host_online]),
    )

    // Assigned but never acked: listed, and honestly offline.
    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_reach", hostId })
    expect(await listed()).toEqual({ ws_reach: false })

    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_reach"] })
    expect(await listed()).toEqual({ ws_reach: true })

    // Pausing the machine is what makes it unreachable — no revoke, no unassign.
    await api.pauseHostEnrollment!(owner, { hostId, paused: true })
    expect(await listed()).toEqual({ ws_reach: false })
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_reach" })).toEqual({ active: false })
  })

  test("routes a workspace through owner assignment AND the machine's acked set", async () => {
    const api = authority()
    const { keys, hostId } = await enroll(api, { displayName: "Laptop B" })

    // Assigning a never-registered workspace cold-registers it, exactly as
    // the retired per-workspace registration did.
    await expect(api.assignWorkspaceHost!(owner, { workspaceId: "ws_alpha", hostId }))
      .resolves.toEqual({ assigned: true, workspace_id: "ws_alpha", host_id: hostId })
    expect((await api.listWorkspaces(owner) as Array<{ workspace_id: string }>).map((w) => w.workspace_id))
      .toContain("ws_alpha")

    // Owner intent alone is not routable: no ack yet.
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" })).toEqual({ active: false })

    // Ack the set: now routable, and the response reconciles owner intent.
    const beat = await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"] })
    expect(beat.assigned_workspace_ids).toEqual(["ws_alpha"])
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" })).toMatchObject({
      active: true,
      host_id: hostId,
      workspace_id: "ws_alpha",
      display_name: "Laptop B",
    })
    expect(await api.listHostAssignments!(owner)).toMatchObject([
      { host_id: hostId, display_name: "Laptop B", workspace_ids: ["ws_alpha"], acked_workspace_ids: ["ws_alpha"] },
    ])
  })

  test("reports the session composition the machine declared, for either flavour", async () => {
    // The control plane cannot derive this. The same product composes either
    // flavour depending on whether a session authority was injected, so the
    // routing answer carries back exactly what the machine said and nothing
    // else. Both values are exercised because a passthrough that hard-coded
    // one of them would still satisfy a single-value test.
    for (const declared of ["local", "managed-private"] as const) {
      const api = authority()
      const { keys, hostId } = await enroll(api)
      await api.assignWorkspaceHost!(owner, { workspaceId: "ws_alpha", hostId })
      await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"], sessionAuthority: declared })

      expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" }))
        .toMatchObject({ active: true, session_authority: declared })
    }
  })

  test("a machine that declared no composition routes with none, rather than a default", async () => {
    // The failure this replaces was a control plane that answered "local" for
    // every user-hosted workspace. Silence must stay silence all the way to
    // the mint: a caller that reads a value here would be reading a guess.
    const api = authority()
    const { keys, hostId } = await enroll(api)
    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_alpha", hostId })
    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"] })

    const routed = await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" })
    expect(routed).toMatchObject({ active: true })
    expect(routed).not.toHaveProperty("session_authority")
  })

  test("a later beat replaces the declared composition instead of accumulating one", async () => {
    // A host that restarts into a different composition — an unsigned daemon
    // that gains an injected session authority — must answer with the
    // composition of its LATEST beat, and one that stops declaring must go
    // back to undeclared.
    const api = authority()
    const { keys, hostId } = await enroll(api)
    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_alpha", hostId })

    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"], sessionAuthority: "managed-private" })
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" }))
      .toMatchObject({ session_authority: "managed-private" })

    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"], sessionAuthority: "local" })
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" }))
      .toMatchObject({ session_authority: "local" })

    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"] })
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" }))
      .not.toHaveProperty("session_authority")
  })

  test("assigning requires a live enrollment for that machine", async () => {
    const api = authority()
    await enroll(api, { auth: owner })

    // `other` never enrolled this machine; the assignment must not exist as a
    // way to piggyback on someone else's laptop.
    await expect(api.assignWorkspaceHost!(other, { workspaceId: "ws_alpha", hostId: "host_laptop" }))
      .rejects.toThrow(/Host enrollment not found/)
  })

  test("a failed assignment strands no cold-registered workspace", async () => {
    // Cold registration makes assigning a two-write operation, and the writes
    // are not independent: the workspace row exists only to be assigned. If
    // the first commits while the second fails, the owner is left with a
    // user-hosted workspace no machine serves — visible in the workspace list
    // as a share that does not work, and unreachable by retry, because the
    // second attempt now finds an `existing` row and takes the authorize
    // branch instead of re-registering.
    //
    // Forced at the second statement with a trigger on a second connection,
    // the same device the retired registration path's rollback test used.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-assign-rollback-")), "authority.db")
    const api = createSqliteWorkspaceAuthority({ path: file })
    const reader = new Database(file, { readonly: false })
    const { keys, hostId } = await enroll(api)
    reader.exec(`
      CREATE TRIGGER fail_assignment BEFORE INSERT ON host_workspace_assignments
      BEGIN SELECT RAISE(FAIL, 'forced assignment failure'); END
    `)

    await expect(api.assignWorkspaceHost!(owner, { workspaceId: "ws_cold", hostId }))
      .rejects.toThrow(/forced assignment failure/)

    // The whole operation rolled back: no workspace, no assignment, and
    // nothing in the owner's list to explain.
    expect(reader.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE workspace_id = ?`).get("ws_cold"))
      .toEqual({ n: 0 })
    expect(reader.prepare(`SELECT COUNT(*) AS n FROM host_workspace_assignments`).get()).toEqual({ n: 0 })
    expect((await api.listWorkspaces(owner) as Array<{ workspace_id: string }>).map((w) => w.workspace_id))
      .not.toContain("ws_cold")

    // And the retry still takes the cold-register path, which is the property
    // a half-committed first attempt would have destroyed.
    reader.exec(`DROP TRIGGER fail_assignment`)
    await expect(api.assignWorkspaceHost!(owner, { workspaceId: "ws_cold", hostId }))
      .resolves.toEqual({ assigned: true, workspace_id: "ws_cold", host_id: hostId })
    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_cold"] })
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_cold" })).toMatchObject({
      active: true,
      workspace_id: "ws_cold",
      host_id: hostId,
    })
  })

  test("unassign wins over a still-acked set: routing is intent AND consent", async () => {
    const api = authority()
    const { keys, hostId } = await enroll(api)
    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_alpha", hostId })
    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"] })
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" })).toMatchObject({ active: true })

    await expect(api.unassignWorkspaceHost!(owner, { workspaceId: "ws_alpha" }))
      .resolves.toEqual({ unassigned: true })

    // Unsharing retires the workspace: nothing is routable because nothing is listed.
    await expect(api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" })).rejects.toThrow("Workspace not found")
    expect(await api.listWorkspaces(owner)).toEqual([])
  })

  test("an expired lease makes everything inert without touching assignments", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const api = authority()
    const { keys, hostId } = await enroll(api)
    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_alpha", hostId })
    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"], ttlMs: 8_000 })
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" })).toMatchObject({ active: true })

    vi.setSystemTime(1_000_000 + 8_001)

    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" })).toEqual({ active: false })
    expect(await api.listHostAssignments!(owner)).toEqual([])

    // The assignment survived the lapse: one fresh ack restores routing with
    // no owner action.
    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"] })
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" })).toMatchObject({ active: true })
  })

  test("revoking the enrollment cascades its assignments away entirely", async () => {
    // Table-level assertion over a second connection, because nothing the
    // authority returns is a function of dangling assignment rows.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-assignments-")), "authority.db")
    const api = createSqliteWorkspaceAuthority({ path: file })
    const reader = new Database(file, { readonly: false })
    const { keys, hostId } = await enroll(api)
    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_alpha", hostId })
    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"] })

    await api.revokeHostEnrollment(owner, { hostId })

    const dangling = reader.prepare(`SELECT COUNT(*) AS n FROM host_workspace_assignments`).get() as { n: number }
    expect(dangling.n).toBe(0)
    expect(await api.activeHostEnrollment!(owner)).toEqual({ active: false, reason: "revoked" })
    // The machine's workspaces go with it.
    await expect(api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" })).rejects.toThrow("Workspace not found")
    expect(await api.listWorkspaces(owner)).toEqual([])
  })

  test("marking a second device open lands on the assignment", async () => {
    const api = authority()
    const { keys, hostId } = await enroll(api)
    await api.assignWorkspaceHost!(owner, { workspaceId: "ws_alpha", hostId })
    await ackHeartbeat(api, { hostId, keys, workspaceIds: ["ws_alpha"] })

    const marked = await api.markSecondDeviceOpen!(owner, { workspaceId: "ws_alpha" })

    expect(marked.recorded).toBe(true)
    expect(await api.activeWorkspaceHost!(owner, { workspaceId: "ws_alpha" })).toMatchObject({
      active: true,
      second_device_open_at: marked.second_device_open_at,
    })
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

/**
 * Retention bounds for `host_enrollment_requests`.
 *
 * These read the TABLE, not the API. Nothing this authority returns is a
 * function of how many request rows exist, which is exactly why the table grew
 * forever without anyone noticing: every behavioural test passed throughout. So
 * the assertion has to be a row count, taken over a second connection to the
 * same file.
 */
describe("host_enrollment_requests retention", () => {
  const CHALLENGE_TTL_MS = 60_000
  const CONSUMED_RETENTION_MS = 10 * 60_000

  function fileAuthority() {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-enrollment-")), "authority.db")
    return { api: createSqliteWorkspaceAuthority({ path: file }), reader: new Database(file, { readonly: false }) }
  }

  function requestRows(reader: InstanceType<typeof Database>) {
    return reader
      .prepare(`SELECT request_id, used_at, expires_at FROM host_enrollment_requests ORDER BY expires_at`)
      .all() as Array<{ request_id: string; used_at: number | null; expires_at: number }>
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  test("an unconsumed request is signable for exactly the canonical challenge TTL", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { api } = fileAuthority()

    const request = await api.createHostEnrollmentRequest!(owner, { hostId: "host_ttl" })

    expect(request.expires_at).toBe(1_000_000 + CHALLENGE_TTL_MS)
  })

  test("creating a request prunes requests that have passed their challenge TTL", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { api, reader } = fileAuthority()
    for (const hostId of ["host_a", "host_b", "host_c"]) {
      await api.createHostEnrollmentRequest!(owner, { hostId })
    }
    expect(requestRows(reader)).toHaveLength(3)

    // One tick past the TTL — the first instant at which every row above is
    // collectable — then one more nonce to carry the prune.
    vi.setSystemTime(1_000_000 + CHALLENGE_TTL_MS + 1)
    await api.createHostEnrollmentRequest!(owner, { hostId: "host_d" })

    // Only the new one. Before the prune this was 4, then 5, then 6 — the
    // table's whole history, forever.
    const rows = requestRows(reader)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.expires_at).toBe(1_000_000 + CHALLENGE_TTL_MS + 1 + CHALLENGE_TTL_MS)
  })

  test("a live request is not pruned by another account's request", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { api, reader } = fileAuthority()
    await api.createHostEnrollmentRequest!(owner, { hostId: "host_live" })

    vi.setSystemTime(1_000_000 + CHALLENGE_TTL_MS - 1)
    await api.createHostEnrollmentRequest!(other, { hostId: "host_other" })

    // A prune that collected un-expired nonces would break enrollment for
    // everyone whose handshake straddled someone else's request.
    expect(requestRows(reader)).toHaveLength(2)
  })

  test("consumed evidence survives the prune for the full retention window", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { api, reader } = fileAuthority()
    const { request } = await enroll(api, { hostId: "host_consumed" })

    // Consumption rewrites `expires_at` from challenge deadline to
    // collectable-at. That rewrite IS the retention window.
    const consumed = requestRows(reader).find((row) => row.request_id === request.request_id)!
    expect(consumed.used_at).toBe(1_000_000)
    expect(consumed.expires_at).toBe(1_000_000 + CONSUMED_RETENTION_MS)

    // Well past the challenge TTL, well inside retention: a prune here would
    // destroy the evidence an exact retry has to be answered from.
    vi.setSystemTime(1_000_000 + CONSUMED_RETENTION_MS - 1)
    await api.createHostEnrollmentRequest!(owner, { hostId: "host_carrier" })
    expect(requestRows(reader).map((row) => row.request_id)).toContain(request.request_id)

    vi.setSystemTime(1_000_000 + CONSUMED_RETENTION_MS + 1)
    await api.createHostEnrollmentRequest!(owner, { hostId: "host_carrier_2" })
    expect(requestRows(reader).map((row) => row.request_id)).not.toContain(request.request_id)
  })

  test("a consumed request is still refused inside its retention window", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { api } = fileAuthority()
    const { request, keys, hostId } = await enroll(api, { hostId: "host_replay" })

    // The extended `expires_at` must not read as extended VALIDITY. `used_at`
    // is the gate, and it is checked before the expiry.
    vi.setSystemTime(1_000_000 + CHALLENGE_TTL_MS + 1)
    await expect(
      api.enrollHost!(owner, {
        hostId,
        publicKey: keys.publicKey,
        requestId: request.request_id,
        signature: signPayload(
          keys.privateKey,
          enrollmentPayload({ hostId, requestId: request.request_id, nonce: request.nonce }),
        ),
      }),
    ).rejects.toThrow(/Invalid host enrollment request/)
  })
})
