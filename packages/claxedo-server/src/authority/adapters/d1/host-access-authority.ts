import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type {
  HostEnrollment,
  HostEnrollmentState,
  WorkspaceAuthority,
  WorkspaceShareTarget,
} from "@claxedo/server-core/platform/auth/authority"

export const D1_HOST_ACCESS_AUTHORITY_METHODS = [
  "createHostEnrollmentRequest",
  "enrollHost",
  "heartbeatHostEnrollment",
  "pauseHostEnrollment",
  "activeHostEnrollment",
  "markSecondDeviceOpen",
  "assignWorkspaceHost",
  "unassignWorkspaceHost",
  "activeWorkspaceHost",
  "listHostAssignments",
  "grantWorkspaceShare",
  "revokeWorkspaceShare",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1HostAccessAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_HOST_ACCESS_AUTHORITY_METHODS)[number]>

export type D1HostAccessAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: (prefix: "request" | "enrollment" | "grant" | "assert") => string
  randomNonce?: () => string
  registerLocalForSharing?: WorkspaceAuthority["registerLocalForSharing"]
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
/** A signed heartbeat payload must stay small; 200 shares per machine is generous. */
const MAX_ACKED_WORKSPACES = 200
const MAX_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 60_000
const CONSUMED_REQUEST_RETENTION_MS = 10 * 60_000
const REQUEST_SWEEP_LIMIT = 500

