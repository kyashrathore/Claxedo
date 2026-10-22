import { invitationRedeemPayload } from "@claxedo/account-contract/machine"
import type { D1Database } from "@cloudflare/workers-types"
import { sha256Hex } from "@claxedo/helpers/crypto"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  hostEnrollmentScope,
  type HostInvitationCreateInput,
  type HostInvitationCreateResult,
  type HostInvitationRedeemInput,
  type HostInvitationRedeemResult,
  type HostInvitationRow,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import { timingSafeEqualStrings } from "@claxedo/server-core/platform/auth/web-crypto"
import { d1BatchAssertionFailed, d1UniqueFailureOn } from "../../../platform/db/d1-constraint"
import { requireHuman, type HumanPrincipal } from "./access-context"
import { activeGuard, batchUnder, deleteAssertion } from "./authorization"
import { D1HostAccessAuthorityError } from "./host-access-errors"
import { randomBase64Url, storedKeyFingerprint, verifiedPublicKey, verifyHostSignature } from "./host-attestation-codec"
import {
  DEFAULT_TTL_MS,
  denied,
  enrollmentById,
  enrollmentJson,
  enrollmentOf,
  optionalText,
  requireText,
  type InvitationRow,
} from "./host-enrollment-records"
import { requireScope, storedScope } from "./host-scope-rules"

export const D1_HOST_INVITATION_AUTHORITY_METHODS = [
  "createHostInvitation",
  "listHostInvitations",
  "revokeHostInvitation",
  "redeemHostInvitation",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1HostInvitationAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_HOST_INVITATION_AUTHORITY_METHODS)[number]>

export type D1HostInvitationAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: (prefix: "enrollment" | "assert" | "invitation") => string
  /** The caller's current organization, recorded on an invitation when it is created. */
  resolveOrgId?: WorkspaceAuthority["resolveOrgId"]
}

const INVITATION_MIN_TTL_MS = 5 * 60_000
const INVITATION_MAX_TTL_MS = 24 * 60 * 60_000
const INVITATION_DEFAULT_TTL_MS = 60 * 60_000

/**
 * The owner's single-use invitations and their redemption, which is how a
 * `claxedo connect` machine is enrolled: the secret is the credential, the
 * store keeps its hash, and a redeemed invitation becomes an enrollment
 * confined to the invitation's organization and roots.
 */
export class D1HostInvitationAuthority implements D1HostInvitationAuthorityPort {
  private readonly now: () => number
  private readonly randomId: NonNullable<D1HostInvitationAuthorityOptions["randomId"]>

  constructor(
    private readonly database: D1Database,
    private readonly options: D1HostInvitationAuthorityOptions,
  ) {
    requireText(options.deploymentId, "deploymentId")
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? ((prefix) => `${prefix}_${randomBase64Url(16)}`)
  }

  async createHostInvitation(
    auth: SignedControlPlaneAuth,
    args: HostInvitationCreateInput,
  ): Promise<HostInvitationCreateResult> {
    const who = await this.requirePrincipal(auth)
    const scope = requireScope(args.scope)
    const displayName = optionalText(args.displayName, "displayName", 200)
    const orgId = await this.currentOrgId(who, auth)
    const now = this.now()
    const expiresAt = now + invitationTtl(args.expiresInMs)
    const invitationId = this.randomId("invitation")
    const secret = randomBase64Url(32)
    await batchUnder(this.database, activeGuard(who), [this.database.prepare(`
      insert into host_invitations (
        invitation_id, owner_user_id, owner_actor_id, org_id, secret_hash, display_name, scope_json,
        expires_at, redeemed_at, redeemed_enrollment_id, redeemed_host_id, redeemed_public_key_fingerprint,
        created_by_actor_id, created_at, revoked_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, ?, ?, null)
    `).bind(
      invitationId,
      who.userId,
      who.actorId,
      orgId,
      await sha256Hex(secret),
      displayName ?? null,
      JSON.stringify(scope),
      expiresAt,
      who.actorId,
      now,
    )])
    return { invitationId, secret, expiresAt }
  }

  async listHostInvitations(auth: SignedControlPlaneAuth): Promise<HostInvitationRow[]> {
    const who = await this.requirePrincipal(auth)
    const rows = await this.database.prepare(`
      select * from host_invitations where owner_actor_id = ?
      order by created_at desc, invitation_id
    `).bind(who.actorId).all<InvitationRow>()
    return (rows.results ?? []).map((row) => ({
      invitation_id: row.invitation_id,
      ...(row.display_name ? { display_name: row.display_name } : {}),
      scope: storedScope(row.scope_json),
      org_id: row.org_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      ...(row.redeemed_at !== null ? { redeemed_at: row.redeemed_at } : {}),
      ...(row.redeemed_host_id !== null ? { redeemed_host_id: row.redeemed_host_id } : {}),
      ...(row.redeemed_enrollment_id !== null ? { redeemed_enrollment_id: row.redeemed_enrollment_id } : {}),
      ...(row.revoked_at !== null ? { revoked_at: row.revoked_at } : {}),
    }))
  }

