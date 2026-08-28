import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type {
  HostEnrollment,
  HostEnrollmentState,
  WorkspaceAuthority,
  WorkspaceShareTarget,
} from "@claxedo/server-core/platform/auth/authority"

export const D1_HOST_ACCESS_AUTHORITY_METHODS = [
  "createLocalHostLinkChallenge",
  "registerLocalHostLink",
  "heartbeatLocalHostLink",
  "pauseLocalHostLink",
  "activeLocalHostLink",
  "createHostEnrollmentRequest",
  "enrollHost",
  "heartbeatHostEnrollment",
  "pauseHostEnrollment",
  "activeHostEnrollment",
  "markSecondDeviceOpen",
  "grantWorkspaceShare",
  "revokeWorkspaceShare",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1HostAccessAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_HOST_ACCESS_AUTHORITY_METHODS)[number]>

export type D1HostAccessAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: (prefix: "challenge" | "request" | "enrollment" | "grant" | "assert") => string
  randomNonce?: () => string
}

type Principal = { userId: string; actorId: string; actorKind: "human" | "agent" }

type PrincipalRow = {
  user_id: string
  user_state: "active" | "suspended" | "deleted"
  actor_id: string
  actor_kind: "human" | "agent"
  actor_state: "active" | "suspended" | "revoked"
  unlinked_at: number | null
}

type WorkspaceRow = {
  workspace_id: string
  org_id: string
  project_id: string
  backing: "local-worktree" | "cloud-vm"
  access: "user-hosted" | "cloud"
  home_region: string | null
  role_rank: number
}

type HostChallengeRow = {
  challenge_id: string
  workspace_id: string
  org_id: string
  project_id: string
  owner_user_id: string
  owner_actor_id: string
  host_id: string
  nonce: string
  expires_at: number
  used_at: number | null
  used_signature_hash: string | null
}

type HostLinkRow = {
  workspace_id: string
  org_id: string
  project_id: string
  host_id: string
  owner_user_id: string
  owner_actor_id: string
  public_key_json: string
  display_name: string | null
  last_seen_at: number
  expires_at: number
  paused_at: number | null
  revoked_at: number | null
  second_device_open_at: number | null
  last_signature_hash: string | null
  created_at: number
  updated_at: number
}

type EnrollmentRequestRow = {
  request_id: string
  owner_user_id: string
  owner_actor_id: string
  host_id: string
  nonce: string
  expires_at: number
  used_at: number | null
  used_signature_hash: string | null
}

type EnrollmentRow = {
  enrollment_id: string
  owner_user_id: string
  owner_actor_id: string
  host_id: string
  public_key_json: string
  display_name: string | null
  last_seen_at: number
  expires_at: number
  paused_at: number | null
  revoked_at: number | null
  last_signature_hash: string | null
  created_at: number
  updated_at: number
}

type ShareGrantRow = {
  grant_id: string
  workspace_id: string
  org_id: string
  project_id: string
  target_kind: "actor" | "user" | "org"
  target_actor_id: string | null
  target_user_id: string | null
  target_org_id: string | null
  role: "viewer" | "editor" | "admin"
  created_by_actor_id: string
  created_at: number
  revoked_at: number | null
}

type RuntimeTokenRow = {
  jti: string
  workspace_id: string
  org_id: string
  project_id: string
  host_id: string
  minted_for_user_id: string
  minted_for_actor_id: string
  expires_at: number
  revoked_at: number | null
  created_at: number
}

const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 60_000
const CONSUMED_REQUEST_RETENTION_MS = 10 * 60_000
const REQUEST_SWEEP_LIMIT = 500

export class D1HostAccessAuthorityError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "resource_conflict"
      | "host_attestation_denied"
      | "signature_replayed",
    message: string,
  ) {
    super(message)
    this.name = "D1HostAccessAuthorityError"
  }
}

/**
 * Worker-safe host, share, and runtime-token authority. Every persisted owner
 * is a canonical user/actor and every workspace row carries immutable tenant
 * scope copied from the authoritative workspace.
 */
export class D1HostAccessAuthority implements D1HostAccessAuthorityPort {
  private readonly now: () => number
  private readonly randomId: NonNullable<D1HostAccessAuthorityOptions["randomId"]>
  private readonly randomNonce: NonNullable<D1HostAccessAuthorityOptions["randomNonce"]>

  constructor(
    private readonly database: D1Database,
    private readonly options: D1HostAccessAuthorityOptions,
  ) {
    requireText(options.deploymentId, "deploymentId")
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? ((prefix) => `${prefix}_${randomBase64Url(16)}`)
    this.randomNonce = options.randomNonce ?? (() => randomBase64Url(32))
  }

