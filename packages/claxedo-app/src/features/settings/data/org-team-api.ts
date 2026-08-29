import { authFetch } from "@/platform/api/api"

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

export async function listOrgs() {
  return json<OrgListItem[]>(await authFetch("/api/control/orgs"))
}

export async function createOrg(name: string) {
  return json<{ org_id: string; name: string; default_team_id?: string }>(await authFetch("/api/control/orgs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }))
}

export async function listTeams(orgId: string) {
  return json<TeamListItem[]>(await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/teams`))
}

export async function createTeam(orgId: string, name: string) {
  return json<{ team_id: string; name: string }>(await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/teams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }))
}

export async function ensureDefaultTeam(orgId: string) {
  return json<unknown>(await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/ensure-default-team`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }))
}

export async function listTeamMembers(teamId: string) {
  return json<TeamMember[]>(await authFetch(`/api/control/teams/${encodeURIComponent(teamId)}/members`))
}

export async function addTeamMember(input: {
  teamId: string
  tokenIdentifier?: string
  clerkSubject?: string
  userPublicId?: string
  role?: "member" | "admin" | "owner"
}) {
  return json<unknown>(await authFetch(`/api/control/teams/${encodeURIComponent(input.teamId)}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(input.tokenIdentifier ? { tokenIdentifier: input.tokenIdentifier } : {}),
      ...(input.clerkSubject ? { clerkSubject: input.clerkSubject } : {}),
      ...(input.userPublicId ? { userPublicId: input.userPublicId } : {}),
      ...(input.role ? { role: input.role } : {}),
    }),
  }))
}

export async function removeTeamMember(input: {
  teamId: string
  tokenIdentifier?: string
  userPublicId?: string
}) {
  return json<unknown>(await authFetch(`/api/control/teams/${encodeURIComponent(input.teamId)}/members`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(input.tokenIdentifier ? { tokenIdentifier: input.tokenIdentifier } : {}),
      ...(input.userPublicId ? { userPublicId: input.userPublicId } : {}),
    }),
  }))
}

export async function grantTeamProject(input: {
  teamId: string
  projectId: string
  role: "viewer" | "editor" | "admin"
}) {
  return json<unknown>(await authFetch(`/api/control/teams/${encodeURIComponent(input.teamId)}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: input.projectId, role: input.role }),
  }))
}
