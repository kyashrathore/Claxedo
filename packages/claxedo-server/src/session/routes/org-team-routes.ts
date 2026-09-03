import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { apiError, signedOrError } from "../../workspace/route-support"

type Options = {
  authentication?: RequestAuthenticationAdapter
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  cliTokenEnv?: Record<string, string | undefined>
}

const bodyLimitBytes = 16 * 1024

type OrgTeamError = {
  status: 400 | 403 | 404 | 409
  code: string
  message: string
}

function hasErrorCode(error: unknown, code: string) {
  const value = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  return value === code || message === code || message.includes(code)
}

function orgTeamAuthorityError(error: unknown): OrgTeamError | undefined {
  if (hasErrorCode(error, "organization_policy_denied")) {
    return { status: 403, code: "organization_policy_denied", message: "Organization creation is disabled for this deployment" }
  }
  if (hasErrorCode(error, "org_admin_required")) {
    return { status: 403, code: "org_admin_required", message: "Organization administrator authority is required" }
  }
  if (hasErrorCode(error, "team_member_org_membership_required")) {
    return { status: 403, code: "team_member_org_membership_required", message: "The team member must belong to the team organization" }
  }
  if (hasErrorCode(error, "org_membership_required")) {
    return { status: 403, code: "org_membership_required", message: "Organization membership is required" }
  }
  if (hasErrorCode(error, "team_not_allowed_on_personal_org")) {
    return { status: 400, code: "team_not_allowed_on_personal_org", message: "Personal organizations cannot contain teams" }
  }
  if (hasErrorCode(error, "team_member_target_required")) {
    return { status: 400, code: "team_member_target_required", message: "Exactly one team member target is required" }
  }
  if (hasErrorCode(error, "organization_not_found") || String(error).includes("Organization not found")) {
    return { status: 404, code: "organization_not_found", message: "Organization not found" }
  }
  if (hasErrorCode(error, "team_not_found") || String(error).includes("Team not found")) {
    return { status: 404, code: "team_not_found", message: "Team not found" }
  }
  if (hasErrorCode(error, "team_member_not_found")) {
    return { status: 404, code: "team_member_not_found", message: "Team member not found" }
  }
  if (hasErrorCode(error, "project_not_found") || String(error).includes("Project not found")) {
    return { status: 404, code: "project_not_found", message: "Project not found" }
  }
  if (hasErrorCode(error, "resource_conflict")) {
    return { status: 409, code: "resource_conflict", message: "Organization or team authority changed concurrently" }
  }
  return undefined
}

/** Canonical HTTP envelope for organization/team authority failures across adapters. */
export function orgTeamErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
  const mapped = orgTeamAuthorityError(error)
  if (mapped) return c.json({ error: apiError(mapped.code, mapped.message) }, mapped.status)
  throw error
}

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
    if ("error" in authResult) {
      const status = authResult.status ?? 401
      throw Object.assign(
        new ControlPlaneAuthError(status, "invalid_bearer_token", "Signed auth required"),
        { response: authResult },
      )
    }
    if (!authResult.auth) throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
    return authResult.auth
  }

  return new Hono()
    .get("/orgs", async (c) => {
      try {
        const auth = await signed(c.req.raw)
        return c.json(await requireAuthority(services).listOrgs(auth))
      } catch (err) {
        return orgTeamErrorResponse(c, err)
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
        return orgTeamErrorResponse(c, err)
      }
    })
    .get("/orgs/:orgId/teams", async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const list = requireAuthority(services).listTeams
        if (!list) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        return c.json(await list(auth, { orgId: c.req.param("orgId") }))
      } catch (err) {
        return orgTeamErrorResponse(c, err)
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
        return orgTeamErrorResponse(c, err)
      }
    })
    .post("/orgs/:orgId/ensure-default-team", limited, async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const ensure = requireAuthority(services).ensureDefaultTeam
        if (!ensure) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        return c.json(await ensure(auth, { orgId: c.req.param("orgId") }))
      } catch (err) {
        return orgTeamErrorResponse(c, err)
      }
    })
    .get("/teams/:teamId/members", async (c) => {
      try {
        const auth = await signed(c.req.raw)
        const list = requireAuthority(services).listTeamMembers
        if (!list) return c.json({ error: apiError("not_implemented", "Teams unavailable") }, 501)
        return c.json(await list(auth, { teamId: c.req.param("teamId") }))
      } catch (err) {
        return orgTeamErrorResponse(c, err)
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
        return orgTeamErrorResponse(c, err)
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
        return orgTeamErrorResponse(c, err)
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
        return orgTeamErrorResponse(c, err)
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
