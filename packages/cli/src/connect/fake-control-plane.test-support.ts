/**
 * The control plane a `claxedo connect` host and the `claxedo host` owner
 * commands talk to, as these tests see it. The machine routes enforce the P1
 * contracts the way host-connector's own strict fake does (that file is not a
 * package export, so its refusals are restated here rather than imported
 * across packages): reused nonce, stale timestamp, bad signature, superseded
 * generation and stale ack revisions are refused; `resumed` is answered only
 * for the same key AND host id. The owner routes are the account-side twins
 * the CLI drives with a bearer.
 *
 * The serving credential is minted in the real route's shape — the signer's
 * result plus `hostId`, `workspaceIds`, `relayUrl` — with a decodable token
 * so the relay stub can say which workspaces a presented credential covers.
 */

import {
  base64url,
  base64urlDecode,
  hostInvitationRedeemPayload,
  hostMachineRequestPayload,
  hostPublicKeyFingerprint,
  hostSha256Hex,
  MACHINE_REQUEST_HEADERS,
} from "@claxedo/host-connector/host-identity"
import type { FetchLike } from "@claxedo/host-connector/machine-transport"
import { asArray, asRecordOrEmpty, asString, isString } from "@claxedo/helpers/guards"
import { requestJson } from "../http"

const SKEW_MS = 60_000
const NONCE_TTL_MS = 120_000
const LEASE_MS = 60_000
const TUNNEL_TOKEN_TTL_MS = 5 * 60_000
export const OWNER_TOKEN = "owner-bearer"

type Scope = { revision: number; allowed_roots: string[]; visibility: "owner" | "org" }

type Enrollment = {
  enrollment_id: string
  host_id: string
  display_name: string
  owner: string
  public_key: JsonWebKey
  fingerprint: string
  key_version: number
  serving_generation: number
  scope: Scope
  expires_at: number
  revoked_at?: number
  created_at: number
  last_seen_at: number
}

type Invitation = {
  invitation_id: string
  secret_hash: string
  owner: string
  display_name: string
  scope: Scope
  expires_at: number
  revoked_at?: number
  redeemed_at?: number
  redeemed_host_id?: string
  redeemed_public_key_fingerprint?: string
  redeemed_enrollment_id?: string
}

type Assignment = {
  workspace_id: string
  enrollment_id: string
  host_id: string
  remote_directory: string
  display_name?: string
  revision: number
}

type Readiness = { enrollment_id: string; generation: number; revision: number }

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

const underRoot = (directory: string, root: string) => root === "/" || directory === root || directory.startsWith(`${root}/`)

let ids = 0
const mintFakeId = (prefix: string) => `${prefix}_${(++ids).toString(36)}`

