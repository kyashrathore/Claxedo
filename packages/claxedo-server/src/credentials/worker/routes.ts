import { Hono } from "hono"
import { CredentialRoutes } from "@claxedo/server-core/credentials/routes/credential"
import { ControlPlaneAuthError, controlPlaneAuthContext, type ControlPlaneAuthConfig, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { ControlPlaneCredentials } from "../../authority/services"
import { orgRoutedCredentials } from "./org-routed"

export type HostedCredentialRoutesInput = {
  authentication: RequestAuthenticationAdapter
  authConfig: ControlPlaneAuthConfig
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  credentials: (orgId: string) => ControlPlaneCredentials
  changed: (orgId: string) => Promise<void>
}

/**
 * The shared account-setup routes, `/api/claxedo/credentials`, served by the
 * hosted plane: the person is the one the session proves, and their
 * organization is the authority's, never a claim the request carries. No
 * provider device login is served: every sign-in it completes is a ChatGPT
 * plan, which a cloud sandbox cannot be delivered.
 */
export function hostedCredentialRoutes(input: HostedCredentialRoutesInput) {
  const credentials = orgRoutedCredentials(input.credentials, input.changed)
  const resolveOrg = async (request: Request) => {
    const auth = await controlPlaneAuthContext(request, { authentication: input.authentication, config: input.authConfig })
    if (auth.mode !== "signed") throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed authentication is required")
    return await input.resolveOrgId(auth)
  }
  return new Hono()
    .route("/api/claxedo/credentials", CredentialRoutes(credentials, { authentication: input.authentication, authConfig: input.authConfig, resolveOrg }))
}
