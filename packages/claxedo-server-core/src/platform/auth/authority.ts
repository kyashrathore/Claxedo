import { isRecord } from "@claxedo/helpers/guards"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "./auth"
import type { OrgId, ProjectId } from "./branded-id"
import type {
  AuthorizeRuntimePrivateSessionInput,
  RegisterRuntimePrivateSessionInput,
} from "./private-session-authority"

/**
 * Typed neutral authority port for the control plane.
 *
 * This is the seam the generic control-plane core owns: routes and pull flows
 * depend on this capability, not on any particular authority storage. Claxedo's
 * storage-backed implementation lives behind `authority/adapters/*` and
 * satisfies this structural type; alternative control-plane compositions can
 * inject a different implementation.
 *
 * The signatures below are derived structurally from actual route/pull-flow
 * usage and the adapter implementation modules. Keep them structural (do not
 * reference the adapter's factory return type) so this module drags no adapter
 * runtime code and stays storage-agnostic.
 */

export type ProjectRole = "viewer" | "editor" | "admin" | "owner"
export type ProjectAction = "read" | "write" | "admin" | "owner"

export type ProjectRoleArgs = {
  orgId?: OrgId
  projectId: ProjectId
}

export type ProjectRoleResult = { ok: true; role: ProjectRole; orgId: OrgId } | { ok: false }

export type AuthorizeProjectArgs = ProjectRoleArgs & {
  action: ProjectAction
}

export type AuthorizeProjectResult = ProjectRoleResult

export type WorkspaceVisibility = {
  sessionId: string
  title?: string
  createdAt?: number
  updatedAt?: number
}

/** Canonical identity contract returned by authority-backed session inventory. */
export type AuthoritySessionInventoryRow = {
  session_id: string
  workspace_id?: string
  [field: string]: unknown
}

export type RuntimeActorIdentity = {
  actorId: string
  actorKind: "human" | "agent"
  actorPublicId?: string
  actorName?: string
  actorAvatarUrl?: string
}

export type WorkspaceOwnerIdentity = { userId: string; actorId: string; orgId: string; projectId: string }

export type WorkspaceRecord = {
  workspace_id?: string
  org_id?: string
  project_id?: string
  // Kept as plain strings on the port: routes compare against literal values
  // (`=== "cloud-vm"`), which narrows fine, while the concrete payload shape is
  // the adapter's concern.
  backing?: string
  access?: string
  display_name?: string
  home_region?: string
  [field: string]: unknown
}

export type WorkspaceOpenResult = {
  allowed?: boolean
  role?: string
  workspace?: WorkspaceRecord
}

export type WorkspaceShareTarget =
  | { kind: "actor"; actorId: string }
  | { kind: "user"; userId: string }
  | { kind: "org"; orgId: string }

/**
 * Canonical recipient identity resolved by the authority before a session
 * share is revoked. Routes use this target for recipient doorbells, including
 * grant-id-only revokes whose request body carries no recipient selector.
 */
export type SessionShareFanoutTarget = {
  grantedToTokenIdentifier?: string
  grantedToSubject?: string
  grantedToUserId?: string
  grantedToOrgId?: string
  grantedToTeamId?: string
  grantedToTeamPublicId?: string
}

export type SessionShareRevokeResult = {
  revoked: boolean
  runtime_tokens_revoked?: number
  revokedTargets: SessionShareFanoutTarget[]
}

export type SessionPeopleContext = {
  can_manage_shares: boolean
  grants: Array<Record<string, unknown>>
  participants: Array<Record<string, unknown>>
  teams: Array<{
    team_id: string
    name: string
    is_shared: boolean
  }>
}

/**
 * Neutral authority capability. Every method mirrors a concrete route or
 * pull-flow call site; the shapes are the structural contract the core relies
 * on and the adapter must satisfy.
 */
/** Identity supplied only by authenticated channel ingress; authority resolves the linked actor afresh. */
export type ChannelMachineIdentity = { channel: string; externalUserId: string; threadKey: string }

