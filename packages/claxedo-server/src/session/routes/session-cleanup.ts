import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { SessionCleanupRoutes, type SessionCleanupPort } from "@claxedo/server-core/session/cleanup-routes"
import { prepareRuntimeSessionCleanup, deleteRuntimeSessionCleanup } from "@claxedo/server-core/session/cleanup-runtime"
import { buildSessionListResponse, sessionListKeysetPage } from "@claxedo/server-core/session/navigation-list"
import { signedSessionList } from "../list"
import { mintSessionCleanupCapability, resolveSessionCleanupOwner, type SessionCleanupCapabilityInput } from "../cleanup-capability"
import { AGENT_PLUGIN_ALL_PROJECTS_SCOPE, AGENT_PLUGIN_DESKTOP_WORKSPACE } from "@claxedo/server-core/agent-plugins/activation/runtime-scope"
import { sessionCleanupRuntimeClient } from "../cleanup-runtime-client"
import { authorizeSessionCleanup } from "../cleanup-authorization"
import type { ControlPlaneServices } from "../../authority/services"
import { z } from "zod"

export function createHostedSessionCleanupRoutes(input: {
  services: ControlPlaneServices
  authenticate(request: Request): Promise<SignedControlPlaneAuth | Response>
  capability?: SessionCleanupCapabilityInput
}) {
  const authority = requireAuthority(input.services)
  const routes = SessionCleanupRoutes({
    authenticate: async (request) => {
      const authorization = await authorizeSessionCleanup(input, request)
      if (authorization instanceof Response) return authorization
      const { identity } = authorization
      const revalidate = () => authorization.revalidate()
      const port: SessionCleanupPort = {
        list: async (query) => {
          await revalidate()
          if (identity.auth) return signedSessionList(input.services, identity.auth, query)
          if (!authority.listSessionCleanupPage) throw new Error("Session cleanup inventory is unavailable")
          return authority.listSessionCleanupPage(identity, { ...sessionListKeysetPage(query), ...(query.workspaceId ? { workspaceId: query.workspaceId } : { all: true }) })
            .then((sessions) => buildSessionListResponse({ query, sessions, cursorApplied: true }))
        },
        prepare: async (row) => prepareRuntimeSessionCleanup(await sessionCleanupRuntimeClient(input.services, identity, row.workspaceId!, revalidate), row),
        admit: async (target) => {
          await revalidate()
          if (identity.auth && authority.admitSessionCleanup) return authority.admitSessionCleanup(identity.auth, target)
          if (!identity.auth && authority.admitRuntimeSessionCleanup) return authority.admitRuntimeSessionCleanup(identity, target)
          throw new Error("Session cleanup admission is unavailable")
        },
        delete: async (target) => {
          const runtime = await sessionCleanupRuntimeClient(input.services, identity, target.workspaceId, revalidate)
          await revalidate()
          return deleteRuntimeSessionCleanup(runtime, target)
        },
      }
      return port
    },
  })
  routes.post("/api/claxedo/session-cleanup/grant/desktop", async (c) => {
    if (!input.capability) return sessionCleanupRefusalResponse(503, "session_cleanup_grant_unavailable")
    const parsed = z.strictObject({ orgId: z.string().min(1).optional() }).safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return sessionCleanupRefusalResponse(400, "invalid_session_cleanup_grant_request")
    const auth = await input.authenticate(c.req.raw)
    if (auth instanceof Response) return auth
    const actor = await resolveRuntimeActor(authority, auth)
    if (actor.actorKind !== "human" || !actor.userId) return sessionCleanupRefusalResponse(403, "session_cleanup_access_denied")
    const scope = { userId: actor.userId, actorId: actor.actorId, orgId: parsed.data.orgId ?? await authority.resolveOrgId(auth), workspaceId: AGENT_PLUGIN_DESKTOP_WORKSPACE, projectId: AGENT_PLUGIN_ALL_PROJECTS_SCOPE, desktop: true as const }
    if (!(await resolveSessionCleanupOwner(input.capability, scope))) return sessionCleanupRefusalResponse(403, "session_cleanup_account_consent_required")
    const minted = await mintSessionCleanupCapability(scope, input.capability.signingEnv, input.capability.passes ? { register: input.capability.passes } : {})
    return c.json({ token: minted.token, expiresAt: minted.expiresAt, actorId: scope.actorId, orgId: scope.orgId })
  })
  return routes
}

function sessionCleanupRefusalResponse(status: number, code: string) {
  return Response.json({ error: { code } }, { status })
}
