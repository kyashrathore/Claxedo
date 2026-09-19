/**
 * A control plane that enforces the P1 contracts, for this package's tests
 * and, through the `./test-support` entry, for every consumer's.
 *
 * Strict on purpose: it refuses a reused nonce, a stale timestamp, a bad
 * signature, a superseded generation, a stale ack revision, an occupied host
 * id, a folder outside the scope, and answers `resumed` only for the same key
 * AND host id. A permissive fake here would let every one of the connector's
 * guarantees pass untested — the tests are only as strong as this file's
 * refusals, and the refusal codes are the control plane's own
 * (`claxedo-server-core/src/platform/auth/machine-auth.ts`).
 *
 * The machine routes are owned here. Anything else — the owner's routes a
 * signed-in CLI drives with a bearer — is composed over it by the consumer
 * through `owner`, against the state this fake exposes.
 *
 * Web Crypto only, like the code under test, so it runs wherever the package
 * does.
 */

import { redeemInvitation } from "./bootstrap"
import {
  base64url,
  base64urlDecode,
  createHostKeyPair,
  hostInvitationRedeemPayload,
  hostKeyPairFromJwk,
  hostMachineRequestPayload,
  hostPublicKeyFingerprint,
  hostSha256Hex,
  MACHINE_REQUEST_HEADERS,
  newHostId,
  publicKeyJwk,
} from "./host-identity"
import { createHostStateStore, isPlainRecord, newHostState, normalizeAbsolutePath, pathWithinRoots, type HostStateFs } from "./host-state"
import type { FetchLike } from "./machine-transport"

const SKEW_MS = 60_000
const NONCE_TTL_MS = 120_000
const LEASE_MS = 60_000
const TUNNEL_TOKEN_TTL_MS = 5 * 60_000

export type FakeScope = { revision: number; allowed_roots: string[]; visibility: "owner" | "org" }

export type FakeEnrollment = {
  enrollment_id: string
  host_id: string
  display_name: string
  owner: string
  public_key: JsonWebKey
  fingerprint: string
  key_version: number
  serving_generation: number
  /** Absent for a machine the owner enrolled through their account: that path grants no roots. */
  scope?: FakeScope
  expires_at: number
  last_seen_at: number
  revoked_at?: number
  paused_at?: number
  created_at: number
}

type Invitation = {
  invitation_id: string
  secret_hash: string
  owner: string
  display_name: string
  scope: FakeScope
  expires_at: number
  revoked_at?: number
  redeemed_at?: number
  redeemed_host_id?: string
  redeemed_public_key_fingerprint?: string
  redeemed_enrollment_id?: string
}

export type FakeAssignment = {
  workspace_id: string
  enrollment_id: string
  host_id: string
  /**
   * Absent when the owner assigned the workspace without naming a directory.
   * The row exists and the workspace counts as assigned, but there is no
   * description to hand the machine, so it can never ack it.
   */
  remote_directory?: string
  display_name?: string
  revision: number
}

export type FakeReadiness = { enrollment_id: string; generation: number; revision: number }

export class FakeRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export type FakeOwnerRequest = { method: string; url: URL; headers: Headers; body: Record<string, unknown> }

let ids = 0
const nextId = (prefix: string) => `${prefix}_${(++ids).toString(36)}`

async function verify(publicKey: JsonWebKey, payload: string, signature: string) {
  const key = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64urlDecode(signature),
      new TextEncoder().encode(payload),
    )
  } catch {
    return false
  }
}

/** The relay stub reads the workspace claim back out of the token the host presents. */
export function decodeFakeTunnelToken(token: string): { workspace_ids: string[]; enrollment_id: string; generation: number } {
  const [prefix, body] = token.split(".")
  if (prefix !== "htt" || !body) throw new Error(`not a fake host tunnel token: ${token}`)
  const parsed: unknown = JSON.parse(new TextDecoder().decode(base64urlDecode(body)))
  const claim = isPlainRecord(parsed) ? parsed : {}
  return {
    workspace_ids: Array.isArray(claim.workspace_ids) ? claim.workspace_ids.filter((id): id is string => typeof id === "string") : [],
    enrollment_id: typeof claim.enrollment_id === "string" ? claim.enrollment_id : "",
    generation: typeof claim.generation === "number" ? claim.generation : -1,
  }
}