export type WorkspaceAuthority = {
  /** Internal host delegation; the authority rechecks the actor and current workspace role. */
  resolveRuntimeMachineAccess: (actorId: string, workspaceId: string) => Promise<RuntimeActorIdentity & { orgId: string; role: ProjectRole }>
  recordActorRuntimeAccessToken: (args: Parameters<WorkspaceAuthority["recordRuntimeAccessToken"]>[1]) => Promise<unknown>
  resolveChannelMachineAccess: (identity: ChannelMachineIdentity, workspaceId: string) => Promise<RuntimeActorIdentity & { orgId: string; role: ProjectRole }>
  /**
   * The workspace's canonical owner, for a credential this control plane
   * minted that carries no signed bearer of its own.
   *
   * Optional because only a deployment that mints such credentials can answer
   * it, and a credential is refused where it is unanswered rather than
   * admitted on what the credential itself claims. Undefined for a workspace
   * that is gone, whose owner is no longer an active user, or who can no
   * longer write to it.
   */
  resolveWorkspaceOwner?: (workspaceId: string) => Promise<WorkspaceOwnerIdentity | undefined>
  recordChannelRuntimeAccessToken: (identity: ChannelMachineIdentity, args: Parameters<WorkspaceAuthority["recordRuntimeAccessToken"]>[1]) => Promise<unknown>
  // identity
  usersMe: (auth: SignedControlPlaneAuth) => Promise<unknown>
  listOrgs: (auth: SignedControlPlaneAuth) => Promise<unknown>
  resolveOrgId: (auth: SignedControlPlaneAuth) => Promise<OrgId>
  projectRole: (auth: SignedControlPlaneAuth, args: ProjectRoleArgs) => Promise<ProjectRoleResult>
  authorizeProject: (auth: SignedControlPlaneAuth, args: AuthorizeProjectArgs) => Promise<AuthorizeProjectResult>
  authorizeChannelProject: (args: {
    channel: string
    externalUserId: string
    threadKey: string
    projectId: string
    action: ProjectAction
  }) => Promise<AuthorizeProjectResult & Partial<RuntimeActorIdentity>>
  authorizeChannelWorkspace: (args: {
    channel: string
    externalUserId: string
    threadKey: string
    workspaceId: string
    action: ProjectAction
  }) => Promise<RuntimeActorIdentity | void>
  bindChannelIdentity: (
    auth: SignedControlPlaneAuth,
    args: { channel: string; externalUserId: string },
  ) => Promise<{
    bindingId: string
    created: boolean
    userId: string
    actorId: string
    actorKind: "human" | "agent"
  }>
  revokeChannelIdentity: (
    auth: SignedControlPlaneAuth,
    args: { channel: string; externalUserId: string },
  ) => Promise<{ revoked: boolean }>

  // workspaces
  authorizeWorkspaceOpen: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<void>
  authorizeWorkspaceCreate?: (auth: SignedControlPlaneAuth, args: { orgId?: string }) => Promise<void>
  openWorkspace: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<WorkspaceOpenResult>
  listWorkspaces: (auth: SignedControlPlaneAuth) => Promise<unknown>
  registerLocalForSharing: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      orgId?: string
      displayName: string
      projectId?: string
      repoUrl?: string
      repoName?: string
      gitBranch?: string
      remoteDirectory?: string
      homeRegion?: string
    },
  ) => Promise<unknown>
  // --- machine-wide enrollment ---------------------------------------------
  //
  // Enrollment carries no workspace, and that absence is the feature: a laptop
  // is enrolled once, and which workspaces a session may reach is decided at
  // request time from the workspace tables. Required on the port, so no call
  // site needs an absence check.
  createHostEnrollmentRequest: (
    auth: SignedControlPlaneAuth,
    args: { hostId: string },
  ) => Promise<{ request_id: string; nonce: string; expires_at: number }>
  enrollHost: (
    auth: SignedControlPlaneAuth,
    args: {
      hostId: string
      publicKey: string
      requestId: string
      signature: string
      displayName?: string
      ttlMs?: number
    },
  ) => Promise<HostEnrollment>
  heartbeatHostEnrollment: (
    auth: SignedControlPlaneAuth,
    args: {
      hostId: string
      signature: string
      ttlMs?: number
      /**
       * The workspaces this machine currently serves, sorted, covered by the
       * heartbeat signature (payload v2). One signature per interval carries
       * the machine's whole consent set; routing requires a workspace to be
       * BOTH owner-assigned and inside the machine's last-acked set.
       */
      workspaceIds: readonly string[]
      /**
       * How the runtime this machine serves composed its session access —
       * `SessionAccessPolicy.sessionAuthority` on that very runtime, read from
       * the composition rather than assumed from the product.
       *
       * Deliberately outside the heartbeat signature, which exists to prove
       * MACHINE CONSENT to serve a workspace set. This is a description of a
       * composition, not an authorization claim: it can neither grant nor
       * widen access, because the runtime itself is what admits or refuses
       * every stream (`authorizeSessionEventScope`). A wrong value only makes
       * a client open a stream its own runtime then rejects.
       *
       * Absent means the machine did not say. The control plane records the
       * absence and mints no stream scope from it — it never guesses a
       * runtime's composition on the host's behalf.
       */
      sessionAuthority?: HostSessionAuthority
    },
  ) => Promise<{
    expires_at: number
    last_seen_at: number
    /** Owner assignments for this host, for client-side set reconciliation. */
    assigned_workspace_ids: string[]
  }>
  /** The owner destroys one of their machine enrollments; absent, the deployment cannot. */
  revokeHostEnrollment?: (
    auth: SignedControlPlaneAuth,
    args: { hostId?: string },
  ) => Promise<{ revoked: number; runtime_tokens_revoked: number }>
  pauseHostEnrollment: (
    auth: SignedControlPlaneAuth,
    args: { hostId?: string; paused: boolean },
  ) => Promise<{ paused: boolean }>
  activeHostEnrollment: (
    auth: SignedControlPlaneAuth,
    args?: Record<string, never>,
  ) => Promise<HostEnrollmentState>
  /**
   * Assign one workspace to one enrolled host — the OWNER's declaration that
   * host H serves workspace X. Pure data: no challenge, no signature, no TTL
   * of its own (liveness is the enrollment lease; consent is the heartbeat's
   * acked set). Cold-registers the workspace row when it does not exist yet,
   * exactly as the retired per-workspace registration did.
   */
  assignWorkspaceHost: (
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
  ) => Promise<{ assigned: true; workspace_id: string; host_id: string }>
  unassignWorkspaceHost: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) => Promise<{ unassigned: boolean }>
  /**
   * The routable host for a workspace: owner-assigned AND inside the host's
   * last-acked served set AND the enrollment lease is live. The single
   * read-side routing question every consumer asks.
   */
  activeWorkspaceHost: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) => Promise<
    | {
      active: true
      host_id: string
      workspace_id: string
      display_name?: string
      second_device_open_at?: number
      expires_at: number
      last_seen_at: number
      /**
       * The composition the routable machine declared on its last heartbeat.
       * Absent when it declared none — the caller reports the absence rather
       * than substituting a guess.
       */
      session_authority?: HostSessionAuthority
    }
    | { active: false }
  >
  /** Every live assignment on the account, grouped for the devices surface. */
  listHostAssignments: (
    auth: SignedControlPlaneAuth,
  ) => Promise<Array<{
    host_id: string
    display_name: string
    last_seen_at: number
    expires_at: number
    workspace_ids: string[]
    acked_workspace_ids: string[]
  }>>
  /**
   * The machine's own heartbeat: the caller is the verified machine principal
   * (`verifyMachineRequest`), not an account bearer, and `who` is the row's
   * owner. The renewal is refused with `enrollment_generation_superseded` when
   * `args.generation` is below the stored serving generation.
   */
  heartbeatHostEnrollmentByMachine?: (
    machine: MachinePrincipal,
    args: HostMachineHeartbeatInput,
  ) => Promise<HostMachineHeartbeatResult>
  /**
   * A starting instance claims the next serving generation; beats and tunnels
   * of every earlier generation are refused from this point. Readiness rows of
   * prior generations are dropped in the same batch.
   */
  acquireHostServingGeneration?: (
    machine: MachinePrincipal,
  ) => Promise<{ generation: number; generation_acquired_at: number }>
  createHostInvitation?: (
    auth: SignedControlPlaneAuth,
    args: HostInvitationCreateInput,
  ) => Promise<HostInvitationCreateResult>
  listHostInvitations?: (auth: SignedControlPlaneAuth) => Promise<HostInvitationRow[]>
  revokeHostInvitation?: (
    auth: SignedControlPlaneAuth,
    args: { invitationId: string },
  ) => Promise<{ revoked: boolean }>
  /** No caller auth: the single-use invitation secret is the credential. */
  redeemHostInvitation?: (args: HostInvitationRedeemInput) => Promise<HostInvitationRedeemResult>
  /**
   * Owner only. Assignments whose directory falls outside the new roots are
   * deleted and their workspaces retired in the same batch.
   */
  updateHostEnrollmentScope?: (
    auth: SignedControlPlaneAuth,
    args: { enrollmentId: string; scope: HostScopeDefinition },
  ) => Promise<HostScopeUpdateResult>
  listHostEnrollments?: (auth: SignedControlPlaneAuth) => Promise<HostEnrollmentListRow[]>
  /** What `verifyMachineRequest` reads and consumes; absent, no route can admit a machine caller. */
  machineAuth?: MachineAuthAdapter
  markSecondDeviceOpen: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) => Promise<{ recorded: boolean; second_device_open_at: number }>
  deleteWorkspace: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<unknown>
  createCloudWorkspace: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      orgId?: string
      projectId?: string
      displayName: string
      repoUrl?: string
      repoName?: string
      gitBranch?: string
      homeRegion?: string
    },
  ) => Promise<unknown>
  grantWorkspaceShare: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      role: "viewer" | "editor" | "admin"
      target: WorkspaceShareTarget
    },
  ) => Promise<unknown>
  revokeWorkspaceShare: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      grantId?: string
      target?: WorkspaceShareTarget
    },
  ) => Promise<unknown>

  // sessions
  authorizeSessionRead: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string },
  ) => Promise<void>
  authorizeSessionWrite: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string },
  ) => Promise<void>
  authorizeRuntimeSession?: (args: AuthorizeRuntimePrivateSessionInput) => Promise<void>
  registerRuntimeSession?: (args: RegisterRuntimePrivateSessionInput) => Promise<unknown>
  grantSessionParticipant: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; participantActorId: string },
  ) => Promise<{ participant_id: string }>
  revokeSessionParticipant: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; participantActorId: string },
  ) => Promise<{ removed: boolean }>
  grantSessionShare?: (
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      grantedToTokenIdentifier?: string
      grantedToSubject?: string
      grantedToUserId?: string
      grantedToOrgId?: string
      grantedToTeamId?: string
      grantedToTeamPublicId?: string
    },
  ) => Promise<unknown>
  revokeSessionShare?: (
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      grantId?: string
      grantedToTokenIdentifier?: string
      grantedToSubject?: string
      grantedToUserId?: string
      grantedToOrgId?: string
      grantedToTeamId?: string
      grantedToTeamPublicId?: string
    },
  ) => Promise<SessionShareRevokeResult>
  listSessionShares?: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string },
  ) => Promise<SessionPeopleContext>
  createOrg?: (auth: SignedControlPlaneAuth, args: { name: string }) => Promise<unknown>
  listTeams?: (auth: SignedControlPlaneAuth, args: { orgId: string }) => Promise<unknown>
  createTeamInOrg?: (auth: SignedControlPlaneAuth, args: { orgId: string; name: string }) => Promise<unknown>
  addTeamMember?: (
    auth: SignedControlPlaneAuth,
    args: {
      teamId: string
      tokenIdentifier?: string
      providerSubject?: string
      userPublicId?: string
      role?: "member" | "admin" | "owner"
    },
  ) => Promise<unknown>
  removeTeamMember?: (
    auth: SignedControlPlaneAuth,
    args: {
      teamId: string
      tokenIdentifier?: string
      providerSubject?: string
      userPublicId?: string
    },
  ) => Promise<unknown>
  listTeamMembers?: (auth: SignedControlPlaneAuth, args: { teamId: string }) => Promise<unknown>
  grantTeamProject?: (
    auth: SignedControlPlaneAuth,
    args: { teamId: string; projectId: string; role: "viewer" | "editor" | "admin" },
  ) => Promise<unknown>
  revokeTeamProject?: (
    auth: SignedControlPlaneAuth,
    args: { teamId: string; projectId: string },
  ) => Promise<unknown>
  ensureDefaultTeam?: (auth: SignedControlPlaneAuth, args: { orgId: string }) => Promise<unknown>
  listSessions: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) => Promise<AuthoritySessionInventoryRow[]>
  resolveSession?: (auth: SignedControlPlaneAuth, args: { sessionId: string }) => Promise<unknown>
  readSessionMessages: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; limit?: number; before?: string },
  ) => Promise<unknown>
  syncSessionMessages: (
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      messages: unknown[]
      intakeReady?: boolean
      maxEventOrdinal?: number
      fencingToken?: number
    },
  ) => Promise<unknown>
  upsertSessionVisibility: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      sessions: WorkspaceVisibility[]
    },
  ) => Promise<unknown>
  replaceSessionVisibility: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      sessions: WorkspaceVisibility[]
    },
  ) => Promise<unknown>
  deleteSessionVisibility: (
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
    },
  ) => Promise<unknown>

  // runtime tokens
  recordRuntimeAccessToken: (
    auth: SignedControlPlaneAuth,
    args: {
      jti: string
      workspaceId: string
      hostId: string
      actorId: string
      actorKind: "human" | "agent"
      role: "viewer" | "editor" | "admin" | "owner"
      expiresAt: number
    },
  ) => Promise<unknown>
  recordRuntimeAccessTokenForService: (args: {
    jti: string
    workspaceId: string
    hostId: string
    actorId: string
    actorKind: "human" | "agent"
    principalKind: "user" | "service"
    role: "viewer" | "editor" | "admin" | "owner"
    expiresAt: number
  }) => Promise<unknown>
  runtimeAccessTokenActive: (args: {
    jti: string
    workspaceId: string
    hostId: string
    minimumRole?: "viewer" | "editor" | "admin" | "owner"
  }) => Promise<unknown>
  revokeRuntimeAccessToken: (
    auth: SignedControlPlaneAuth,
    args: { jti: string; workspaceId: string },
  ) => Promise<unknown>
  revokeRuntimeAccessTokensForWorkspaceUser: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) => Promise<unknown>

  // audit
  auditDeny: (
    auth: SignedControlPlaneAuth | undefined,
    args: {
      action: string
      reason: string
      workspaceId?: string
      metadata?: Record<string, unknown>
    },
  ) => Promise<void>
  auditAllow: (
    auth: SignedControlPlaneAuth,
    args: {
      action: string
      workspaceId?: string
      metadata?: Record<string, unknown>
    },
  ) => Promise<void>
}

