import z from "zod"
import { authFetch } from "@/platform/api/api"
import { hostedControlCall } from "@/platform/account/hosted-control-call"
import { readField, readString } from "@/lib/record"

export type OrgListItem = {
  org_id: string
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

/**
 * Wire schemas for the three list shapes above.
 *
 * Every function here answers through `hostedControlCall`, which has two
 * producers: the hosted operation's decoder in `HOSTED_OPERATIONS` (`array`
 * for the lists — it proves an array and nothing about the rows) and a raw
 * `authFetch` body. Neither produces an `OrgListItem` until something parses
 * one, and the readers in `org-team-section` and `rail-org-team-switcher` index
 * `name`, `role` and the ids directly. The `z.ZodType<…>` annotations tie each
 * schema to the exported type, so the two cannot drift apart silently.
 */
const OrgListItemSchema: z.ZodType<OrgListItem> = z.object({
  org_id: z.string(),
  slug: z.string().optional(),
  name: z.string(),
  role: z.string(),
})

const TeamListItemSchema: z.ZodType<TeamListItem> = z.object({
  team_id: z.string(),
  org_id: z.string(),
  name: z.string(),
  is_default: z.boolean().optional(),
})

const TeamMemberSchema: z.ZodType<TeamMember> = z.object({
  user_id: z.string(),
  public_id: z.string().optional(),
  display_name: z.string().optional(),
  email: z.string().optional(),
  token_identifier: z.string().optional(),
  role: z.string(),
})

const CreatedOrgSchema = z.object({
  org_id: z.string(),
  name: z.string(),
  default_team_id: z.string().optional(),
})

const CreatedTeamSchema = z.object({ team_id: z.string(), name: z.string() })

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

/**
 * The route body, unchecked.
 *
 * This used to hand back a caller-named `T` — an annotation over `res.json()`,
 * which is `any`, so the contract type was asserted rather than established.
 * The schemas above do that job now, on the branch-agnostic result, which is
 * the only place both producers meet.
 */
async function json(res: Response): Promise<unknown> {
  if (!res.ok) {
    const message = readString(readField(await res.json().catch(() => undefined), "error"), "message")
    throw new Error(message ?? `Request failed (${res.status})`)
  }
  return await res.json()
}

/**
 * Desktop signed mode: renderer has no bearer. Named AccountPort ops reach the
 * hosted control plane through Electron main. Browser signed mode keeps
 * authFetch against `VITE_CLAXEDO_SERVER_URL`.
 */

export async function listOrgs() {
  return z.array(OrgListItemSchema).parse(await hostedControlCall(
    "org.list",
    {},
    async () => json(await authFetch("/api/control/orgs")),
  ))
}

export async function createOrg(name: string) {
  return CreatedOrgSchema.parse(await hostedControlCall(
    "org.create",
    { name },
    async () => json(
      await authFetch("/api/control/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    ),
  ))
}

export async function listTeams(orgId: string) {
  return z.array(TeamListItemSchema).parse(await hostedControlCall(
    "org.teams.list",
    { orgId },
    async () => json(
      await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/teams`),
    ),
  ))
}

export async function createTeam(orgId: string, name: string) {
  return CreatedTeamSchema.parse(await hostedControlCall(
    "org.teams.create",
    { orgId, name },
    async () => json(
      await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/teams`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    ),
  ))
}

export async function ensureDefaultTeam(orgId: string) {
  return hostedControlCall(
    "org.ensureDefaultTeam",
    { orgId },
    async () => json(
      await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/ensure-default-team`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ),
  )
}

export async function listTeamMembers(teamId: string) {
  return z.array(TeamMemberSchema).parse(await hostedControlCall(
    "team.members.list",
    { teamId },
    async () => json(
      await authFetch(`/api/control/teams/${encodeURIComponent(teamId)}/members`),
    ),
  ))
}

export async function addTeamMember(input: {
  teamId: string
  tokenIdentifier?: string
  providerSubject?: string
  userPublicId?: string
  role?: "member" | "admin" | "owner"
}) {
  return hostedControlCall(
    "team.members.add",
    {
      teamId: input.teamId,
      ...(input.tokenIdentifier ? { tokenIdentifier: input.tokenIdentifier } : {}),
      ...(input.providerSubject ? { providerSubject: input.providerSubject } : {}),
      ...(input.userPublicId ? { userPublicId: input.userPublicId } : {}),
      ...(input.role ? { role: input.role } : {}),
    },
    async () => json(await authFetch(`/api/control/teams/${encodeURIComponent(input.teamId)}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(input.tokenIdentifier ? { tokenIdentifier: input.tokenIdentifier } : {}),
        ...(input.providerSubject ? { providerSubject: input.providerSubject } : {}),
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
    async () => json(await authFetch(`/api/control/teams/${encodeURIComponent(input.teamId)}/members`, {
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
    async () => json(await authFetch(`/api/control/teams/${encodeURIComponent(input.teamId)}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: input.projectId, role: input.role }),
    })),
  )
}
