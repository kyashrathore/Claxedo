import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "./auth"

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

type BrandedString<T extends string> = string & { readonly __brand: T }

export type OrgId = BrandedString<"OrgId">
export type ProjectId = BrandedString<"ProjectId">
export type WorkspaceId = BrandedString<"WorkspaceId">
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

/**
 * Canonical recipient identity resolved by the authority before a session
 * share is revoked. Routes use this target for recipient doorbells, including
 * grant-id-only revokes whose request body carries no recipient selector.
 */
export type SessionShareFanoutTarget = {
  grantedToTokenIdentifier?: string
  grantedToClerkSubject?: string
  grantedToUserId?: string
  grantedToClerkOrgId?: string
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
export type WorkspaceAuthority = {
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
  createLocalHostLinkChallenge: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      hostId: string
    },
  ) => Promise<{ challenge_id: string; nonce: string; expires_at: number }>
  registerLocalHostLink: (
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
  ) => Promise<unknown>
  heartbeatLocalHostLink: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      hostId: string
      signature: string
      ttlMs?: number
    },
  ) => Promise<unknown>
  pauseLocalHostLink: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      hostId?: string
      paused: boolean
    },
  ) => Promise<unknown>
  activeLocalHostLink: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) => Promise<
    | { active: true; host_id: string; workspace_id: string; display_name?: string; second_device_open_at?: number; expires_at: number; last_seen_at: number }
    | { active: false }
  >
  // --- machine-wide enrollment (Unit 6) ------------------------------------
  //
  // The same four verbs as the local-host-link methods above, with the
  // workspace removed from every one of them. That absence IS the feature: a
  // laptop is enrolled once, and which workspaces a session may reach is
  // decided at request time from the workspace tables rather than frozen into a
  // registration row per project.
  //
  // Optional on the port while both authorities are being built out; Unit 6's
  // hard cut removes the legacy methods and makes these required.
  createHostEnrollmentRequest?: (
    auth: SignedControlPlaneAuth,
    args: { hostId: string },
  ) => Promise<{ request_id: string; nonce: string; expires_at: number }>
  enrollHost?: (
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
  heartbeatHostEnrollment?: (
    auth: SignedControlPlaneAuth,
    args: { hostId: string; signature: string; ttlMs?: number },
  ) => Promise<{ expires_at: number; last_seen_at: number }>
  pauseHostEnrollment?: (
    auth: SignedControlPlaneAuth,
    args: { hostId?: string; paused: boolean },
  ) => Promise<{ paused: boolean }>
  activeHostEnrollment?: (
    auth: SignedControlPlaneAuth,
    args?: Record<string, never>,
  ) => Promise<HostEnrollmentState>
  markSecondDeviceOpen?: (
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
      grantedToTokenIdentifier?: string
      grantedToClerkSubject?: string
      grantedToClerkOrgId?: string
      grantedToTeamId?: string
      grantedToTeamPublicId?: string
    },
  ) => Promise<unknown>
  revokeWorkspaceShare: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      grantId?: string
      grantedToTokenIdentifier?: string
      grantedToClerkSubject?: string
      grantedToClerkOrgId?: string
      grantedToTeamId?: string
      grantedToTeamPublicId?: string
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
  authorizeRuntimeSession?: (args: {
    actorId: string
    actorKind: "human" | "agent"
    sessionId: string
    workspaceId: string
    action: "read" | "write"
  }) => Promise<void>
  registerRuntimeSession?: (args: {
    actorId: string
    actorKind: "human" | "agent"
    sessionId: string
    workspaceId: string
    title?: string
  }) => Promise<unknown>
  addSessionParticipant: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; participantTokenIdentifier: string },
  ) => Promise<unknown>
  removeSessionParticipant: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; participantTokenIdentifier: string },
  ) => Promise<unknown>
  grantSessionShare?: (
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      grantedToTokenIdentifier?: string
      grantedToClerkSubject?: string
      grantedToUserId?: string
      grantedToClerkOrgId?: string
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
      grantedToClerkSubject?: string
      grantedToUserId?: string
      grantedToClerkOrgId?: string
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
      clerkSubject?: string
      userPublicId?: string
      role?: "member" | "admin" | "owner"
    },
  ) => Promise<unknown>
  removeTeamMember?: (
    auth: SignedControlPlaneAuth,
    args: {
      teamId: string
      tokenIdentifier?: string
      clerkSubject?: string
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
  runtimeAccessTokenActive: (args: { jti: string; workspaceId: string; hostId: string }) => Promise<unknown>
  revokeRuntimeAccessToken: (
    auth: SignedControlPlaneAuth,
    args: { jti: string; workspaceId: string },
  ) => Promise<unknown>
  revokeRuntimeAccessTokensForWorkspaceUser: (
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) => Promise<unknown>

  // agent extensions
  listWorkspaceAgentExtensions: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<unknown>
  listWorkspaceAgentExtensionsForRuntime: (args: { workspaceId: string }) => Promise<unknown>
  authorizeWorkspaceAgentExtensionsAdmin: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<void>
  upsertWorkspaceAgentExtension: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      extensionId: string
      packageName: string
      desired: unknown
      lock: unknown
    },
  ) => Promise<unknown>
  setWorkspaceAgentExtensionEnabled: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      extensionId: string
      enabled: boolean
    },
  ) => Promise<unknown>
  deleteWorkspaceAgentExtension: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      extensionId: string
    },
  ) => Promise<unknown>
  listAgentExtensionPolicyOverrides: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<unknown>
  listAgentExtensionPolicyOverridesForRuntime: (args: { workspaceId: string }) => Promise<unknown>
  setAgentExtensionPolicyOverride: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      extensionId: string
      scope: "org" | "user" | "workspace"
      enabled: boolean
      reason?: string
    },
  ) => Promise<unknown>
  deleteAgentExtensionPolicyOverride: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      extensionId: string
      scope: "org" | "user" | "workspace"
    },
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

/**
 * Resolve the configured authority or fail closed. This is the single
 * authority-required helper; it subsumes the copy-pasted per-route helpers that
 * previously guarded authority access in five route modules.
 */
export function requireAuthority(services: { authority?: WorkspaceAuthority } | undefined): WorkspaceAuthority {
  if (services?.authority) return services.authority
  throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Workspace authority is not configured")
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