/** Resolve the configured authority or fail closed (503); the one authority-required helper for every route. */
export function requireAuthority(services: { authority?: WorkspaceAuthority } | undefined): WorkspaceAuthority {
  if (services?.authority) return services.authority
  throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Workspace authority is not configured")
}

/**
 * How the runtime behind a host composed its session access, in the host's own
 * words: the `SessionAccessPolicy.sessionAuthority` marker of the very runtime
 * the machine serves (`@claxedo/workspace-runtime` session-access-policy.ts).
 *
 * `"local"` serves the broad workspace event streams as well as session-scoped
 * ones; `"managed-private"` serves session-scoped streams ONLY and answers an
 * unscoped one with a permanent 400 `session_event_scope_required`. Which of
 * the two a machine runs is a fact only that machine holds — the same product
 * (a desktop daemon, a `claxedo up` host) composes either one depending on
 * whether a session authority was injected — so the control plane records what
 * the host declares and never infers it from access, backing or kind.
 */
export type HostSessionAuthority = "local" | "managed-private"

/**
 * Narrow a declared or stored value to a `HostSessionAuthority`. Anything else
 * — including the NULL a row carries before any host declared one — is "not
 * declared", which every caller must treat as an answer rather than a default.
 */
export function hostSessionAuthority(input: unknown): HostSessionAuthority | undefined {
  return input === "local" || input === "managed-private" ? input : undefined
}

