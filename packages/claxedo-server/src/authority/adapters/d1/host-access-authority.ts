import { enrollmentPayload } from "@claxedo/account-contract/machine"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { hostEnrollmentScope, hostProviderConfigRekeyed, hostSessionAuthority, pendingHostProviderConfig, storedHostProviderIds } from "@claxedo/server-core/platform/auth/host-connect-contract"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { HostAssignmentAck, HostAssignmentDescription, HostEnrollment, HostEnrollmentListRow, HostEnrollmentState, HostMachineHeartbeatInput, HostMachineHeartbeatResult, HostScopeDefinition, HostScopeUpdateResult, MachineAuthAdapter, MachinePrincipal } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { normalizeStoredDirectory } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { hostPathWithinRoots } from "@claxedo/account-contract/host-path"
import { assignmentsOutsideRootsSql, requireScope } from "./host-scope-rules"
import { asRecord, parseJson } from "@claxedo/server-core/platform/json/index"
import { listHostDevices, stringList } from "./host-devices"
import type { D1WorkspaceAuthority } from "./workspace-authority"
import {
  activeGuard, batchUnder, deleteAssertion, mayGuard, maySql, wonAssertion, type WorkspaceAction,
} from "./authorization"
import { d1BatchAssertionFailed, d1UniqueFailureOn } from "../../../platform/db/d1-constraint"
import { requireHuman } from "./access-context"
import { D1HostAccessAuthorityError } from "./host-access-errors"
import { randomBase64Url, storedKeyFingerprint, verifiedPublicKey, verifyHostSignature } from "./host-attestation-codec"
import {
  DEFAULT_TTL_MS,
  MACHINE_ELIGIBLE_SQL,
  denied,
  enrollmentById,
  enrollmentJson,
  enrollmentOf,
  invitationOrgOf,
  optionalText,
  requireRevision,
  requireText,
  type EnrollmentRow,
} from "./host-enrollment-records"
import { declaredSealingPublicKey } from "./host-provider-config-authority"
import { d1MachineAuth } from "./host-machine-auth"

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
  "authorizeWorkspaceHostAssignment",
  "assignWorkspaceHost",
  "unassignWorkspaceHost",
  "activeWorkspaceHost",
  "listHostDevices",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1HostAccessAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_HOST_ACCESS_AUTHORITY_METHODS)[number]> & {
  machineAuth: MachineAuthAdapter
}

export type D1HostAccessAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: (prefix: "request" | "enrollment" | "grant" | "assert" | "audit") => string
  randomNonce?: () => string
  /** The statements that cold-register a machine-placed workspace, run inside the assignment's own batch. */
  localWorkspaceRegistration?: D1WorkspaceAuthority["localWorkspaceRegistration"]
  /**
   * Whether this caller may file the workspace a cold share would create.
   * Cold registration IS `localWorkspaceRegistration`, so it takes that
   * registration's own admission rather than a second rule written here.
   */
  authorizeLocalWorkspaceRegistration?: D1WorkspaceAuthority["authorizeLocalWorkspaceRegistration"]
}

type Principal = { userId: string; actorId: string; actorKind: "human" | "agent" }