export function createFakeControlPlane(
  options: {
    now?: () => number
    url?: string
    relayUrl?: string
    /** Every request that is not a machine route; absent, they are 404. A `FakeRefusal` thrown here is answered as its status. */
    owner?: (request: FakeOwnerRequest) => unknown
  } = {},
) {
  const now = options.now ?? (() => Date.now())
  const url = options.url ?? "https://control-plane.test"
  const relayUrl = options.relayUrl ?? "https://relay.test"
  const enrollments = new Map<string, FakeEnrollment>()
  const invitations = new Map<string, Invitation>()
  const assignments = new Map<string, FakeAssignment>()
  const readiness = new Map<string, FakeReadiness>()
  const nonces = new Map<string, number>()
  const log: Array<{ method: string; path: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const faults = {
    /** Commit the redeem, then fail the response as a dropped connection. */
    dropRedeemResponse: false,
    /** Answer every machine route with this status instead (a deploy window). */
    unavailable: undefined as number | undefined,
  }

  const routable = (enrollment: FakeEnrollment) =>
    [...assignments.values()]
      .filter((assignment) => assignment.enrollment_id === enrollment.enrollment_id)
      .filter((assignment) => {
        const ready = readiness.get(assignment.workspace_id)
        return (
          ready !== undefined &&
          ready.enrollment_id === enrollment.enrollment_id &&
          ready.generation === enrollment.serving_generation &&
          ready.revision === assignment.revision &&
          enrollment.expires_at > now()
        )
      })
      .map((assignment) => assignment.workspace_id)
      .sort()

  /** The real route's shape: the signer's result plus `hostId`, `workspaceIds`, `relayUrl`, with a decodable claim. */
  const hostTunnel = (enrollment: FakeEnrollment) => {
    const workspaceIds = routable(enrollment)
    if (workspaceIds.length === 0) return undefined
    const claim = { workspace_ids: workspaceIds, enrollment_id: enrollment.enrollment_id, generation: enrollment.serving_generation }
    return {
      hostTunnelToken: `htt.${base64url(new TextEncoder().encode(JSON.stringify(claim)))}`,
      tokenExpiresAt: now() + TUNNEL_TOKEN_TTL_MS,
      jti: nextId("jti"),
      hostId: enrollment.host_id,
      workspaceIds,
      relayUrl,
    }
  }

  const endpoints = () => ({
    relay: { url: relayUrl, jwks_url: `${relayUrl}/.well-known/jwks.json` },
    authority: { session_authority_url: `${url}/api/runtime-authority/session-authorize` },
  })

  /**
   * The control plane's check order: headers, clock, then everything that
   * needs the row answers one 401 until the signature has verified, so an
   * unsigned caller learns nothing about the row; the 403 eligibility
   * decisions come after.
   */
  const verifyMachine = async (request: { pathname: string; headers: Headers; bodyText: string; body: Record<string, unknown> }) => {
    const enrollmentId = request.headers.get(MACHINE_REQUEST_HEADERS.enrollmentId)
    const tsHeader = request.headers.get(MACHINE_REQUEST_HEADERS.ts)
    const nonce = request.headers.get(MACHINE_REQUEST_HEADERS.nonce)
    const signature = request.headers.get(MACHINE_REQUEST_HEADERS.signature)
    if (!enrollmentId || !tsHeader || !nonce || !signature || !/^\d+$/.test(tsHeader)) {
      throw new FakeRefusal(400, "machine_headers_invalid")
    }
    if (nonce.length < 16 || nonce.length > 64 || !/^[A-Za-z0-9_-]+$/.test(nonce)) {
      throw new FakeRefusal(400, "machine_headers_invalid")
    }
    const ts = Number(tsHeader)
    if (Math.abs(now() - ts) > SKEW_MS) throw new FakeRefusal(401, "machine_timestamp_skew")
    const enrollment = enrollments.get(enrollmentId)
    if (!enrollment) throw new FakeRefusal(401, "machine_request_denied")
    if (request.body.enrollmentId !== undefined && request.body.enrollmentId !== enrollmentId) {
      throw new FakeRefusal(400, "machine_body_invalid")
    }
    if (request.body.hostId !== undefined && request.body.hostId !== enrollment.host_id) {
      throw new FakeRefusal(400, "machine_body_invalid")
    }
    const payload = await hostMachineRequestPayload({
      method: "POST",
      pathname: request.pathname,
      bodyText: request.bodyText,
      ts,
      nonce,
      enrollmentId,
    })
    if (!(await verify(enrollment.public_key, payload, signature))) throw new FakeRefusal(401, "machine_request_denied")
    for (const [key, expiresAt] of nonces) if (expiresAt <= now()) nonces.delete(key)
    const nonceKey = `${enrollmentId}:${nonce}`
    if (nonces.has(nonceKey)) throw new FakeRefusal(401, "machine_nonce_replayed")
    nonces.set(nonceKey, ts + NONCE_TTL_MS)
    if (enrollment.revoked_at !== undefined) throw new FakeRefusal(403, "enrollment_revoked")
    if (enrollment.paused_at !== undefined) throw new FakeRefusal(403, "enrollment_paused")
    if (request.body.keyVersion !== undefined && request.body.keyVersion !== enrollment.key_version) {
      throw new FakeRefusal(403, "enrollment_key_version_mismatch")
    }
    return enrollment
  }

  const acquire = (enrollment: FakeEnrollment) => {
    enrollment.serving_generation += 1
    for (const [workspaceId, ready] of readiness) {
      if (ready.enrollment_id === enrollment.enrollment_id && ready.generation < enrollment.serving_generation) {
        readiness.delete(workspaceId)
      }
    }
    return { generation: enrollment.serving_generation, generation_acquired_at: now() }
  }

  const heartbeat = (enrollment: FakeEnrollment, body: Record<string, unknown>) => {
    if (typeof body.generation !== "number" || body.generation > enrollment.serving_generation) {
      throw new FakeRefusal(400, "invalid_input")
    }
    if (body.generation < enrollment.serving_generation) throw new FakeRefusal(409, "enrollment_generation_superseded")
    const acks = (Array.isArray(body.acks) ? body.acks : [])
      .filter(isPlainRecord)
      .map((ack) => ({
        workspaceId: typeof ack.workspaceId === "string" ? ack.workspaceId : "",
        revision: typeof ack.revision === "number" ? ack.revision : -1,
      }))
    const mine = [...assignments.values()].filter((assignment) => assignment.enrollment_id === enrollment.enrollment_id)
    for (const ack of acks) {
      const assignment = mine.find((entry) => entry.workspace_id === ack.workspaceId)
      // A stale revision is not readiness for anything: the host is
      // describing a directory the owner has already moved on from.
      if (!assignment || assignment.revision !== ack.revision) continue
      readiness.set(ack.workspaceId, {
        enrollment_id: enrollment.enrollment_id,
        generation: enrollment.serving_generation,
        revision: ack.revision,
      })
    }
    const ackedIds = new Set(acks.map((ack) => ack.workspaceId))
    for (const [workspaceId, ready] of readiness) {
      if (ready.enrollment_id === enrollment.enrollment_id && !ackedIds.has(workspaceId)) readiness.delete(workspaceId)
    }
    enrollment.expires_at = now() + LEASE_MS
    enrollment.last_seen_at = now()
    const credential = hostTunnel(enrollment)
    return {
      expires_at: enrollment.expires_at,
      last_seen_at: enrollment.last_seen_at,
      assignments: mine.flatMap((assignment) => assignment.remote_directory === undefined ? [] : [{
        workspace_id: assignment.workspace_id,
        remote_directory: assignment.remote_directory,
        ...(assignment.display_name ? { display_name: assignment.display_name } : {}),
        revision: assignment.revision,
      }]),
      ...(enrollment.scope ? { scope: enrollment.scope } : {}),
      assigned_workspace_ids: mine.map((assignment) => assignment.workspace_id).sort(),
      ...(credential ? { hostTunnel: credential } : {}),
      ...endpoints(),
    }
  }

  const redeemResponse = (enrollment: FakeEnrollment, resumed: boolean) => {
    // An invitation carries the scope it was created with onto the enrollment
    // it mints, so a redeemed row without one is this fake losing state.
    if (!enrollment.scope) throw new Error(`enrollment ${enrollment.enrollment_id} was redeemed without a scope`)
    return {
      resumed,
      enrollment: {
        enrollment_id: enrollment.enrollment_id,
        host_id: enrollment.host_id,
        expires_at: enrollment.expires_at,
        last_seen_at: enrollment.last_seen_at,
        created_at: enrollment.created_at,
      },
      owner_user_id: enrollment.owner,
      owner_actor_id: `actor_${enrollment.owner}`,
      org_id: "org_1",
      owner_display_name: "Alice",
      key_version: enrollment.key_version,
      serving_generation: enrollment.serving_generation,
      scope: enrollment.scope,
      ...endpoints(),
    }
  }

  const redeem = async (body: Record<string, unknown>) => {
    const invitationId = typeof body.invitationId === "string" ? body.invitationId : ""
    const secret = typeof body.secret === "string" ? body.secret : ""
    const hostId = typeof body.hostId === "string" ? body.hostId : ""
    const invitation = invitations.get(invitationId)
    if (!invitation || invitation.secret_hash !== (await hostSha256Hex(secret))) {
      throw new FakeRefusal(400, "invitation_invalid")
    }
    if (invitation.revoked_at !== undefined) throw new FakeRefusal(410, "invitation_revoked")
    if (invitation.expires_at <= now()) throw new FakeRefusal(410, "invitation_expired")
    if (typeof body.publicKey !== "string" || typeof body.signature !== "string") {
      throw new FakeRefusal(400, "invitation_invalid")
    }
    const publicKey = publicKeyJwk(body.publicKey)
    const fingerprint = await hostPublicKeyFingerprint(publicKey)
    const payload = hostInvitationRedeemPayload({ invitationId, hostId, publicKeySha256: fingerprint })
    if (!(await verify(publicKey, payload, body.signature))) throw new FakeRefusal(401, "invitation_signature_invalid")
    if (invitation.redeemed_at !== undefined) {
      const same =
        invitation.redeemed_public_key_fingerprint === fingerprint && invitation.redeemed_host_id === hostId
      const existing = invitation.redeemed_enrollment_id ? enrollments.get(invitation.redeemed_enrollment_id) : undefined
      if (same && existing) return redeemResponse(existing, true)
      throw new FakeRefusal(409, "invitation_redeemed")
    }
    for (const enrollment of enrollments.values()) {
      if (enrollment.owner === invitation.owner && enrollment.host_id === hostId) {
        throw new FakeRefusal(409, "invitation_host_conflict")
      }
    }
    const enrollment: FakeEnrollment = {
      enrollment_id: nextId("enr"),
      host_id: hostId,
      display_name: typeof body.displayName === "string" && body.displayName ? body.displayName : invitation.display_name,
      owner: invitation.owner,
      public_key: publicKey,
      fingerprint,
      key_version: 1,
      serving_generation: 0,
      scope: invitation.scope,
      expires_at: now() + LEASE_MS,
      last_seen_at: now(),
      created_at: now(),
    }
    enrollments.set(enrollment.enrollment_id, enrollment)
    invitation.redeemed_at = now()
    invitation.redeemed_host_id = hostId
    invitation.redeemed_public_key_fingerprint = fingerprint
    invitation.redeemed_enrollment_id = enrollment.enrollment_id
    if (faults.dropRedeemResponse) {
      faults.dropRedeemResponse = false
      throw new TypeError("fetch failed")
    }
    return redeemResponse(enrollment, false)
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  const fetchImpl: FetchLike = async (input, init) => {
    const target = new URL(input.href)
    const headers = new Headers(init?.headers)
    const method = (init?.method ?? "GET").toUpperCase()
    const bodyText = typeof init?.body === "string" ? init.body : ""
    const parsed: unknown = bodyText ? JSON.parse(bodyText) : {}
    const body = isPlainRecord(parsed) ? parsed : {}
    log.push({ method, path: target.pathname, body, headers: Object.fromEntries(headers.entries()) })
    try {
      if (target.pathname === "/api/claxedo/host/enrollments/redeem") return json(200, await redeem(body))
      if (faults.unavailable !== undefined) {
        return json(faults.unavailable, { error: { code: "deployment_candidate_unavailable", message: "deploying" } })
      }
      const request = { pathname: target.pathname, headers, bodyText, body }
      if (target.pathname === "/api/claxedo/host/enrollments/acquire") {
        return json(200, acquire(await verifyMachine(request)))
      }
      if (target.pathname === "/api/claxedo/host/enrollments/heartbeat") {
        return json(200, heartbeat(await verifyMachine(request), body))
      }
      if (!options.owner) throw new FakeRefusal(404, "not_found")
      return json(200, await options.owner({ method, url: target, headers, body }))
    } catch (error) {
      if (error instanceof FakeRefusal) return json(error.status, { error: { code: error.code, message: error.code } })
      throw error
    }
  }

  const enrollmentByHostId = (hostId: string) =>
    [...enrollments.values()].find((entry) => entry.host_id === hostId && entry.revoked_at === undefined)

  const unassign = (workspaceId: string) => {
    assignments.delete(workspaceId)
    readiness.delete(workspaceId)
  }

  return {
    url,
    relayUrl,
    fetch: fetchImpl,
    log,
    faults,
    enrollments,
    assignments,
    readiness,
    beats: () => log.filter((entry) => entry.path === "/api/claxedo/host/enrollments/heartbeat"),
    /** What the relay would be told is routable right now, per enrollment. */
    routable: (enrollmentId: string) => {
      const enrollment = enrollments.get(enrollmentId)
      return enrollment ? routable(enrollment) : []
    },
    enrollmentByHostId,
    /**
     * What `POST /api/claxedo/host/enrollments` leaves behind when the OWNER
     * enrolls a machine with their account credential. State, not a route: the
     * caller that drives it (Electron main, on behalf of the connector child)
     * reaches the control plane through the account, never through this
     * fetch, so there is nothing here for a machine transport to call.
     *
     * Upserts on (owner, host id), which is the uniqueness both authorities
     * declare (`on conflict (owner_actor_id, host_id)` on D1,
     * `ON CONFLICT (owner_token_identifier, host_id)` on SQLite). A machine
     * that restarts and enrolls again keeps its enrollment id, its serving
     * generation and the assignments pointed at it; minting a second row
     * instead would let a test's restart find an empty control plane and pass
     * without ever exercising the restore.
     *
     * The row carries no scope, as the real one does not: an account
     * enrollment grants no roots, and a host reached this way confines no
     * directory.
     */
    enrollAccountHost: async (input: { hostId: string; publicKey: string; owner?: string; displayName?: string }) => {
      const publicKey = publicKeyJwk(input.publicKey)
      const fingerprint = await hostPublicKeyFingerprint(publicKey)
      const owner = input.owner ?? "alice"
      const existing = [...enrollments.values()].find((entry) => entry.owner === owner && entry.host_id === input.hostId)
      if (existing) {
        // Proving possession of the key again is a stronger statement than a
        // pause or a revoke, so it clears both. A DIFFERENT key is a new
        // version, which is what turns a stale machine's request into
        // `enrollment_key_version_mismatch` rather than a bare signature
        // refusal.
        if (existing.fingerprint !== fingerprint) existing.key_version += 1
        existing.public_key = publicKey
        existing.fingerprint = fingerprint
        if (input.displayName) existing.display_name = input.displayName
        existing.expires_at = now() + LEASE_MS
        existing.last_seen_at = now()
        delete existing.revoked_at
        delete existing.paused_at
        return existing
      }
      const enrollment: FakeEnrollment = {
        enrollment_id: nextId("enr"),
        host_id: input.hostId,
        display_name: input.displayName ?? "machine",
        owner,
        public_key: publicKey,
        fingerprint,
        key_version: 1,
        serving_generation: 0,
        expires_at: now() + LEASE_MS,
        last_seen_at: now(),
        created_at: now(),
      }
      enrollments.set(enrollment.enrollment_id, enrollment)
      return enrollment
    },
    createInvitation: async (input: {
      owner?: string
      displayName?: string
      scope: Omit<FakeScope, "revision"> & { revision?: number }
      expiresInMs?: number
    }) => {
      const invitationId = base64url(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12))))
      const secret = base64url(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32))))
      const invitation: Invitation = {
        invitation_id: invitationId,
        secret_hash: await hostSha256Hex(secret),
        owner: input.owner ?? "alice",
        display_name: input.displayName ?? "machine",
        scope: { ...input.scope, revision: input.scope.revision ?? 1 },
        expires_at: now() + Math.min(Math.max(input.expiresInMs ?? 3_600_000, 5 * 60_000), 24 * 60 * 60_000),
      }
      invitations.set(invitationId, invitation)
      return { invitationId, secret, token: `chx_inv_1.${invitationId}.${secret}`, expiresAt: invitation.expires_at, invitation }
    },
    /**
     * The owner's assignment, by enrollment or host id. The lexical scope
     * check is the control plane's; a test that wants the host's resolved
     * check to be the one refusing widens `enrollment.scope` directly. The
     * directory is recorded normalized (`normalizeStoredDirectory` at the
     * control plane), so `/srv/app/` and `/srv/app` are one row.
     */
    assign: (
      input: ({ enrollmentId: string } | { hostId: string }) & { workspaceId: string; remoteDirectory?: string; displayName?: string },
    ) => {
      const enrollment = "hostId" in input ? enrollmentByHostId(input.hostId) : enrollments.get(input.enrollmentId)
      if (!enrollment || enrollment.revoked_at !== undefined) throw new FakeRefusal(404, "host_enrollment_not_found")
      const remoteDirectory = input.remoteDirectory === undefined ? undefined : normalizeAbsolutePath(input.remoteDirectory)
      if (input.remoteDirectory !== undefined && remoteDirectory === undefined) throw new FakeRefusal(400, "invalid_input")
      if (enrollment.scope && !pathWithinRoots(remoteDirectory ?? "", enrollment.scope.allowed_roots)) {
        throw new FakeRefusal(400, "host_assignment_outside_scope")
      }
      const existing = assignments.get(input.workspaceId)
      const assignment: FakeAssignment = {
        workspace_id: input.workspaceId,
        enrollment_id: enrollment.enrollment_id,
        host_id: enrollment.host_id,
        ...(remoteDirectory === undefined ? {} : { remote_directory: remoteDirectory }),
        ...(input.displayName ? { display_name: input.displayName } : {}),
        revision: (existing?.revision ?? 0) + 1,
      }
      assignments.set(input.workspaceId, assignment)
      return assignment.revision
    },
    unassign,
    /** Replace the roots; assignments outside them are retired, as the control plane's scope update does. */
    setScope: (enrollmentId: string, scope: Omit<FakeScope, "revision">) => {
      const enrollment = enrollments.get(enrollmentId)
      if (!enrollment) throw new FakeRefusal(404, "host_enrollment_not_found")
      enrollment.scope = { ...scope, revision: (enrollment.scope?.revision ?? 0) + 1 }
      for (const [workspaceId, assignment] of assignments) {
        if (assignment.enrollment_id !== enrollmentId) continue
        if (!pathWithinRoots(assignment.remote_directory ?? "", scope.allowed_roots)) unassign(workspaceId)
      }
      return enrollment.scope
    },
    revoke: (enrollmentId: string) => {
      const enrollment = enrollments.get(enrollmentId)
      if (!enrollment) throw new FakeRefusal(404, "host_enrollment_not_found")
      enrollment.revoked_at = now()
      for (const [workspaceId, assignment] of assignments) {
        if (assignment.enrollment_id === enrollmentId) unassign(workspaceId)
      }
    },
    pause: (enrollmentId: string, paused: boolean) => {
      const enrollment = enrollments.get(enrollmentId)
      if (!enrollment) throw new FakeRefusal(404, "host_enrollment_not_found")
      if (paused) enrollment.paused_at = now()
      else delete enrollment.paused_at
    },
    replaceKey: (enrollmentId: string, publicKey: JsonWebKey) => {
      const enrollment = enrollments.get(enrollmentId)
      if (!enrollment) throw new Error(`no enrollment ${enrollmentId}`)
      enrollment.public_key = publicKey
      enrollment.key_version += 1
    },
  }
}