  async createLocalHostLinkChallenge(
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string; hostId: string },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const hostId = requireText(args.hostId, "hostId")
    const workspace = await this.requireWorkspaceAccess(who, workspaceId, "admin")
    requireLocalWorkspace(workspace)
    const challengeId = this.randomId("challenge")
    const nonce = this.randomNonce()
    const now = this.now()
    const expiresAt = now + CHALLENGE_TTL_MS
    await this.database.batch([
      this.expiredRowSweep("host_attestation_challenges", "challenge_id", now),
      this.database.prepare(`
        ${workspaceAccessCte(3)}
        insert into host_attestation_challenges (
          challenge_id, workspace_id, org_id, project_id, owner_user_id, owner_actor_id,
          host_id, nonce, expires_at, used_at, used_signature_hash, created_at
        )
        select ?, workspace_id, org_id, project_id, ?, ?, ?, ?, ?, null, null, ?
        from authorized_workspace
        where backing = 'local-worktree' and access = 'user-hosted'
      `).bind(
        who.actorId,
        workspaceId,
        challengeId,
        who.userId,
        who.actorId,
        hostId,
        nonce,
        expiresAt,
        now,
      ),
    ])
    const created = await this.challenge(challengeId)
    if (!created) throw denied()
    return { challenge_id: challengeId, nonce, expires_at: expiresAt }
  }

  async registerLocalHostLink(
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      hostId: string
      publicKey: string
      challengeId: string
      signature: string
      displayName?: string
      ttlMs?: number
    },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const hostId = requireText(args.hostId, "hostId")
    const challengeId = requireText(args.challengeId, "challengeId")
    const displayName = optionalText(args.displayName, "displayName", 200)
    const ttlMs = normalizedTtl(args.ttlMs)
    const workspace = await this.requireWorkspaceAccess(who, workspaceId, "admin")
    requireLocalWorkspace(workspace)
    const challenge = await this.challenge(challengeId)
    const now = this.now()
    if (
      !challenge || challenge.workspace_id !== workspaceId || challenge.host_id !== hostId
      || challenge.owner_user_id !== who.userId || challenge.owner_actor_id !== who.actorId
      || challenge.used_at !== null || challenge.expires_at <= now
    ) throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid local host attestation challenge")
    const publicKey = await verifiedPublicKey(args.publicKey)
    const signatureHash = await verifyHostSignature({
      publicKey,
      signature: args.signature,
      payload: localHostRegistrationPayload({
        workspaceId,
        hostId,
        challengeId,
        nonce: challenge.nonce,
      }),
    })
    const expiresAt = now + ttlMs
    const assertionId = this.randomId("assert")
    await this.guardedBatch([
      this.signatureUse(signatureHash, "local-register", who.actorId, workspaceId, hostId, now),
      this.database.prepare(`
        update host_attestation_challenges
        set used_at = ?, used_signature_hash = ?
        where challenge_id = ? and workspace_id = ? and owner_actor_id = ? and host_id = ?
          and used_at is null and expires_at > ?
      `).bind(now, signatureHash, challengeId, workspaceId, who.actorId, hostId, now),
      this.database.prepare(`
        insert into local_host_links (
          workspace_id, org_id, project_id, host_id, owner_user_id, owner_actor_id,
          public_key_json, display_name, last_seen_at, expires_at, paused_at, revoked_at,
          second_device_open_at, last_signature_hash, created_at, updated_at
        )
        select challenge.workspace_id, challenge.org_id, challenge.project_id, challenge.host_id,
          challenge.owner_user_id, challenge.owner_actor_id, ?, ?, ?, ?, null, null, null, ?, ?, ?
        from host_attestation_challenges challenge
        join workspaces workspace
          on workspace.workspace_id = challenge.workspace_id and workspace.org_id = challenge.org_id
          and workspace.project_id = challenge.project_id and workspace.deleted_at is null
        where challenge.challenge_id = ? and challenge.used_signature_hash = ?
          and workspace.backing = 'local-worktree' and workspace.access = 'user-hosted'
        on conflict (workspace_id, host_id) do update set
          public_key_json = excluded.public_key_json,
          display_name = excluded.display_name,
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at,
          paused_at = null,
          revoked_at = null,
          last_signature_hash = excluded.last_signature_hash,
          updated_at = excluded.updated_at
      `).bind(
        publicKey,
        displayName ?? null,
        now,
        expiresAt,
        signatureHash,
        now,
        now,
        challengeId,
        signatureHash,
      ),
      this.database.prepare(`
        ${workspaceAccessCte(3)}
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from local_host_links link
          join authorized_workspace workspace on workspace.workspace_id = link.workspace_id
          where link.workspace_id = ? and link.host_id = ? and link.owner_actor_id = ?
            and link.last_signature_hash = ? and link.revoked_at is null and link.paused_at is null
        ) then 1 else 0 end)
      `).bind(who.actorId, workspaceId, assertionId, workspaceId, hostId, who.actorId, signatureHash),
      this.deleteAssertion(assertionId),
    ], "Local host registration raced with an authority change")
    return {
      host_id: hostId,
      workspace_id: workspaceId,
      ...(workspace.home_region ? { home_region: workspace.home_region } : {}),
      expires_at: expiresAt,
      paused: false,
    }
  }

  async heartbeatLocalHostLink(
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string; hostId: string; signature: string; ttlMs?: number },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const hostId = requireText(args.hostId, "hostId")
    const ttlMs = normalizedTtl(args.ttlMs)
    const workspace = await this.requireWorkspaceAccess(who, workspaceId, "admin")
    requireLocalWorkspace(workspace)
    const link = await this.localHostLink(workspaceId, hostId)
    if (!link || link.revoked_at !== null) throw new D1HostAccessAuthorityError("host_attestation_denied", "Local host link is unavailable")
    const signatureHash = await verifyHostSignature({
      publicKey: link.public_key_json,
      signature: args.signature,
      payload: localHostHeartbeatPayload({ workspaceId, hostId, ttlMs: args.ttlMs }),
    })
    const now = this.now()
    const expiresAt = now + ttlMs
    const assertionId = this.randomId("assert")
    await this.guardedBatch([
      this.signatureUse(signatureHash, "local-heartbeat", who.actorId, workspaceId, hostId, now),
      this.database.prepare(`
        ${workspaceAccessCte(3)}
        update local_host_links set
          last_seen_at = ?, expires_at = ?, last_signature_hash = ?, updated_at = ?
        where workspace_id = ? and host_id = ? and revoked_at is null
          and exists (select 1 from authorized_workspace)
      `).bind(who.actorId, workspaceId, now, expiresAt, signatureHash, now, workspaceId, hostId),
      this.database.prepare(`
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from local_host_links
          where workspace_id = ? and host_id = ? and revoked_at is null
            and last_seen_at = ? and expires_at = ? and last_signature_hash = ?
        ) then 1 else 0 end)
      `).bind(assertionId, workspaceId, hostId, now, expiresAt, signatureHash),
      this.deleteAssertion(assertionId),
    ], "Local host heartbeat raced with an authority change")
    return {
      host_id: hostId,
      workspace_id: workspaceId,
      ...(workspace.home_region ? { home_region: workspace.home_region } : {}),
      expires_at: expiresAt,
      paused: link.paused_at !== null,
    }
  }

  async pauseLocalHostLink(
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string; hostId?: string; paused: boolean },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const hostId = optionalText(args.hostId, "hostId")
    await this.requireWorkspaceAccess(who, workspaceId, "admin")
    const now = this.now()
    const result = await this.database.prepare(`
      ${workspaceAccessCte(3)}
      update local_host_links set paused_at = ?, updated_at = ?
      where workspace_id = ? and (? is null or host_id = ?) and revoked_at is null
        and exists (select 1 from authorized_workspace)
    `).bind(
      who.actorId,
      workspaceId,
      args.paused ? now : null,
      now,
      workspaceId,
      hostId ?? null,
      hostId ?? null,
    ).run()
    return { workspace_id: workspaceId, paused: args.paused, count: changes(result) }
  }

  async activeLocalHostLink(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    try {
      await this.requireWorkspaceAccess(who, workspaceId, "read")
    } catch (error) {
      if (isDenied(error)) return { active: false as const }
      throw error
    }
    const row = await this.database.prepare(`
      select * from local_host_links
      where workspace_id = ? and revoked_at is null and paused_at is null and expires_at > ?
      order by last_seen_at desc, host_id limit 1
    `).bind(workspaceId, this.now()).first<HostLinkRow>()
    if (!row) return { active: false as const }
    return {
      active: true as const,
      host_id: row.host_id,
      workspace_id: row.workspace_id,
      ...(row.display_name ? { display_name: row.display_name } : {}),
      ...(row.second_device_open_at ? { second_device_open_at: row.second_device_open_at } : {}),
      expires_at: row.expires_at,
      last_seen_at: row.last_seen_at,
    }
  }

  async markSecondDeviceOpen(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const now = this.now()
    await this.requireWorkspaceAccess(who, workspaceId, "read")
    const result = await this.database.prepare(`
      ${workspaceAccessCte(1)}
      update local_host_links
      set second_device_open_at = coalesce(second_device_open_at, ?), updated_at = ?
      where workspace_id = ? and owner_actor_id = ? and revoked_at is null
        and exists (select 1 from authorized_workspace)
    `).bind(who.actorId, workspaceId, now, now, workspaceId, who.actorId).run()
    return { recorded: changes(result) > 0, second_device_open_at: now }
  }

  async revokeLocalHostLink(
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string; hostId?: string },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const hostId = optionalText(args.hostId, "hostId")
    await this.requireWorkspaceAccess(who, workspaceId, "admin")
    const now = this.now()
    const results = await this.database.batch([
      this.database.prepare(`
        ${workspaceAccessCte(3)}
        update local_host_links set revoked_at = ?, updated_at = ?
        where workspace_id = ? and (? is null or host_id = ?) and revoked_at is null
          and exists (select 1 from authorized_workspace)
      `).bind(who.actorId, workspaceId, now, now, workspaceId, hostId ?? null, hostId ?? null),
      this.database.prepare(`
        ${workspaceAccessCte(3)}
        update runtime_access_tokens set revoked_at = ?
        where workspace_id = ? and (? is null or host_id = ?) and revoked_at is null
          and exists (select 1 from authorized_workspace)
          and exists (
            select 1 from local_host_links link
            where link.workspace_id = ? and (? is null or link.host_id = ?)
              and link.revoked_at = ?
          )
      `).bind(
        who.actorId,
        workspaceId,
        now,
        workspaceId,
        hostId ?? null,
        hostId ?? null,
        workspaceId,
        hostId ?? null,
        hostId ?? null,
        now,
      ),
    ])
    return { revoked: changes(results[0]!), runtime_tokens_revoked: changes(results[1]!) }
  }

  async createHostEnrollmentRequest(auth: SignedControlPlaneAuth, args: { hostId: string }) {
    const who = await this.requirePrincipal(auth)
    const hostId = requireText(args.hostId, "hostId")
    const requestId = this.randomId("request")
    const nonce = this.randomNonce()
    const now = this.now()
    const expiresAt = now + CHALLENGE_TTL_MS
    await this.database.batch([
      this.expiredRowSweep("host_enrollment_requests", "request_id", now),
      this.database.prepare(`
        insert into host_enrollment_requests (
          request_id, owner_user_id, owner_actor_id, host_id, nonce,
          expires_at, used_at, used_signature_hash, created_at
        ) values (?, ?, ?, ?, ?, ?, null, null, ?)
      `).bind(requestId, who.userId, who.actorId, hostId, nonce, expiresAt, now),
    ])
    return { request_id: requestId, nonce, expires_at: expiresAt }
  }

  async enrollHost(
    auth: SignedControlPlaneAuth,
    args: {
      hostId: string
      publicKey: string
      requestId: string
      signature: string
      displayName?: string
      ttlMs?: number
    },
  ): Promise<HostEnrollment> {
    const who = await this.requirePrincipal(auth)
    const hostId = requireText(args.hostId, "hostId")
    const requestId = requireText(args.requestId, "requestId")
    const displayName = optionalText(args.displayName, "displayName", 200)
    const request = await this.enrollmentRequest(requestId)
    const now = this.now()
    if (
      !request || request.owner_user_id !== who.userId || request.owner_actor_id !== who.actorId
      || request.host_id !== hostId || request.used_at !== null || request.expires_at <= now
    ) throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host enrollment request")
    const publicKey = await verifiedPublicKey(args.publicKey)
    const signatureHash = await verifyHostSignature({
      publicKey,
      signature: args.signature,
      payload: hostEnrollmentPayload({ hostId, requestId, nonce: request.nonce }),
    })
    const expiresAt = now + normalizedTtl(args.ttlMs)
    const enrollmentId = this.randomId("enrollment")
    const assertionId = this.randomId("assert")
    await this.guardedBatch([
      this.signatureUse(signatureHash, "host-enroll", who.actorId, null, hostId, now),
      this.database.prepare(`
        update host_enrollment_requests
        set used_at = ?, used_signature_hash = ?, expires_at = ?
        where request_id = ? and owner_actor_id = ? and host_id = ?
          and used_at is null and expires_at > ?
      `).bind(
        now,
        signatureHash,
        now + CONSUMED_REQUEST_RETENTION_MS,
        requestId,
        who.actorId,
        hostId,
        now,
      ),
      this.database.prepare(`
        insert into host_enrollments (
          enrollment_id, owner_user_id, owner_actor_id, host_id, public_key_json,
          display_name, last_seen_at, expires_at, paused_at, revoked_at,
          last_signature_hash, created_at, updated_at
        )
        select ?, request.owner_user_id, request.owner_actor_id, request.host_id,
          ?, ?, ?, ?, null, null, ?, ?, ?
        from host_enrollment_requests request
        where request.request_id = ? and request.used_signature_hash = ?
        on conflict (owner_actor_id, host_id) do update set
          public_key_json = excluded.public_key_json,
          display_name = excluded.display_name,
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at,
          paused_at = null,
          revoked_at = null,
          last_signature_hash = excluded.last_signature_hash,
          updated_at = excluded.updated_at
      `).bind(
        enrollmentId,
        publicKey,
        displayName ?? null,
        now,
        expiresAt,
        signatureHash,
        now,
        now,
        requestId,
        signatureHash,
      ),
      this.database.prepare(`
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from host_enrollments
          where owner_actor_id = ? and host_id = ? and last_signature_hash = ?
            and revoked_at is null and paused_at is null
        ) then 1 else 0 end)
      `).bind(assertionId, who.actorId, hostId, signatureHash),
      this.deleteAssertion(assertionId),
    ], "Host enrollment raced with another request")
    return enrollmentJson((await this.enrollment(who.actorId, hostId))!)
  }

  async heartbeatHostEnrollment(
    auth: SignedControlPlaneAuth,
    args: { hostId: string; signature: string; ttlMs?: number },
  ) {
    const who = await this.requirePrincipal(auth)
    const hostId = requireText(args.hostId, "hostId")
    const enrollment = await this.enrollment(who.actorId, hostId)
    if (!enrollment || enrollment.revoked_at !== null) {
      throw new D1HostAccessAuthorityError("host_attestation_denied", "Host enrollment is unavailable")
    }
    const signatureHash = await verifyHostSignature({
      publicKey: enrollment.public_key_json,
      signature: args.signature,
      payload: hostEnrollmentHeartbeatPayload({ hostId, ttlMs: args.ttlMs }),
    })
    const now = this.now()
    const expiresAt = now + normalizedTtl(args.ttlMs)
    const assertionId = this.randomId("assert")
    await this.guardedBatch([
      this.signatureUse(signatureHash, "host-heartbeat", who.actorId, null, hostId, now),
      this.database.prepare(`
        update host_enrollments set
          last_seen_at = ?, expires_at = ?, last_signature_hash = ?, updated_at = ?
        where owner_actor_id = ? and host_id = ? and revoked_at is null
      `).bind(now, expiresAt, signatureHash, now, who.actorId, hostId),
      this.database.prepare(`
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from host_enrollments
          where owner_actor_id = ? and host_id = ? and last_seen_at = ?
            and expires_at = ? and last_signature_hash = ? and revoked_at is null
        ) then 1 else 0 end)
      `).bind(assertionId, who.actorId, hostId, now, expiresAt, signatureHash),
      this.deleteAssertion(assertionId),
    ], "Host enrollment heartbeat raced with revocation")
    return { expires_at: expiresAt, last_seen_at: now }
  }

  async pauseHostEnrollment(
    auth: SignedControlPlaneAuth,
    args: { hostId?: string; paused: boolean },
  ) {
    const who = await this.requirePrincipal(auth)
    const hostId = optionalText(args.hostId, "hostId")
    const now = this.now()
    await this.database.prepare(`
      update host_enrollments set paused_at = ?, updated_at = ?
      where owner_actor_id = ? and (? is null or host_id = ?) and revoked_at is null
    `).bind(args.paused ? now : null, now, who.actorId, hostId ?? null, hostId ?? null).run()
    return { paused: args.paused }
  }

  async activeHostEnrollment(auth: SignedControlPlaneAuth): Promise<HostEnrollmentState> {
    const who = await this.requirePrincipal(auth)
    const row = await this.database.prepare(`
      select * from host_enrollments where owner_actor_id = ?
      order by last_seen_at desc, enrollment_id limit 1
    `).bind(who.actorId).first<EnrollmentRow>()
    if (!row) return { active: false, reason: "not-enrolled" }
    if (row.revoked_at !== null) return { active: false, reason: "revoked" }
    if (row.paused_at !== null) return { active: false, reason: "paused" }
    if (row.expires_at <= this.now()) return { active: false, reason: "expired" }
    return { active: true, ...enrollmentJson(row) }
  }

  async revokeHostEnrollment(auth: SignedControlPlaneAuth, args: { hostId?: string }) {
    const who = await this.requirePrincipal(auth)
    const hostId = optionalText(args.hostId, "hostId")
    const now = this.now()
    const results = await this.database.batch([
      this.database.prepare(`
        update host_enrollments set revoked_at = ?, updated_at = ?
        where owner_actor_id = ? and (? is null or host_id = ?) and revoked_at is null
      `).bind(now, now, who.actorId, hostId ?? null, hostId ?? null),
      this.database.prepare(`
        update runtime_access_tokens set revoked_at = ?
        where minted_for_actor_id = ? and (? is null or host_id = ?) and revoked_at is null
          and exists (
            select 1 from host_enrollments enrollment
            where enrollment.owner_actor_id = ? and (? is null or enrollment.host_id = ?)
              and enrollment.revoked_at = ?
          )
      `).bind(
        now,
        who.actorId,
        hostId ?? null,
        hostId ?? null,
        who.actorId,
        hostId ?? null,
        hostId ?? null,
        now,
      ),
    ])
    return { revoked: changes(results[0]!), runtime_tokens_revoked: changes(results[1]!) }
  }

  async grantWorkspaceShare(
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      role: "viewer" | "editor" | "admin"
      target: WorkspaceShareTarget
    },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const role = requireShareRole(args.role)
    const target = normalizeShareTarget(args.target)
    const workspace = await this.requireWorkspaceAccess(who, workspaceId, "admin")
    const targetExists = await this.shareTargetInOrganization(target, workspace.org_id)
    if (!targetExists) throw denied("Workspace share target belongs to another tenant")
    const existing = await this.activeGrant(workspaceId, target)
    if (existing) {
      if (existing.role !== role) throw new D1HostAccessAuthorityError("resource_conflict", "Active share role differs")
      return { grantId: existing.grant_id, created: false }
    }
    const grantId = this.randomId("grant")
    const now = this.now()
    try {
      await this.database.prepare(`
        ${workspaceAccessCte(3)}
        insert into workspace_share_grants (
          grant_id, workspace_id, org_id, project_id, target_kind,
          target_actor_id, target_user_id, target_org_id, role,
          created_by_actor_id, created_at, revoked_at
        )
        select ?, workspace_id, org_id, project_id, ?, ?, ?, ?, ?, ?, ?, null
        from authorized_workspace
      `).bind(
        who.actorId,
        workspaceId,
        grantId,
        target.kind,
        target.kind === "actor" ? target.id : null,
        target.kind === "user" ? target.id : null,
        target.kind === "org" ? target.id : null,
        role,
        who.actorId,
        now,
      ).run()
    } catch (error) {
      if (!isUniqueFailure(error)) throw error
      const winner = await this.activeGrant(workspaceId, target)
      if (winner?.role === role) return { grantId: winner.grant_id, created: false }
      throw new D1HostAccessAuthorityError("resource_conflict", "Active share role differs")
    }
    const created = await this.grant(grantId)
    if (!created) throw new D1HostAccessAuthorityError("resource_conflict", "Workspace share collided")
    return { grantId, created: true }
  }

  async revokeWorkspaceShare(
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      grantId?: string
      target?: WorkspaceShareTarget
    },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireWorkspaceAccess(who, workspaceId, "admin")
    if (!!args.grantId === !!args.target) {
      throw new D1HostAccessAuthorityError("invalid_input", "Specify exactly one share grant or canonical target")
    }
    const grant = args.grantId
      ? await this.grant(requireText(args.grantId, "grantId"))
      : await this.activeGrant(workspaceId, normalizeShareTarget(args.target!))
    if (!grant || grant.workspace_id !== workspaceId || grant.revoked_at !== null) return { revoked: false }
    const now = this.now()
    const assertionId = this.randomId("assert")
    const results = await this.guardedBatch([
      this.database.prepare(`
        ${workspaceAccessCte(3)}
        update workspace_share_grants set revoked_at = ?
        where grant_id = ? and workspace_id = ? and revoked_at is null
          and exists (select 1 from authorized_workspace)
      `).bind(who.actorId, workspaceId, now, grant.grant_id, workspaceId),
      this.database.prepare(`
        update runtime_access_tokens set revoked_at = ?
        where workspace_id = ? and revoked_at is null and minted_for_user_id in (
          select case grant.target_kind
            when 'actor' then actor.user_id
            when 'user' then grant.target_user_id
            else membership.user_id end
          from workspace_share_grants grant
          left join actors actor on actor.actor_id = grant.target_actor_id
          left join org_memberships membership
            on membership.org_id = grant.target_org_id and membership.revoked_at is null
          where grant.grant_id = ? and grant.revoked_at = ?
        )
      `).bind(now, workspaceId, grant.grant_id, now),
      this.database.prepare(`
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from workspace_share_grants where grant_id = ? and workspace_id = ? and revoked_at = ?
        ) then 1 else 0 end)
      `).bind(assertionId, grant.grant_id, workspaceId, now),
      this.deleteAssertion(assertionId),
    ], "Workspace share revocation raced with an authority change")
    return { revoked: true, runtime_tokens_revoked: changes(results[1]!) }
  }

  async recordRuntimeAccessToken(
    auth: SignedControlPlaneAuth,
    args: { jti: string; workspaceId: string; hostId: string; expiresAt: number },
  ) {
    return await this.recordRuntimeTokenForActor(await this.requirePrincipal(auth), args)
  }

  async recordRuntimeAccessTokenForActor(args: {
    jti: string
    workspaceId: string
    hostId: string
    actorId: string
    expiresAt: number
  }) {
    return await this.recordRuntimeTokenForActor(await this.requireRuntimeActor(args.actorId), args)
  }

  async runtimeAccessTokenActive(args: { jti: string; workspaceId: string; hostId: string }) {
    const jti = requireText(args.jti, "jti")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const hostId = requireText(args.hostId, "hostId")
    const row = await this.database.prepare(`select * from runtime_access_tokens where jti = ?`)
      .bind(jti).first<RuntimeTokenRow>()
    if (!row) return inactiveToken("runtime_access_token_unknown", "Runtime Access Token has not been recorded")
    if (row.revoked_at !== null) return inactiveToken("runtime_access_token_revoked", "Runtime Access Token has been revoked")
    if (row.workspace_id !== workspaceId || row.host_id !== hostId) {
      return inactiveToken("runtime_access_token_mismatch", "Runtime Access Token does not match workspace or host")
    }
    if (row.expires_at <= this.now()) return inactiveToken("runtime_access_token_expired", "Runtime Access Token has expired")
    try {
      await this.requireWorkspaceAccess(await this.requireRuntimeActor(row.minted_for_actor_id), workspaceId, "read")
    } catch (error) {
      if (isDenied(error)) {
        return inactiveToken("runtime_access_token_revoked", "Runtime Access Token authority has been revoked")
      }
      throw error
    }
    return { active: true }
  }

  async revokeRuntimeAccessToken(
    auth: SignedControlPlaneAuth,
    args: { jti: string; workspaceId: string },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const jti = requireText(args.jti, "jti")
    const now = this.now()
    await this.requireWorkspaceAccess(who, workspaceId, "read")
    await this.database.prepare(`
      ${workspaceAccessCte(1)}
      update runtime_access_tokens set revoked_at = ?
      where jti = ? and workspace_id = ? and revoked_at is null
        and exists (select 1 from authorized_workspace)
    `).bind(who.actorId, workspaceId, now, jti, workspaceId).run()
    return { ok: true }
  }

  async revokeRuntimeAccessTokensForWorkspaceUser(
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const now = this.now()
    await this.requireWorkspaceAccess(who, workspaceId, "read")
    const result = await this.database.prepare(`
      ${workspaceAccessCte(1)}
      update runtime_access_tokens set revoked_at = ?
      where workspace_id = ? and minted_for_user_id = ? and revoked_at is null
        and exists (select 1 from authorized_workspace)
    `).bind(who.actorId, workspaceId, now, workspaceId, who.userId).run()
    return { revoked: changes(result) }
  }

  private async recordRuntimeTokenForActor(
    actor: Principal,
    args: { jti: string; workspaceId: string; hostId: string; expiresAt: number },
  ) {
    const jti = requireText(args.jti, "jti")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const hostId = requireText(args.hostId, "hostId")
    const expiresAt = requireFutureTimestamp(args.expiresAt, this.now())
    await this.requireWorkspaceAccess(actor, workspaceId, "read")
    const now = this.now()
    try {
      await this.database.prepare(`
        ${workspaceAccessCte(1)}
        insert into runtime_access_tokens (
          jti, workspace_id, org_id, project_id, host_id,
          minted_for_user_id, minted_for_actor_id, expires_at, revoked_at, created_at
        )
        select ?, workspace_id, org_id, project_id, ?, ?, ?, ?, null, ?
        from authorized_workspace
      `).bind(
        actor.actorId,
        workspaceId,
        jti,
        hostId,
        actor.userId,
        actor.actorId,
        expiresAt,
        now,
      ).run()
    } catch (error) {
      if (isUniqueFailure(error)) {
        throw new D1HostAccessAuthorityError("resource_conflict", "Runtime Access Token JTI is already recorded")
      }
      throw error
    }
    if (!await this.database.prepare(`select 1 from runtime_access_tokens where jti = ?`).bind(jti).first()) throw denied()
    return { ok: true }
  }

  private async requirePrincipal(auth: SignedControlPlaneAuth): Promise<Principal> {
    const principal = auth.principal
    if (!principal) throw new ControlPlaneAuthError(503, "identity_provisioning", "Canonical application identity is required")
    if (principal.deploymentId !== this.options.deploymentId || principal.actorKind !== "human") {
      throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Application principal belongs to another authority domain")
    }
    const row = await this.database.prepare(`
      select ai.user_id, u.state as user_state, a.actor_id, a.kind as actor_kind,
        a.state as actor_state, ai.unlinked_at
      from auth_identities ai
      join users u on u.user_id = ai.user_id
      join actors a on a.actor_id = ? and a.user_id = u.user_id
      where ai.adapter = ? and ai.issuer = ? and ai.subject = ?
    `).bind(
      principal.actorId,
      principal.identity.adapter,
      principal.identity.issuer,
      principal.identity.subject,
    ).first<PrincipalRow>()
    if (
      !row || row.unlinked_at !== null || row.user_id !== principal.userId || row.actor_id !== principal.actorId
      || row.actor_kind !== "human"
    ) throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Application principal is stale or unlinked")
    if (row.user_state === "deleted") throw new ControlPlaneAuthError(403, "account_deleted", "Application account is deleted")
    if (row.user_state !== "active" || row.actor_state !== "active") {
      throw new ControlPlaneAuthError(403, "account_suspended", "Application account is suspended")
    }
    return { userId: row.user_id, actorId: row.actor_id, actorKind: "human" }
  }

  private async requireRuntimeActor(actorIdInput: string): Promise<Principal> {
    const actorId = requireText(actorIdInput, "actorId")
    const row = await this.database.prepare(`
      select a.actor_id, a.user_id, a.kind as actor_kind, a.state as actor_state,
        u.state as user_state
      from actors a left join users u on u.user_id = a.user_id
      where a.actor_id = ?
    `).bind(actorId).first<PrincipalRow>()
    if (!row || !row.user_id || row.actor_state !== "active" || row.user_state !== "active") {
      throw denied("Canonical active runtime actor is required")
    }
    return { userId: row.user_id, actorId, actorKind: row.actor_kind }
  }

  private async requireWorkspaceAccess(actor: Principal, workspaceId: string, action: "read" | "admin") {
    const row = await this.database.prepare(`
      ${workspaceAccessCte(action === "read" ? 1 : 3)}
      select * from authorized_workspace
    `).bind(actor.actorId, workspaceId).first<WorkspaceRow>()
    if (!row) throw denied()
    return row
  }

  private async shareTargetInOrganization(target: ReturnType<typeof normalizeShareTarget>, orgId: string) {
    if (target.kind === "org") return target.id === orgId
    if (target.kind === "user") {
      return !!await this.database.prepare(`
        select 1 from users user
        join org_memberships membership on membership.user_id = user.user_id and membership.revoked_at is null
        where user.user_id = ? and user.state = 'active' and membership.org_id = ?
      `).bind(target.id, orgId).first()
    }
    return !!await this.database.prepare(`
      select 1 from actors actor
      join users user on user.user_id = actor.user_id and user.state = 'active'
      join org_memberships membership on membership.user_id = user.user_id and membership.revoked_at is null
      where actor.actor_id = ? and actor.state = 'active' and membership.org_id = ?
    `).bind(target.id, orgId).first()
  }

  private async activeGrant(workspaceId: string, target: ReturnType<typeof normalizeShareTarget>) {
    const column = target.kind === "actor" ? "target_actor_id" : target.kind === "user" ? "target_user_id" : "target_org_id"
    return await this.database.prepare(`
      select * from workspace_share_grants
      where workspace_id = ? and target_kind = ? and ${column} = ? and revoked_at is null
    `).bind(workspaceId, target.kind, target.id).first<ShareGrantRow>()
  }

  private async challenge(challengeId: string) {
    return await this.database.prepare(`select * from host_attestation_challenges where challenge_id = ?`)
      .bind(challengeId).first<HostChallengeRow>()
  }

  private async localHostLink(workspaceId: string, hostId: string) {
    return await this.database.prepare(`select * from local_host_links where workspace_id = ? and host_id = ?`)
      .bind(workspaceId, hostId).first<HostLinkRow>()
  }

  private async enrollmentRequest(requestId: string) {
    return await this.database.prepare(`select * from host_enrollment_requests where request_id = ?`)
      .bind(requestId).first<EnrollmentRequestRow>()
  }

  private async enrollment(actorId: string, hostId: string) {
    return await this.database.prepare(`select * from host_enrollments where owner_actor_id = ? and host_id = ?`)
      .bind(actorId, hostId).first<EnrollmentRow>()
  }

  private async grant(grantId: string) {
    return await this.database.prepare(`select * from workspace_share_grants where grant_id = ?`)
      .bind(grantId).first<ShareGrantRow>()
  }

  private signatureUse(
    signatureHash: string,
    domain: "local-register" | "local-heartbeat" | "host-enroll" | "host-heartbeat",
    actorId: string,
    workspaceId: string | null,
    hostId: string,
    now: number,
  ) {
    return this.database.prepare(`
      insert into host_signature_uses (
        signature_hash, signature_domain, actor_id, workspace_id, host_id, used_at
      ) values (?, ?, ?, ?, ?, ?)
    `).bind(signatureHash, domain, actorId, workspaceId, hostId, now)
  }

  private deleteAssertion(assertionId: string) {
    return this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId)
  }

  private expiredRowSweep(table: "host_attestation_challenges" | "host_enrollment_requests", id: string, now: number) {
    return this.database.prepare(`
      delete from ${table} where ${id} in (
        select ${id} from ${table} where expires_at <= ? order by expires_at limit ?
      )
    `).bind(now, REQUEST_SWEEP_LIMIT)
  }

  private async guardedBatch(statements: D1PreparedStatement[], message: string) {
    try {
      return await this.database.batch(statements)
    } catch (error) {
      if (isUniqueFailure(error) && String(error).includes("host_signature_uses")) {
        throw new D1HostAccessAuthorityError("signature_replayed", "Host signature has already been used")
      }
      if (String(error).includes("authority_batch_assertions.passed") || String(error).includes("CHECK constraint failed")) {
        throw new D1HostAccessAuthorityError("resource_conflict", message)
      }
      throw error
    }
  }
}

