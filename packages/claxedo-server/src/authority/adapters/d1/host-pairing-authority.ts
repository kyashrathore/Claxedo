import { hostPathWithinRoots } from "@claxedo/account-contract/host-path"
import { PAIRING_TTL_MS, pairingCode, pairingRedeemPayload } from "@claxedo/account-contract/machine"
import type { D1Database } from "@cloudflare/workers-types"
import { sha256Hex } from "@claxedo/helpers/crypto"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  hostEnrollmentScope,
  type HostPairingCreateResult,
  type HostPairingDecision,
  type HostPairingFolderInput,
  type HostPairingMachine,
  type HostPairingRedeemInput,
  type HostPairingRedeemResult,
  type HostPairingSelf,
  type HostPairingView,
  type MachinePrincipal,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import { timingSafeEqualStrings } from "@claxedo/server-core/platform/auth/web-crypto"
import { d1BatchAssertionFailed, d1UniqueFailureOn } from "../../../platform/db/d1-constraint"
import { requireHuman, type HumanPrincipal } from "./access-context"
import { activeGuard, batchUnder, deleteAssertion } from "./authorization"
import { D1HostAccessAuthorityError } from "./host-access-errors"
import { randomBase64Url, storedKeyFingerprint, verifiedPublicKey, verifyHostSignature } from "./host-attestation-codec"
import {
  DEFAULT_TTL_MS,
  enrollmentById,
  enrollmentJson,
  enrollmentOf,
  invitationOrgIdFor,
  requireText,
  type InvitationRow,
} from "./host-enrollment-records"
import {
  newPairingCode,
  pairingAnswerDue,
  pairingByCode,
  pairingMachine,
  pairingView,
  requireOpenPairing,
  storedPairingMachine,
  storedPairingRequest,
} from "./host-pairing-records"
import { requireScope } from "./host-scope-rules"

export const D1_HOST_PAIRING_AUTHORITY_METHODS = [
  "createHostPairing",
  "hostPairing",
  "listHostPairingRequests",
  "cancelHostPairings",
  "recordHostPairingProgress",
  "redeemHostPairing",
  "requestHostPairingFolder",
  "hostPairingSelf",
  "approveHostPairing",
  "recordHostPairingWorkspace",
  "denyHostPairing",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1HostPairingAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_HOST_PAIRING_AUTHORITY_METHODS)[number]>

export type D1HostPairingAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: (prefix: "enrollment" | "assert" | "invitation") => string
  newCode?: () => string
  resolveOrgId?: WorkspaceAuthority["resolveOrgId"]
}

const NO_ROOTS = JSON.stringify({ allowed_roots: [] })

/**
 * Pairing: the app mints a short single-use code, the machine redeems it and
 * waits, and the person who minted it approves or denies what asked. A code
 * redeemed by a machine already enrolled to that person is a request to share
 * another folder instead of a second enrollment. Every row is an invitation of
 * kind `pairing`, so redemption, organization and owner rules stay the
 * invitation's own.
 */
export class D1HostPairingAuthority implements D1HostPairingAuthorityPort {
  private readonly now: () => number
  private readonly randomId: NonNullable<D1HostPairingAuthorityOptions["randomId"]>
  private readonly newCode: () => string

  constructor(private readonly database: D1Database, private readonly options: D1HostPairingAuthorityOptions) {
    requireText(options.deploymentId, "deploymentId")
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? ((prefix) => `${prefix}_${randomBase64Url(16)}`)
    this.newCode = options.newCode ?? newPairingCode
  }