export type FakeControlPlane = ReturnType<typeof createFakeControlPlane>

/**
 * An in-memory `HostStateFs` that records every call, so tests can assert the
 * ORDER of writes — the state file's whole contract — not only the content.
 */
export function memoryHostStateFs() {
  const files = new Map<string, { text: string; mode: number }>()
  const dirs = new Map<string, number>()
  const calls: string[] = []
  const fs: HostStateFs = {
    readFile: async (file) => {
      calls.push(`read ${file}`)
      return files.get(file)?.text ?? null
    },
    writeFile: async (file, text, options) => {
      calls.push(`write ${file}`)
      if (files.has(file)) throw Object.assign(new Error(`EEXIST: ${file}`), { code: "EEXIST" })
      files.set(file, { text, mode: options.mode })
    },
    rename: async (from, to) => {
      calls.push(`rename ${from} -> ${to}`)
      const entry = files.get(from)
      if (!entry) throw Object.assign(new Error(`ENOENT: ${from}`), { code: "ENOENT" })
      files.delete(from)
      files.set(to, entry)
    },
    mkdir: async (dir, options) => {
      calls.push(`mkdir ${dir}`)
      dirs.set(dir, options.mode)
    },
    unlink: async (file) => {
      calls.push(`unlink ${file}`)
      files.delete(file)
    },
  }
  return { fs, files, dirs, calls }
}

