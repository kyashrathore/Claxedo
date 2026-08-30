import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { hostedControlCall } from "@/platform/account/hosted-control-call"
import { controlSessionUrl } from "@/platform/runtime/agent/workspace-control-routes"

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
  return hostedControlCall(
    "org.teams.list",
    { orgId },
    async () => json<Array<{ team_id: string; name: string }>>(
      await authFetch(`/api/control/orgs/${encodeURIComponent(orgId)}/teams`),
    ),
  )
}

export async function listSessionShares(sessionId: string, workspaceId: string) {
  return hostedControlCall(
    "session.shares.list",
    { sessionId, workspaceId },
    async () => json<{
      grants: Array<{
        grant_id: string
        granted_to_user_id?: string
        granted_to_org_id?: string
        granted_to_team_id?: string
      }>
      participants: Array<{ user_id: string }>
    }>(await authFetch(controlSessionUrl({
      baseUrl: getClaxedoServerUrl(),
      sessionID: sessionId,
      suffix: "/shares",
      workspaceId,
    }))),
  )
}

export async function grantSessionShare(input: {
  sessionId: string
  workspaceId: string
  grantedToTokenIdentifier?: string
  grantedToTeamPublicId?: string
  grantedToOrgId?: string
}) {
  return hostedControlCall(
    "session.shares.grant",
    {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      ...(input.grantedToTokenIdentifier ? { grantedToTokenIdentifier: input.grantedToTokenIdentifier } : {}),
      ...(input.grantedToTeamPublicId ? { grantedToTeamPublicId: input.grantedToTeamPublicId } : {}),
      ...(input.grantedToOrgId ? { grantedToOrgId: input.grantedToOrgId } : {}),
    },
    async () => json<unknown>(await authFetch(controlSessionUrl({
      baseUrl: getClaxedoServerUrl(),
      sessionID: input.sessionId,
      suffix: "/shares",
    }), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        ...(input.grantedToTokenIdentifier ? { grantedToTokenIdentifier: input.grantedToTokenIdentifier } : {}),
        ...(input.grantedToTeamPublicId ? { grantedToTeamPublicId: input.grantedToTeamPublicId } : {}),
        ...(input.grantedToOrgId ? { grantedToOrgId: input.grantedToOrgId } : {}),
      }),
    })),
  )
}

export async function revokeSessionShare(input: {
  sessionId: string
  workspaceId: string
  grantId?: string
  grantedToTokenIdentifier?: string
  grantedToTeamPublicId?: string
}) {
  return hostedControlCall(
    "session.shares.revoke",
    {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.grantedToTokenIdentifier ? { grantedToTokenIdentifier: input.grantedToTokenIdentifier } : {}),
      ...(input.grantedToTeamPublicId ? { grantedToTeamPublicId: input.grantedToTeamPublicId } : {}),
    },
    async () => json<unknown>(await authFetch(controlSessionUrl({
      baseUrl: getClaxedoServerUrl(),
      sessionID: input.sessionId,
      suffix: "/shares",
    }), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        ...(input.grantId ? { grantId: input.grantId } : {}),
        ...(input.grantedToTokenIdentifier ? { grantedToTokenIdentifier: input.grantedToTokenIdentifier } : {}),
        ...(input.grantedToTeamPublicId ? { grantedToTeamPublicId: input.grantedToTeamPublicId } : {}),
      }),
    })),
  )
}

export async function addSessionParticipant(input: {
  sessionId: string
  workspaceId: string
  participantTokenIdentifier: string
}) {
  return hostedControlCall(
    "session.participants.add",
    {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      participantTokenIdentifier: input.participantTokenIdentifier,
    },
    async () => json<unknown>(await authFetch(controlSessionUrl({
      baseUrl: getClaxedoServerUrl(),
      sessionID: input.sessionId,
      suffix: "/participants",
    }), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        participantTokenIdentifier: input.participantTokenIdentifier,
      }),
    })),
  )
}
