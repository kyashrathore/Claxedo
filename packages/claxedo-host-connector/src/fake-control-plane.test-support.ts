/**
 * A control plane that enforces the P1 contracts, for this package's tests.
 *
 * Strict on purpose: it refuses a reused nonce, a stale timestamp, a bad
 * signature, a superseded generation, a stale ack revision, an occupied host
 * id, and answers `resumed` only for the same key AND host id. A permissive
 * fake here would let every one of the connector's guarantees pass untested —
 * the tests below are only as strong as this file's refusals.
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
import { createHostStateStore, isPlainRecord, newHostState, type HostStateFs } from "./host-state"
import type { FetchLike } from "./machine-transport"

const SKEW_MS = 60_000
const NONCE_TTL_MS = 120_000
const LEASE_MS = 60_000

type Scope = { revision: number; allowed_roots: string[]; visibility: "owner" | "org" }

type Enrollment = {
  enrollment_id: string
  host_id: string
  owner: string
  public_key: JsonWebKey
  fingerprint: string
  key_version: number
  serving_generation: number
  scope: Scope
  expires_at: number
  revoked_at?: number
  created_at: number
}

type Invitation = {
  invitation_id: string
  secret_hash: string
  owner: string
  scope: Scope
  expires_at: number
  revoked_at?: number
  redeemed_at?: number
  redeemed_host_id?: string
  redeemed_public_key_fingerprint?: string
  redeemed_enrollment_id?: string
}

type Assignment = { workspace_id: string; enrollment_id: string; remote_directory: string; display_name?: string; revision: number }

type Readiness = { enrollment_id: string; generation: number; revision: number }

export class FakeRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

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

export function createFakeControlPlane(options: { now?: () => number; url?: string } = {}) {
  const now = options.now ?? (() => Date.now())
  const url = options.url ?? "https://control-plane.test"
  const enrollments = new Map<string, Enrollment>()
  const invitations = new Map<string, Invitation>()
  const assignments = new Map<string, Assignment>()
  const readiness = new Map<string, Readiness>()
  const nonces = new Map<string, number>()
  const log: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const faults = {
    /** Commit the redeem, then fail the response as a dropped connection. */
    dropRedeemResponse: false,
    /** Answer every machine route with this status instead (a deploy window). */
    unavailable: undefined as number | undefined,
  }

  const servingCredential = (enrollment: Enrollment) => {
    const workspaceIds = [...assignments.values()]
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
    return workspaceIds.length ? { workspace_ids: workspaceIds, enrollment_id: enrollment.enrollment_id, generation: enrollment.serving_generation } : undefined
  }

  const endpoints = () => ({
    relay: { url: `${url}/relay`, jwks_url: `${url}/relay/jwks` },
    authority: { session_authority_url: `${url}/api/runtime-authority` },
  })

  /** P1.1's check order, cheapest first. */
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
    if (!enrollment) throw new FakeRefusal(401, "machine_enrollment_unknown")
    if (enrollment.revoked_at !== undefined) throw new FakeRefusal(403, "enrollment_revoked")
    if (request.body.enrollmentId !== undefined && request.body.enrollmentId !== enrollmentId) {
      throw new FakeRefusal(401, "machine_body_mismatch")
    }
    if (request.body.hostId !== undefined && request.body.hostId !== enrollment.host_id) {
      throw new FakeRefusal(401, "machine_body_mismatch")
    }
    if (request.body.keyVersion !== undefined && request.body.keyVersion !== enrollment.key_version) {
      throw new FakeRefusal(403, "enrollment_key_version_mismatch")
    }
    const payload = await hostMachineRequestPayload({
      method: "POST",
      pathname: request.pathname,
      bodyText: request.bodyText,
      ts,
      nonce,
      enrollmentId,
    })
    if (!(await verify(enrollment.public_key, payload, signature))) {
      throw new FakeRefusal(401, "machine_signature_invalid")
    }
    for (const [key, expiresAt] of nonces) if (expiresAt <= now()) nonces.delete(key)
    const nonceKey = `${enrollmentId}:${nonce}`
    if (nonces.has(nonceKey)) throw new FakeRefusal(401, "machine_nonce_replayed")
    nonces.set(nonceKey, ts + NONCE_TTL_MS)
    return enrollment
  }

  const acquire = (enrollment: Enrollment) => {
    enrollment.serving_generation += 1
    for (const [workspaceId, ready] of readiness) {
      if (ready.enrollment_id === enrollment.enrollment_id && ready.generation < enrollment.serving_generation) {
        readiness.delete(workspaceId)
      }
    }
    return { generation: enrollment.serving_generation, generation_acquired_at: now() }
  }

  const heartbeat = (enrollment: Enrollment, body: Record<string, unknown>) => {
    if (typeof body.generation !== "number" || body.generation !== enrollment.serving_generation) {
      throw new FakeRefusal(409, "enrollment_generation_superseded")
    }
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
    const credential = servingCredential(enrollment)
    return {
      expires_at: enrollment.expires_at,
      last_seen_at: now(),
      assignments: mine.map((assignment) => ({
        workspace_id: assignment.workspace_id,
        remote_directory: assignment.remote_directory,
        ...(assignment.display_name ? { display_name: assignment.display_name } : {}),
        revision: assignment.revision,
      })),
      scope: enrollment.scope,
      assigned_workspace_ids: mine.map((assignment) => assignment.workspace_id).sort(),
      ...(credential ? { hostTunnel: credential } : {}),
      ...endpoints(),
    }
  }

  const redeemResponse = (enrollment: Enrollment, resumed: boolean) => ({
    resumed,
    enrollment: {
      enrollment_id: enrollment.enrollment_id,
      host_id: enrollment.host_id,
      expires_at: enrollment.expires_at,
      last_seen_at: enrollment.created_at,
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
  })

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
    const enrollment: Enrollment = {
      enrollment_id: nextId("enr"),
      host_id: hostId,
      owner: invitation.owner,
      public_key: publicKey,
      fingerprint,
      key_version: 1,
      serving_generation: 0,
      scope: invitation.scope,
      expires_at: now() + LEASE_MS,
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
    const bodyText = typeof init?.body === "string" ? init.body : ""
    const parsed: unknown = bodyText ? JSON.parse(bodyText) : {}
    const body = isPlainRecord(parsed) ? parsed : {}
    log.push({ path: target.pathname, body, headers: Object.fromEntries(headers.entries()) })
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
      return json(404, { error: { code: "not_found", message: target.pathname } })
    } catch (error) {
      if (error instanceof FakeRefusal) return json(error.status, { error: { code: error.code, message: error.code } })
      throw error
    }
  }

  return {
    url,
    fetch: fetchImpl,
    log,
    faults,
    enrollments,
    readiness,
    /** What the relay would be told is routable right now, per enrollment. */
    routable: (enrollmentId: string) => {
      const enrollment = enrollments.get(enrollmentId)
      return enrollment ? (servingCredential(enrollment)?.workspace_ids ?? []) : []
    },
    createInvitation: async (input: { owner?: string; scope: Scope; expiresInMs?: number }) => {
      const invitationId = base64url(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12))))
      const secret = base64url(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32))))
      const invitation: Invitation = {
        invitation_id: invitationId,
        secret_hash: await hostSha256Hex(secret),
        owner: input.owner ?? "alice",
        scope: input.scope,
        expires_at: now() + (input.expiresInMs ?? 3_600_000),
      }
      invitations.set(invitationId, invitation)
      return { invitationId, secret, token: `chx_inv_1.${invitationId}.${secret}`, invitation }
    },
    assign: (input: { enrollmentId: string; workspaceId: string; remoteDirectory: string; displayName?: string }) => {
      const existing = assignments.get(input.workspaceId)
      const assignment: Assignment = {
        workspace_id: input.workspaceId,
        enrollment_id: input.enrollmentId,
        remote_directory: input.remoteDirectory,
        ...(input.displayName ? { display_name: input.displayName } : {}),
        revision: (existing?.revision ?? 0) + 1,
      }
      assignments.set(input.workspaceId, assignment)
      return assignment.revision
    },
    unassign: (workspaceId: string) => {
      assignments.delete(workspaceId)
      readiness.delete(workspaceId)
    },
    setScope: (enrollmentId: string, scope: Omit<Scope, "revision">) => {
      const enrollment = enrollments.get(enrollmentId)
      if (!enrollment) throw new Error(`no enrollment ${enrollmentId}`)
      enrollment.scope = { ...scope, revision: enrollment.scope.revision + 1 }
      return enrollment.scope
    },
    revoke: (enrollmentId: string) => {
      const enrollment = enrollments.get(enrollmentId)
      if (!enrollment) throw new Error(`no enrollment ${enrollmentId}`)
      enrollment.revoked_at = now()
      for (const [workspaceId, assignment] of assignments) {
        if (assignment.enrollment_id === enrollmentId) {
          assignments.delete(workspaceId)
          readiness.delete(workspaceId)
        }
      }
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
