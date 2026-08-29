import { authFetch } from "@/platform/api/api"

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(body.error?.message ?? `Request failed (${res.status})`)
  }
  return await res.json() as T
}

const ACTIVE_ORG_KEY = "claxedo.activeOrgId"

export function readActiveOrgId() {
  return localStorage.getItem(ACTIVE_ORG_KEY) ?? undefined
}

export async function listTeamsForActiveOrg() {
  const orgId = readActiveOrgId()
  if (!orgId) return [] as Array<{ team_id: string; name: string }>
  return json<Array<{ team_id: string; name: string }>>(
    await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/teams`),
  )
}

export async function listSessionShares(sessionId: string, workspaceId: string) {
  return json<{
    grants: Array<{
      grant_id: string
      granted_to_user_id?: string
      granted_to_org_id?: string
      granted_to_team_id?: string
    }>
    participants: Array<{ user_id: string }>
  }>(await authFetch(`/api/control/sessions/${encodeURIComponent(sessionId)}/shares?workspaceId=${encodeURIComponent(workspaceId)}`))
}

export async function grantSessionShare(input: {
  sessionId: string
  workspaceId: string
  grantedToTokenIdentifier?: string
  grantedToTeamPublicId?: string
  grantedToOrgId?: string
}) {
  return json<unknown>(await authFetch(`/api/control/sessions/${encodeURIComponent(input.sessionId)}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      ...(input.grantedToTokenIdentifier ? { grantedToTokenIdentifier: input.grantedToTokenIdentifier } : {}),
      ...(input.grantedToTeamPublicId ? { grantedToTeamPublicId: input.grantedToTeamPublicId } : {}),
      ...(input.grantedToOrgId ? { grantedToOrgId: input.grantedToOrgId } : {}),
    }),
  }))
}

export async function revokeSessionShare(input: {
  sessionId: string
  workspaceId: string
  grantId?: string
  grantedToTokenIdentifier?: string
  grantedToTeamPublicId?: string
}) {
  return json<unknown>(await authFetch(`/api/control/sessions/${encodeURIComponent(input.sessionId)}/shares`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.grantedToTokenIdentifier ? { grantedToTokenIdentifier: input.grantedToTokenIdentifier } : {}),
      ...(input.grantedToTeamPublicId ? { grantedToTeamPublicId: input.grantedToTeamPublicId } : {}),
    }),
  }))
}

export async function addSessionParticipant(input: {
  sessionId: string
  workspaceId: string
  participantTokenIdentifier: string
}) {
  return json<unknown>(await authFetch(`/api/control/sessions/${encodeURIComponent(input.sessionId)}/participants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      participantTokenIdentifier: input.participantTokenIdentifier,
    }),
  }))
}