  async revokeHostInvitation(auth: SignedControlPlaneAuth, args: { invitationId: string }) {
    const who = await this.requirePrincipal(auth)
    const invitationId = requireText(args.invitationId, "invitationId")
    const now = this.now()
    const [result] = await batchUnder(this.database, activeGuard(who), [this.database.prepare(`
      update host_invitations set revoked_at = ?
      where invitation_id = ? and owner_actor_id = ? and revoked_at is null and redeemed_at is null
    `).bind(now, invitationId, who.actorId)])
    return { revoked: changes(result) > 0 }
  }

  /**
   * No caller auth: the invitation secret is the credential. The row is read
   * once and every decision below is made against that read; the batch then
   * re-asserts single use, so two concurrent redeems produce one enrollment and
   * the loser is answered from a fresh read.
   */
  async redeemHostInvitation(args: HostInvitationRedeemInput): Promise<HostInvitationRedeemResult> {
    const invitationId = requireText(args.invitationId, "invitationId")
    const secret = requireText(args.secret, "secret")
    const hostId = requireText(args.hostId, "hostId")
    const displayName = optionalText(args.displayName, "displayName", 200)
    const invitation = await this.invitation(invitationId)
    const secretHash = await sha256Hex(secret)
    // One answer for a wrong id and a wrong secret: the id is not secret, and
    // an answer that told them apart would confirm which ids exist.
    if (!invitation || !timingSafeEqualStrings(invitation.secret_hash, secretHash)) {
      throw new D1HostAccessAuthorityError("invitation_invalid", "Invitation is invalid")
    }
    const publicKey = await verifiedPublicKey(args.publicKey)
    const fingerprint = await storedKeyFingerprint(publicKey)
    await verifyHostSignature({
      publicKey,
      signature: args.signature,
      payload: invitationRedeemPayload({ invitationId, hostId, publicKeySha256: fingerprint }),
    })
    const now = this.now()
    const settled = await this.settledRedeem(invitation, { hostId, fingerprint, now })
    if (settled) return settled
    if (invitation.revoked_at !== null) {
      throw new D1HostAccessAuthorityError("invitation_revoked", "Invitation has been revoked")
    }
    if (invitation.expires_at <= now) {
      throw new D1HostAccessAuthorityError("invitation_expired", "Invitation has expired")
    }
    if (await enrollmentOf(this.database, invitation.owner_actor_id, hostId)) {
      throw new D1HostAccessAuthorityError(
        "invitation_host_conflict",
        "This owner already has an enrollment for the host id; enroll with a fresh host id",
      )
    }
    const enrollmentId = this.randomId("enrollment")
    const assertionId = this.randomId("assert")
    const expiresAt = now + DEFAULT_TTL_MS
    try {
      await this.database.batch([
        this.database.prepare(`
          update host_invitations set
            redeemed_at = ?, redeemed_host_id = ?, redeemed_public_key_fingerprint = ?, redeemed_enrollment_id = ?
          where invitation_id = ? and secret_hash = ? and redeemed_at is null and revoked_at is null
            and expires_at > ?
        `).bind(now, hostId, fingerprint, enrollmentId, invitationId, secretHash, now),
        this.database.prepare(`
          insert into host_enrollments (
            enrollment_id, owner_user_id, owner_actor_id, host_id, public_key_json,
            display_name, last_seen_at, expires_at, paused_at, revoked_at,
            last_signature_hash, created_at, updated_at, key_version, serving_generation,
            enrolled_via, scope_json, scope_revision
          )
          select ?, invitation.owner_user_id, invitation.owner_actor_id, ?, ?, ?, ?, ?, null, null,
            null, ?, ?, 1, 0, 'invitation', invitation.scope_json, 1
          from host_invitations invitation
          where invitation.invitation_id = ? and invitation.redeemed_enrollment_id = ?
        `).bind(
          enrollmentId,
          hostId,
          publicKey,
          displayName ?? invitation.display_name,
          now,
          expiresAt,
          now,
          now,
          invitationId,
          enrollmentId,
        ),
        this.database.prepare(`
          insert into authority_batch_assertions (assertion_id, passed)
          values (?, case when exists (
            select 1 from host_enrollments where enrollment_id = ? and enrolled_via = 'invitation'
          ) then 1 else 0 end)
        `).bind(assertionId, enrollmentId),
        deleteAssertion(this.database, assertionId),
      ])
    } catch (error) {
      if (d1UniqueFailureOn(error, "host_enrollments")) {
        throw new D1HostAccessAuthorityError(
          "invitation_host_conflict",
          "This owner already has an enrollment for the host id; enroll with a fresh host id",
        )
      }
      if (!d1BatchAssertionFailed(error)) throw error
      const current = await this.invitation(invitationId)
      const resumed = current && await this.settledRedeem(current, { hostId, fingerprint, now })
      if (resumed) return resumed
      if (current?.revoked_at !== null) {
        throw new D1HostAccessAuthorityError("invitation_revoked", "Invitation has been revoked")
      }
      throw new D1HostAccessAuthorityError("invitation_expired", "Invitation has expired")
    }
    const result = await this.redeemResult(invitation, enrollmentId, false)
    if (!result) throw new D1HostAccessAuthorityError("host_attestation_denied", "Host enrollment is unavailable")
    return result
  }

