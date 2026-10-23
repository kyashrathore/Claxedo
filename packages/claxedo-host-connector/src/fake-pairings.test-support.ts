/**
 * The pairing half of the fake control plane: a code its owner mints, a
 * machine redeems into an enrollment that waits for the owner's answer, or,
 * on a machine already enrolled to that owner, uses to ask to share another
 * folder. The refusals and stages are the control plane's own
 * (`claxedo-server/src/authority/adapters/d1/host-pairing-authority.ts`).
 */

import { hostPathWithinRoots, normalizeHostPath } from "@claxedo/account-contract/host-path"
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  pairingCode,
  pairingRedeemPayload,
  publicKeyFingerprint,
  publicKeyJwk,
} from "@claxedo/account-contract/machine"
import type { FakeEnrollment } from "./fake-control-plane.test-support"
import { hostSha256Hex } from "./host-identity"
import { isPlainRecord } from "./host-state"

export type FakePairing = {
  pairing_id: string
  code: string
  owner: string
  expires_at: number
  signed_out_at?: number
  redeemed_at?: number
  enrollment_id?: string
  host_id?: string
  fingerprint?: string
  request?: { kind: "machine" | "folder"; folder: string; hostname: string }
  progress?: { hostname: string; os: string }
  decision?: "approved" | "denied"
  workspace_id?: string
}

type Refuse = (status: number, code: string) => Error

export type FakePairingDeps = {
  now: () => number
  url: string
  enrollments: Map<string, FakeEnrollment>
  nextId: (prefix: string) => string
  leaseMs: number
  refuse: Refuse
  verify: (publicKey: JsonWebKey, payload: string, signature: string) => Promise<boolean>
  ring: (enrollment: FakeEnrollment) => void
  routable: (enrollment: FakeEnrollment) => string[]
  assign: (input: { enrollmentId: string; workspaceId: string; remoteDirectory: string; displayName: string }) => number
  endpoints: () => Record<string, unknown>
}

const stringOrEmpty = (value: unknown) => (typeof value === "string" ? value : "")