/** One machine's enrollment, as the owner sees it. Carries no key material. */
export type HostEnrollment = {
  enrollment_id: string
  host_id: string
  display_name?: string
  expires_at: number
  last_seen_at: number
  created_at: number
}

export type HostEnrollmentState =
  | ({ active: true } & HostEnrollment)
  /**
   * Why it is not active, rather than a bare `false`.
   *
   * "You paused this machine" and "this machine has not checked in since
   * Tuesday" are different problems with different fixes, and a UI that cannot
   * tell them apart shows the user the wrong one.
   */
  | { active: false; reason: "not-enrolled" | "paused" | "expired" | "revoked" }

export type HostEnrolledVia = "account" | "invitation"

/** What an owner grants a machine: the roots it may serve and who may see them. */
export type HostScopeDefinition = {
  /** Absolute POSIX paths. Empty means the machine may serve nothing. */
  allowed_roots: string[]
  /** `"owner"`: no implicit org-member access to the machine's workspaces. */
  visibility: "owner" | "org"
}

/** The stored scope, versioned so a host can tell a newer delivery from a stale one. */
export type HostEnrollmentScope = HostScopeDefinition & { revision: number }

/**
 * Narrow a stored `scope_json` column to a scope. Undefined when the column is
 * NULL or malformed — an account enrollment has no scope, and every caller
 * must treat that as an answer rather than a default.
 */