function workspaceAccessCte(rank: 1 | 3) {
  return `with current_actor as (
    select actor.actor_id, actor.user_id
    from actors actor join users user on user.user_id = actor.user_id and user.state = 'active'
    where actor.actor_id = ? and actor.state = 'active'
  ), authorized_workspace as (
    select workspace.workspace_id, workspace.org_id, workspace.project_id,
      workspace.backing, workspace.access, workspace.home_region,
      max(
        case when workspace.owner_user_id = current_actor.user_id then 4 else 0 end,
        coalesce(case direct.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
        coalesce(case project_member.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
        case when organization.owner_user_id = current_actor.user_id then 3
          when org_member.role in ('owner', 'admin') then 3
          when org_member.role = 'member' then 1 else 0 end
      ) as role_rank
    from current_actor
    join workspaces workspace on workspace.workspace_id = ? and workspace.deleted_at is null
    join projects project
      on project.project_id = workspace.project_id and project.org_id = workspace.org_id and project.deleted_at is null
    join orgs organization on organization.org_id = workspace.org_id and organization.deleted_at is null
    left join workspace_memberships direct
      on direct.workspace_id = workspace.workspace_id and direct.user_id = current_actor.user_id and direct.revoked_at is null
    left join project_memberships project_member
      on project_member.project_id = workspace.project_id and project_member.user_id = current_actor.user_id
      and project_member.revoked_at is null
    left join org_memberships org_member
      on org_member.org_id = workspace.org_id and org_member.user_id = current_actor.user_id and org_member.revoked_at is null
    where organization.owner_user_id = current_actor.user_id or org_member.user_id is not null
    group by workspace.workspace_id
    having role_rank >= ${rank}
  )`
}

