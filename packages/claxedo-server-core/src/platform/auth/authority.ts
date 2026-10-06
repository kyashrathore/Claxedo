import type { HostDevice } from "./host-devices"
import type { HostEnrollment, HostEnrollmentListRow, HostEnrollmentState, HostInvitationCreateInput, HostInvitationCreateResult, HostInvitationRedeemInput, HostInvitationRedeemResult, HostInvitationRow, HostMachineHeartbeatInput, HostMachineHeartbeatResult, HostProviderConfigPushInput, HostProviderConfigTarget, HostScopeDefinition, HostScopeUpdateResult, HostSessionAuthority, MachineAuthAdapter, MachinePrincipal } from "./host-connect-contract"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "./auth"
import type { OrgId, ProjectId } from "./branded-id"
import type { SandboxMachineClass } from "@claxedo/sandbox-contract"
import type { CloudWorkspaceCreateArgs, RuntimeCloudWorkspaceCreateArgs } from "./cloud-workspace-create"
import type {
  AuthorizeRuntimePrivateSessionInput,
  PrivateSessionRuntimePrincipal,
  PrivateSessionAuthority,
  RegisterRuntimePrivateSessionInput,
  SessionPageQuery,
} from "./private-session-authority"
import type { LatestView } from "../../session/latest-view-page"
import type { AgentContentPart, TurnPageQuery, TurnPageRequest, TurnPage, FirstRead } from "@claxedo/agent-runtime-contract"
import type { HostSessionRowsAuthority } from "./host-session-rows"
import type { OrgAccessAuthority } from "./org-access-authority"
import type { SessionShareAuthority } from "./session-share-authority"
import type { SessionReaderAuthority } from "./session-reader-authority"

export {
  DEFAULT_SESSION_SHARE_LEVEL,
  isSessionShareLevel,
  requestedSessionShareLevel,
  SESSION_SHARE_LEVELS,
  storedSessionShareLevel,
  type SessionShareLevel,
} from "./session-share-level"
export type {
  SessionPeopleContext,
  SessionShareGrantResult,
  SessionShareRevokeResult,
} from "./session-share-authority"

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
  userId?: string
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
  /**
   * Where the workspace runs: the enrolled machine serving it, and the
   * directory on that machine. A provisioner-owned cloud VM names no
   * enrollment — `backing` is what says the provisioner owns it.
   */
  placement?: { host_enrollment_id?: string; directory?: string }
  display_name?: string
  home_region?: string
  [field: string]: unknown
}

/**
 * What serving this workspace from a machine would do to the authority's
 * records: describe a row it already holds, or file one. The caller uses it to
 * report the share, never to decide it — an admission that returns has already
 * decided.
 */
export type WorkspaceHostAssignmentAdmission = { registration: "existing" | "cold" }

export type WorkspaceOpenResult = {
  allowed?: boolean
  role?: string
  workspace?: WorkspaceRecord
}

/**
 * Neutral authority capability. Every method mirrors a concrete route or
 * pull-flow call site; the shapes are the structural contract the core relies
 * on and the adapter must satisfy.
 */
/** Identity supplied only by authenticated channel ingress; authority resolves the linked actor afresh. */
export type ChannelMachineIdentity = { channel: string; externalUserId: string; threadKey: string }

/** The same identity carrying the binding generation the authority admitted it under. */
export type AuthorizedChannelIdentity = ChannelMachineIdentity & { identityVersion: number }