  async createHostPairing(auth: SignedControlPlaneAuth): Promise<HostPairingCreateResult> {
    const who = await this.requirePrincipal(auth)
    const orgId = await invitationOrgIdFor(this.database, who, auth, this.options.resolveOrgId)
    const now = this.now()
    const pairingId = this.randomId("invitation")
    const code = this.newCode()
    const expiresAt = now + PAIRING_TTL_MS
    await batchUnder(this.database, activeGuard(who), [this.database.prepare(`
      insert into host_invitations (
        invitation_id, owner_user_id, owner_actor_id, org_id, secret_hash, display_name, scope_json,
        expires_at, redeemed_at, redeemed_enrollment_id, redeemed_host_id, redeemed_public_key_fingerprint,
        created_by_actor_id, created_at, revoked_at, kind
      ) values (?, ?, ?, ?, ?, null, ?, ?, null, null, null, null, ?, ?, null, 'pairing')
    `).bind(pairingId, who.userId, who.actorId, orgId, await sha256Hex(code), NO_ROOTS, expiresAt, who.actorId, now)])
    return { pairingId, code, expiresAt }
  }

  async hostPairing(auth: SignedControlPlaneAuth, args: { pairingId: string }): Promise<HostPairingView> {
    return await pairingView(this.database, await this.ownedPairing(auth, args.pairingId), this.now())
  }

  async listHostPairingRequests(auth: SignedControlPlaneAuth): Promise<HostPairingView[]> {
    const who = await this.requirePrincipal(auth)
    const now = this.now()
    const rows = await this.database.prepare(`
      select * from host_invitations
      where owner_actor_id = ? and kind = 'pairing' and redeemed_at is not null and redeemed_at > ?
        and pairing_decision is null
      order by redeemed_at desc, invitation_id
    `).bind(who.actorId, now - PAIRING_TTL_MS).all<InvitationRow>()
    return await Promise.all((rows.results ?? []).map((row) => pairingView(this.database, row, now)))
  }

  async cancelHostPairings(auth: SignedControlPlaneAuth) {
    const who = await this.requirePrincipal(auth)
    const [result] = await batchUnder(this.database, activeGuard(who), [this.database.prepare(`
      update host_invitations set revoked_at = ?
      where owner_actor_id = ? and kind = 'pairing' and redeemed_at is null and revoked_at is null
    `).bind(this.now(), who.actorId)])
    return { cancelled: result?.meta?.changes ?? 0 }
  }

  async recordHostPairingProgress(args: { code: string; hostname: string; os: string }) {
    const now = this.now()
    const invitation = requireOpenPairing(await this.pairingFor(args.code), now)
    const progress = { stage: "installing", hostname: args.hostname, os: args.os, at: now }
    await this.database.prepare(`
      update host_invitations set pairing_progress_json = ? where invitation_id = ? and redeemed_at is null
    `).bind(JSON.stringify(progress), invitation.invitation_id).run()
    return { pairingId: invitation.invitation_id, ownerUserId: invitation.owner_user_id }
  }

  /**
   * No caller auth: the code is the credential, read once and re-asserted in
   * the batch, so two machines racing one code produce one enrollment. The
   * enrollment is born awaiting approval with no roots.
   */
  async redeemHostPairing(input: HostPairingRedeemInput): Promise<HostPairingRedeemResult> {
    const hostId = requireText(input.hostId, "hostId")
    const codeSha256 = await this.codeSha256(input.code)
    const invitation = await pairingByCode(this.database, codeSha256)
    const publicKey = await verifiedPublicKey(input.publicKey)
    const fingerprint = await storedKeyFingerprint(publicKey)
    await verifyHostSignature({ publicKey, signature: input.signature, payload: pairingRedeemPayload({ codeSha256, hostId, publicKeySha256: fingerprint }) })
    const now = this.now()
    const resumed = invitation && await this.resumedRedeem(invitation, hostId, fingerprint)
    if (resumed) return resumed
    const open = requireOpenPairing(invitation, now)
    if (await enrollmentOf(this.database, open.owner_actor_id, hostId)) {
      throw new D1HostAccessAuthorityError("invitation_host_conflict", "This owner already has an enrollment for the host id; enroll with a fresh host id")
    }
    const machine = pairingMachine({ ...input.machine, ...(input.country ? { country: input.country } : {}) })
    const enrollmentId = this.randomId("enrollment")
    await this.insertAwaitingEnrollment(open, { enrollmentId, hostId, publicKey, fingerprint, machine, now })
    const result = await this.redeemResult(open.invitation_id, enrollmentId, false)
    if (!result) throw new D1HostAccessAuthorityError("host_attestation_denied", "Host enrollment is unavailable")
    return result
  }

