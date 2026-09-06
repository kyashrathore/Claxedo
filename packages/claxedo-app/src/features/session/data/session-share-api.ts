import z from "zod"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { readField, readString } from "@/lib/record"
import { hostedControlCall } from "@/platform/account/hosted-control-call"
import { controlSessionUrl } from "@/platform/runtime/agent/workspace-control-routes"

/**
 * Read a control-plane response body.
 *
 * The caller states the shape as a schema rather than a type argument: the body
 * is JSON off the wire, and a bare `as T` claimed a shape nothing had checked.
 * Zod is already this app's boundary parser (see `features/processes/data`).
 */
async function json<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}))
    throw new Error(readString(readField(body, "error"), "message") ?? `Request failed (${res.status})`)
  }
  return schema.parse(await res.json())
}

const SessionPeopleContextSchema = z.object({
  can_manage_shares: z.boolean(),
  grants: z.array(z.object({
    grant_id: z.string(),
    granted_to_user_id: z.string().optional(),
    granted_to_org_id: z.string().optional(),
    granted_to_team_id: z.string().optional(),
  })),
  participants: z.array(z.object({ user_id: z.string() })),
  teams: z.array(z.object({ team_id: z.string(), name: z.string(), is_shared: z.boolean() })),
})

export type SessionPeopleContext = z.infer<typeof SessionPeopleContextSchema>

/**
 * The schema runs on whichever branch answered.
 *
 * `hostedControlCall` has two producers and they carry different evidence: the
 * hosted operation's decoder proves the envelope holds the three arrays, and
 * the HTTP route proves nothing at all until something parses it. Parsing the
 * result rather than only the fallback is what makes the return type true on
 * signed desktop as well as in the browser.
 */
export async function listSessionShares(sessionId: string, workspaceId: string): Promise<SessionPeopleContext> {
  return SessionPeopleContextSchema.parse(await hostedControlCall(
    "session.shares.list",
    { sessionId, workspaceId },
    async () => json(await authFetch(controlSessionUrl({
      baseUrl: getClaxedoServerUrl(),
      sessionID: sessionId,
      suffix: "/shares",
      workspaceId,
    })), z.unknown()),
  ))
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
    async () => json(await authFetch(controlSessionUrl({
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
    }), z.unknown()),
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
    async () => json(await authFetch(controlSessionUrl({
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
    }), z.unknown()),
  )
}
