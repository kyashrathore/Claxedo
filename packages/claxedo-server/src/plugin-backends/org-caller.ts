import { pluginRefusal } from "@claxedo/plugin-runtime"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../authority/services"
import { signedOrError } from "../workspace/route-support"

export type OrgCallerInput = Readonly<{
  authentication: RequestAuthenticationAdapter
  authority: Pick<WorkspaceAuthority, "resolveOrgId">
  services?: ControlPlaneServices
}>

export type OrgCaller = Readonly<{ auth: SignedControlPlaneAuth; userId: string; orgId: string }>

/**
 * The signed caller and the organization the authority resolves for them, or
 * the refusal to answer: no credential and an unknown principal are a 401, a
 * caller with no active organization a 403. The caller never names an
 * organization, so another organization's plugins are unreachable by
 * construction.
 */
export async function orgCallerOrRefusal(request: Request, input: OrgCallerInput): Promise<OrgCaller | Response> {
  const signed = await signedOrError(request, { authentication: input.authentication, requireSigned: true }, input.services)
  if ("error" in signed) return Response.json(signed.error, { status: signed.status })
  const principal = signed.auth?.principal
  if (!signed.auth || !principal) return pluginRefusal(401, "unauthorized", "A signed caller is required")
  try {
    return { auth: signed.auth, userId: principal.userId, orgId: await input.authority.resolveOrgId(signed.auth) }
  } catch (error) {
    if (error instanceof ControlPlaneAuthError) return Response.json(controlPlaneAuthErrorBody(error), { status: error.status })
    throw error
  }
}
