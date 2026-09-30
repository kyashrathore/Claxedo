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

const ORG_TEAM_ERRORS: Record<string, Omit<OrgTeamError, "code">> = {
  invalid_input: { status: 400, message: "The request names an invalid value" },
  organization_policy_denied: { status: 403, message: "Organization creation is disabled for this deployment" },
  org_admin_required: { status: 403, message: "Organization administrator authority is required" },
  org_owner_required: { status: 403, message: "Only an organization owner may grant, change or remove the owner role" },
  org_owner_protected: { status: 409, message: "The organization's founding owner cannot be removed or demoted" },
  team_member_org_membership_required: { status: 403, message: "The team member must belong to the team organization" },
  project_member_org_membership_required: { status: 403, message: "The project member must belong to the project organization" },
  org_membership_required: { status: 403, message: "Organization membership is required" },
  project_admin_required: { status: 403, message: "Project administrator authority is required" },
  team_not_allowed_on_personal_org: { status: 400, message: "Personal organizations cannot contain teams" },
  team_member_target_required: { status: 400, message: "Exactly one team member target is required" },
  org_member_target_required: { status: 400, message: "Exactly one organization member target is required" },
  org_member_email_unsupported: { status: 400, message: "This deployment cannot find accounts by email" },
  organization_not_found: { status: 404, message: "Organization not found" },
  team_not_found: { status: 404, message: "Team not found" },
  team_member_not_found: { status: 404, message: "Team member not found" },
  org_member_not_found: { status: 404, message: "Organization member not found" },
  project_not_found: { status: 404, message: "Project not found" },
  project_member_not_found: { status: 404, message: "Project member not found" },
  project_member_owner_immutable: { status: 409, message: "The project owner's access cannot be changed" },
  resource_conflict: { status: 409, message: "Organization or team authority changed concurrently" },
}

const NOT_FOUND_BY_MESSAGE: Record<string, string> = {
  "Organization not found": "organization_not_found",
  "Team not found": "team_not_found",
  "Project not found": "project_not_found",
}

function orgTeamAuthorityError(error: unknown): OrgTeamError | undefined {
  for (const [code, mapped] of Object.entries(ORG_TEAM_ERRORS)) {
    if (hasErrorCode(error, code)) return { code, ...mapped }
  }
  for (const [message, code] of Object.entries(NOT_FOUND_BY_MESSAGE)) {
    if (String(error).includes(message)) return { code, ...ORG_TEAM_ERRORS[code] }
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
      return c.json(await add(auth, {
        teamId: c.req.param("teamId")!,
        ...memberSelector(input),
        ...(isOrgMemberRole(input.role) ? { role: input.role } : {}),
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
