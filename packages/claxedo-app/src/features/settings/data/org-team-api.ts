import { authFetch } from "@/platform/api/api"
import { hostedControlCall } from "@/platform/account/hosted-control-call"

export type OrgListItem = {
  org_id: string
  clerk_org_id?: string
  slug?: string
  name: string
  role: string
}

export type TeamListItem = {
  team_id: string
  org_id: string
  name: string
  is_default?: boolean
}

export type TeamMember = {
  user_id: string
  public_id?: string
  display_name?: string
  email?: string
  token_identifier?: string
  role: string
}

const ACTIVE_ORG_KEY = "claxedo.activeOrgId"
const ACTIVE_TEAM_KEY = "claxedo.activeTeamId"

export function readActiveOrgId() {
  return localStorage.getItem(ACTIVE_ORG_KEY) ?? undefined
}

export function writeActiveOrgId(orgId: string | undefined) {
  if (!orgId) localStorage.removeItem(ACTIVE_ORG_KEY)
  else localStorage.setItem(ACTIVE_ORG_KEY, orgId)
}

export function readActiveTeamId() {
  return localStorage.getItem(ACTIVE_TEAM_KEY) ?? undefined
}

export function writeActiveTeamId(teamId: string | undefined) {
  if (!teamId) localStorage.removeItem(ACTIVE_TEAM_KEY)
  else localStorage.setItem(ACTIVE_TEAM_KEY, teamId)
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(body.error?.message ?? `Request failed (${res.status})`)
  }
  return await res.json() as T
}

/**
 * Desktop signed mode: renderer has no bearer. Named AccountPort ops reach the
 * hosted control plane through Electron main. Browser signed mode keeps
 * authFetch against `VITE_CLAXEDO_SERVER_URL`.
 */

export async function listOrgs() {
  return hostedControlCall(
    "org.list",
    {},
    async () => json<OrgListItem[]>(await authFetch("/api/control/orgs")),
  )
}

export async function createOrg(name: string) {
  return hostedControlCall(
    "org.create",
    { name },
    async () => json<{ org_id: string; name: string; default_team_id?: string }>(
      await authFetch("/api/control/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    ),
  )
}

export async function listTeams(orgId: string) {
  return hostedControlCall(
    "org.teams.list",
    { orgId },
    async () => json<TeamListItem[]>(
      await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/teams`),
    ),
  )
}

export async function createTeam(orgId: string, name: string) {
  return hostedControlCall(
    "org.teams.create",
    { orgId, name },
    async () => json<{ team_id: string; name: string }>(
      await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/teams`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    ),
  )
}

export async function ensureDefaultTeam(orgId: string) {
  return hostedControlCall(
    "org.ensureDefaultTeam",
    { orgId },
    async () => json<unknown>(
      await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/ensure-default-team`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ),
  )
}

export async function listTeamMembers(teamId: string) {
  return hostedControlCall(
    "team.members.list",
    { teamId },
    async () => json<TeamMember[]>(
      await authFetch(`/api/control/teams/${encodeURIComponent(teamId)}/members`),
    ),
  )
}

export async function addTeamMember(input: {
  teamId: string
  tokenIdentifier?: string
  clerkSubject?: string
  userPublicId?: string
  role?: "member" | "admin" | "owner"
}) {
  return hostedControlCall(
    "team.members.add",
    {
      teamId: input.teamId,
      ...(input.tokenIdentifier ? { tokenIdentifier: input.tokenIdentifier } : {}),
      ...(input.clerkSubject ? { clerkSubject: input.clerkSubject } : {}),
      ...(input.userPublicId ? { userPublicId: input.userPublicId } : {}),
      ...(input.role ? { role: input.role } : {}),
    },
    async () => json<unknown>(await authFetch(`/api/control/teams/${encodeURIComponent(input.teamId)}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(input.tokenIdentifier ? { tokenIdentifier: input.tokenIdentifier } : {}),
        ...(input.clerkSubject ? { clerkSubject: input.clerkSubject } : {}),
        ...(input.userPublicId ? { userPublicId: input.userPublicId } : {}),
        ...(input.role ? { role: input.role } : {}),
      }),
    })),
  )
}

export async function removeTeamMember(input: {
  teamId: string
  tokenIdentifier?: string
  userPublicId?: string
}) {
  return hostedControlCall(
    "team.members.remove",
    {
      teamId: input.teamId,
      ...(input.tokenIdentifier ? { tokenIdentifier: input.tokenIdentifier } : {}),
      ...(input.userPublicId ? { userPublicId: input.userPublicId } : {}),
    },
    async () => json<unknown>(await authFetch(`/api/control/teams/${encodeURIComponent(input.teamId)}/members`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(input.tokenIdentifier ? { tokenIdentifier: input.tokenIdentifier } : {}),
        ...(input.userPublicId ? { userPublicId: input.userPublicId } : {}),
      }),
    })),
  )
}

export async function grantTeamProject(input: {
  teamId: string
  projectId: string
  role: "viewer" | "editor" | "admin"
}) {
  return hostedControlCall(
    "team.projects.grant",
    {
      teamId: input.teamId,
      projectId: input.projectId,
      role: input.role,
    },
    async () => json<unknown>(await authFetch(`/api/control/teams/${encodeURIComponent(input.teamId)}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: input.projectId, role: input.role }),
    })),
  )
}