  async requestHostPairingFolder(machine: MachinePrincipal, input: HostPairingFolderInput): Promise<HostPairingSelf> {
    const now = this.now()
    const invitation = requireOpenPairing(await this.pairingFor(input.code), now)
    const enrollment = await enrollmentById(this.database, machine.enrollmentId)
    if (!enrollment || enrollment.owner_actor_id !== invitation.owner_actor_id) {
      throw new D1HostAccessAuthorityError("pairing_invalid", "Pairing code is invalid")
    }
    const known = storedPairingMachine(enrollment.machine_json)
    const facts = pairingMachine({
      hostname: known?.hostname ?? enrollment.display_name ?? enrollment.host_id,
      os: known?.os ?? "", arch: known?.arch ?? "", cli_version: known?.cli_version ?? "",
      folder: input.folder, ...(input.home ? { home: input.home } : {}), ...(input.country ? { country: input.country } : {}),
    })
    const request = JSON.stringify({ request: "folder", machine: facts })
    const updated = await this.database.prepare(`
      update host_invitations set redeemed_at = ?, redeemed_enrollment_id = ?, redeemed_host_id = ?, pairing_request_json = ?
      where invitation_id = ? and redeemed_at is null and revoked_at is null and expires_at > ?
    `).bind(now, enrollment.enrollment_id, enrollment.host_id, request, invitation.invitation_id, now).run()
    if ((updated.meta?.changes ?? 0) === 0) throw new D1HostAccessAuthorityError("pairing_used", "Pairing code was already used")
    return await this.selfView(invitation.invitation_id, now)
  }

  async hostPairingSelf(machine: MachinePrincipal): Promise<HostPairingSelf | undefined> {
    const row = await this.database.prepare(`
      select invitation_id from host_invitations
      where kind = 'pairing' and redeemed_enrollment_id = ? order by redeemed_at desc limit 1
    `).bind(machine.enrollmentId).first<{ invitation_id: string }>()
    return row ? await this.selfView(row.invitation_id, this.now()) : undefined
  }

  /**
   * The first approval of a machine names it, makes the requested folder its
   * one root and lifts the hold; the approval of a folder request adds that
   * folder to the roots. Both are idempotent while no workspace has been
   * recorded, so an approval whose assignment failed can be given again.
   */
  async approveHostPairing(auth: SignedControlPlaneAuth, args: HostPairingDecision) {
    const invitation = await this.ownedPairing(auth, args.pairingId)
    const now = this.now()
    const request = this.answerable(invitation, now, true)
    const enrollment = await enrollmentById(this.database, invitation.redeemed_enrollment_id ?? "")
    if (!enrollment || enrollment.revoked_at !== null) throw new D1HostAccessAuthorityError("pairing_decided", "This machine was removed")
    const roots = this.approvedRoots(request, enrollment.scope_json, enrollment.scope_revision)
    const displayName = request.request === "machine" ? args.displayName?.trim() || request.machine.hostname : undefined
    await this.database.batch([
      this.database.prepare(`
        update host_enrollments set approval_requested_at = null, display_name = coalesce(?, display_name),
          scope_json = ?, scope_revision = scope_revision + ?, updated_at = ?
        where enrollment_id = ? and revoked_at is null
      `).bind(displayName ?? null, JSON.stringify({ allowed_roots: roots.allowed_roots }), roots.changed ? 1 : 0, now, enrollment.enrollment_id),
      this.database.prepare(`
        update host_invitations set pairing_decision = 'approved', pairing_decided_at = coalesce(pairing_decided_at, ?)
        where invitation_id = ?
      `).bind(now, invitation.invitation_id),
    ])
    return { hostId: enrollment.host_id, ownerUserId: enrollment.owner_user_id, folder: request.machine.folder, workspaceId: invitation.pairing_workspace_id ?? undefined }
  }