export type WorkspaceAuthority = OrgAccessAuthority & SessionShareAuthority & Partial<SessionReaderAuthority> & {
  /** Internal host delegation, answered only for the workspace's owner, whose actor the authority rechecks. */
  resolveRuntimeMachineAccess: (actorId: string, workspaceId: string) => Promise<RuntimeActorIdentity & { orgId: string; role: ProjectRole }>
  resolveChannelMachineAccess: (identity: ChannelMachineIdentity, workspaceId: string) => Promise<RuntimeActorIdentity & { orgId: string; role: ProjectRole; identityVersion: number }>
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
  /**
   * Admission for creating a workspace, asked before the billable work a
   * creation causes. `orgId` and `projectId` are the caller's selectors when
   * they named any; with neither, the adapter resolves the tenant its own
   * creation path would resolve and admits against that. An omitted selector
   * is a tenant the adapter derives, never an admission it skips, so a caller
   * cannot drop `orgId` to reach an unchecked create. Answers the organization
   * admitted against, which is the one the workspace will be placed for.
   *
   * Optional because an adapter that cannot answer it must not appear to: a
   * caller of a creation route refuses a signed create where this is absent
   * rather than provisioning unadmitted.
   */
  authorizeWorkspaceCreate?: (
    auth: SignedControlPlaneAuth,
    args: { orgId?: string; projectId?: string },
  ) => Promise<{ orgId: string }>
  openWorkspace: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<WorkspaceOpenResult>
  listWorkspaces: (auth: SignedControlPlaneAuth) => Promise<unknown>
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
   * May this caller have a machine serve this workspace, and would doing so
   * file a new row? The workspace half of `assignWorkspaceHost`, answered on
   * its own so a caller that must act before assigning — enrolling a machine,
   * claiming a serving generation — can be refused before it does.
   *
   * `assignWorkspaceHost` applies the same admission, so this is one policy
   * asked twice, not a second one. What it deliberately does NOT answer is
   * the machine half: enrollment liveness, serving scope and invitation
   * tenancy stay with the assignment, because a machine that is not enrolled
   * yet must still be able to share its first workspace.
   *
   * Optional on the port, never optional at a call site: a caller refuses the
   * share where this is unanswered rather than assuming the workspace is new.
   */
  authorizeWorkspaceHostAssignment?: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string; orgId?: string; projectId?: string },
  ) => Promise<WorkspaceHostAssignmentAdmission>
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
  /** Every unrevoked enrollment on the account, each with its state and its machine's assigned workspaces. */
  listHostDevices: (
    auth: SignedControlPlaneAuth,
  ) => Promise<HostDevice[]>
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
  /**
   * Owner only. The name the account sees for this machine on every device.
   *
   * A machine names itself at enrollment; this is how the owner overrides that
   * name afterwards, and it is the only field of an enrollment a person edits.
   */
  renameHostEnrollment?: (
    auth: SignedControlPlaneAuth,
    args: { enrollmentId: string; displayName: string },
  ) => Promise<{ enrollment_id: string; display_name: string }>
  listHostEnrollments?: (auth: SignedControlPlaneAuth) => Promise<HostEnrollmentListRow[]>
  /**
   * Owner only, and the whole host-management grant: the account that enrolled
   * a machine is the only one that may read what it can be sealed to or push
   * to it. There is no org-wide or team-wide form of either — an organization
   * groups people and grants nothing on a machine.
   */
  hostProviderConfigTarget?: (
    auth: SignedControlPlaneAuth,
    args: { enrollmentId: string },
  ) => Promise<HostProviderConfigTarget>
  /** Owner only. Writes ciphertext at `revision`, or a withdrawal; never sees a secret. */
  pushHostProviderConfig?: (
    auth: SignedControlPlaneAuth,
    args: HostProviderConfigPushInput,
  ) => Promise<{ enrollment_id: string; revision: number; sealed: boolean }>
  /** The caller's non-revoked enrollment of one machine, for a reader that needs one row and not the fleet. */
  hostEnrollmentByHost?: (
    auth: SignedControlPlaneAuth,
    args: { hostId: string },
  ) => Promise<Pick<HostEnrollmentListRow, "enrollment_id" | "host_id" | "enrolled_via"> | undefined>
  /** What `verifyMachineRequest` reads and consumes; absent, no route can admit a machine caller. */
  machineAuth?: MachineAuthAdapter
  deleteWorkspace: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<unknown>
  /** The machine a cloud workspace's next sandbox is created on; `null` returns it to the provider's default. */
  setWorkspaceMachineClass: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string; machineClass: SandboxMachineClass | null },
  ) => Promise<{ machine_class: SandboxMachineClass | null }>
  createCloudWorkspace: (auth: SignedControlPlaneAuth, args: CloudWorkspaceCreateArgs) => Promise<unknown>
  /**
   * A cloud workspace created for a person who did not sign the request: the
   * canonical actor a credential this control plane minted resolved to, as
   * `reserveRuntimeSession` takes one.
   *
   * Optional because only a deployment that resolves such credentials to an
   * owner can name one, and a caller holding none refuses the creation rather
   * than substituting a signed principal it does not have. `orgId` and
   * `projectId` are the resolved owner's, and the adapter holds the principal
   * to that project as strictly as it holds a signed creator.
   */
  createRuntimeCloudWorkspace?: (principal: PrivateSessionRuntimePrincipal, args: RuntimeCloudWorkspaceCreateArgs) => Promise<unknown>
  /** The undo of `createRuntimeCloudWorkspace`, as the same principal. */
  deleteRuntimeWorkspace?: (principal: PrivateSessionRuntimePrincipal, args: { workspaceId: string }) => Promise<unknown>

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
  createOrg?: (auth: SignedControlPlaneAuth, args: { name: string }) => Promise<unknown>
  listSessions: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) => Promise<AuthoritySessionInventoryRow[]>
  listSessionPage: (auth: SignedControlPlaneAuth, args: SessionPageQuery) => Promise<AuthoritySessionInventoryRow[]>
  publishHostSessionRows?: HostSessionRowsAuthority["publishHostSessionRows"]
  resolveSession?: (auth: SignedControlPlaneAuth, args: { sessionId: string }) => Promise<unknown>
  readSessionMessages: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; limit?: number; before?: string; view?: LatestView },
  ) => Promise<unknown>
  /** The session's row as `listSessions` lists it, its outline and, with `firstPage`, its first page; nothing when the reader cannot read it. */
  readSessionFirstRead: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; firstPage?: TurnPageRequest },
  ) => Promise<FirstRead<AuthoritySessionInventoryRow> | undefined>
  /** The turns before `page.before`, read and projected as the first page is; nothing when the reader cannot read the session. */
  readSessionPage: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; page: TurnPageQuery & { before: string } },
  ) => Promise<TurnPage | undefined>
  /** One part of one of the session's messages whole, `{}` when there is no such part; nothing when the reader cannot read the session. */
  readSessionPart: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; messageId: string; partId: string },
  ) => Promise<{ part?: AgentContentPart } | undefined>
  syncSessionMessages: PrivateSessionAuthority["syncSessionMessages"]
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
  /**
   * The account a machine's own session usage is attributed to: the actor of
   * the session's latest turn, else the creator the session registered under.
   * The metering path holds no caller auth — this takes none and answers from
   * the authority's own records — and a session it cannot place resolves to
   * no owner rather than a guessed one.
   *
   * Optional because only a deployment whose authority records runtime
   * producers can answer it; a composition without one writes the fact
   * unowned rather than attributing it to whoever asks next.
   */
  resolveSessionUsageOwner?: (
    args: { sessionId: string },
  ) => Promise<{ org_id: string; user_id: string } | undefined>
  /**
   * The account a reported cloud turn's usage is attributed to: the actor the
   * runtime admitted for `turnId` on `sessionId`. No owner when the session
   * admitted no such turn, the actor has no account, or the session's
   * workspace is not a live cloud workspace — only a cloud VM reports usage to
   * the plane, and a machine keeps its own.
   */
  resolveCloudTurnUsageOwner?: (
    args: { sessionId: string; turnId: string },
  ) => Promise<{ org_id: string; user_id: string } | undefined>

  // runtime tokens
  /** Without `sessionId` the token reaches the workspace and is its owner's; with one it is a viewer's for that session alone. */
  recordRuntimeAccessToken: (
    auth: SignedControlPlaneAuth,
    args: {
      jti: string
      workspaceId: string
      hostId: string
      actorId: string
      actorKind: "human" | "agent"
      role: "viewer" | "editor" | "admin" | "owner"
      sessionId?: string
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
  runtimeAccessTokenActive: (args: { jti: string; workspaceId: string; hostId: string }) => Promise<unknown>
  revokeRuntimeAccessToken: (
    auth: SignedControlPlaneAuth,
    args: { jti: string; workspaceId: string },
  ) => Promise<unknown>
  revokeRuntimeAccessTokensForWorkspaceUser: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) => Promise<unknown>

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