export function localHostRegistrationPayload(input: {
  workspaceId: string
  hostId: string
  challengeId: string
  nonce: string
}) {
  return [
    "claxedo.local-host-link.register.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `challenge_id=${input.challengeId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

export function localHostHeartbeatPayload(input: { workspaceId: string; hostId: string; ttlMs?: number }) {
  return [
    "claxedo.local-host-link.heartbeat.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
  ].join("\n")
}

export function hostEnrollmentPayload(input: { hostId: string; requestId: string; nonce: string }) {
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.hostId}`,
    `request_id=${input.requestId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

export function hostEnrollmentHeartbeatPayload(input: { hostId: string; ttlMs?: number }) {
  return [
    "claxedo.host-enrollment.heartbeat.v1",
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
  ].join("\n")
}

async function verifiedPublicKey(input: string) {
  const value = requireText(input, "publicKey", 8_000)
  let jwk: JsonWebKey
  try {
    jwk = JSON.parse(value) as JsonWebKey
  } catch {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host public key")
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || jwk.d) {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Host public key must be a public P-256 JWK")
  }
  try {
    await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  } catch {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host public key")
  }
  return JSON.stringify(jwk)
}

async function verifyHostSignature(input: { publicKey: string; payload: string; signature: string }) {
  let jwk: JsonWebKey
  try {
    jwk = JSON.parse(input.publicKey) as JsonWebKey
  } catch {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid stored host public key")
  }
  const signatureBytes = base64UrlBytes(requireText(input.signature, "signature", 2_000))
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  if (!await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signatureBytes,
    new TextEncoder().encode(input.payload),
  )) throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host attestation")
  return await sha256(canonicalP256Signature(signatureBytes))
}

function normalizeShareTarget(target: WorkspaceShareTarget) {
  if (target.kind === "actor") return { kind: target.kind, id: requireText(target.actorId, "actorId") }
  if (target.kind === "user") return { kind: target.kind, id: requireText(target.userId, "userId") }
  if (target.kind === "org") return { kind: target.kind, id: requireText(target.orgId, "orgId") }
  throw new D1HostAccessAuthorityError("invalid_input", "Unknown canonical workspace share target")
}

function requireShareRole(role: string): "viewer" | "editor" | "admin" {
  if (role !== "viewer" && role !== "editor" && role !== "admin") {
    throw new D1HostAccessAuthorityError("invalid_input", "Unknown workspace share role")
  }
  return role
}

function requireLocalWorkspace(workspace: WorkspaceRow) {
  if (workspace.backing !== "local-worktree" || workspace.access !== "user-hosted") {
    throw new D1HostAccessAuthorityError(
      "resource_conflict",
      "Local host links require a user-hosted local workspace",
    )
  }
}

function enrollmentJson(row: EnrollmentRow): HostEnrollment {
  return {
    enrollment_id: row.enrollment_id,
    host_id: row.host_id,
    ...(row.display_name ? { display_name: row.display_name } : {}),
    expires_at: row.expires_at,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  }
}

function inactiveToken(code: string, reason: string) {
  return { active: false, code, reason }
}

function normalizedTtl(input: number | undefined) {
  if (input === undefined) return DEFAULT_TTL_MS
  if (!Number.isFinite(input)) throw new D1HostAccessAuthorityError("invalid_input", "ttlMs must be finite")
  return Math.max(5_000, Math.min(input, MAX_TTL_MS))
}

function requireFutureTimestamp(value: number, now: number) {
  if (!Number.isSafeInteger(value) || value <= now) {
    throw new D1HostAccessAuthorityError("invalid_input", "expiresAt must be a future safe-integer timestamp")
  }
  return value
}

function optionalText(value: string | undefined, name: string, max = 512) {
  if (value === undefined) return undefined
  return requireText(value, name, max)
}

function requireText(value: unknown, name: string, max = 512) {
  if (typeof value !== "string") {
    throw new D1HostAccessAuthorityError("invalid_input", `${name} must be a string`)
  }
  const result = value.trim()
  if (!result || result.length > max) {
    throw new D1HostAccessAuthorityError("invalid_input", `${name} must be a non-empty string of at most ${max} characters`)
  }
  return result
}

function randomBase64Url(size: number) {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)))
}