  async recordHostPairingWorkspace(auth: SignedControlPlaneAuth, args: { pairingId: string; workspaceId: string }) {
    const invitation = await this.ownedPairing(auth, args.pairingId)
    await this.database.prepare(`update host_invitations set pairing_workspace_id = ? where invitation_id = ? and pairing_decision = 'approved'`)
      .bind(requireText(args.workspaceId, "workspaceId"), invitation.invitation_id).run()
    return await pairingView(this.database, { ...invitation, pairing_decision: "approved", pairing_workspace_id: args.workspaceId }, this.now())
  }

  /** A denied machine request revokes the waiting enrollment; a denied folder request leaves the machine as it was. */
  async denyHostPairing(auth: SignedControlPlaneAuth, args: { pairingId: string }) {
    const invitation = await this.ownedPairing(auth, args.pairingId)
    const now = this.now()
    const request = this.answerable(invitation, now, false)
    await this.database.batch([
      ...(request.request === "machine" ? [this.database.prepare(`
        update host_enrollments set revoked_at = ?, revoked_reason = 'denied', updated_at = ?
        where enrollment_id = ? and approval_requested_at is not null and revoked_at is null
      `).bind(now, now, invitation.redeemed_enrollment_id)] : []),
      this.database.prepare(`update host_invitations set pairing_decision = 'denied', pairing_decided_at = ? where invitation_id = ?`)
        .bind(now, invitation.invitation_id),
    ])
    return { hostId: invitation.redeemed_host_id ?? "", ownerUserId: invitation.owner_user_id }
  }

  private answerable(invitation: InvitationRow, now: number, approving: boolean) {
    const request = storedPairingRequest(invitation.pairing_request_json)
    if (!request || invitation.redeemed_at === null) throw new D1HostAccessAuthorityError("pairing_invalid", "Nothing has asked with this code yet")
    const retry = approving && invitation.pairing_decision === "approved" && invitation.pairing_workspace_id === null
    if (invitation.pairing_decision !== null && !retry) throw new D1HostAccessAuthorityError("pairing_decided", "This request was already answered")
    if (!retry && pairingAnswerDue(invitation) <= now) throw new D1HostAccessAuthorityError("pairing_expired", "This request waited too long; run the connect command again")
    return request
  }

  private approvedRoots(request: { request: "machine" | "folder"; machine: HostPairingMachine }, scopeJson: string | null, revision: number) {
    const current = request.request === "machine" ? [] : hostEnrollmentScope(scopeJson, revision)?.allowed_roots ?? []
    if (hostPathWithinRoots(request.machine.folder, current)) return { allowed_roots: current, changed: false }
    return { allowed_roots: requireScope({ allowed_roots: [...current, request.machine.folder] }).allowed_roots, changed: true }
  }

  private async insertAwaitingEnrollment(
    invitation: InvitationRow,
    row: { enrollmentId: string; hostId: string; publicKey: string; fingerprint: string; machine: HostPairingMachine; now: number },
  ) {
    const assertionId = this.randomId("assert")
    const request = JSON.stringify({ request: "machine", machine: row.machine })
    try {
      await this.database.batch([
        this.database.prepare(`
          update host_invitations set redeemed_at = ?, redeemed_host_id = ?, redeemed_public_key_fingerprint = ?,
            redeemed_enrollment_id = ?, pairing_request_json = ?
          where invitation_id = ? and redeemed_at is null and revoked_at is null and expires_at > ?
        `).bind(row.now, row.hostId, row.fingerprint, row.enrollmentId, request, invitation.invitation_id, row.now),
        this.database.prepare(`
          insert into host_enrollments (
            enrollment_id, owner_user_id, owner_actor_id, host_id, public_key_json, display_name, last_seen_at, expires_at,
            paused_at, revoked_at, last_signature_hash, created_at, updated_at, key_version, serving_generation,
            enrolled_via, scope_json, scope_revision, approval_requested_at, machine_json
          )
          select ?, owner_user_id, owner_actor_id, ?, ?, ?, ?, ?, null, null, null, ?, ?, 1, 0, 'invitation', ?, 1, ?, ?
          from host_invitations where invitation_id = ? and redeemed_enrollment_id = ?
        `).bind(
          row.enrollmentId, row.hostId, row.publicKey, row.machine.hostname, row.now, row.now + DEFAULT_TTL_MS, row.now, row.now,
          NO_ROOTS, row.now, JSON.stringify(row.machine), invitation.invitation_id, row.enrollmentId,
        ),
        this.database.prepare(`
          insert into authority_batch_assertions (assertion_id, passed)
          values (?, case when exists (select 1 from host_enrollments where enrollment_id = ?) then 1 else 0 end)
        `).bind(assertionId, row.enrollmentId),
        deleteAssertion(this.database, assertionId),
      ])
    } catch (error) {
      if (d1UniqueFailureOn(error, "host_enrollments")) {
        throw new D1HostAccessAuthorityError("invitation_host_conflict", "This owner already has an enrollment for the host id; enroll with a fresh host id")
      }
      if (!d1BatchAssertionFailed(error)) throw error
      throw new D1HostAccessAuthorityError("pairing_used", "Pairing code was already used")
    }
  }

