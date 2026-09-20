import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import {
  hostEnrollmentScope,
  hostProviderConfigRekeyed,
  hostSessionAuthority,
  nextHostProviderConfigRevision,
  pendingHostProviderConfig,
  storedHostProviderIds,
} from "@claxedo/server-core/platform/auth/authority"
import type {
  HostAssignmentAck,
  HostAssignmentDescription,
  HostConnectErrorCode,
  HostEnrollment,
  HostEnrollmentListRow,
  HostEnrollmentState,
  HostInvitationCreateInput,
  HostInvitationCreateResult,
  HostInvitationRedeemInput,
  HostInvitationRedeemResult,
  HostInvitationRow,
  HostMachineHeartbeatInput,
  HostMachineHeartbeatResult,
  HostProviderConfigPushInput,
  HostProviderConfigTarget,
  HostScopeDefinition,
  HostScopeUpdateResult,
  MachineAuthAdapter,
  MachinePrincipal,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"
import {
  directoryWithinRoots,
  invitationRedeemPayload,
  invitationToken,
  normalizePosixDirectory,
  normalizeStoredDirectory,
  publicKeyFingerprint,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import type { MachineAuthRefusal } from "@claxedo/server-core/platform/auth/machine-auth"
import { MACHINE_SEAL_VERSION, machineSealingPublicKey } from "@claxedo/server-core/platform/auth/machine-seal"
import { timingSafeEqualStrings } from "@claxedo/server-core/platform/auth/web-crypto"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { asRecord, parseJson } from "@claxedo/server-core/platform/json/index"
import { batchAssertionFailed, type D1WorkspaceAuthority } from "./workspace-authority"

export const D1_HOST_ACCESS_AUTHORITY_METHODS = [
  "createHostEnrollmentRequest",
  "enrollHost",
  "heartbeatHostEnrollmentByMachine",
  "acquireHostServingGeneration",
  "pauseHostEnrollment",
  "activeHostEnrollment",
  "listHostEnrollments",
  "hostEnrollmentByHost",
  "updateHostEnrollmentScope",
  "renameHostEnrollment",
  "hostProviderConfigTarget",
  "pushHostProviderConfig",
  "createHostInvitation",
  "listHostInvitations",
  "revokeHostInvitation",
  "redeemHostInvitation",
  "markSecondDeviceOpen",
  "assignWorkspaceHost",
  "unassignWorkspaceHost",
  "activeWorkspaceHost",
  "listHostAssignments",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1HostAccessAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_HOST_ACCESS_AUTHORITY_METHODS)[number]> & {
  machineAuth: MachineAuthAdapter
}

export type D1HostAccessAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: (prefix: "request" | "enrollment" | "grant" | "assert" | "invitation" | "audit") => string
  randomNonce?: () => string
  /** The statements that cold-register a machine-placed workspace, run inside the assignment's own batch. */
  localWorkspaceRegistration?: D1WorkspaceAuthority["localWorkspaceRegistration"]
  /** The caller's current organization, recorded on an invitation when it is created. */
  resolveOrgId?: WorkspaceAuthority["resolveOrgId"]
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
  home_region: string | null
  remote_directory: string | null
  host_assignment_revision: number
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
  session_authority: string | null
  created_at: number
  updated_at: number
  key_version: number
  serving_generation: number
  generation_acquired_at: number | null
  enrolled_via: "account" | "invitation"
  scope_json: string | null
  scope_revision: number
  sealing_public_key_json: string | null
  provider_config_sealed: string | null
  provider_config_revision: number
  provider_config_acked_revision: number
  provider_config_updated_at: number | null
  provider_config_sealed_key_json: string | null
  provider_config_provider_ids: string | null
}

type InvitationRow = {
  invitation_id: string
  owner_user_id: string
  owner_actor_id: string
  org_id: string
  secret_hash: string
  display_name: string | null
  scope_json: string
  expires_at: number
  redeemed_at: number | null
  redeemed_enrollment_id: string | null
  redeemed_host_id: string | null
  redeemed_public_key_fingerprint: string | null
  created_by_actor_id: string
  created_at: number
  revoked_at: number | null
}

const DEFAULT_TTL_MS = 60_000
/** A signed heartbeat payload must stay small; 200 shares per machine is generous. */
const MAX_ACKED_WORKSPACES = 200
const MAX_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 60_000
const CONSUMED_REQUEST_RETENTION_MS = 10 * 60_000
const REQUEST_SWEEP_LIMIT = 500
const INVITATION_MIN_TTL_MS = 5 * 60_000
const INVITATION_MAX_TTL_MS = 24 * 60 * 60_000
const INVITATION_DEFAULT_TTL_MS = 60 * 60_000
const MAX_SCOPE_ROOTS = 50
const MAX_SCOPE_ROOT_LENGTH = 1_024
const MAX_SEALING_PUBLIC_KEY_LENGTH = 4_000
/** base64url of the route's 32 KiB plaintext cap plus the ephemeral key, iv and tag. */
const MAX_SEALED_LENGTH = 64 * 1024
const MAX_PROVIDER_IDS = 100

export type D1HostAccessErrorCode =
  | "invalid_input"
  | "resource_conflict"
  | "host_attestation_denied"
  | "signature_replayed"
  | "host_enrollment_not_found"
  | Extract<
    MachineAuthRefusal["code"],
    "enrollment_revoked" | "enrollment_paused" | "enrollment_owner_ineligible" | "enrollment_key_version_mismatch"
  >
  | HostConnectErrorCode

const ERROR_STATUS: Record<D1HostAccessErrorCode, number> = {
  invalid_input: 400,
  resource_conflict: 409,
  host_attestation_denied: 403,
  signature_replayed: 409,
  host_enrollment_not_found: 404,
  enrollment_revoked: 403,
  enrollment_paused: 403,
  enrollment_owner_ineligible: 403,
  enrollment_key_version_mismatch: 403,
  invitation_invalid: 403,
  invitation_expired: 410,
  invitation_revoked: 410,
  invitation_redeemed: 409,
  invitation_host_conflict: 409,
  enrollment_generation_superseded: 409,
  host_assignment_outside_scope: 400,
  host_sealing_key_undeclared: 409,
  host_provider_config_revision_stale: 409,
}

export class D1HostAccessAuthorityError extends ClaxedoError<D1HostAccessErrorCode> {
  constructor(
    code: D1HostAccessErrorCode,
    message: string,
    /** Extra fields the route places beside `code` and `message` in the error body. */
    public readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, status: ERROR_STATUS[code] })
  }
}

/**
 * The one definition of "a host is serving this workspace right now": an
 * enrollment that is neither revoked nor paused, whose lease has not expired,
 * and whose readiness row for the workspace names this enrollment at its
 * current serving generation and the assignment's current revision. Written
 * against an `assignment`/`enrollment` join, and binding exactly one value —
 * `now`.
 *
 * `activeWorkspaceHost` answers it for one workspace, the workspace list
 * stamps it on every machine-placed row (`D1WorkspaceAuthority.listWorkspaces`),
 * the relay target resolver routes on it and the tunnel credential is minted
 * for it; all four must mean the same thing. A re-pointed directory (new
 * revision) or a superseded instance (new generation) therefore stops routing
 * on the next read, not on the next token.
 */