export class D1HostAccessAuthorityError extends ClaxedoError {
  constructor(
    code:
      | "invalid_input"
      | "resource_conflict"
      | "host_attestation_denied"
      | "signature_replayed",
    message: string,
  ) {
    super({
      code,
      message,
      status: code === "invalid_input" ? 400 : code === "host_attestation_denied" ? 403 : 409,
    })
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

  async markSecondDeviceOpen(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const now = this.now()
    await this.requireWorkspaceAccess(who, workspaceId, "read")
    const result = await this.database.prepare(`
      ${workspaceAccessCte(1)}
      update host_workspace_assignments
      set second_device_open_at = coalesce(second_device_open_at, ?), updated_at = ?
      where workspace_id = ? and owner_actor_id = ?
        and exists (select 1 from authorized_workspace)
    `).bind(who.actorId, workspaceId, now, now, workspaceId, who.actorId).run()
    return { recorded: changes(result) > 0, second_device_open_at: now }
  }

  /**
   * The OWNER's declaration that host H serves workspace X. Pure data: no
   * challenge and no TTL — liveness is the enrollment lease, consent is the
   * heartbeat's acked set, and routing requires all three. Cold-registers the
   * workspace row exactly as the retired per-workspace registration did.
   */
  async assignWorkspaceHost(
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      hostId: string
      displayName?: string
      orgId?: string
      projectId?: string
      repoUrl?: string
      repoName?: string
      gitBranch?: string
      remoteDirectory?: string
      homeRegion?: string
    },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const hostId = requireText(args.hostId, "hostId")
    const displayName = optionalText(args.displayName, "displayName", 200)
    const enrollment = await this.enrollment(who.actorId, hostId)
    if (!enrollment || enrollment.revoked_at !== null) {
      throw new D1HostAccessAuthorityError("host_attestation_denied", "Host enrollment is unavailable")
    }
    let workspace = await this.workspace(workspaceId)
    if (workspace) {
      workspace = await this.requireWorkspaceAccess(who, workspaceId, "admin")
      requireLocalWorkspace(workspace)
      // The assigning machine describes the workspace it serves — name,
      // repository, branch, directory — and that description is the record.
      const description: Array<[string, string]> = [
        ...(displayName ? [["display_name", displayName] as [string, string]] : []),
        ...(args.repoUrl ? [["repo_url", args.repoUrl] as [string, string]] : []),
        ...(args.repoName ? [["repo_name", args.repoName] as [string, string]] : []),
        ...(args.gitBranch ? [["git_branch", args.gitBranch] as [string, string]] : []),
        ...(args.remoteDirectory ? [["remote_directory", args.remoteDirectory] as [string, string]] : []),
      ]
      if (description.length) {
        await this.database.prepare(`
          update workspaces set ${description.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ?
          where workspace_id = ?
        `).bind(...description.map(([, value]) => value), this.now(), workspaceId).run()
      }
    } else {
      if (!this.options.registerLocalForSharing) {
        throw new D1HostAccessAuthorityError("host_attestation_denied", "Cold local workspace registration is unavailable")
      }
      await this.options.registerLocalForSharing(auth, {
        workspaceId,
        displayName: displayName ?? workspaceId,
        ...(args.orgId ? { orgId: args.orgId } : {}),
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.repoUrl ? { repoUrl: args.repoUrl } : {}),
        ...(args.repoName ? { repoName: args.repoName } : {}),
        ...(args.gitBranch ? { gitBranch: args.gitBranch } : {}),
        ...(args.remoteDirectory ? { remoteDirectory: args.remoteDirectory } : {}),
        ...(args.homeRegion ? { homeRegion: args.homeRegion } : {}),
      })
      workspace = await this.requireWorkspaceAccess(who, workspaceId, "admin")
      requireLocalWorkspace(workspace)
    }
    const now = this.now()
    await this.database.prepare(`
      insert into host_workspace_assignments (
        workspace_id, host_id, org_id, owner_user_id, owner_actor_id,
        second_device_open_at, assigned_at, updated_at
      ) values (?, ?, ?, ?, ?, null, ?, ?)
      on conflict (workspace_id) do update set
        host_id = excluded.host_id,
        owner_user_id = excluded.owner_user_id,
        owner_actor_id = excluded.owner_actor_id,
        updated_at = excluded.updated_at
    `).bind(workspaceId, hostId, workspace.org_id, who.userId, who.actorId, now, now).run()
    return { assigned: true as const, workspace_id: workspaceId, host_id: hostId }
  }

  async unassignWorkspaceHost(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireWorkspaceAccess(who, workspaceId, "admin")
    const result = await this.database.prepare(`
      delete from host_workspace_assignments where workspace_id = ?
    `).bind(workspaceId).run()
    return { unassigned: changes(result) > 0 }
  }

  /** Routable host: owner-assigned AND machine-acked AND live lease. */
  async activeWorkspaceHost(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireWorkspaceAccess(who, workspaceId, "read")
    const row = await this.database.prepare(`
      select assignment.workspace_id, assignment.host_id, assignment.second_device_open_at,
        enrollment.display_name, enrollment.expires_at, enrollment.last_seen_at
      from host_workspace_assignments assignment
      inner join host_enrollments enrollment on enrollment.host_id = assignment.host_id
        and enrollment.owner_actor_id = assignment.owner_actor_id
      where assignment.workspace_id = ?
        and enrollment.revoked_at is null and enrollment.paused_at is null
        and enrollment.expires_at > ?
        and exists (
          select 1 from json_each(coalesce(enrollment.acked_workspace_ids, '[]'))
          where json_each.value = assignment.workspace_id
        )
      limit 1
    `).bind(workspaceId, this.now()).first<{
      workspace_id: string
      host_id: string
      second_device_open_at: number | null
      display_name: string | null
      expires_at: number
      last_seen_at: number
    }>()
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

  /** Every live assignment on the account, grouped for the devices surface. */
  async listHostAssignments(auth: SignedControlPlaneAuth) {
    const who = await this.requirePrincipal(auth)
    const rows = await this.database.prepare(`
      select assignment.workspace_id, assignment.host_id,
        enrollment.display_name, enrollment.last_seen_at, enrollment.expires_at,
        coalesce(enrollment.acked_workspace_ids, '[]') as acked_workspace_ids
      from host_workspace_assignments assignment
      inner join host_enrollments enrollment on enrollment.host_id = assignment.host_id
        and enrollment.owner_actor_id = assignment.owner_actor_id
      where assignment.owner_actor_id = ?
        and enrollment.revoked_at is null and enrollment.paused_at is null
        and enrollment.expires_at > ?
      order by assignment.host_id, assignment.workspace_id
    `).bind(who.actorId, this.now()).all<{
      workspace_id: string
      host_id: string
      display_name: string | null
      last_seen_at: number
      expires_at: number
      acked_workspace_ids: string
    }>()
    const groups = new Map<string, {
      host_id: string
      display_name: string
      last_seen_at: number
      expires_at: number
      workspace_ids: string[]
      acked_workspace_ids: string[]
    }>()
    for (const row of rows.results ?? []) {
      const group = groups.get(row.host_id) ?? {
        host_id: row.host_id,
        display_name: row.display_name ?? row.host_id,
        last_seen_at: row.last_seen_at,
        expires_at: row.expires_at,
        workspace_ids: [],
        acked_workspace_ids: JSON.parse(row.acked_workspace_ids) as string[],
      }
      group.workspace_ids.push(row.workspace_id)
      groups.set(row.host_id, group)
    }
    return [...groups.values()]
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
      this.signatureUse(signatureHash, "host-enroll", who.actorId, hostId, now),
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
    args: { hostId: string; signature: string; ttlMs?: number; workspaceIds: readonly string[] },
  ) {
    const who = await this.requirePrincipal(auth)
    const hostId = requireText(args.hostId, "hostId")
    const enrollment = await this.enrollment(who.actorId, hostId)
    if (!enrollment || enrollment.revoked_at !== null) {
      throw new D1HostAccessAuthorityError("host_attestation_denied", "Host enrollment is unavailable")
    }
    if (!Array.isArray(args.workspaceIds)) {
      throw new D1HostAccessAuthorityError("invalid_input", "workspaceIds is required — the heartbeat signature covers the served set")
    }
    const workspaceIds = [...new Set(args.workspaceIds.map((id) => requireText(id, "workspaceIds")))].sort()
    if (workspaceIds.length > MAX_ACKED_WORKSPACES) {
      throw new D1HostAccessAuthorityError("invalid_input", "workspaceIds exceeds the served-set cap")
    }
    const signatureHash = await verifyHostSignature({
      publicKey: enrollment.public_key_json,
      signature: args.signature,
      payload: hostEnrollmentHeartbeatPayloadV2({ hostId, ttlMs: args.ttlMs, workspaceIds }),
    })
    const now = this.now()
    const expiresAt = now + normalizedTtl(args.ttlMs)
    const assertionId = this.randomId("assert")
    await this.guardedBatch([
      this.signatureUse(signatureHash, "host-heartbeat", who.actorId, hostId, now),
      this.database.prepare(`
        update host_enrollments set
          last_seen_at = ?, expires_at = ?, last_signature_hash = ?, updated_at = ?,
          acked_workspace_ids = ?, acked_at = ?
        where owner_actor_id = ? and host_id = ? and revoked_at is null
      `).bind(now, expiresAt, signatureHash, now, JSON.stringify(workspaceIds), now, who.actorId, hostId),
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
    // The owner's assignment view rides back on every ack so the machine can
    // reconcile its persisted set — without this, machine consent and owner
    // intent drift apart silently forever.
    const assigned = await this.database.prepare(`
      select workspace_id from host_workspace_assignments
      where host_id = ? and owner_actor_id = ?
      order by workspace_id
    `).bind(hostId, who.actorId).all<{ workspace_id: string }>()
    return {
      expires_at: expiresAt,
      last_seen_at: now,
      assigned_workspace_ids: (assigned.results ?? []).map((row) => row.workspace_id),
    }
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
      // A revoked key's host id never returns (a later enable enrolls a NEW
      // id), so its assignments could never become routable again — leaving
      // them would only accumulate dangling rows that a later re-share must
      // displace. The cascade keeps "revoke = nothing routable" exactly true.
      this.database.prepare(`
        delete from host_workspace_assignments
        where owner_actor_id = ? and (? is null or host_id = ?)
      `).bind(who.actorId, hostId ?? null, hostId ?? null),
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
    return { revoked: changes(results[0]!), runtime_tokens_revoked: changes(results[2]!) }
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

  async runtimeAccessTokenActive(args: {
    jti: string
    workspaceId: string
    hostId: string
    minimumRole?: "viewer" | "editor" | "admin" | "owner"
  }) {
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
      const access = await this.requireWorkspaceAccess(await this.requireRuntimeActor(row.minted_for_actor_id), workspaceId, "read")
      if (args.minimumRole && access.role_rank < hostRoleRank(args.minimumRole)) {
        return inactiveToken("runtime_access_token_revoked", "Runtime Access Token no longer has the required workspace role")
      }
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

  private async workspace(workspaceId: string) {
    return await this.database.prepare(`
      select workspace_id, org_id, project_id, backing, access, home_region, 0 as role_rank
      from workspaces where workspace_id = ? and deleted_at is null
    `).bind(workspaceId).first<WorkspaceRow>()
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

  /**
   * Replay guard for one machine signature.
   *
   * `workspace_id` is always null: enrollment is machine-wide, so no signature
   * this authority verifies is scoped to a workspace. The column stays because
   * it holds historical rows from the retired per-workspace flow.
   */
  private signatureUse(
    signatureHash: string,
    domain: "host-enroll" | "host-heartbeat",
    actorId: string,
    hostId: string,
    now: number,
  ) {
    return this.database.prepare(`
      insert into host_signature_uses (
        signature_hash, signature_domain, actor_id, workspace_id, host_id, used_at
      ) values (?, ?, ?, null, ?, ?)
    `).bind(signatureHash, domain, actorId, hostId, now)
  }

  private deleteAssertion(assertionId: string) {
    return this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId)
  }

  private expiredRowSweep(table: "host_enrollment_requests", id: string, now: number) {
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

function hostRoleRank(role: "viewer" | "editor" | "admin" | "owner") {
  return role === "viewer" ? 0 : role === "editor" ? 1 : role === "admin" ? 2 : 3
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

export function hostEnrollmentPayload(input: { hostId: string; requestId: string; nonce: string }) {
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.hostId}`,
    `request_id=${input.requestId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

/**
 * Heartbeat v2: the machine's ONE signature per interval also covers the
 * workspaces it currently serves (sorted, comma-joined). Routing requires a
 * workspace to be BOTH owner-assigned and inside this acked set, which
 * preserves the retired per-workspace signature's security property — an
 * owner session cannot conjure serving the machine never consented to — at
 * one signature instead of N+1. Replay is defended exactly like v1: every
 * signature hash is single-use (`host_signature_uses` primary key) and ECDSA
 * signatures are randomized, so a client must re-sign on every beat and a
 * captured signature collides with its own prior use.
 */
export function hostEnrollmentHeartbeatPayloadV2(input: {
  hostId: string
  ttlMs?: number
  workspaceIds: readonly string[]
}) {
  return [
    "claxedo.host-enrollment.heartbeat.v2",
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
    `workspaces=${[...input.workspaceIds].sort().join(",")}`,
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