type WorkspaceRow = {
  workspace_id: string
  org_id: string
  project_id: string
  backing: "local-worktree" | "cloud-vm"
  home_region: string | null
  remote_directory: string | null
  host_assignment_revision: number
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

/** A signed heartbeat payload must stay small; 200 shares per machine is generous. */
const MAX_ACKED_WORKSPACES = 200
const MAX_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 60_000
const CONSUMED_REQUEST_RETENTION_MS = 10 * 60_000
const REQUEST_SWEEP_LIMIT = 500
const MAX_SCOPE_ROOT_LENGTH = 1_024

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
export const HOST_SERVING_WORKSPACE_SQL = `enrollment.revoked_at is null and enrollment.paused_at is null and enrollment.approval_requested_at is null
        and enrollment.expires_at > ?
        and exists (
          select 1 from host_assignment_readiness readiness
          where readiness.workspace_id = assignment.workspace_id
            and readiness.enrollment_id = enrollment.enrollment_id
            and readiness.generation = enrollment.serving_generation
            and readiness.revision = assignment.revision
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
    this.machineAuth = d1MachineAuth(database)
  }

  /**
   * The OWNER's declaration that host H serves workspace X. Pure data: no
   * challenge and no TTL — liveness is the enrollment lease, consent is the
   * heartbeat's readiness row, and routing requires all three. Cold-registers
   * the workspace row exactly as the retired per-workspace registration did.
   *
   * Ownership is decided against the record as it stands — a retired
   * machine-placed row included, since assigning it is what revives it — so a
   * refused request writes nothing. The cold registration, the revival, the
   * directory and the next assignment revision then land in one batch guarded
   * on the workspace counter and the enrollment's scope revision this call
   * validated, so a scope that moved in between leaves neither an assignment
   * nor a workspace behind; the enrollment's scope decides whether the
   * directory is allowed.
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
    const enrollment = await enrollmentOf(this.database, who.actorId, hostId)
    if (!enrollment || enrollment.revoked_at !== null) {
      throw new D1HostAccessAuthorityError("host_attestation_denied", "Host enrollment is unavailable")
    }
    const scope = hostEnrollmentScope(enrollment.scope_json, enrollment.scope_revision)
    const invitationOrgId = enrollment.enrolled_via === "invitation"
      ? await invitationOrgOf(this.database, enrollment.enrollment_id)
      : undefined
    if (invitationOrgId && args.orgId && args.orgId !== invitationOrgId) {
      throw new D1HostAccessAuthorityError("host_assignment_outside_scope", "Workspace organization differs from the invitation's")
    }
    // The workspace half is the admission `authorizeWorkspaceHostAssignment`
    // already gave this caller; the invitation and scope rules below are the
    // machine half, which only an assignment can know.
    const { workspace } = await this.admitHostAssignment(auth, who, {
      workspaceId,
      // The organization a cold register files into: the caller's, else the
      // one this machine was invited to serve.
      ...(args.orgId ?? invitationOrgId ? { orgId: args.orgId ?? invitationOrgId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    })
    if (workspace && invitationOrgId && workspace.org_id !== invitationOrgId) {
      throw new D1HostAccessAuthorityError("host_assignment_outside_scope", "Workspace organization differs from the invitation's")
    }
    const directory = requestedDirectory ?? workspace?.remote_directory ?? undefined
    const remoteDirectory = directory === undefined ? undefined : normalizeStoredDirectory(directory)
    if (scope && !hostPathWithinRoots(remoteDirectory ?? "", scope.allowed_roots)) {
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
    ]
    const counter = workspace?.host_assignment_revision ?? 0
    const revision = counter + 1
    const now = this.now()
    const assertionId = this.randomId("assert")
    const admitted = workspace ? mayGuard(who, "assign_host", { kind: "workspace", workspaceId }) : activeGuard(who)
    await batchUnder(this.database, admitted, [
      ...registration,
      this.database.prepare(`
        update workspaces set deleted_at = null, host_assignment_revision = ?,
          ${description.map(([column]) => `${column} = ?, `).join("")}updated_at = ?
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
      wonAssertion(this.database, assertionId),
      this.database.prepare(`
        insert into host_workspace_assignments (
          workspace_id, host_id, org_id, owner_user_id, owner_actor_id,
          assigned_at, updated_at, revision
        )
        select workspace_id, ?, org_id, ?, ?, ?, ?, host_assignment_revision
        from workspaces where workspace_id = ?
        on conflict (workspace_id) do update set
          host_id = excluded.host_id,
          owner_user_id = excluded.owner_user_id,
          owner_actor_id = excluded.owner_actor_id,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).bind(hostId, who.userId, who.actorId, now, now, workspaceId),
      deleteAssertion(this.database, assertionId),
    ], (statements) => this.guardedBatch(statements, "Host assignment raced with a scope, assignment or workspace identity change"))
    return { assigned: true as const, workspace_id: workspaceId, host_id: hostId }
  }

  async unassignWorkspaceHost(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireWorkspaceAccess(who, workspaceId, "administer")
    const now = this.now()
    const [result] = await batchUnder(this.database, mayGuard(who, "administer", { kind: "workspace", workspaceId }), [
      this.database.prepare(`
        delete from host_workspace_assignments where workspace_id = ? returning host_id
      `).bind(workspaceId),
      this.database.prepare(`delete from host_assignment_readiness where workspace_id = ?`).bind(workspaceId),
      this.database.prepare(retireMachinePlacedWorkspaceSql("workspace_id = ?")).bind(now, now, workspaceId),
    ])
    const deleted = asRecord(result.results?.[0])
    const hostId = typeof deleted?.host_id === "string" ? deleted.host_id : undefined
    return { unassigned: hostId !== undefined || changes(result) > 0, ...(hostId ? { host_id: hostId } : {}) }
  }

  /** Routable host: owner-assigned AND ready at the current revision and generation AND live lease. */
  async activeWorkspaceHost(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireWorkspaceAccess(who, workspaceId, "open")
    const row = await this.database.prepare(`
      select assignment.workspace_id, assignment.host_id,
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
      expires_at: row.expires_at,
      last_seen_at: row.last_seen_at,
      ...(sessionAuthority ? { session_authority: sessionAuthority } : {}),
    }
  }

  async listHostDevices(auth: SignedControlPlaneAuth) {
    return await listHostDevices(this.database, this.options.deploymentId, auth, this.now())
  }

  async createHostEnrollmentRequest(auth: SignedControlPlaneAuth, args: { hostId: string }) {
    const who = await this.requirePrincipal(auth)
    const hostId = requireText(args.hostId, "hostId")
    const requestId = this.randomId("request")
    const nonce = this.randomNonce()
    const now = this.now()
    const expiresAt = now + CHALLENGE_TTL_MS
    await batchUnder(this.database, activeGuard(who), [
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
      payload: enrollmentPayload({ hostId, requestId, nonce: request.nonce }),
    })
    const expiresAt = now + normalizedTtl(args.ttlMs)
    const enrollmentId = this.randomId("enrollment")
    const assertionId = this.randomId("assert")
    await batchUnder(this.database, activeGuard(who), [
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
      deleteAssertion(this.database, assertionId),
    ], (statements) => this.guardedBatch(statements, "Host enrollment raced with another request"))
    return enrollmentJson((await enrollmentOf(this.database, who.actorId, hostId))!)
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
        deleteAssertion(this.database, assertionId),
      ])
    } catch (error) {
      if (!d1BatchAssertionFailed(error)) throw error
      throw await this.machineMutationRefusal(machine, generation, "Host heartbeat raced with an enrollment change")
    }
    const row = await enrollmentById(this.database, machine.enrollmentId)
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
        wonAssertion(this.database, assertionId),
        this.database.prepare(`
          delete from host_assignment_readiness where enrollment_id = ? and generation < ?
        `).bind(machine.enrollmentId, generation),
        this.auditRow({
          enrollmentId: machine.enrollmentId,
          action: "host_enrollment.generation_acquired",
          metadata: { enrollmentId: machine.enrollmentId, hostId: machine.hostId, generation },
          now,
        }),
        deleteAssertion(this.database, assertionId),
      ])
    } catch (error) {
      if (!d1BatchAssertionFailed(error)) throw error
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
    await batchUnder(this.database, activeGuard(who), [this.database.prepare(`
      update host_enrollments set paused_at = ?, updated_at = ?
      where owner_actor_id = ? and (? is null or host_id = ?) and revoked_at is null
    `).bind(args.paused ? now : null, now, who.actorId, hostId ?? null, hostId ?? null)])
    return { paused: args.paused }
  }

  async activeHostEnrollment(auth: SignedControlPlaneAuth): Promise<HostEnrollmentState> {
    const who = await this.requirePrincipal(auth)
    const row = await this.database.prepare(`
      select * from host_enrollments where owner_actor_id = ? and approval_requested_at is null
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
      select * from host_enrollments where owner_actor_id = ? and revoked_at is null and approval_requested_at is null
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
    const row = await enrollmentById(this.database, enrollmentId)
    if (!row || row.owner_actor_id !== who.actorId || row.revoked_at !== null) {
      throw new D1HostAccessAuthorityError("host_enrollment_not_found", "Host enrollment not found")
    }
    const revision = row.scope_revision + 1
    const rootsJson = JSON.stringify(scope.allowed_roots)
    const now = this.now()
    const auditId = this.randomId("audit")
    const assertionId = this.randomId("assert")
    const outsideRoots = () => [row.host_id, row.owner_actor_id, rootsJson]
    await batchUnder(this.database, activeGuard(who), [
      this.database.prepare(`
        update host_enrollments set scope_json = ?, scope_revision = ?, updated_at = ?
        where enrollment_id = ? and owner_actor_id = ? and scope_revision = ? and revoked_at is null
      `).bind(JSON.stringify(scope), revision, now, enrollmentId, who.actorId, row.scope_revision),
      wonAssertion(this.database, assertionId),
      this.database.prepare(retireMachinePlacedWorkspaceSql(`workspace_id in (${assignmentsOutsideRootsSql})`))
        .bind(now, now, ...outsideRoots()),
      this.database.prepare(`
        delete from host_assignment_readiness where workspace_id in (${assignmentsOutsideRootsSql})
      `).bind(...outsideRoots()),
      this.auditRow({
        eventId: auditId,
        enrollmentId,
        action: "host_enrollment.scope_updated",
        metadata: new SqlJson(
          `json_object('enrollmentId', ?, 'hostId', ?, 'scopeRevision', ?, 'retiredWorkspaceIds',
            json((select json_group_array(workspace_id) from (${assignmentsOutsideRootsSql} order by assignment.workspace_id))))`,
          [enrollmentId, row.host_id, revision, ...outsideRoots()],
        ),
        now,
      }),
      this.database.prepare(`
        delete from host_workspace_assignments where workspace_id in (${assignmentsOutsideRootsSql})
      `).bind(...outsideRoots()),
      deleteAssertion(this.database, assertionId),
    ], (statements) => this.guardedBatch(statements, "Host enrollment scope changed concurrently"))
    const audit = await this.database.prepare(`select metadata_json from authority_audit_events where event_id = ?`)
      .bind(auditId).first<{ metadata_json: string }>()
    const retired = stringList(asRecord(parseJson(audit?.metadata_json ?? "{}"))?.retiredWorkspaceIds)
    return { host_id: row.host_id, scope: { ...scope, revision }, retired_workspace_ids: retired }
  }

  async renameHostEnrollment(
    auth: SignedControlPlaneAuth,
    args: { enrollmentId: string; displayName: string },
  ): Promise<{ enrollment_id: string; display_name: string }> {
    const who = await this.requirePrincipal(auth)
    const enrollmentId = requireText(args.enrollmentId, "enrollmentId")
    const displayName = requireText(args.displayName, "displayName", 200)
    const now = this.now()
    const [renamed] = await batchUnder(this.database, activeGuard(who), [this.database.prepare(`
      update host_enrollments set display_name = ?, updated_at = ?
      where enrollment_id = ? and owner_actor_id = ? and revoked_at is null
      returning enrollment_id
    `).bind(displayName, now, enrollmentId, who.actorId)])
    const updated = renamed.results[0]
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

  async revokeHostEnrollment(auth: SignedControlPlaneAuth, args: { hostId?: string }) {
    const who = await this.requirePrincipal(auth)
    const hostId = optionalText(args.hostId, "hostId")
    const now = this.now()
    const results = await batchUnder(this.database, activeGuard(who), [
      this.database.prepare(`
        update host_enrollments set revoked_at = ?, updated_at = ?
        where owner_actor_id = ? and (? is null or host_id = ?) and revoked_at is null
      `).bind(now, now, who.actorId, hostId ?? null, hostId ?? null),
      // A revoked key's host id never returns (a later enable enrolls a NEW
      // id), so its assignments could never become routable again — leaving
      // them would only accumulate dangling rows that a later re-share must
      // displace. The cascade keeps "revoke = nothing routable" exactly true.
      this.database.prepare(retireMachinePlacedWorkspaceSql(`workspace_id in (
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

  private requirePrincipal(auth: SignedControlPlaneAuth): Promise<Principal> {
    return requireHuman(this.database, this.options.deploymentId, auth)
  }

  private async requireWorkspaceAccess(actor: Principal, workspaceId: string, action: WorkspaceAction) {
    const allowed = maySql(actor, action, { kind: "workspace", alias: "workspace" })
    const row = await this.database.prepare(`
      select workspace.workspace_id, workspace.org_id, workspace.project_id,
        workspace.backing, workspace.home_region, workspace.remote_directory,
        workspace.host_assignment_revision
      from workspaces workspace
      where workspace.workspace_id = ? and ${allowed.sql}
    `).bind(workspaceId, ...allowed.bind).first<WorkspaceRow>()
    if (!row) throw denied()
    return row
  }

  /**
   * Whether this caller may have a machine serve this workspace, and whether
   * that files a new row. The one place that answers it: the standalone
   * admission and the assignment both come here, so a caller cannot be
   * refused by one and admitted by the other.
   */
  private async admitHostAssignment(
    auth: SignedControlPlaneAuth,
    who: Principal,
    args: { workspaceId: string; orgId?: string; projectId?: string },
  ): Promise<{ registration: "existing" | "cold"; workspace?: WorkspaceRow }> {
    if (await this.assignableWorkspaceExists(args.workspaceId)) {
      const workspace = await this.requireWorkspaceAccess(who, args.workspaceId, "assign_host")
      requireLocalWorkspace(workspace)
      return { registration: "existing", workspace }
    }
    if (!this.options.authorizeLocalWorkspaceRegistration) {
      throw new D1HostAccessAuthorityError("host_attestation_denied", "Cold local workspace registration is unavailable")
    }
    await this.options.authorizeLocalWorkspaceRegistration(auth, {
      ...(args.orgId ? { orgId: args.orgId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    })
    return { registration: "cold" }
  }

  async authorizeWorkspaceHostAssignment(
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string; orgId?: string; projectId?: string },
  ) {
    const who = await this.requirePrincipal(auth)
    const { registration } = await this.admitHostAssignment(auth, who, {
      ...args,
      workspaceId: requireText(args.workspaceId, "workspaceId"),
    })
    return { registration }
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

  /** At most `REQUEST_SWEEP_LIMIT` expired rows per call, oldest first, so one request's batch stays bounded. */
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
      if (d1UniqueFailureOn(error, "host_signature_uses")) {
        throw new D1HostAccessAuthorityError("signature_replayed", "Host signature has already been used")
      }
      if (d1BatchAssertionFailed(error)) {
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

/**
 * A machine-placed workspace exists in the inventory exactly as long as a
 * machine is assigned to serve it: unsharing it or revoking its machine retires
 * the row, and sharing it again revives the same record. Cloud rows are never
 * touched here — their lifetime is the sandbox's.
 */
export function retireMachinePlacedWorkspaceSql(where: string) {
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

function normalizedTtl(input: number | undefined) {
  if (input === undefined) return DEFAULT_TTL_MS
  if (!Number.isFinite(input)) throw new D1HostAccessAuthorityError("invalid_input", "ttlMs must be finite")
  return Math.max(5_000, Math.min(input, MAX_TTL_MS))
}

function changes(result: { meta?: { changes?: number } }) {
  return result.meta?.changes ?? 0
}