  private async invitation(invitationId: string) {
    return await this.database.prepare(`select * from host_invitations where invitation_id = ?`)
      .bind(invitationId).first<InvitationRow>()
  }

  /**
   * The caller's current organization: the token's org claim when it names
   * one the caller is a live member or owner of, else the single organization
   * the caller belongs to. Recorded on the invitation at creation and never
   * inferred later.
   */
  private async currentOrgId(who: HumanPrincipal, auth: SignedControlPlaneAuth) {
    const claimed = auth.user.orgId?.trim()
    if (claimed) {
      const member = await this.database.prepare(`
        select 1 from orgs organization
        left join org_memberships membership
          on membership.org_id = organization.org_id and membership.user_id = ? and membership.revoked_at is null
        where organization.org_id = ? and organization.deleted_at is null
          and (organization.owner_user_id = ? or membership.user_id is not null)
      `).bind(who.userId, claimed, who.userId).first()
      if (!member) throw denied("Invitation organization is not one the caller belongs to")
      return claimed
    }
    if (!this.options.resolveOrgId) {
      throw new D1HostAccessAuthorityError("invalid_input", "Invitation organization resolution is unavailable")
    }
    return requireText(await this.options.resolveOrgId(auth), "orgId")
  }

  private async settledRedeem(
    invitation: InvitationRow,
    presented: { hostId: string; fingerprint: string; now: number },
  ): Promise<HostInvitationRedeemResult | undefined> {
    if (invitation.redeemed_at === null || invitation.redeemed_enrollment_id === null) return undefined
    if (
      invitation.redeemed_host_id === presented.hostId
      && invitation.redeemed_public_key_fingerprint !== null
      && timingSafeEqualStrings(invitation.redeemed_public_key_fingerprint, presented.fingerprint)
    ) {
      const resumed = await this.redeemResult(invitation, invitation.redeemed_enrollment_id, true)
      if (resumed) return resumed
    }
    throw new D1HostAccessAuthorityError("invitation_redeemed", "Invitation has already been redeemed", {
      redeemed_host_id: invitation.redeemed_host_id,
      redeemed_at: invitation.redeemed_at,
    })
  }

  /** The redeem answer for a live enrollment; undefined once the enrollment is gone or revoked. */
  private async redeemResult(
    invitation: InvitationRow,
    enrollmentId: string,
    resumed: boolean,
  ): Promise<HostInvitationRedeemResult | undefined> {
    const row = await enrollmentById(this.database, enrollmentId)
    if (!row || row.revoked_at !== null) return undefined
    const scope = hostEnrollmentScope(row.scope_json, row.scope_revision)
    if (!scope) throw new D1HostAccessAuthorityError("resource_conflict", "Invitation enrollment carries no scope")
    return {
      resumed,
      enrollment: enrollmentJson(row),
      owner_user_id: row.owner_user_id,
      owner_actor_id: row.owner_actor_id,
      org_id: invitation.org_id,
      key_version: row.key_version,
      serving_generation: row.serving_generation,
      scope,
    }
  }

  private requirePrincipal(auth: SignedControlPlaneAuth): Promise<HumanPrincipal> {
    return requireHuman(this.database, this.options.deploymentId, auth)
  }
}

function invitationTtl(input: number | undefined) {
  if (input === undefined) return INVITATION_DEFAULT_TTL_MS
  if (!Number.isFinite(input)) throw new D1HostAccessAuthorityError("invalid_input", "expiresInMs must be finite")
  return Math.max(INVITATION_MIN_TTL_MS, Math.min(input, INVITATION_MAX_TTL_MS))
}

function changes(result: { meta?: { changes?: number } }) {
  return result.meta?.changes ?? 0
}
