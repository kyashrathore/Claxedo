import type { SignedControlPlaneAuth } from "./auth"

export type OrgMemberRole = "member" | "admin" | "owner"
export type ProjectGrantRole = "viewer" | "editor" | "admin"

export function isOrgMemberRole(value: unknown): value is OrgMemberRole {
  return value === "member" || value === "admin" || value === "owner"
}

export function isProjectGrantRole(value: unknown): value is ProjectGrantRole {
  return value === "viewer" || value === "editor" || value === "admin"
}

/** One person by exactly one of these: their public id, a verified email, a provider token identifier, or a provider subject. */
export type MemberSelector = {
  userPublicId?: string
  email?: string
  tokenIdentifier?: string
  providerSubject?: string
}

/** Finds an existing account by its verified email address, for deployments whose identity provider holds one. */
export type FindAccountByEmail = (email: string) => Promise<{ tokenIdentifier: string } | undefined>

export type OrgMember = { user_id: string; public_id: string; role: OrgMemberRole; joined_at: number }

export type OrgMemberRemoval = {
  removed: boolean
  team_memberships_revoked: number
  project_memberships_revoked: number
  session_shares_revoked: number
  session_participations_revoked: number
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
    args: MemberSelector & { teamId: string; role?: OrgMemberRole },
  ) => Promise<unknown>
  removeTeamMember?: (auth: SignedControlPlaneAuth, args: MemberSelector & { teamId: string }) => Promise<unknown>
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
  addOrgMember?: (
    auth: SignedControlPlaneAuth,
    args: MemberSelector & { orgId: string; role: OrgMemberRole },
  ) => Promise<OrgMember>
  updateOrgMember?: (
    auth: SignedControlPlaneAuth,
    args: { orgId: string; userPublicId: string; role: OrgMemberRole },
  ) => Promise<OrgMember>
  removeOrgMember?: (auth: SignedControlPlaneAuth, args: { orgId: string; userPublicId: string }) => Promise<OrgMemberRemoval>
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
