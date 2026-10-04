import { Hono } from "hono"
import type { EnvelopeKeyProvider } from "@claxedo/server-core/credentials/envelope"
import { CredentialRoutes } from "@claxedo/server-core/credentials/routes/credential"
import { ProviderAuthRoutes } from "@claxedo/server-core/credentials/routes/provider-auth"
import { createProviderAuthService } from "@claxedo/server-core/credentials/provider-auth/service"
import { ControlPlaneAuthError, controlPlaneAuthContext, type ControlPlaneAuthConfig, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { SandboxDriverKeys, SandboxKeyRemoval } from "@claxedo/server-core/credentials/routes/sandbox-driver-keys"
import type { SandboxDriverID, SandboxProvisionerID } from "@claxedo/sandbox-contract"
import type { ControlPlaneCredentials } from "../../authority/services"
import { orgRoutedCredentials } from "./org-routed"

export type HostedCredentialRoutesInput = {
  authentication: RequestAuthenticationAdapter
  authConfig: ControlPlaneAuthConfig
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  credentials: (orgId: string) => ControlPlaneCredentials
  changed: (orgId: string) => Promise<void>
  /** The plane's credential keys: a sign-in's callback can land on another Worker instance than its authorize did. */
  keys: EnvelopeKeyProvider
  fetch?: typeof fetch
  /** Absent on a plane that provisions no cloud sandboxes. */
  sandboxDriverKeys?: HostedSandboxDriverKeys
}

/** The organization's sandbox provider keys beside the deployment's managed driver. */
export type HostedSandboxDriverKeys = {
  drivers: readonly SandboxDriverID[]
  managed: SandboxProvisionerID
  administers(auth: SignedControlPlaneAuth, orgId: string): Promise<boolean>
  chosen(orgId: string): Promise<string | undefined>
  choose(auth: SignedControlPlaneAuth, orgId: string, driver: SandboxDriverID | undefined): Promise<void>
  remove(auth: SignedControlPlaneAuth, orgId: string, keyId: string): Promise<SandboxKeyRemoval>
}

function orgSandboxDriverKeys(keys: HostedSandboxDriverKeys, signed: (request: Request) => Promise<SignedControlPlaneAuth>): SandboxDriverKeys {
  return {
    drivers: keys.drivers,
    owner: "org",
    managed: keys.managed,
    canManage: async (request, { org }) => keys.administers(await signed(request), org),
    chosenDriver: ({ org }) => keys.chosen(org),
    chooseDriver: async (request, { org }, driver) => keys.choose(await signed(request), org, driver),
    removeKey: async (request, { org }, keyId) => keys.remove(await signed(request), org, keyId),
  }
}

/**
 * The shared account-setup routes, `/api/claxedo/credentials` and the
 * provider device login, served by the hosted plane: the person is the one
 * the session proves, and their organization is the authority's, never a
 * claim the request carries.
 */
export function hostedCredentialRoutes(input: HostedCredentialRoutesInput) {
  const credentials = orgRoutedCredentials(input.credentials, input.changed)
  const signed = async (request: Request) => {
    const auth = await controlPlaneAuthContext(request, { authentication: input.authentication, config: input.authConfig })
    if (auth.mode !== "signed") throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed authentication is required")
    return auth
  }
  const resolveOrg = async (request: Request) => await input.resolveOrgId(await signed(request))
  const auth = { authentication: input.authentication, authConfig: input.authConfig, resolveOrg }
  const service = createProviderAuthService(credentials, { reach: "cloud", keys: input.keys, ...(input.fetch ? { fetch: input.fetch } : {}) })
  return new Hono()
    .route("/api/claxedo/credentials", CredentialRoutes(credentials, {
      ...auth,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.sandboxDriverKeys ? { sandboxDriverKeys: orgSandboxDriverKeys(input.sandboxDriverKeys, signed) } : {}),
    }))
    .route("/", ProviderAuthRoutes({ service, ...auth }))
}
