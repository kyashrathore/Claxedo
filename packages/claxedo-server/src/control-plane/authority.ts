import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "./auth"
import type { ControlPlaneServices } from "./services"

/**
 * Typed neutral authority port for the control plane.
 *
 * This is the seam the generic control-plane core owns: routes and pull flows
 * depend on this capability, not on any particular authority storage. Claxedo's
 * storage-backed implementation lives behind `control-plane/adapters/*` and
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
  }) => Promise<AuthorizeProjectResult>
  authorizeChannelWorkspace: (args: {
    channel: string
    externalUserId: string
    threadKey: string
    workspaceId: string
    action: ProjectAction
  }) => Promise<void>

  // workspaces
  authorizeWorkspaceOpen: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<void>
  openWorkspace: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<WorkspaceOpenResult>
  listWorkspaces: (auth: SignedControlPlaneAuth) => Promise<unknown>
  registerLocalForSharing: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
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
    | { active: true; host_id: string; workspace_id: string; expires_at: number; last_seen_at: number }
    | { active: false }
  >
  deleteWorkspace: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<unknown>
  createCloudWorkspace: (
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
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
    },
  ) => Promise<unknown>

  // sessions
  authorizeSessionRead: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string },
  ) => Promise<void>
  listSessions: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<unknown>
  resolveSession?: (auth: SignedControlPlaneAuth, args: { sessionId: string }) => Promise<unknown>
  readSessionMessages: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string },
  ) => Promise<unknown>
  syncSessionMessages: (
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      messages: unknown[]
      intakeReady?: boolean
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
      expiresAt: number
    },
  ) => Promise<unknown>
  recordRuntimeAccessTokenForService: (args: {
    jti: string
    workspaceId: string
    hostId: string
    subject: string
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
export function requireAuthority(services: ControlPlaneServices | undefined): WorkspaceAuthority {
  if (services?.authority) return services.authority
  throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Workspace authority is not configured")
}