export function hostEnrollmentScope(json: unknown, revision: number): HostEnrollmentScope | undefined {
  if (typeof json !== "string") return undefined
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const { allowed_roots, visibility } = value
  if (!Array.isArray(allowed_roots) || !allowed_roots.every((root) => typeof root === "string")) return undefined
  if (visibility !== "owner" && visibility !== "org") return undefined
  return { allowed_roots: [...allowed_roots], visibility, revision }
}

/**
 * The verified caller of a machine-signed route (`verifyMachineRequest`).
 * `keyVersion` and `generation` are what the verifier read; every mutation
 * re-asserts them inside its batch so a key replaced or an instance
 * superseded between verification and write writes nothing.
 */
export type MachinePrincipal = {
  enrollmentId: string
  hostId: string
  ownerUserId: string
  ownerActorId: string
  /** Absent for an account enrollment, which records none. */
  scope: HostEnrollmentScope | undefined
  keyVersion: number
  generation: number
}

/** The enrollment as the verifier needs it, read once by `enrollment_id`. */
export type MachineEnrollmentRow = {
  enrollment_id: string
  host_id: string
  owner_user_id: string
  owner_actor_id: string
  /** Public P-256 JWK JSON as stored. */
  public_key_json: string
  key_version: number
  serving_generation: number
  revoked_at: number | null
  paused_at: number | null
  scope: HostEnrollmentScope | undefined
  /** Owner eligibility is adapter-specific (D1: user and actor `active`; SQLite: the users row exists), so the adapter answers it. */
  ownerEligible: boolean
}

