import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"

import { signedOrError } from "../../workspace/route-support"

export type HostedAuthProfileRouteOptions = {
  authentication: RequestAuthenticationAdapter
  listOrgs(auth: SignedControlPlaneAuth): Promise<unknown>
  ownerBootstrap?: "one-use-claim"
}

export type HostedAuthProfile = {
  user: { id: string }
  organizations: Array<{ id: string; name: string }>
}

function authorityUnavailable(message: string): ControlPlaneAuthError {
  return new ControlPlaneAuthError(503, "workspace_authority_unavailable", message)
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw authorityUnavailable(`Workspace authority returned an invalid ${field}`)
  }
  return value
}

/**
 * Projects the authority's provider-specific rows into the one stable public
 * organization shape. Unknown fields are deliberately dropped: provider IDs,
 * membership internals, billing state, and credentials are not profile data.
 */
function publicOrganizations(value: unknown): HostedAuthProfile["organizations"] {
  if (!Array.isArray(value)) throw authorityUnavailable("Workspace authority returned an invalid organization list")
  const seen = new Set<string>()
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw authorityUnavailable("Workspace authority returned an invalid organization")
    }
    const row = entry as Record<string, unknown>
    const id = requiredText(row.org_id, "organization id")
    if (seen.has(id)) throw authorityUnavailable("Workspace authority returned a duplicate organization id")
    seen.add(id)
    return { id, name: requiredText(row.name, "organization name") }
  })
}

function authErrorResponse(error: ControlPlaneAuthError) {
  return new Response(JSON.stringify(controlPlaneAuthErrorBody(error)), {
    status: error.status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  })
}

/**
 * Application-owned account discovery for native and browser clients.
 * Authentication may be provider-backed, but this response is not OIDC
 * UserInfo: its IDs come from the mapped application principal and authority.
 */
export function HostedAuthProfileRoutes(options: HostedAuthProfileRouteOptions) {
  const app = new Hono()
  const response = async (context: Context) => {
    context.header("cache-control", "no-store")
    const authResult = await signedOrError(context.req.raw, {
      authentication: options.authentication,
      requireSigned: true,
    })
    if ("error" in authResult) {
      return context.json(authResult.error, authResult.status as ContentfulStatusCode)
    }
    const auth = authResult.auth
    if (!auth?.principal) {
      return authErrorResponse(new ControlPlaneAuthError(
        503,
        "auth_verifier_unavailable",
        "Verified application principal is unavailable",
      ))
    }
    try {
      const profile: HostedAuthProfile = {
        user: { id: auth.principal.userId },
        organizations: publicOrganizations(await options.listOrgs(auth)),
      }
      return context.json(profile)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return authErrorResponse(error)
      throw error
    }
  }

  app.get("/api/claxedo/auth/profile", response)
  if (options.ownerBootstrap === "one-use-claim") {
    // Authentication owns verification and the selected application-authority
    // adapter owns the atomic claim consumption. This route only gives that
    // irreversible first write one explicit, auditable application entrypoint.
    app.post("/api/claxedo/auth/bootstrap-owner", response)
  }
  return app
}
