import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "@claxedo/server-core/platform/auth/auth"
import { apiError, signedOrError } from "../../workspace/route-support"

type Options = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  cliTokenEnv?: Record<string, string | undefined>
}

const bodyLimitBytes = 16 * 1024

export function OrgTeamControlRoutes(services: ControlPlaneServices, options: Options = {}) {
  const limited = bodyLimit({
    maxSize: bodyLimitBytes,
    onError: (c) => c.json({
      error: apiError("request_body_too_large", `Request body exceeds the ${bodyLimitBytes}-byte limit`),
    }, 413),
  })

  async function signed(req: Request) {
    const authResult = await signedOrError(req, {
      ...options,
      requireSigned: true,
    }, services)
    if ("error" in authResult) throw Object.assign(new ControlPlaneAuthError(authResult.status, "unauthorized", "Signed auth required"), { response: authResult })
    if (!authResult.auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
    return authResult.auth
  }

  return new Hono()
    .get("/orgs", async (c) => {
      try {
        const auth = await signed(c.req.raw)
        return c.json(await requireAuthority(services).listOrgs(auth))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .post("/orgs", limited, async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const body = await c.req.json().catch(() => ({})) as { name?: string }
        const create = requireAuthority(services).createOrg
        if (!create) return c.json({ error: apiError("not_implemented", "Org create unavailable") }, 501)
        if (!body.name?.trim()) return c.json({ error: apiError("org_name_required", "name is required") }, 400)
        return c.json(await create(auth, { name: body.name.trim() }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .get("/orgs/:orgId/teams", async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const list = requireAuthority(services).listTeams
        if (!list) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        return c.json(await list(auth, { orgId: c.req.param("orgId") }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .post("/orgs/:orgId/teams", limited, async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const create = requireAuthority(services).createTeamInOrg
        if (!create) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        const body = await c.req.json().catch(() => ({})) as { name?: string }
        if (!body.name?.trim()) return c.json({ error: apiError("team_name_required", "name is required") }, 400)
        return c.json(await create(auth, { orgId: c.req.param("orgId"), name: body.name.trim() }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .post("/orgs/:orgId/ensure-default-team", limited, async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const ensure = requireAuthority(services).ensureDefaultTeam
        if (!ensure) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        return c.json(await ensure(auth, { orgId: c.req.param("orgId") }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .get("/teams/:teamId/members", async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const list = requireAuthority(services).listTeamMembers
        if (!list) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        return c.json(await list(auth, { teamId: c.req.param("teamId") }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .post("/teams/:teamId/members", limited, async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const add = requireAuthority(services).addTeamMember
        if (!add) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
        return c.json(await add(auth, {
          teamId: c.req.param("teamId"),
          ...(typeof body.tokenIdentifier === "string" ? { tokenIdentifier: body.tokenIdentifier } : {}),
          ...(typeof body.clerkSubject === "string" ? { clerkSubject: body.clerkSubject } : {}),
          ...(typeof body.userPublicId === "string" ? { userPublicId: body.userPublicId } : {}),
          ...(body.role === "member" || body.role === "admin" || body.role === "owner" ? { role: body.role } : {}),
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .delete("/teams/:teamId/members", limited, async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const remove = requireAuthority(services).removeTeamMember
        if (!remove) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
        return c.json(await remove(auth, {
          teamId: c.req.param("teamId"),
          ...(typeof body.tokenIdentifier === "string" ? { tokenIdentifier: body.tokenIdentifier } : {}),
          ...(typeof body.clerkSubject === "string" ? { clerkSubject: body.clerkSubject } : {}),
          ...(typeof body.userPublicId === "string" ? { userPublicId: body.userPublicId } : {}),
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .post("/teams/:teamId/projects", limited, async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const grant = requireAuthority(services).grantTeamProject
        if (!grant) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        const body = await c.req.json().catch(() => ({})) as { projectId?: string; role?: string }
        if (!body.projectId || (body.role !== "viewer" && body.role !== "editor" && body.role !== "admin")) {
          return c.json({ error: apiError("team_project_grant_required", "projectId and role are required") }, 400)
        }
        return c.json(await grant(auth, {
          teamId: c.req.param("teamId"),
          projectId: body.projectId,
          role: body.role,
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .delete("/teams/:teamId/projects", limited, async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const revoke = requireAuthority(services).revokeTeamProject
        if (!revoke) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        const body = await c.req.json().catch(() => ({})) as { projectId?: string }
        if (!body.projectId) return c.json({ error: apiError("team_project_grant_required", "projectId is required") }, 400)
        return c.json(await revoke(auth, {
          teamId: c.req.param("teamId"),
          projectId: body.projectId,
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
}