export const HOST_SERVING_WORKSPACE_SQL = `enrollment.revoked_at is null and enrollment.paused_at is null
        and enrollment.expires_at > ?
        and exists (
          select 1 from host_assignment_readiness readiness
          where readiness.workspace_id = assignment.workspace_id
            and readiness.enrollment_id = enrollment.enrollment_id
            and readiness.generation = enrollment.serving_generation
            and readiness.revision = assignment.revision
        )`

/**
 * The organization branch of a workspace's role rank: every workspace-scoped
 * rank computation — `workspaceAccessCte` here, workspace-authority's
 * `workspaceAccessSql`, channel-runtime-authority's `workspaceAccessSql`, the
 * session authority's actor rank and the Agent Plugins store's
 * `WORKSPACE_ACCESS_SQL` — builds its org branch from this one string. The
 * ordinary org member's implicit viewer rank is gated on the workspace's
 * `org_member_visible`; owners and admins are not. Project access has no
 * workspace row and does not use this.
 */
export function organizationRoleRankSql(input: {
  orgOwnerUserId: string
  userId: string
  orgMemberRole: string
  workspaceAlias: string
}) {
  return `case when ${input.orgOwnerUserId} = ${input.userId} then 3
          when ${input.orgMemberRole} in ('owner', 'admin') then 3
          when ${input.orgMemberRole} = 'member' and ${input.workspaceAlias}.org_member_visible = 1 then 1
          else 0 end`
}

/**
 * The machine caller's eligibility, evaluated inside every batch that mutates
 * on its behalf: the enrollment is live, the key the verifier read is still
 * the key on the row, and the owner is an active user with an active actor.
 * Written against `host_enrollments` unaliased, binding `enrollment_id` and
 * `key_version` in that order.
 */
const MACHINE_ELIGIBLE_SQL = `enrollment_id = ? and key_version = ? and revoked_at is null and paused_at is null
        and exists (
          select 1 from users owner
          join actors owner_actor on owner_actor.actor_id = host_enrollments.owner_actor_id
            and owner_actor.user_id = owner.user_id
          where owner.user_id = host_enrollments.owner_user_id
            and owner.state = 'active' and owner_actor.state = 'active'
        )`

export class D1HostAccessAuthority implements D1HostAccessAuthorityPort {
  private readonly now: () => number
  private readonly randomId: NonNullable<D1HostAccessAuthorityOptions["randomId"]>
  private readonly randomNonce: NonNullable<D1HostAccessAuthorityOptions["randomNonce"]>
  readonly machineAuth: MachineAuthAdapter

