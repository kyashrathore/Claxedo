/**
 * The invitation half of the fake control plane: a token its owner mints with
 * a scope, redeemed once by one key and host id into an enrollment that
 * carries that scope. The refusals are the control plane's own
 * (`claxedo-server/src/authority/adapters/d1/host-invitation-authority.ts`).
 */

import { invitationRedeemPayload, invitationToken, publicKeyFingerprint, publicKeyJwk } from "@claxedo/account-contract/machine"
import type { FakeEnrollment, FakeScope } from "./fake-control-plane.test-support"
import type { FakePairingDeps } from "./fake-pairings.test-support"
import { base64url, hostSha256Hex } from "./host-identity"

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

export type FakeInvitationDeps = Pick<FakePairingDeps, "now" | "url" | "enrollments" | "nextId" | "leaseMs" | "refuse" | "verify" | "endpoints"> & {
  /** `dropRedeemResponse`: commit the redeem, then fail the response as a dropped connection. */
  faults: { dropRedeemResponse: boolean }
}

export function createFakeInvitations(deps: FakeInvitationDeps) {
  const { now, enrollments } = deps
  const invitations = new Map<string, Invitation>()

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
      ...deps.endpoints(),
    }
  }

  const redeem = async (body: Record<string, unknown>) => {
    const invitationId = typeof body.invitationId === "string" ? body.invitationId : ""
    const secret = typeof body.secret === "string" ? body.secret : ""
    const hostId = typeof body.hostId === "string" ? body.hostId : ""
    const invitation = invitations.get(invitationId)
    if (!invitation || invitation.secret_hash !== (await hostSha256Hex(secret))) {
      throw deps.refuse(400, "invitation_invalid")
    }
    if (invitation.revoked_at !== undefined) throw deps.refuse(410, "invitation_revoked")
    if (invitation.expires_at <= now()) throw deps.refuse(410, "invitation_expired")
    if (typeof body.publicKey !== "string" || typeof body.signature !== "string") {
      throw deps.refuse(400, "invitation_invalid")
    }
    const publicKey = publicKeyJwk(body.publicKey)
    const fingerprint = await publicKeyFingerprint(publicKey)
    const payload = invitationRedeemPayload({ invitationId, hostId, publicKeySha256: fingerprint })
    if (!(await deps.verify(publicKey, payload, body.signature))) throw deps.refuse(401, "invitation_signature_invalid")
    if (invitation.redeemed_at !== undefined) {
      const same = invitation.redeemed_public_key_fingerprint === fingerprint && invitation.redeemed_host_id === hostId
      const existing = invitation.redeemed_enrollment_id
        ? enrollments.get(invitation.redeemed_enrollment_id)
        : undefined
      if (same && existing) return redeemResponse(existing, true)
      throw deps.refuse(409, "invitation_redeemed")
    }
    for (const enrollment of enrollments.values()) {
      if (enrollment.owner === invitation.owner && enrollment.host_id === hostId) {
        throw deps.refuse(409, "invitation_host_conflict")
      }
    }
    const enrollment: FakeEnrollment = {
      enrollment_id: deps.nextId("enr"),
      host_id: hostId,
      display_name:
        typeof body.displayName === "string" && body.displayName ? body.displayName : invitation.display_name,
      owner: invitation.owner,
      public_key: publicKey,
      fingerprint,
      key_version: 1,
      serving_generation: 0,
      scope: invitation.scope,
      expires_at: now() + deps.leaseMs,
      last_seen_at: now(),
      created_at: now(),
    }
    enrollments.set(enrollment.enrollment_id, enrollment)
    invitation.redeemed_at = now()
    invitation.redeemed_host_id = hostId
    invitation.redeemed_public_key_fingerprint = fingerprint
    invitation.redeemed_enrollment_id = enrollment.enrollment_id
    if (deps.faults.dropRedeemResponse) {
      deps.faults.dropRedeemResponse = false
      throw new TypeError("fetch failed")
    }
    return redeemResponse(enrollment, false)
  }

  const create = async (input: {
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
    return {
      invitationId,
      secret,
      token: invitationToken({ controlPlaneUrl: deps.url, invitationId, secret }),
      expiresAt: invitation.expires_at,
      invitation,
    }
  }

  return { redeem, create }
}