async function verifySignature(publicKey: JsonWebKey, payload: string, signature: string) {
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
const stringsOf = (value: unknown) => asArray(value).filter(isString)
const bodyRecord = (text: string) => asRecordOrEmpty(JSON.parse(text))

export function decodeFakeTunnelToken(token: string): { workspace_ids: string[]; enrollment_id: string; generation: number } {
  const [prefix, body] = token.split(".")
  if (prefix !== "htt" || !body) throw new Error(`not a fake host tunnel token: ${token}`)
  const claim = bodyRecord(new TextDecoder().decode(base64urlDecode(body)))
  return {
    workspace_ids: stringsOf(claim.workspace_ids),
    enrollment_id: asString(claim.enrollment_id) ?? "",
    generation: typeof claim.generation === "number" ? claim.generation : -1,
  }
}

export function createFakeConnectControlPlane(options: { now?: () => number; url?: string; relayUrl?: string } = {}) {
  const now = options.now ?? (() => Date.now())
  const url = options.url ?? "https://control-plane.test"
  const relayUrl = options.relayUrl ?? "https://relay.test"
  const enrollments = new Map<string, Enrollment>()
  const invitations = new Map<string, Invitation>()
  const assignments = new Map<string, Assignment>()
  const readiness = new Map<string, Readiness>()
  const nonces = new Map<string, number>()
  const log: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  const faults = {
    dropRedeemResponse: false,
    unavailable: undefined as number | undefined,
  }

  const routable = (enrollment: Enrollment) =>
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

  const hostTunnel = (enrollment: Enrollment) => {
    const workspaceIds = routable(enrollment)
    if (workspaceIds.length === 0) return undefined
    const claim = { workspace_ids: workspaceIds, enrollment_id: enrollment.enrollment_id, generation: enrollment.serving_generation }
    return {
      hostTunnelToken: `htt.${base64url(new TextEncoder().encode(JSON.stringify(claim)))}`,
      tokenExpiresAt: now() + TUNNEL_TOKEN_TTL_MS,
      jti: mintFakeId("jti"),
      hostId: enrollment.host_id,
      workspaceIds,
      relayUrl,
    }
  }

  const endpoints = () => ({
    relay: { url: relayUrl, jwks_url: `${relayUrl}/.well-known/jwks.json` },
    authority: { session_authority_url: `${url}/api/runtime-authority/session-authorize` },
  })

  const verifyMachine = async (request: { pathname: string; headers: Headers; bodyText: string; body: Record<string, unknown> }) => {
    const enrollmentId = request.headers.get(MACHINE_REQUEST_HEADERS.enrollmentId)
    const tsHeader = request.headers.get(MACHINE_REQUEST_HEADERS.ts)
    const nonce = request.headers.get(MACHINE_REQUEST_HEADERS.nonce)
    const signature = request.headers.get(MACHINE_REQUEST_HEADERS.signature)
    if (!enrollmentId || !tsHeader || !nonce || !signature || !/^\d+$/.test(tsHeader)) {
      throw new Refusal(400, "machine_headers_invalid")
    }
    const ts = Number(tsHeader)
    if (Math.abs(now() - ts) > SKEW_MS) throw new Refusal(401, "machine_timestamp_skew")
    const enrollment = enrollments.get(enrollmentId)
    if (!enrollment) throw new Refusal(401, "machine_enrollment_unknown")
    if (enrollment.revoked_at !== undefined) throw new Refusal(403, "enrollment_revoked")
    if (request.body.hostId !== enrollment.host_id) throw new Refusal(401, "machine_body_mismatch")
    if (request.body.keyVersion !== enrollment.key_version) throw new Refusal(403, "enrollment_key_version_mismatch")
    const payload = await hostMachineRequestPayload({
      method: "POST",
      pathname: request.pathname,
      bodyText: request.bodyText,
      ts,
      nonce,
      enrollmentId,
    })
    if (!(await verifySignature(enrollment.public_key, payload, signature))) throw new Refusal(401, "machine_signature_invalid")
    for (const [key, expiresAt] of nonces) if (expiresAt <= now()) nonces.delete(key)
    const nonceKey = `${enrollmentId}:${nonce}`
    if (nonces.has(nonceKey)) throw new Refusal(401, "machine_nonce_replayed")
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
    if (body.generation !== enrollment.serving_generation) throw new Refusal(409, "enrollment_generation_superseded")
    const acks = (Array.isArray(body.acks) ? body.acks : []).map(asRecordOrEmpty).map((ack) => ({
      workspaceId: asString(ack.workspaceId) ?? "",
      revision: typeof ack.revision === "number" ? ack.revision : -1,
    }))
    const mine = [...assignments.values()].filter((assignment) => assignment.enrollment_id === enrollment.enrollment_id)
    for (const ack of acks) {
      const assignment = mine.find((entry) => entry.workspace_id === ack.workspaceId)
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
      last_seen_at: enrollment.last_seen_at,
      created_at: enrollment.created_at,
    },
    org_id: "org_1",
    owner_display_name: "Alice",
    key_version: enrollment.key_version,
    serving_generation: enrollment.serving_generation,
    scope: enrollment.scope,
    ...endpoints(),
  })

  const redeem = async (body: Record<string, unknown>) => {
    const invitationId = asString(body.invitationId) ?? ""
    const secret = asString(body.secret) ?? ""
    const hostId = asString(body.hostId) ?? ""
    const invitation = invitations.get(invitationId)
    if (!invitation || invitation.secret_hash !== (await hostSha256Hex(secret))) throw new Refusal(400, "invitation_invalid")
    if (invitation.revoked_at !== undefined) throw new Refusal(410, "invitation_revoked")
    if (invitation.expires_at <= now()) throw new Refusal(410, "invitation_expired")
    if (typeof body.publicKey !== "string" || typeof body.signature !== "string") throw new Refusal(400, "invitation_invalid")
    const publicKey: JsonWebKey = bodyRecord(body.publicKey)
    const fingerprint = await hostPublicKeyFingerprint(publicKey)
    const payload = hostInvitationRedeemPayload({ invitationId, hostId, publicKeySha256: fingerprint })
    if (!(await verifySignature(publicKey, payload, body.signature))) throw new Refusal(401, "invitation_signature_invalid")
    if (invitation.redeemed_at !== undefined) {
      const same = invitation.redeemed_public_key_fingerprint === fingerprint && invitation.redeemed_host_id === hostId
      const existing = invitation.redeemed_enrollment_id ? enrollments.get(invitation.redeemed_enrollment_id) : undefined
      if (same && existing) return redeemResponse(existing, true)
      throw new Refusal(409, "invitation_redeemed")
    }
    for (const enrollment of enrollments.values()) {
      if (enrollment.owner === invitation.owner && enrollment.host_id === hostId) throw new Refusal(409, "invitation_host_conflict")
    }
    const enrollment: Enrollment = {
      enrollment_id: mintFakeId("enr"),
      host_id: hostId,
      display_name: typeof body.displayName === "string" && body.displayName ? body.displayName : invitation.display_name,
      owner: invitation.owner,
      public_key: publicKey,
      fingerprint,
      key_version: 1,
      serving_generation: 0,
      scope: invitation.scope,
      expires_at: now() + LEASE_MS,
      created_at: now(),
      last_seen_at: now(),
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

  const createInvitation = async (input: { owner?: string; displayName?: string; scope: Omit<Scope, "revision">; expiresInMs?: number }) => {
    const invitationId = base64url(crypto.getRandomValues(new Uint8Array(12)))
    const secret = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const invitation: Invitation = {
      invitation_id: invitationId,
      secret_hash: await hostSha256Hex(secret),
      owner: input.owner ?? "alice",
      display_name: input.displayName ?? "machine",
      scope: { ...input.scope, revision: 1 },
      expires_at: now() + Math.min(Math.max(input.expiresInMs ?? 3_600_000, 5 * 60_000), 24 * 60 * 60_000),
    }
    invitations.set(invitationId, invitation)
    return { invitationId, token: `chx_inv_1.${invitationId}.${secret}`, expiresAt: invitation.expires_at }
  }

  const assign = (input: { hostId: string; workspaceId: string; remoteDirectory: string; displayName?: string }) => {
    const enrollment = [...enrollments.values()].find((entry) => entry.host_id === input.hostId && entry.revoked_at === undefined)
    if (!enrollment) throw new Refusal(404, "host_enrollment_not_found")
    if (!input.remoteDirectory.startsWith("/")) throw new Refusal(400, "remote_directory_invalid")
    if (!enrollment.scope.allowed_roots.some((root) => underRoot(input.remoteDirectory, root))) {
      throw new Refusal(403, "remote_directory_outside_scope")
    }
    const existing = assignments.get(input.workspaceId)
    const assignment: Assignment = {
      workspace_id: input.workspaceId,
      enrollment_id: enrollment.enrollment_id,
      host_id: enrollment.host_id,
      remote_directory: input.remoteDirectory,
      ...(input.displayName ? { display_name: input.displayName } : {}),
      revision: (existing?.revision ?? 0) + 1,
    }
    assignments.set(input.workspaceId, assignment)
    return { assigned: true, workspace_id: input.workspaceId, host_id: enrollment.host_id, revision: assignment.revision }
  }

  const unassign = (workspaceId: string) => {
    assignments.delete(workspaceId)
    readiness.delete(workspaceId)
  }

  const setScope = (enrollmentId: string, scope: Omit<Scope, "revision">) => {
    const enrollment = enrollments.get(enrollmentId)
    if (!enrollment) throw new Refusal(404, "host_enrollment_not_found")
    enrollment.scope = { ...scope, revision: enrollment.scope.revision + 1 }
    for (const [workspaceId, assignment] of assignments) {
      if (assignment.enrollment_id !== enrollmentId) continue
      if (!scope.allowed_roots.some((root) => underRoot(assignment.remote_directory, root))) {
        unassign(workspaceId)
      }
    }
    return enrollment.scope
  }

  const revoke = (hostId: string) => {
    const enrollment = [...enrollments.values()].find((entry) => entry.host_id === hostId)
    if (!enrollment) throw new Refusal(404, "host_enrollment_not_found")
    enrollment.revoked_at = now()
    for (const [workspaceId, assignment] of assignments) if (assignment.enrollment_id === enrollment.enrollment_id) unassign(workspaceId)
    return { paused: true, host_id: hostId }
  }

  const machines = () =>
    [...enrollments.values()]
      .filter((enrollment) => enrollment.revoked_at === undefined)
      .map((enrollment) => ({
        enrollment_id: enrollment.enrollment_id,
        display_name: enrollment.display_name,
        host_id: enrollment.host_id,
        public_key_fingerprint: enrollment.fingerprint,
        key_version: enrollment.key_version,
        enrolled_via: "invitation",
        last_seen_at: enrollment.last_seen_at,
        expires_at: enrollment.expires_at,
        serving_generation: enrollment.serving_generation,
        acked: [...readiness]
          .filter(([, ready]) => ready.enrollment_id === enrollment.enrollment_id)
          .map(([workspaceId, ready]) => ({ workspace_id: workspaceId, revision: ready.revision })),
        scope: enrollment.scope,
      }))

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  const owner = async (method: string, target: URL, headers: Headers, body: Record<string, unknown>) => {
    if (headers.get("authorization") !== `Bearer ${OWNER_TOKEN}`) throw new Refusal(401, "unauthorized")
    const pathname = target.pathname
    if (method === "POST" && pathname === "/api/claxedo/host/invitations") {
      const scope = asRecordOrEmpty(body.scope)
      const minted = await createInvitation({
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
        scope: { allowed_roots: stringsOf(scope.allowed_roots), visibility: scope.visibility === "org" ? "org" : "owner" },
        ...(typeof body.expiresInMs === "number" ? { expiresInMs: body.expiresInMs } : {}),
      })
      return { invitation_id: minted.invitationId, token: minted.token, expires_at: minted.expiresAt }
    }
    if (method === "GET" && pathname === "/api/claxedo/host/enrollments") return { active: null, machines: machines() }
    const scopeMatch = /^\/api\/claxedo\/host\/enrollments\/([^/]+)\/scope$/.exec(pathname)
    if (method === "PATCH" && scopeMatch) {
      return setScope(decodeURIComponent(scopeMatch[1]), {
        allowed_roots: stringsOf(body.allowed_roots),
        visibility: body.visibility === "org" ? "org" : "owner",
      })
    }
    if (method === "POST" && pathname === "/api/claxedo/host/enrollments/pause") {
      if (body.paused !== true) throw new Refusal(400, "only_pause_is_faked")
      return revoke(asString(body.hostId) ?? "")
    }
    if (method === "GET" && pathname === "/api/workspace") {
      return {
        workspaces: [...assignments.values()].map((assignment) => ({
          workspace_id: assignment.workspace_id,
          access: "user-hosted",
          display_name: assignment.display_name ?? assignment.workspace_id,
          remote_directory: assignment.remote_directory,
          host_id: assignment.host_id,
        })),
      }
    }
    const assignMatch = /^\/api\/workspace\/([^/]+)\/host-assignment$/.exec(pathname)
    if (assignMatch && method === "POST") {
      return assign({
        hostId: asString(body.hostId) ?? "",
        workspaceId: decodeURIComponent(assignMatch[1]),
        remoteDirectory: asString(body.remoteDirectory) ?? "",
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
      })
    }
    if (assignMatch && method === "DELETE") {
      unassign(decodeURIComponent(assignMatch[1]))
      return { unassigned: true }
    }
    throw new Refusal(404, "not_found")
  }

  const fetchImpl: FetchLike = async (input, init) => {
    const target = new URL(input.href)
    const headers = new Headers(init?.headers)
    const method = (init?.method ?? "GET").toUpperCase()
    const bodyText = typeof init?.body === "string" ? init.body : ""
    const body = bodyText ? bodyRecord(bodyText) : {}
    log.push({ method, path: target.pathname, body })
    try {
      if (target.pathname === "/api/claxedo/host/enrollments/redeem") return json(200, await redeem(body))
      if (faults.unavailable !== undefined) {
        return json(faults.unavailable, { error: { code: "deployment_candidate_unavailable", message: "deploying" } })
      }
      const request = { pathname: target.pathname, headers, bodyText, body }
      if (target.pathname === "/api/claxedo/host/enrollments/acquire") return json(200, acquire(await verifyMachine(request)))
      if (target.pathname === "/api/claxedo/host/enrollments/heartbeat") {
        return json(200, heartbeat(await verifyMachine(request), body))
      }
      return json(200, await owner(method, target, headers, body))
    } catch (error) {
      if (error instanceof Refusal) return json(error.status, { error: { code: error.code, message: error.code } })
      throw error
    }
  }

  /** `requestJson` bound to this fake instead of the global fetch, for the owner commands. */
  const request: typeof requestJson = (input) => requestJson({ ...input, fetch: fetchImpl })

  return {
    url,
    relayUrl,
    fetch: fetchImpl,
    request,
    log,
    faults,
    enrollments,
    assignments,
    readiness,
    createInvitation,
    assign,
    unassign,
    setScope,
    revoke,
    routable: (enrollmentId: string) => {
      const enrollment = enrollments.get(enrollmentId)
      return enrollment ? routable(enrollment) : []
    },
    beats: () => log.filter((entry) => entry.path === "/api/claxedo/host/enrollments/heartbeat"),
  }
}

export type FakeControlPlane = ReturnType<typeof createFakeConnectControlPlane>