export type MachineAuthAdapter = {
  lookupEnrollment: (enrollmentId: string) => Promise<MachineEnrollmentRow | undefined>
  /** Insert-or-fail on `(enrollmentId, nonce)`; false when the nonce was already consumed. */
  consumeNonce: (input: { enrollmentId: string; nonce: string; expiresAt: number }) => Promise<boolean>
}

/** One workspace the owner points at this machine, versioned per re-point. */
export type HostAssignmentDescription = {
  workspace_id: string
  remote_directory: string
  display_name?: string
  /** Strictly increasing per workspace; bumped in the same batch as `remote_directory`. */
  revision: number
}

/** The host's statement that it serves a workspace at a given description. */
export type HostAssignmentAck = { workspaceId: string; revision: number }

export type HostMachineHeartbeatInput = {
  enrollmentId: string
  hostId: string
  generation: number
  acks: HostAssignmentAck[]
  ttlMs?: number
  sessionAuthority?: HostSessionAuthority
}

export type HostMachineHeartbeatResult = {
  expires_at: number
  last_seen_at: number
  assignments: HostAssignmentDescription[]
  scope: HostEnrollmentScope | undefined
  /** Kept for the desktop's set reconciliation. */
  assigned_workspace_ids: string[]
}

export type HostInvitationCreateInput = {
  scope: HostScopeDefinition
  displayName?: string
  /** Clamped to [5 min, 24 h]; 1 h when absent. */
  expiresInMs?: number
}