  constructor(
    private readonly database: D1Database,
    private readonly options: D1HostAccessAuthorityOptions,
  ) {
    requireText(options.deploymentId, "deploymentId")
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? ((prefix) => `${prefix}_${randomBase64Url(16)}`)
    this.randomNonce = options.randomNonce ?? (() => randomBase64Url(32))
    this.machineAuth = {
      lookupEnrollment: async (enrollmentId) => {
        const row = await this.database.prepare(`
          select enrollment.*, exists (
            select 1 from users owner
            join actors owner_actor on owner_actor.actor_id = enrollment.owner_actor_id
              and owner_actor.user_id = owner.user_id
            where owner.user_id = enrollment.owner_user_id
              and owner.state = 'active' and owner_actor.state = 'active'
          ) as owner_eligible
          from host_enrollments enrollment where enrollment.enrollment_id = ?
        `).bind(enrollmentId).first<EnrollmentRow & { owner_eligible: number }>()
        if (!row) return undefined
        return {
          enrollment_id: row.enrollment_id,
          host_id: row.host_id,
          owner_user_id: row.owner_user_id,
          owner_actor_id: row.owner_actor_id,
          public_key_json: row.public_key_json,
          key_version: row.key_version,
          serving_generation: row.serving_generation,
          revoked_at: row.revoked_at,
          paused_at: row.paused_at,
          scope: hostEnrollmentScope(row.scope_json, row.scope_revision),
          ownerEligible: row.owner_eligible === 1,
        }
      },
      consumeNonce: async (input) => {
        try {
          await this.database.prepare(`
            insert into host_request_nonces (enrollment_id, nonce, expires_at) values (?, ?, ?)
          `).bind(input.enrollmentId, input.nonce, input.expiresAt).run()
          return true
        } catch (error) {
          if (isUniqueFailure(error)) return false
          throw error
        }
      },
    }
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
   * heartbeat's readiness row, and routing requires all three. Cold-registers
   * the workspace row exactly as the retired per-workspace registration did.
   *
   * The owner's rank is decided against the record as it stands — a retired
   * machine-placed row included, since assigning it is what revives it — so a
   * refused request writes nothing. The cold registration, the revival, the
   * directory and the next assignment revision then land in one batch guarded
   * on the workspace counter and the enrollment's scope revision this call
   * validated, so a scope that moved in between leaves neither an assignment
   * nor a workspace behind; the enrollment's scope decides both whether the
   * directory is allowed and whether ordinary org members see the workspace.
   * A stored directory is written back in its normalized form even when the
   * request omits one, so a row an older writer left un-normalized is
   * repaired by the next assignment.
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
    const requestedDirectory = optionalText(args.remoteDirectory, "remoteDirectory", MAX_SCOPE_ROOT_LENGTH)
    const enrollment = await this.enrollment(who.actorId, hostId)
    if (!enrollment || enrollment.revoked_at !== null) {
      throw new D1HostAccessAuthorityError("host_attestation_denied", "Host enrollment is unavailable")
    }
    const scope = hostEnrollmentScope(enrollment.scope_json, enrollment.scope_revision)
    const invitationOrgId = enrollment.enrolled_via === "invitation"
      ? await this.invitationOrgId(enrollment.enrollment_id)
      : undefined
    if (invitationOrgId && args.orgId && args.orgId !== invitationOrgId) {
      throw new D1HostAccessAuthorityError("host_assignment_outside_scope", "Workspace organization differs from the invitation's")
    }
    const orgMemberVisible = scope?.visibility !== "owner"
    let workspace: WorkspaceRow | undefined
    if (await this.assignableWorkspaceExists(workspaceId)) {
      workspace = await this.requireWorkspaceAccess(who, workspaceId, "admin", true)
      requireLocalWorkspace(workspace)
      if (invitationOrgId && workspace.org_id !== invitationOrgId) {
        throw new D1HostAccessAuthorityError("host_assignment_outside_scope", "Workspace organization differs from the invitation's")
      }
    }
    const directory = requestedDirectory ?? workspace?.remote_directory ?? undefined
    const remoteDirectory = directory === undefined ? undefined : normalizeStoredDirectory(directory)
    if (scope && !directoryWithinRoots(remoteDirectory ?? "", scope.allowed_roots)) {
      throw new D1HostAccessAuthorityError(
        "host_assignment_outside_scope",
        "Workspace directory is outside the roots this machine may serve",
      )
    }
    let registration: D1PreparedStatement[] = []
    if (!workspace) {
      if (!this.options.localWorkspaceRegistration) {
        throw new D1HostAccessAuthorityError("host_attestation_denied", "Cold local workspace registration is unavailable")
      }
      const orgId = args.orgId ?? invitationOrgId
      registration = (await this.options.localWorkspaceRegistration(auth, {
        workspaceId,
        displayName: displayName ?? workspaceId,
        ...(orgId ? { orgId } : {}),
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.repoUrl ? { repoUrl: args.repoUrl } : {}),
        ...(args.repoName ? { repoName: args.repoName } : {}),
        ...(args.gitBranch ? { gitBranch: args.gitBranch } : {}),
        ...(remoteDirectory ? { remoteDirectory } : {}),
        ...(args.homeRegion ? { homeRegion: args.homeRegion } : {}),
        orgMemberVisible,
      })).statements
    }
    // The assigning owner describes the workspace the machine serves — name,
    // repository, branch, directory — and that description is the record.
    const description: Array<[string, string | number]> = [
      ...(displayName ? [["display_name", displayName] as [string, string]] : []),
      ...(args.repoUrl ? [["repo_url", args.repoUrl] as [string, string]] : []),
      ...(args.repoName ? [["repo_name", args.repoName] as [string, string]] : []),
      ...(args.gitBranch ? [["git_branch", args.gitBranch] as [string, string]] : []),
      ...(remoteDirectory ? [["remote_directory", remoteDirectory] as [string, string]] : []),
      ["org_member_visible", orgMemberVisible ? 1 : 0],
    ]
    const counter = workspace?.host_assignment_revision ?? 0
    const revision = counter + 1
    const now = this.now()
    const assertionId = this.randomId("assert")
    await this.guardedBatch([
      ...registration,
      this.database.prepare(`
        update workspaces set deleted_at = null, host_assignment_revision = ?,
          ${description.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ?
        where workspace_id = ? and host_assignment_revision = ? and backing = 'local-worktree'
          and exists (
            select 1 from host_enrollments
            where owner_actor_id = ? and host_id = ? and revoked_at is null and scope_revision = ?
          )
      `).bind(
        revision,
        ...description.map(([, value]) => value),
        now,
        workspaceId,
        counter,
        who.actorId,
        hostId,
        enrollment.scope_revision,
      ),
      this.wonAssertion(assertionId),
      this.database.prepare(`
        insert into host_workspace_assignments (
          workspace_id, host_id, org_id, owner_user_id, owner_actor_id,
          second_device_open_at, assigned_at, updated_at, revision
        )
        select workspace_id, ?, org_id, ?, ?, null, ?, ?, host_assignment_revision
        from workspaces where workspace_id = ?
        on conflict (workspace_id) do update set
          host_id = excluded.host_id,
          owner_user_id = excluded.owner_user_id,
          owner_actor_id = excluded.owner_actor_id,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).bind(hostId, who.userId, who.actorId, now, now, workspaceId),
      this.deleteAssertion(assertionId),
    ], "Host assignment raced with a scope, assignment or workspace identity change")
    return { assigned: true as const, workspace_id: workspaceId, host_id: hostId }
  }

  async unassignWorkspaceHost(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireWorkspaceAccess(who, workspaceId, "admin")
    const now = this.now()
    const [result] = await this.database.batch([
      this.database.prepare(`
        delete from host_workspace_assignments where workspace_id = ?
      `).bind(workspaceId),
      this.database.prepare(`delete from host_assignment_readiness where workspace_id = ?`).bind(workspaceId),
      this.database.prepare(retireUserHostedWorkspaceSql("workspace_id = ?")).bind(now, now, workspaceId),
    ])
    return { unassigned: changes(result) > 0 }
  }

  /** Routable host: owner-assigned AND ready at the current revision and generation AND live lease. */
  async activeWorkspaceHost(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireWorkspaceAccess(who, workspaceId, "read")
    const row = await this.database.prepare(`
      select assignment.workspace_id, assignment.host_id, assignment.second_device_open_at,
        enrollment.display_name, enrollment.expires_at, enrollment.last_seen_at,
        enrollment.session_authority
      from host_workspace_assignments assignment
      inner join host_enrollments enrollment on enrollment.host_id = assignment.host_id
        and enrollment.owner_actor_id = assignment.owner_actor_id
      where assignment.workspace_id = ? and ${HOST_SERVING_WORKSPACE_SQL}
      limit 1
    `).bind(workspaceId, this.now()).first<{
      workspace_id: string
      host_id: string
      second_device_open_at: number | null
      display_name: string | null
      expires_at: number
      last_seen_at: number
      session_authority: string | null
    }>()
    if (!row) return { active: false as const }
    const sessionAuthority = hostSessionAuthority(row.session_authority)
    return {
      active: true as const,
      host_id: row.host_id,
      workspace_id: row.workspace_id,
      ...(row.display_name ? { display_name: row.display_name } : {}),
      ...(row.second_device_open_at ? { second_device_open_at: row.second_device_open_at } : {}),
      expires_at: row.expires_at,
      last_seen_at: row.last_seen_at,
      ...(sessionAuthority ? { session_authority: sessionAuthority } : {}),
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
        acked_workspace_ids: storedStringList(row.acked_workspace_ids),
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
      // A re-enrollment that presents a different key bumps `key_version`, so a
      // machine request verified against the old key writes nothing.
      this.database.prepare(`
        insert into host_enrollments (
          enrollment_id, owner_user_id, owner_actor_id, host_id, public_key_json,
          display_name, last_seen_at, expires_at, paused_at, revoked_at,
          last_signature_hash, created_at, updated_at, key_version, serving_generation, enrolled_via
        )
        select ?, request.owner_user_id, request.owner_actor_id, request.host_id,
          ?, ?, ?, ?, null, null, ?, ?, ?, 1, 0, 'account'
        from host_enrollment_requests request
        where request.request_id = ? and request.used_signature_hash = ?
        on conflict (owner_actor_id, host_id) do update set
          key_version = case when host_enrollments.public_key_json = excluded.public_key_json
            then host_enrollments.key_version else host_enrollments.key_version + 1 end,
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

  async heartbeatHostEnrollmentByMachine(
    machine: MachinePrincipal,
    args: HostMachineHeartbeatInput,
  ): Promise<HostMachineHeartbeatResult> {
    if (requireText(args.enrollmentId, "enrollmentId") !== machine.enrollmentId) {
      throw new D1HostAccessAuthorityError("invalid_input", "enrollmentId does not name the verified machine")
    }
    if (requireText(args.hostId, "hostId") !== machine.hostId) {
      throw new D1HostAccessAuthorityError("invalid_input", "hostId does not name the verified machine")
    }
    const generation = requireGeneration(args.generation)
    if (generation < machine.generation) throw supersededGeneration(machine.generation)
    if (generation > machine.generation) {
      throw new D1HostAccessAuthorityError("invalid_input", "generation was never issued to this enrollment")
    }
    const acks = requireAcks(args.acks)
    const sealingPublicKey = args.sealingPublicKey === undefined ? null : declaredSealingPublicKey(args.sealingPublicKey)
    const ackedRevision = args.providerConfigAckedRevision === undefined
      ? null
      : requireRevision(args.providerConfigAckedRevision, "providerConfigAckedRevision", 0)
    const now = this.now()
    const expiresAt = now + normalizedTtl(args.ttlMs)
    const assertionId = this.randomId("assert")
    const withdrawn = acks.map((ack) => ack.workspaceId)
    try {
      await this.database.batch([
        this.nonceSweep(now),
        this.database.prepare(`
          update host_enrollments set
            last_seen_at = ?, expires_at = ?, updated_at = ?,
            acked_workspace_ids = ?, acked_at = ?, session_authority = ?,
            sealing_public_key_json = coalesce(?, sealing_public_key_json),
            -- Stored as declared, never clamped to this row's revision: a
            -- machine may hold more than the row records after a restore from
            -- backup, and that is the number the next mint must outrun.
            provider_config_acked_revision = coalesce(?, provider_config_acked_revision)
          where ${MACHINE_ELIGIBLE_SQL} and serving_generation = ?
        `).bind(
          now,
          expiresAt,
          now,
          JSON.stringify(withdrawn.slice().sort()),
          now,
          hostSessionAuthority(args.sessionAuthority) ?? null,
          sealingPublicKey,
          ackedRevision,
          machine.enrollmentId,
          machine.keyVersion,
          generation,
        ),
        this.readinessWithdrawal(machine.enrollmentId, withdrawn),
        // Only an ack of the CURRENT revision makes a workspace ready: a host
        // still serving a re-pointed directory keeps saying so with the old
        // revision and stays unroutable until it re-acks.
        this.readinessUpsert(machine.enrollmentId, acks, now),
        this.database.prepare(`
          insert into authority_batch_assertions (assertion_id, passed)
          values (?, case when exists (
            select 1 from host_enrollments
            where ${MACHINE_ELIGIBLE_SQL} and serving_generation = ? and expires_at = ?
          ) then 1 else 0 end)
        `).bind(assertionId, machine.enrollmentId, machine.keyVersion, generation, expiresAt),
        this.deleteAssertion(assertionId),
      ])
    } catch (error) {
      if (!batchAssertionFailed(error)) throw error
      throw await this.machineMutationRefusal(machine, generation, "Host heartbeat raced with an enrollment change")
    }
    const row = await this.enrollmentById(machine.enrollmentId)
    if (!row) throw new D1HostAccessAuthorityError("host_attestation_denied", "Host enrollment is unavailable")
    const assigned = await this.assignmentDescriptions(row.owner_actor_id, row.host_id)
    const providerConfigPending = pendingHostProviderConfig(row)
    return {
      expires_at: expiresAt,
      last_seen_at: now,
      assignments: assigned.flatMap((entry) => entry.description ? [entry.description] : []),
      scope: hostEnrollmentScope(row.scope_json, row.scope_revision),
      assigned_workspace_ids: assigned.map((entry) => entry.workspace_id),
      ...(providerConfigPending ? { provider_config: providerConfigPending } : {}),
    }
  }

  async acquireHostServingGeneration(machine: MachinePrincipal) {
    const now = this.now()
    const generation = machine.generation + 1
    const assertionId = this.randomId("assert")
    try {
      await this.database.batch([
        this.database.prepare(`
          update host_enrollments set
            serving_generation = serving_generation + 1, generation_acquired_at = ?, updated_at = ?
          where ${MACHINE_ELIGIBLE_SQL} and serving_generation = ?
        `).bind(now, now, machine.enrollmentId, machine.keyVersion, machine.generation),
        this.wonAssertion(assertionId),
        this.database.prepare(`
          delete from host_assignment_readiness where enrollment_id = ? and generation < ?
        `).bind(machine.enrollmentId, generation),
        this.auditRow({
          enrollmentId: machine.enrollmentId,
          action: "host_enrollment.generation_acquired",
          metadata: { enrollmentId: machine.enrollmentId, hostId: machine.hostId, generation },
          now,
        }),
        this.deleteAssertion(assertionId),
      ])
    } catch (error) {
      if (!batchAssertionFailed(error)) throw error
      throw await this.machineMutationRefusal(machine, machine.generation, "Serving generation raced with another instance")
    }
    return { generation, generation_acquired_at: now }
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

  async listHostEnrollments(auth: SignedControlPlaneAuth): Promise<HostEnrollmentListRow[]> {
    const who = await this.requirePrincipal(auth)
    const rows = await this.database.prepare(`
      select * from host_enrollments where owner_actor_id = ? and revoked_at is null
      order by last_seen_at desc, enrollment_id
    `).bind(who.actorId).all<EnrollmentRow>()
    const ready = await this.database.prepare(`
      select readiness.enrollment_id, readiness.workspace_id, readiness.revision
      from host_assignment_readiness readiness
      join host_enrollments enrollment on enrollment.enrollment_id = readiness.enrollment_id
        and enrollment.serving_generation = readiness.generation
      where enrollment.owner_actor_id = ? and enrollment.revoked_at is null
      order by readiness.workspace_id
    `).bind(who.actorId).all<{ enrollment_id: string; workspace_id: string; revision: number }>()
    const acked = new Map<string, HostAssignmentAck[]>()
    for (const row of ready.results ?? []) {
      const list = acked.get(row.enrollment_id) ?? []
      list.push({ workspaceId: row.workspace_id, revision: row.revision })
      acked.set(row.enrollment_id, list)
    }
    const descriptions = new Map<string, HostAssignmentDescription[]>()
    for (const entry of await this.assignmentDescriptions(who.actorId)) {
      if (!entry.description) continue
      const list = descriptions.get(entry.host_id) ?? []
      list.push(entry.description)
      descriptions.set(entry.host_id, list)
    }
    return await Promise.all((rows.results ?? []).map(async (row) => ({
      enrollment_id: row.enrollment_id,
      ...(row.display_name ? { display_name: row.display_name } : {}),
      host_id: row.host_id,
      public_key_fingerprint: await storedKeyFingerprint(row.public_key_json),
      key_version: row.key_version,
      enrolled_via: row.enrolled_via,
      last_seen_at: row.last_seen_at,
      expires_at: row.expires_at,
      serving_generation: row.serving_generation,
      ...(row.generation_acquired_at !== null ? { generation_acquired_at: row.generation_acquired_at } : {}),
      ...(row.paused_at !== null ? { paused_at: row.paused_at } : {}),
      assignments: descriptions.get(row.host_id) ?? [],
      acked: acked.get(row.enrollment_id) ?? [],
      scope: hostEnrollmentScope(row.scope_json, row.scope_revision),
      provider_config_revision: row.provider_config_revision,
      provider_config_acked_revision: row.provider_config_acked_revision,
      sealing_key_declared: row.sealing_public_key_json !== null,
      provider_config_providers: storedHostProviderIds(row.provider_config_provider_ids),
      provider_config_rekeyed: hostProviderConfigRekeyed(row),
    })))
  }

  async hostEnrollmentByHost(auth: SignedControlPlaneAuth, args: { hostId: string }) {
    const who = await this.requirePrincipal(auth)
    const row = await this.database.prepare(`
      select enrollment_id, host_id, enrolled_via from host_enrollments
      where owner_actor_id = ? and host_id = ? and revoked_at is null
    `).bind(who.actorId, requireText(args.hostId, "hostId")).first<Pick<EnrollmentRow, "enrollment_id" | "host_id" | "enrolled_via">>()
    return row ?? undefined
  }

  async updateHostEnrollmentScope(
    auth: SignedControlPlaneAuth,
    args: { enrollmentId: string; scope: HostScopeDefinition },
  ): Promise<HostScopeUpdateResult> {
    const who = await this.requirePrincipal(auth)
    const enrollmentId = requireText(args.enrollmentId, "enrollmentId")
    const scope = requireScope(args.scope)
    const row = await this.enrollmentById(enrollmentId)
    if (!row || row.owner_actor_id !== who.actorId || row.revoked_at !== null) {
      throw new D1HostAccessAuthorityError("host_enrollment_not_found", "Host enrollment not found")
    }
    const revision = row.scope_revision + 1
    const rootsJson = JSON.stringify(scope.allowed_roots)
    const now = this.now()
    const auditId = this.randomId("audit")
    const assertionId = this.randomId("assert")
    // The assignments of this host whose directory is neither one of the new
    // roots nor under one, read inside the batch against the rows it deletes;
    // binds host_id, owner_actor_id and the roots JSON, in that order. A row
    // with no directory is outside every root, as in `directoryWithinRoots`.
    // The prefix clause also admits a row left with a trailing separator
    // (`/srv/app/` under `/srv/app`); `.` and `..` segments it cannot see are
    // what every writer normalizes away and migration 0029 removed.
    const outsideRootsSql = `
      select assignment.workspace_id from host_workspace_assignments assignment
      left join workspaces workspace on workspace.workspace_id = assignment.workspace_id
      where assignment.host_id = ? and assignment.owner_actor_id = ?
        and not exists (
          select 1 from json_each(?) root
          where workspace.remote_directory = root.value
            or (root.value = '/' and substr(workspace.remote_directory, 1, 1) = '/')
            or substr(workspace.remote_directory, 1, length(root.value) + 1) = root.value || '/'
        )`
    const outsideRoots = () => [row.host_id, row.owner_actor_id, rootsJson]
    await this.guardedBatch([
      this.database.prepare(`
        update host_enrollments set scope_json = ?, scope_revision = ?, updated_at = ?
        where enrollment_id = ? and owner_actor_id = ? and scope_revision = ? and revoked_at is null
      `).bind(JSON.stringify(scope), revision, now, enrollmentId, who.actorId, row.scope_revision),
      this.wonAssertion(assertionId),
      this.database.prepare(retireUserHostedWorkspaceSql(`workspace_id in (${outsideRootsSql})`))
        .bind(now, now, ...outsideRoots()),
      this.database.prepare(`
        delete from host_assignment_readiness where workspace_id in (${outsideRootsSql})
      `).bind(...outsideRoots()),
      this.auditRow({
        eventId: auditId,
        enrollmentId,
        action: "host_enrollment.scope_updated",
        metadata: new SqlJson(
          `json_object('enrollmentId', ?, 'hostId', ?, 'scopeRevision', ?, 'retiredWorkspaceIds',
            json((select json_group_array(workspace_id) from (${outsideRootsSql} order by assignment.workspace_id))))`,
          [enrollmentId, row.host_id, revision, ...outsideRoots()],
        ),
        now,
      }),
      this.database.prepare(`
        delete from host_workspace_assignments where workspace_id in (${outsideRootsSql})
      `).bind(...outsideRoots()),
      this.database.prepare(`
        update workspaces set org_member_visible = ?, updated_at = ?
        where workspace_id in (
          select workspace_id from host_workspace_assignments where host_id = ? and owner_actor_id = ?
        )
      `).bind(scope.visibility === "owner" ? 0 : 1, now, row.host_id, row.owner_actor_id),
      this.deleteAssertion(assertionId),
    ], "Host enrollment scope changed concurrently")
    const audit = await this.database.prepare(`select metadata_json from authority_audit_events where event_id = ?`)
      .bind(auditId).first<{ metadata_json: string }>()
    const retired = stringList(asRecord(parseJson(audit?.metadata_json ?? "{}"))?.retiredWorkspaceIds)
    return { scope: { ...scope, revision }, retired_workspace_ids: retired }
  }

  async renameHostEnrollment(
    auth: SignedControlPlaneAuth,
    args: { enrollmentId: string; displayName: string },
  ): Promise<{ enrollment_id: string; display_name: string }> {
    const who = await this.requirePrincipal(auth)
    const enrollmentId = requireText(args.enrollmentId, "enrollmentId")
    const displayName = requireText(args.displayName, "displayName", 200)
    const now = this.now()
    const updated = await this.database.prepare(`
      update host_enrollments set display_name = ?, updated_at = ?
      where enrollment_id = ? and owner_actor_id = ? and revoked_at is null
      returning enrollment_id
    `).bind(displayName, now, enrollmentId, who.actorId).first<{ enrollment_id: string }>()
    if (!updated) {
      throw new D1HostAccessAuthorityError("host_enrollment_not_found", "Host enrollment not found")
    }
    await this.auditRow({
      enrollmentId,
      action: "host_enrollment.renamed",
      metadata: { enrollmentId, displayName },
      now,
    }).run()
    return { enrollment_id: enrollmentId, display_name: displayName }
  }

  /**
   * Scoped to the owner in the query itself: a row the caller does not own
   * reads as absent, so a foreign account learns neither that the machine
   * exists nor which key it declared.
   */
  async hostProviderConfigTarget(
    auth: SignedControlPlaneAuth,
    args: { enrollmentId: string },
  ): Promise<HostProviderConfigTarget> {
    const who = await this.requirePrincipal(auth)
    const enrollmentId = requireText(args.enrollmentId, "enrollmentId")
    const row = await this.database.prepare(`
      select enrollment_id, host_id, display_name, sealing_public_key_json,
        provider_config_revision, provider_config_acked_revision
      from host_enrollments
      where enrollment_id = ? and owner_actor_id = ? and revoked_at is null
    `).bind(enrollmentId, who.actorId).first<
      Pick<
        EnrollmentRow,
        | "enrollment_id" | "host_id" | "display_name" | "sealing_public_key_json"
        | "provider_config_revision" | "provider_config_acked_revision"
      >
    >()
    if (!row) throw new D1HostAccessAuthorityError("host_enrollment_not_found", "Host enrollment not found")
    return {
      enrollment_id: row.enrollment_id,
      host_id: row.host_id,
      ...(row.display_name ? { display_name: row.display_name } : {}),
      sealing_public_key: row.sealing_public_key_json,
      next_revision: nextHostProviderConfigRevision(row),
    }
  }

  /**
   * The write re-asserts what the caller sealed against — the revision it
   * read and the key it sealed to — so a concurrent push or a re-key between
   * the target read and this write refuses rather than storing a blob nobody
   * can open. The audit row is the route's: only it knows which providers the
   * ciphertext names.
   */
  async pushHostProviderConfig(
    auth: SignedControlPlaneAuth,
    args: HostProviderConfigPushInput,
  ): Promise<{ enrollment_id: string; revision: number; sealed: boolean }> {
    const who = await this.requirePrincipal(auth)
    const enrollmentId = requireText(args.enrollmentId, "enrollmentId")
    const revision = requireRevision(args.revision, "revision", 1)
    const sealed = args.sealed === null ? null : requireSealed(args.sealed)
    if (args.sealingPublicKey === null) throw sealingKeyUndeclared()
    const sealingPublicKey = requireText(args.sealingPublicKey, "sealingPublicKey", MAX_SEALING_PUBLIC_KEY_LENGTH)
    const providerIds = requireProviderIds(args.providerIds)
    const now = this.now()
    const assertionId = this.randomId("assert")
    try {
      await this.database.batch([
        this.database.prepare(`
          update host_enrollments set
            provider_config_sealed = ?, provider_config_revision = ?, provider_config_acked_revision = 0,
            provider_config_sealed_key_json = ?, provider_config_provider_ids = ?,
            provider_config_updated_at = ?, updated_at = ?
          where enrollment_id = ? and owner_actor_id = ? and revoked_at is null
            and max(provider_config_revision, provider_config_acked_revision) = ?
            and sealing_public_key_json = ?
        `).bind(
          sealed,
          revision,
          sealed === null ? null : sealingPublicKey,
          providerIds.length === 0 ? null : JSON.stringify(providerIds),
          now,
          now,
          enrollmentId,
          who.actorId,
          revision - 1,
          sealingPublicKey,
        ),
        this.wonAssertion(assertionId),
        this.deleteAssertion(assertionId),
      ])
    } catch (error) {
      if (!batchAssertionFailed(error)) throw error
      const row = await this.database.prepare(`
        select sealing_public_key_json, provider_config_revision, provider_config_acked_revision
        from host_enrollments where enrollment_id = ? and owner_actor_id = ? and revoked_at is null
      `).bind(enrollmentId, who.actorId).first<
        Pick<EnrollmentRow, "sealing_public_key_json" | "provider_config_revision" | "provider_config_acked_revision">
      >()
      if (!row) throw new D1HostAccessAuthorityError("host_enrollment_not_found", "Host enrollment not found")
      if (row.sealing_public_key_json !== sealingPublicKey) throw sealingKeyUndeclared()
      throw new D1HostAccessAuthorityError(
        "host_provider_config_revision_stale",
        "Provider configuration was pushed concurrently",
        { provider_config_revision: row.provider_config_revision },
      )
    }
    return { enrollment_id: enrollmentId, revision, sealed: sealed !== null }
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
    await this.database.prepare(`
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
    ).run()
    return { invitationId, token: invitationToken({ invitationId, secret }), expiresAt }
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
    const result = await this.database.prepare(`
      update host_invitations set revoked_at = ?
      where invitation_id = ? and owner_actor_id = ? and revoked_at is null and redeemed_at is null
    `).bind(now, invitationId, who.actorId).run()
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
    if (await this.enrollment(invitation.owner_actor_id, hostId)) {
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
        this.deleteAssertion(assertionId),
      ])
    } catch (error) {
      if (isUniqueFailure(error) && String(error).includes("host_enrollments")) {
        throw new D1HostAccessAuthorityError(
          "invitation_host_conflict",
          "This owner already has an enrollment for the host id; enroll with a fresh host id",
        )
      }
      if (!batchAssertionFailed(error)) throw error
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
      this.database.prepare(retireUserHostedWorkspaceSql(`workspace_id in (
        select workspace_id from host_workspace_assignments
        where owner_actor_id = ? and (? is null or host_id = ?)
      )`)).bind(now, now, who.actorId, hostId ?? null, hostId ?? null),
      this.database.prepare(`
        delete from host_assignment_readiness where workspace_id in (
          select workspace_id from host_workspace_assignments
          where owner_actor_id = ? and (? is null or host_id = ?)
        )
      `).bind(who.actorId, hostId ?? null, hostId ?? null),
      this.database.prepare(`
        delete from host_workspace_assignments
        where owner_actor_id = ? and (? is null or host_id = ?)
      `).bind(who.actorId, hostId ?? null, hostId ?? null),
      this.database.prepare(`
        update runtime_access_tokens set revoked_at = ?
        where deployment_id = ? and actor_id = ? and (? is null or host_id = ?) and revoked_at is null
          and exists (
            select 1 from host_enrollments enrollment
            where enrollment.owner_actor_id = ? and (? is null or enrollment.host_id = ?)
              and enrollment.revoked_at = ?
          )
      `).bind(
        now,
        this.options.deploymentId,
        who.actorId,
        hostId ?? null,
        hostId ?? null,
        who.actorId,
        hostId ?? null,
        hostId ?? null,
        now,
      ),
    ])
    return { revoked: changes(results[0]), runtime_tokens_revoked: changes(results[4]) }
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

  private async requireWorkspaceAccess(
    actor: Principal,
    workspaceId: string,
    action: "read" | "admin",
    revivable = false,
  ) {
    const row = await this.database.prepare(`
      ${workspaceAccessCte(action === "read" ? 1 : 3, revivable)}
      select * from authorized_workspace
    `).bind(actor.actorId, workspaceId).first<WorkspaceRow>()
    if (!row) throw denied()
    return row
  }

  /** Whether an assignment would write to an existing record: a live row, or a retired machine-placed one it revives. */
  private async assignableWorkspaceExists(workspaceId: string) {
    return !!await this.database.prepare(`
      select 1 from workspaces where workspace_id = ? and (deleted_at is null or backing = 'local-worktree')
    `).bind(workspaceId).first()
  }

  private async enrollmentRequest(requestId: string) {
    return await this.database.prepare(`select * from host_enrollment_requests where request_id = ?`)
      .bind(requestId).first<EnrollmentRequestRow>()
  }

  private async enrollment(actorId: string, hostId: string) {
    return await this.database.prepare(`select * from host_enrollments where owner_actor_id = ? and host_id = ?`)
      .bind(actorId, hostId).first<EnrollmentRow>()
  }

  private async enrollmentById(enrollmentId: string) {
    return await this.database.prepare(`select * from host_enrollments where enrollment_id = ?`)
      .bind(enrollmentId).first<EnrollmentRow>()
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
  private async currentOrgId(who: Principal, auth: SignedControlPlaneAuth) {
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

  /** The organization an invitation-enrolled machine is confined to. */
  private async invitationOrgId(enrollmentId: string) {
    const row = await this.database.prepare(`
      select org_id from host_invitations where redeemed_enrollment_id = ? limit 1
    `).bind(enrollmentId).first<{ org_id: string }>()
    return row?.org_id
  }

  /**
   * The assignments of an owner's hosts — one host, or every host when no
   * id is given — with the description each carries. An assignment whose
   * workspace has no directory yields no description: a machine caller can
   * only serve a path, so `assignments` omits it while
   * `assigned_workspace_ids` still lists it for the desktop's reconciliation.
   */
  private async assignmentDescriptions(ownerActorId: string, hostId?: string) {
    const rows = await this.database.prepare(`
      select assignment.workspace_id, assignment.host_id, assignment.revision,
        workspace.remote_directory, workspace.display_name
      from host_workspace_assignments assignment
      join workspaces workspace on workspace.workspace_id = assignment.workspace_id and workspace.deleted_at is null
      where assignment.owner_actor_id = ? and (? is null or assignment.host_id = ?)
      order by assignment.host_id, assignment.workspace_id
    `).bind(ownerActorId, hostId ?? null, hostId ?? null).all<{
      workspace_id: string
      host_id: string
      revision: number
      remote_directory: string | null
      display_name: string | null
    }>()
    return (rows.results ?? []).map((row) => ({
      workspace_id: row.workspace_id,
      host_id: row.host_id,
      remote_directory: row.remote_directory,
      description: row.remote_directory === null
        ? undefined
        : {
          workspace_id: row.workspace_id,
          remote_directory: row.remote_directory,
          ...(row.display_name ? { display_name: row.display_name } : {}),
          revision: row.revision,
        } satisfies HostAssignmentDescription,
    }))
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
    const row = await this.enrollmentById(enrollmentId)
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

  /**
   * Why a machine mutation's batch wrote nothing, read fresh after the
   * failure and named with the verifier's own codes, so the host sees the
   * same decision whether the change landed before or after verification.
   */
  private async machineMutationRefusal(machine: MachinePrincipal, generation: number, raced: string) {
    const row = await this.machineAuth.lookupEnrollment(machine.enrollmentId)
    if (!row) return new D1HostAccessAuthorityError("host_attestation_denied", "Host enrollment is unavailable")
    if (row.revoked_at !== null) return new D1HostAccessAuthorityError("enrollment_revoked", "Host enrollment is revoked")
    if (row.paused_at !== null) return new D1HostAccessAuthorityError("enrollment_paused", "Host enrollment is paused")
    if (!row.ownerEligible) {
      return new D1HostAccessAuthorityError("enrollment_owner_ineligible", "Host enrollment owner is not active")
    }
    if (row.key_version !== machine.keyVersion) {
      return new D1HostAccessAuthorityError("enrollment_key_version_mismatch", "Host key was replaced")
    }
    if (row.serving_generation !== generation) return supersededGeneration(row.serving_generation)
    return new D1HostAccessAuthorityError("resource_conflict", raced)
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

  /** Readiness rows of this enrollment for every workspace the beat did not ack. */
  private readinessWithdrawal(enrollmentId: string, ackedWorkspaceIds: readonly string[]) {
    return this.database.prepare(`
      delete from host_assignment_readiness
      where enrollment_id = ? and workspace_id not in (select value from json_each(?))
    `).bind(enrollmentId, JSON.stringify(ackedWorkspaceIds))
  }

  /**
   * Readiness for each ack whose workspace is assigned to this enrollment's
   * host at exactly the revision the ack names, recorded at the enrollment's
   * current generation.
   */
  private readinessUpsert(
    enrollmentId: string,
    acks: ReadonlyArray<{ workspaceId: string; revision: number }>,
    now: number,
  ) {
    return this.database.prepare(`
      insert into host_assignment_readiness (workspace_id, enrollment_id, generation, revision, ready_at)
      select assignment.workspace_id, enrollment.enrollment_id, enrollment.serving_generation, assignment.revision, ?
      from json_each(?) ack
      join host_workspace_assignments assignment
        on assignment.workspace_id = json_extract(ack.value, '$.workspaceId')
        and assignment.revision = json_extract(ack.value, '$.revision')
      join host_enrollments enrollment on enrollment.enrollment_id = ?
        and enrollment.host_id = assignment.host_id and enrollment.owner_actor_id = assignment.owner_actor_id
      where true
      on conflict (workspace_id) do update set
        enrollment_id = excluded.enrollment_id,
        generation = excluded.generation,
        revision = excluded.revision,
        ready_at = excluded.ready_at
    `).bind(now, JSON.stringify(acks), enrollmentId)
  }

  /**
   * An audit row attributed to the enrollment's owner, written inside the
   * caller's batch. Metadata given as `SqlJson` is computed by the batch
   * itself, which is how a batch records the rows it deleted.
   */
  private auditRow(input: {
    eventId?: string
    enrollmentId: string
    action: string
    metadata: Record<string, unknown> | SqlJson
    now: number
  }) {
    const metadata = input.metadata instanceof SqlJson
      ? input.metadata
      : new SqlJson("?", [JSON.stringify(input.metadata)])
    return this.database.prepare(`
      insert into authority_audit_events (
        event_id, deployment_id, user_id, actor_id, org_id, project_id, workspace_id,
        unverified_attempted_workspace_id, action, result, reason, metadata_json, created_at
      )
      select ?, ?, owner_user_id, owner_actor_id, null, null, null, null, ?, 'allow', null, ${metadata.sql}, ?
      from host_enrollments where enrollment_id = ?
    `).bind(
      input.eventId ?? this.randomId("audit"),
      this.options.deploymentId,
      input.action,
      ...metadata.bind,
      input.now,
      input.enrollmentId,
    )
  }

  /**
   * Passes only when the statement immediately before it in the batch
   * changed a row: SQLite's `changes()` is per connection and a D1 batch runs
   * its statements in order on one, so this is the batch's own write being
   * counted, not a state another caller could have produced.
   */
  private wonAssertion(assertionId: string) {
    return this.database.prepare(`
      insert into authority_batch_assertions (assertion_id, passed) values (?, changes())
    `).bind(assertionId)
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

  /** Exact rows by expiry: the nonce table's key is the pair, never the enrollment alone. */
  private nonceSweep(now: number) {
    return this.database.prepare(`
      delete from host_request_nonces where (enrollment_id, nonce) in (
        select enrollment_id, nonce from host_request_nonces where expires_at <= ? order by expires_at limit ?
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
      if (batchAssertionFailed(error)) {
        throw new D1HostAccessAuthorityError("resource_conflict", message)
      }
      throw error
    }
  }
}

/** A JSON value expressed in SQL, with the bindings its placeholders take in order. */
class SqlJson {
  constructor(readonly sql: string, readonly bind: unknown[]) {}
}


/**
 * `revivable` admits a retired machine-placed row: its assignment is what
 * revives it, so the owner's rank is decided against the record as it is
 * before anything is written. Every other reader sees live rows only.
 */
function workspaceAccessCte(rank: 1 | 3, revivable = false) {
  return `with current_actor as (
    select actor.actor_id, actor.user_id
    from actors actor join users user on user.user_id = actor.user_id and user.state = 'active'
    where actor.actor_id = ? and actor.state = 'active'
  ), authorized_workspace as (
    select workspace.workspace_id, workspace.org_id, workspace.project_id,
      workspace.backing, workspace.home_region, workspace.remote_directory,
      workspace.host_assignment_revision,
      max(
        case when workspace.owner_user_id = current_actor.user_id then 4 else 0 end,
        coalesce(case project_member.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
        ${organizationRoleRankSql({
          orgOwnerUserId: "organization.owner_user_id",
          userId: "current_actor.user_id",
          orgMemberRole: "org_member.role",
          workspaceAlias: "workspace",
        })}
      ) as role_rank
    from current_actor
    join workspaces workspace on workspace.workspace_id = ?
      and ${revivable ? "(workspace.deleted_at is null or workspace.backing = 'local-worktree')" : "workspace.deleted_at is null"}
    join projects project
      on project.project_id = workspace.project_id and project.org_id = workspace.org_id and project.deleted_at is null
    join orgs organization on organization.org_id = workspace.org_id and organization.deleted_at is null
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

function requireScope(input: HostScopeDefinition): HostScopeDefinition {
  if (!input || typeof input !== "object" || !Array.isArray(input.allowed_roots)) {
    throw new D1HostAccessAuthorityError("invalid_input", "scope.allowed_roots must be a list of absolute paths")
  }
  if (input.allowed_roots.length > MAX_SCOPE_ROOTS) {
    throw new D1HostAccessAuthorityError("invalid_input", `scope.allowed_roots may name at most ${MAX_SCOPE_ROOTS} roots`)
  }
  const roots = input.allowed_roots.map((root) => {
    const normalized = normalizePosixDirectory(requireText(root, "scope.allowed_roots", MAX_SCOPE_ROOT_LENGTH))
    if (!normalized) throw new D1HostAccessAuthorityError("invalid_input", "scope.allowed_roots must be absolute paths")
    return normalized
  })
  if (input.visibility !== "owner" && input.visibility !== "org") {
    throw new D1HostAccessAuthorityError("invalid_input", "scope.visibility must be 'owner' or 'org'")
  }
  return { allowed_roots: [...new Set(roots)], visibility: input.visibility }
}

function storedScope(json: string): HostScopeDefinition {
  const scope = hostEnrollmentScope(json, 0)
  if (!scope) throw new D1HostAccessAuthorityError("resource_conflict", "Stored invitation scope is malformed")
  return { allowed_roots: scope.allowed_roots, visibility: scope.visibility }
}

function supersededGeneration(servingGeneration: number) {
  return new D1HostAccessAuthorityError(
    "enrollment_generation_superseded",
    "A newer instance of this enrollment has acquired the serving generation",
    { serving_generation: servingGeneration },
  )
}

function requireGeneration(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new D1HostAccessAuthorityError("invalid_input", "generation must be a non-negative integer")
  }
  return value
}

function requireRevision(value: number, name: string, minimum: 0 | 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new D1HostAccessAuthorityError("invalid_input", `${name} must be an integer of at least ${minimum}`)
  }
  return value
}

/**
 * Stored as the four members `machineSealingPublicKey` keeps, so one key
 * always serializes to one text and the push's key assertion is a string
 * comparison. A key the sealer could not use is refused at the beat, where
 * the machine can fix it, rather than at the owner's push.
 */
function declaredSealingPublicKey(input: string) {
  const text = requireText(input, "sealingPublicKey", MAX_SEALING_PUBLIC_KEY_LENGTH)
  try {
    return JSON.stringify(machineSealingPublicKey(text))
  } catch {
    throw new D1HostAccessAuthorityError("invalid_input", "sealingPublicKey must be an ECDH P-256 public JWK")
  }
}

function requireSealed(input: string) {
  const sealed = requireText(input, "sealed", MAX_SEALED_LENGTH)
  if (!sealed.startsWith(`${MACHINE_SEAL_VERSION}.`)) {
    throw new D1HostAccessAuthorityError("invalid_input", `sealed must be a ${MACHINE_SEAL_VERSION} blob`)
  }
  return sealed
}

function requireProviderIds(input: string[]): string[] {
  if (!Array.isArray(input) || input.some((id) => typeof id !== "string" || !id || id.length > 200)) {
    throw new D1HostAccessAuthorityError("invalid_input", "providerIds must be a list of provider ids")
  }
  if (input.length > MAX_PROVIDER_IDS) {
    throw new D1HostAccessAuthorityError("invalid_input", `providerIds must name at most ${MAX_PROVIDER_IDS} providers`)
  }
  return [...input].sort()
}

function sealingKeyUndeclared() {
  return new D1HostAccessAuthorityError(
    "host_sealing_key_undeclared",
    "The machine has declared no sealing key, or replaced it since the configuration was sealed",
  )
}

function requireAcks(input: HostAssignmentAck[]): HostAssignmentAck[] {
  if (!Array.isArray(input)) throw new D1HostAccessAuthorityError("invalid_input", "acks must be a list")
  if (input.length > MAX_ACKED_WORKSPACES) {
    throw new D1HostAccessAuthorityError("invalid_input", "acks exceeds the served-set cap")
  }
  const seen = new Set<string>()
  return input.map((ack) => {
    const workspaceId = requireText(ack?.workspaceId, "acks.workspaceId", 200)
    if (!Number.isSafeInteger(ack.revision) || ack.revision < 1) {
      throw new D1HostAccessAuthorityError("invalid_input", "acks.revision must be a positive integer")
    }
    if (seen.has(workspaceId)) throw new D1HostAccessAuthorityError("invalid_input", "acks names a workspace twice")
    seen.add(workspaceId)
    return { workspaceId, revision: ack.revision }
  })
}

function invitationTtl(input: number | undefined) {
  if (input === undefined) return INVITATION_DEFAULT_TTL_MS
  if (!Number.isFinite(input)) throw new D1HostAccessAuthorityError("invalid_input", "expiresInMs must be finite")
  return Math.max(INVITATION_MIN_TTL_MS, Math.min(input, INVITATION_MAX_TTL_MS))
}

async function storedKeyFingerprint(publicKeyJson: string) {
  const jwk = storedJsonWebKey(publicKeyJson)
  if (!jwk) throw new D1HostAccessAuthorityError("resource_conflict", "Stored host public key is malformed")
  return await publicKeyFingerprint(jwk)
}

async function verifiedPublicKey(input: string) {
  const value = requireText(input, "publicKey", 8_000)
  const jwk = storedJsonWebKey(value)
  if (!jwk) throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host public key")
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || jwk.d) {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Host public key must be a public P-256 JWK")
  }
  const normalized = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  try {
    await crypto.subtle.importKey("jwk", normalized, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  } catch {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host public key")
  }
  // Stored as exactly these four members so the same key always serializes
  // to the same text, which is what the re-enroll upsert compares.
  return JSON.stringify(normalized)
}

async function verifyHostSignature(input: { publicKey: string; payload: string; signature: string }) {
  const jwk = storedJsonWebKey(input.publicKey)
  if (!jwk) throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid stored host public key")
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

/**
 * A machine-placed workspace exists in the inventory exactly as long as a
 * machine is assigned to serve it: unsharing it or revoking its machine retires
 * the row, and sharing it again revives the same record. Cloud rows are never
 * touched here — their lifetime is the sandbox's.
 */
export function retireUserHostedWorkspaceSql(where: string) {
  return `
    update workspaces set deleted_at = ?, updated_at = ?
    where backing = 'local-worktree' and deleted_at is null and ${where}
  `
}

function requireLocalWorkspace(workspace: WorkspaceRow) {
  if (workspace.backing !== "local-worktree") {
    throw new D1HostAccessAuthorityError(
      "resource_conflict",
      "A host assignment names a directory, so its workspace must be a local worktree",
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


function normalizedTtl(input: number | undefined) {
  if (input === undefined) return DEFAULT_TTL_MS
  if (!Number.isFinite(input)) throw new D1HostAccessAuthorityError("invalid_input", "ttlMs must be finite")
  return Math.max(5_000, Math.min(input, MAX_TTL_MS))
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
  // A fresh copy rather than a view: `crypto.subtle.digest` takes a BufferSource,
  // and slicing the underlying buffer through `as ArrayBuffer` also asserted away
  // the SharedArrayBuffer case the DOM type admits.
  const result = await crypto.subtle.digest("SHA-256", Uint8Array.from(value))
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


function isUniqueFailure(error: unknown) {
  const text = String(error)
  return text.includes("UNIQUE constraint failed") || text.includes("constraint failed") && text.includes("unique")
}

/** A stored JSON array of ids; a column that is not one contributes no ids. */
function storedStringList(raw: string): string[] {
  try {
    return stringList(parseJson(raw))
  } catch {
    return []
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** A stored JWK, read as the record it is; the caller checks the key material itself. */
function storedJsonWebKey(raw: string): JsonWebKey | undefined {
  try {
    return asRecord(parseJson(raw))
  } catch {
    return undefined
  }
}
