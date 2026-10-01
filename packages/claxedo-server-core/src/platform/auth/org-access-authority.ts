import type { SignedControlPlaneAuth } from "./auth"

export type OrgMemberRole = "member" | "admin" | "owner"
export type ProjectGrantRole = "viewer" | "editor" | "admin"

export function isOrgMemberRole(value: unknown): value is OrgMemberRole {
  return value === "member" || value === "admin" || value === "owner"
}

export function isProjectGrantRole(value: unknown): value is ProjectGrantRole {
  return value === "viewer" || value === "editor" || value === "admin"
}

export type TeamMemberSelector = {
  userPublicId?: string
  tokenIdentifier?: string
  providerSubject?: string
}

export type OrgInvitation = {
  id: string
  org_id: string
  email: string
  role: OrgMemberRole
  invited_by: string
  created_at: number
  expires_at: number
  accepted_at: number | null
  revoked_at: number | null
}

export type OrgInvitationDelivery = {
  sendInvitation?: (input: { email: string; token: string }) => Promise<void>
  verifiedEmail: (auth: SignedControlPlaneAuth) => Promise<string | undefined>
}

export type OrgMember = { user_id: string; public_id: string; role: OrgMemberRole; joined_at: number }

export type OrgMemberRemoval = {
  removed: boolean
  team_memberships_revoked: number
  project_memberships_revoked: number
  session_shares_revoked: number
  runtime_tokens_revoked: number
}

export type ProjectMemberGrant = { project_id: string; user_id: string; role: ProjectGrantRole }

/** Why a person or team reaches a project: its owner, a member grant, a team grant, or their organization role. */
export type ProjectAccessSource = "owner" | "member" | `team:${string}` | "org-role"

export type ProjectAccessEntry =
  | { kind: "user"; user_id: string; role: "viewer" | "editor" | "admin" | "owner"; source: ProjectAccessSource }
  | { kind: "team"; team_id: string; name: string; role: ProjectGrantRole; source: `team:${string}` }

export type ProjectAccessListing = { project_id: string; org_id: string; entries: ProjectAccessEntry[] }

/**
 * Who belongs to an organization, its teams, and who reaches its projects.
 * Every method is optional: an authority that stores none of this leaves it
 * absent, and the routes answer `not_implemented` for it.
 */
export type OrgAccessAuthority = {
  listTeams?: (auth: SignedControlPlaneAuth, args: { orgId: string }) => Promise<unknown>
  createTeamInOrg?: (auth: SignedControlPlaneAuth, args: { orgId: string; name: string }) => Promise<unknown>
  addTeamMember?: (
    auth: SignedControlPlaneAuth,
    args: TeamMemberSelector & { teamId: string; role?: OrgMemberRole },
  ) => Promise<unknown>
  removeTeamMember?: (auth: SignedControlPlaneAuth, args: TeamMemberSelector & { teamId: string }) => Promise<unknown>
  listTeamMembers?: (auth: SignedControlPlaneAuth, args: { teamId: string }) => Promise<unknown>
  grantTeamProject?: (
    auth: SignedControlPlaneAuth,
    args: { teamId: string; projectId: string; role: ProjectGrantRole },
  ) => Promise<unknown>
  revokeTeamProject?: (auth: SignedControlPlaneAuth, args: { teamId: string; projectId: string }) => Promise<unknown>
  listTeamProjects?: (
    auth: SignedControlPlaneAuth,
    args: { teamId: string },
  ) => Promise<Array<{ team_id: string; project_id: string; role: ProjectGrantRole; updated_at: number }>>
  ensureDefaultTeam?: (auth: SignedControlPlaneAuth, args: { orgId: string }) => Promise<unknown>
  listOrgMembers?: (auth: SignedControlPlaneAuth, args: { orgId: string }) => Promise<OrgMember[]>
  createOrgInvitation?: (
    auth: SignedControlPlaneAuth,
    args: { orgId: string; email: string; role: OrgMemberRole },
  ) => Promise<void>
  listOrgInvitations?: (auth: SignedControlPlaneAuth, args: { orgId: string }) => Promise<OrgInvitation[]>
  revokeOrgInvitation?: (
    auth: SignedControlPlaneAuth,
    args: { orgId: string; invitationId: string },
  ) => Promise<{ revoked: boolean }>
  acceptOrgInvitation?: (auth: SignedControlPlaneAuth, args: { token: string }) => Promise<OrgMember>
  updateOrgMember?: (
    auth: SignedControlPlaneAuth,
    args: { orgId: string; userPublicId: string; role: OrgMemberRole },
  ) => Promise<OrgMember>
  removeOrgMember?: (
    auth: SignedControlPlaneAuth,
    args: { orgId: string; userPublicId: string },
  ) => Promise<OrgMemberRemoval>
  grantProjectMember?: (
    auth: SignedControlPlaneAuth,
    args: { projectId: string; userPublicId: string; role: ProjectGrantRole },
  ) => Promise<ProjectMemberGrant>
  revokeProjectMember?: (
    auth: SignedControlPlaneAuth,
    args: { projectId: string; userPublicId: string },
  ) => Promise<{ revoked: boolean }>
  listProjectAccess?: (auth: SignedControlPlaneAuth, args: { projectId: string }) => Promise<ProjectAccessListing>
}