export function createFakePairings(deps: FakePairingDeps) {
  const pairings = new Map<string, FakePairing>()
  const approvalUrl = `${deps.url}/settings/machines`
  const answerDue = (pairing: FakePairing) => (pairing.redeemed_at ?? 0) + PAIRING_TTL_MS

  const byCode = (input: unknown) => {
    const code = pairingCode(stringOrEmpty(input))
    const pairing = code === undefined ? undefined : [...pairings.values()].find((entry) => entry.code === code)
    return { code, pairing }
  }

  const requireOpen = (pairing: FakePairing | undefined) => {
    if (!pairing) throw deps.refuse(403, "pairing_invalid")
    if (pairing.signed_out_at !== undefined) throw deps.refuse(410, "pairing_owner_signed_out")
    if (pairing.redeemed_at !== undefined) throw deps.refuse(409, "pairing_used")
    if (pairing.expires_at <= deps.now()) throw deps.refuse(410, "pairing_expired")
    return pairing
  }

  const stage = (pairing: FakePairing) => {
    if (pairing.decision === "denied") return "denied"
    if (pairing.decision === "approved") {
      const enrollment = pairing.enrollment_id ? deps.enrollments.get(pairing.enrollment_id) : undefined
      const ready = enrollment && pairing.workspace_id && deps.routable(enrollment).includes(pairing.workspace_id)
      return ready ? "ready" : "approved"
    }
    if (pairing.redeemed_at === undefined) {
      if (pairing.signed_out_at !== undefined || pairing.expires_at <= deps.now()) return "expired"
      return pairing.progress ? "installing" : "waiting"
    }
    return answerDue(pairing) <= deps.now() ? "expired" : "awaiting_approval"
  }

  const selfView = (pairing: FakePairing) => {
    const enrollment = pairing.enrollment_id ? deps.enrollments.get(pairing.enrollment_id) : undefined
    return {
      pairing_id: pairing.pairing_id,
      stage: stage(pairing),
      folder: pairing.request?.folder ?? "",
      ...(enrollment && pairing.decision === "approved" ? { display_name: enrollment.display_name } : {}),
      ...(pairing.workspace_id ? { workspace_id: pairing.workspace_id } : {}),
    }
  }

  const redeemResult = (pairing: FakePairing, enrollment: FakeEnrollment, resumed: boolean) => ({
    resumed,
    pairing_id: pairing.pairing_id,
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
    key_version: enrollment.key_version,
    serving_generation: enrollment.serving_generation,
    scope: enrollment.scope ?? { revision: 1, allowed_roots: [] },
    approval_url: approvalUrl,
    ...deps.endpoints(),
  })

  const redeem = async (body: Record<string, unknown>) => {
    const { code, pairing } = byCode(body.code)
    if (code === undefined) throw deps.refuse(403, "pairing_invalid")
    const hostId = stringOrEmpty(body.hostId)
    const machine = isPlainRecord(body.machine) ? body.machine : {}
    const folder = normalizeHostPath(stringOrEmpty(machine.folder))
    if (!hostId || !folder || typeof body.publicKey !== "string" || typeof body.signature !== "string") {
      throw deps.refuse(400, "invalid_input")
    }
    const publicKey = publicKeyJwk(body.publicKey)
    const fingerprint = await publicKeyFingerprint(publicKey)
    const payload = pairingRedeemPayload({ codeSha256: await hostSha256Hex(code), hostId, publicKeySha256: fingerprint })
    if (!(await deps.verify(publicKey, payload, body.signature))) throw deps.refuse(401, "host_attestation_denied")
    const previous = pairing?.enrollment_id ? deps.enrollments.get(pairing.enrollment_id) : undefined
    if (pairing && previous && pairing.host_id === hostId && pairing.fingerprint === fingerprint && previous.revoked_at === undefined) {
      return redeemResult(pairing, previous, true)
    }
    const open = requireOpen(pairing)
    for (const enrollment of deps.enrollments.values()) {
      if (enrollment.owner === open.owner && enrollment.host_id === hostId) throw deps.refuse(409, "invitation_host_conflict")
    }
    const now = deps.now()
    const hostname = stringOrEmpty(machine.hostname) || hostId
    const enrollment: FakeEnrollment = {
      enrollment_id: deps.nextId("enr"),
      host_id: hostId,
      display_name: hostname,
      owner: open.owner,
      public_key: publicKey,
      fingerprint,
      key_version: 1,
      serving_generation: 0,
      scope: { revision: 1, allowed_roots: [] },
      expires_at: now + deps.leaseMs,
      last_seen_at: now,
      created_at: now,
      approval_requested_at: now,
    }
    deps.enrollments.set(enrollment.enrollment_id, enrollment)
    Object.assign(open, {
      redeemed_at: now,
      enrollment_id: enrollment.enrollment_id,
      host_id: hostId,
      fingerprint,
      request: { kind: "machine", folder, hostname },
    } satisfies Partial<FakePairing>)
    return redeemResult(open, enrollment, false)
  }

  const progress = (body: Record<string, unknown>) => {
    const open = requireOpen(byCode(body.code).pairing)
    open.progress = { hostname: stringOrEmpty(body.hostname), os: stringOrEmpty(body.os) }
    return { recorded: true }
  }

  const requestFolder = (enrollment: FakeEnrollment, body: Record<string, unknown>) => {
    const open = requireOpen(byCode(body.code).pairing)
    if (enrollment.owner !== open.owner) throw deps.refuse(403, "pairing_invalid")
    const folder = normalizeHostPath(stringOrEmpty(body.folder))
    if (!folder) throw deps.refuse(400, "invalid_input")
    Object.assign(open, {
      redeemed_at: deps.now(),
      enrollment_id: enrollment.enrollment_id,
      host_id: enrollment.host_id,
      request: { kind: "folder", folder, hostname: enrollment.display_name },
    } satisfies Partial<FakePairing>)
    return { ...selfView(open), approval_url: approvalUrl }
  }

  const latestFor = (enrollment: FakeEnrollment) =>
    [...pairings.values()]
      .filter((pairing) => pairing.enrollment_id === enrollment.enrollment_id)
      .sort((a, b) => (b.redeemed_at ?? 0) - (a.redeemed_at ?? 0))[0]

  const answerable = (pairingId: string) => {
    const pairing = pairings.get(pairingId)
    if (!pairing?.request || pairing.redeemed_at === undefined) throw deps.refuse(403, "pairing_invalid")
    if (pairing.decision !== undefined) throw deps.refuse(409, "pairing_decided")
    if (answerDue(pairing) <= deps.now()) throw deps.refuse(410, "pairing_expired")
    const enrollment = pairing.enrollment_id ? deps.enrollments.get(pairing.enrollment_id) : undefined
    if (!enrollment || enrollment.revoked_at !== undefined) throw deps.refuse(409, "pairing_decided")
    return { pairing, request: pairing.request, enrollment }
  }

  return {
    pairings,
    redeem,
    progress,
    requestFolder,
    self: (enrollment: FakeEnrollment) => {
      const latest = latestFor(enrollment)
      return { pairing: latest ? selfView(latest) : null }
    },
    create: (input: { owner?: string } = {}) => {
      const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH))
      const pairing: FakePairing = {
        pairing_id: deps.nextId("pair"),
        code: [...bytes].map((byte) => PAIRING_CODE_ALPHABET[byte & 31]).join(""),
        owner: input.owner ?? "alice",
        expires_at: deps.now() + PAIRING_TTL_MS,
      }
      pairings.set(pairing.pairing_id, pairing)
      return pairing
    },
    /** The approve route: the first approval names the machine and makes its folder the one root; a folder approval adds the folder. Either assigns a workspace to it. */
    approve: (pairingId: string, input: { workspaceId?: string; displayName?: string } = {}) => {
      const { pairing, request, enrollment } = answerable(pairingId)
      const roots = request.kind === "machine" ? [] : (enrollment.scope?.allowed_roots ?? [])
      if (!hostPathWithinRoots(request.folder, roots)) {
        enrollment.scope = { revision: (enrollment.scope?.revision ?? 0) + 1, allowed_roots: [...roots, request.folder] }
      }
      if (request.kind === "machine") enrollment.display_name = input.displayName ?? request.hostname
      delete enrollment.approval_requested_at
      pairing.decision = "approved"
      pairing.workspace_id = input.workspaceId ?? deps.nextId("ws")
      const name = request.folder.split(/[\\/]/).filter(Boolean).at(-1) ?? request.folder
      deps.assign({ enrollmentId: enrollment.enrollment_id, workspaceId: pairing.workspace_id, remoteDirectory: request.folder, displayName: name })
      return pairing.workspace_id
    },
    /** The deny route: a machine request revokes the waiting enrollment; a folder request leaves the machine as it was. */
    deny: (pairingId: string) => {
      const { pairing, request, enrollment } = answerable(pairingId)
      if (request.kind === "machine") {
        enrollment.revoked_at = deps.now()
        enrollment.revoked_reason = "denied"
      }
      pairing.decision = "denied"
      deps.ring(enrollment)
    },
    signOut: (owner = "alice") => {
      for (const pairing of pairings.values()) {
        if (pairing.owner === owner && pairing.redeemed_at === undefined) pairing.signed_out_at = deps.now()
      }
    },
  }
}