export type HostInvitationCreateResult = {
  invitationId: string
  /** `chx_inv_1.<invitation_id>.<secret>`; the secret is never stored, only its hash. */
  token: string
  expiresAt: number
}

export type HostInvitationRow = {
  invitation_id: string
  display_name?: string
  scope: HostScopeDefinition
  org_id?: string
  created_at: number
  expires_at: number
  redeemed_at?: number
  redeemed_host_id?: string
  redeemed_enrollment_id?: string
  revoked_at?: number
}

export type HostInvitationRedeemInput = {
  invitationId: string
  secret: string
  hostId: string
  /** Public P-256 JWK JSON. */
  publicKey: string
  /** Over `invitationRedeemPayload` (host-connect-contract). */
  signature: string
  displayName?: string
}

export type HostInvitationRedeemResult = {
  /** True when the invitation was already redeemed by this same key and host id. */
  resumed: boolean
  enrollment: HostEnrollment
  owner_user_id: string
  owner_actor_id: string
  org_id?: string
  owner_display_name?: string
  key_version: number
  serving_generation: number
  scope: HostEnrollmentScope
}

export type HostScopeUpdateResult = {
  scope: HostEnrollmentScope
  /** Assignments deleted because their directory fell outside the new roots. */
  retired_workspace_ids: string[]
}

export type HostEnrollmentListRow = {
  enrollment_id: string
  display_name?: string
  host_id: string
  public_key_fingerprint: string
  key_version: number
  enrolled_via: HostEnrolledVia
  last_seen_at: number
  expires_at: number
  serving_generation: number
  generation_acquired_at?: number
  paused_at?: number
  acked: HostAssignmentAck[]
  scope: HostEnrollmentScope | undefined
}

export type HostInvitationErrorCode =
  | "invitation_invalid"
  | "invitation_expired"
  | "invitation_revoked"
  | "invitation_redeemed"
  | "invitation_host_conflict"

export type HostMachineErrorCode = "enrollment_generation_superseded" | "host_assignment_outside_scope"

export type HostConnectErrorCode = HostInvitationErrorCode | HostMachineErrorCode