  private async resumedRedeem(invitation: InvitationRow, hostId: string, fingerprint: string) {
    if (invitation.redeemed_at === null || invitation.redeemed_enrollment_id === null) return undefined
    const same = invitation.redeemed_host_id === hostId && invitation.redeemed_public_key_fingerprint !== null
      && timingSafeEqualStrings(invitation.redeemed_public_key_fingerprint, fingerprint)
    return same ? await this.redeemResult(invitation.invitation_id, invitation.redeemed_enrollment_id, true) : undefined
  }

  private async redeemResult(pairingId: string, enrollmentId: string, resumed: boolean): Promise<HostPairingRedeemResult | undefined> {
    const row = await enrollmentById(this.database, enrollmentId)
    const invitation = await this.pairing(pairingId)
    if (!row || row.revoked_at !== null || !invitation) return undefined
    return {
      resumed,
      pairing_id: pairingId,
      enrollment: enrollmentJson(row),
      owner_user_id: row.owner_user_id,
      owner_actor_id: row.owner_actor_id,
      org_id: invitation.org_id,
      key_version: row.key_version,
      serving_generation: row.serving_generation,
      scope: hostEnrollmentScope(row.scope_json, row.scope_revision) ?? { allowed_roots: [], revision: row.scope_revision },
    }
  }

  private async selfView(pairingId: string, now: number): Promise<HostPairingSelf> {
    const invitation = await this.pairing(pairingId)
    if (!invitation) throw new D1HostAccessAuthorityError("pairing_invalid", "Pairing code is invalid")
    const view = await pairingView(this.database, invitation, now)
    return {
      pairing_id: view.pairing_id,
      stage: view.stage,
      folder: view.machine?.folder ?? "",
      ...(view.display_name ? { display_name: view.display_name } : {}),
      ...(view.workspace_id ? { workspace_id: view.workspace_id } : {}),
    }
  }

  private async codeSha256(input: string) {
    const code = pairingCode(input)
    if (!code) throw new D1HostAccessAuthorityError("pairing_invalid", "Pairing code is invalid")
    return await sha256Hex(code)
  }

  private async pairingFor(input: string) {
    return await pairingByCode(this.database, await this.codeSha256(input))
  }

  private async pairing(pairingId: string) {
    return await this.database.prepare(`select * from host_invitations where invitation_id = ? and kind = 'pairing'`)
      .bind(pairingId).first<InvitationRow>()
  }

  private async ownedPairing(auth: SignedControlPlaneAuth, pairingId: string) {
    const who = await this.requirePrincipal(auth)
    const invitation = await this.pairing(requireText(pairingId, "pairingId"))
    if (!invitation || invitation.owner_actor_id !== who.actorId) throw new D1HostAccessAuthorityError("pairing_invalid", "Pairing not found")
    return invitation
  }

  private requirePrincipal(auth: SignedControlPlaneAuth): Promise<HumanPrincipal> {
    return requireHuman(this.database, this.options.deploymentId, auth)
  }
}