function base64Url(value: Uint8Array) {
  let text = ""
  for (const byte of value) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function base64UrlBytes(input: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host signature encoding")
  }
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
    const value = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
    return Uint8Array.from(value, (character) => character.charCodeAt(0))
  } catch {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host signature encoding")
  }
}

async function sha256(value: Uint8Array) {
  const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
  const result = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function canonicalP256Signature(value: Uint8Array) {
  if (value.byteLength !== 64) {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid P-256 signature length")
  }
  const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")
  const s = BigInt(`0x${hex(value.slice(32))}`)
  if (s === 0n || s >= order) {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid P-256 signature scalar")
  }
  const canonicalS = s > order / 2n ? order - s : s
  const result = new Uint8Array(64)
  result.set(value.slice(0, 32), 0)
  const encodedS = canonicalS.toString(16).padStart(64, "0")
  for (let index = 0; index < 32; index += 1) {
    result[32 + index] = Number.parseInt(encodedS.slice(index * 2, index * 2 + 2), 16)
  }
  return result
}

function hex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function changes(result: { meta?: { changes?: number } }) {
  return result.meta?.changes ?? 0
}

function denied(message = "Workspace authority denied access") {
  return new ControlPlaneAuthError(403, "workspace_authorization_denied", message)
}

function isDenied(error: unknown) {
  return error instanceof ControlPlaneAuthError && error.status === 403
}

function isUniqueFailure(error: unknown) {
  const text = String(error)
  return text.includes("UNIQUE constraint failed") || text.includes("constraint failed") && text.includes("unique")
}
