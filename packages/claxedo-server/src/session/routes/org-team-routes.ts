import { encodeApiError, PUBLIC_API_ERRORS, type PublicApiErrorCode } from "@claxedo/helpers/api-error"
import { contentfulStatus } from "../../platform/http/status"
import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import {
  isOrgMemberRole,
  isProjectGrantRole,
  type MemberSelector,
} from "@claxedo/server-core/platform/auth/org-access-authority"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { apiError, signedOrError, txt } from "../../workspace/route-support"
import { readJsonRecord } from "@claxedo/server-core/platform/json/index"

type Options = {
  authentication?: RequestAuthenticationAdapter
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  cliTokenEnv?: Record<string, string | undefined>
}

const bodyLimitBytes = 16 * 1024

export function orgTeamErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
  const row = error && typeof error === "object" && "code" in error ? error : undefined
  const code = row && typeof row.code === "string" ? row.code as PublicApiErrorCode : undefined
  if (!code || !Object.hasOwn(PUBLIC_API_ERRORS, code)) throw error
  const mapped = PUBLIC_API_ERRORS[code]
  if (!("family" in mapped) || mapped.family !== "access") throw error
  return c.json(encodeApiError({ ...row, code, message: mapped.message }), contentfulStatus(mapped.status))
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

  function authorized(run: (auth: SignedControlPlaneAuth, c: Context) => Promise<Response>) {
    return async (c: Context) => {
      try {
        return await run(await signed(c.req.raw), c)
      } catch (err) {
        return orgTeamErrorResponse(c, err)
      }
    }
  }

  const authority = () => requireAuthority(services)
  const unavailable = (c: Context, message = "Teams unavailable") =>
    c.json({ error: apiError("not_implemented", message) }, 501)
  const body = async (c: Context) => (await readJsonRecord(c.req.raw)) ?? {}

  return new Hono()
    .get("/orgs", authorized(async (auth, c) => c.json(await authority().listOrgs(auth))))
    .post("/orgs", limited, authorized(async (auth, c) => {
      const create = authority().createOrg
      if (!create) return unavailable(c, "Org create unavailable")
      const name = txt((await body(c)).name)?.trim()
      if (!name) return c.json({ error: apiError("org_name_required", "name is required") }, 400)
      return c.json(await create(auth, { name }))
    }))
    .get("/orgs/:orgId/teams", authorized(async (auth, c) => {
      const list = authority().listTeams
      if (!list) return unavailable(c)
      return c.json(await list(auth, { orgId: c.req.param("orgId")! }))
    }))
    .post("/orgs/:orgId/teams", limited, authorized(async (auth, c) => {
      const create = authority().createTeamInOrg
      if (!create) return unavailable(c)
      const name = txt((await body(c)).name)?.trim()
      if (!name) return c.json({ error: apiError("team_name_required", "name is required") }, 400)
      return c.json(await create(auth, { orgId: c.req.param("orgId")!, name }))
    }))
    .post("/orgs/:orgId/ensure-default-team", limited, authorized(async (auth, c) => {
      const ensure = authority().ensureDefaultTeam
      if (!ensure) return unavailable(c)
      return c.json(await ensure(auth, { orgId: c.req.param("orgId")! }))
    }))
    .get("/orgs/:orgId/members", authorized(async (auth, c) => {
      const list = authority().listOrgMembers
      if (!list) return unavailable(c, "Organization members unavailable")
      return c.json(await list(auth, { orgId: c.req.param("orgId")! }))
    }))
    .post("/orgs/:orgId/members", limited, authorized(async (auth, c) => {
      const add = authority().addOrgMember
      if (!add) return unavailable(c, "Organization members unavailable")
      const input = await body(c)
      if (!isOrgMemberRole(input.role)) return c.json({ error: apiError("org_member_role_required", "role is required") }, 400)
      return c.json(await add(auth, { orgId: c.req.param("orgId")!, ...memberSelector(input), role: input.role }))
    }))
    .patch("/orgs/:orgId/members/:userPublicId", limited, authorized(async (auth, c) => {
      const update = authority().updateOrgMember
      if (!update) return unavailable(c, "Organization members unavailable")
      const role = (await body(c)).role
      if (!isOrgMemberRole(role)) return c.json({ error: apiError("org_member_role_required", "role is required") }, 400)
      return c.json(await update(auth, {
        orgId: c.req.param("orgId")!,
        userPublicId: c.req.param("userPublicId")!,
        role,
      }))
    }))
    .delete("/orgs/:orgId/members/:userPublicId", authorized(async (auth, c) => {
      const remove = authority().removeOrgMember
      if (!remove) return unavailable(c, "Organization members unavailable")
      return c.json(await remove(auth, { orgId: c.req.param("orgId")!, userPublicId: c.req.param("userPublicId")! }))
    }))
    .get("/teams/:teamId/members", authorized(async (auth, c) => {
      const list = authority().listTeamMembers
      if (!list) return unavailable(c)
      return c.json(await list(auth, { teamId: c.req.param("teamId")! }))
    }))
    .post("/teams/:teamId/members", limited, authorized(async (auth, c) => {
      const add = authority().addTeamMember
      if (!add) return unavailable(c)
      const input = await body(c)
      const role = input.role
      if (role !== undefined && !isOrgMemberRole(role)) {
        return c.json({ error: apiError("team_member_role_invalid", "role must be member, admin or owner") }, 400)
      }
      return c.json(await add(auth, {
        teamId: c.req.param("teamId")!,
        ...memberSelector(input),
        ...(role === undefined ? {} : { role }),
      }))
    }))
    .delete("/teams/:teamId/members", limited, authorized(async (auth, c) => {
      const remove = authority().removeTeamMember
      if (!remove) return unavailable(c)
      return c.json(await remove(auth, { teamId: c.req.param("teamId")!, ...memberSelector(await body(c)) }))
    }))
    .get("/teams/:teamId/projects", authorized(async (auth, c) => {
      const list = authority().listTeamProjects
      if (!list) return unavailable(c)
      return c.json(await list(auth, { teamId: c.req.param("teamId")! }))
    }))
    .post("/teams/:teamId/projects", limited, authorized(async (auth, c) => {
      const grant = authority().grantTeamProject
      if (!grant) return unavailable(c)
      const input = await body(c)
      const projectId = txt(input.projectId)
      if (!projectId || !isProjectGrantRole(input.role)) {
        return c.json({ error: apiError("team_project_grant_required", "projectId and role are required") }, 400)
      }
      return c.json(await grant(auth, { teamId: c.req.param("teamId")!, projectId, role: input.role }))
    }))
    .delete("/teams/:teamId/projects", limited, authorized(async (auth, c) => {
      const revoke = authority().revokeTeamProject
      if (!revoke) return unavailable(c)
      const projectId = txt((await body(c)).projectId)
      if (!projectId) return c.json({ error: apiError("team_project_grant_required", "projectId is required") }, 400)
      return c.json(await revoke(auth, { teamId: c.req.param("teamId")!, projectId }))
    }))
    .post("/projects/:projectId/members", limited, authorized(async (auth, c) => {
      const grant = authority().grantProjectMember
      if (!grant) return unavailable(c, "Project members unavailable")
      const input = await body(c)
      const userPublicId = txt(input.userPublicId)
      if (!userPublicId || !isProjectGrantRole(input.role)) {
        return c.json({ error: apiError("project_member_grant_required", "userPublicId and role are required") }, 400)
      }
      return c.json(await grant(auth, { projectId: c.req.param("projectId")!, userPublicId, role: input.role }))
    }))
    .delete("/projects/:projectId/members/:userPublicId", authorized(async (auth, c) => {
      const revoke = authority().revokeProjectMember
      if (!revoke) return unavailable(c, "Project members unavailable")
      return c.json(await revoke(auth, {
        projectId: c.req.param("projectId")!,
        userPublicId: c.req.param("userPublicId")!,
      }))
    }))
    .get("/projects/:projectId/access", authorized(async (auth, c) => {
      const list = authority().listProjectAccess
      if (!list) return unavailable(c, "Project access unavailable")
      return c.json(await list(auth, { projectId: c.req.param("projectId")! }))
    }))
}

function memberSelector(input: Record<string, unknown>): MemberSelector {
  return {
    ...(typeof input.tokenIdentifier === "string" ? { tokenIdentifier: input.tokenIdentifier } : {}),
    ...(typeof input.providerSubject === "string" ? { providerSubject: input.providerSubject } : {}),
    ...(typeof input.userPublicId === "string" ? { userPublicId: input.userPublicId } : {}),
    ...(typeof input.email === "string" ? { email: input.email } : {}),
  }
}