/** A host with a fresh key, redeemed against the fake through the real bootstrap. */
export async function enrollFakeHost(
  cp: FakeControlPlane,
  input: { allowedRoots: string[]; cliRoots?: string[]; hostId?: string; tokenFile?: string; displayName?: string } = {
    allowedRoots: ["/srv"],
  },
) {
  const created = await createHostKeyPair()
  const keys = await hostKeyPairFromJwk(created.privateKeyJwk)
  const memory = memoryHostStateFs()
  const store = createHostStateStore({ file: "/home/u/.claxedo/connect/state.json", fs: memory.fs, random: () => "t" })
  const tokenFile = input.tokenFile ?? "/etc/claxedo/invite.txt"
  const invitation = await cp.createInvitation({
    scope: { revision: 1, allowed_roots: input.allowedRoots, visibility: "owner" },
  })
  memory.files.set(tokenFile, { text: invitation.token, mode: 0o600 })
  const fresh = newHostState({
    hostId: input.hostId ?? newHostId(),
    privateKeyJwk: created.privateKeyJwk,
    controlPlaneUrl: cp.url,
    cliRoots: input.cliRoots ?? [],
    storageRoot: "/var/lib/claxedo",
  })
  const outcome = await redeemInvitation({
    tokenFile,
    store,
    state: fresh,
    keys,
    fetch: cp.fetch,
    ...(input.displayName ? { displayName: input.displayName } : {}),
  })
  const enrollmentId = outcome.state.enrollment?.enrollment_id
  if (!enrollmentId) throw new Error("fake enrollment produced no enrollment id")
  return { keys, privateKeyJwk: created.privateKeyJwk, memory, store, state: outcome.state, enrollmentId, invitation }
}
