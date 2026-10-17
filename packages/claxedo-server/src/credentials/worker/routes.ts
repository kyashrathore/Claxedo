import { Hono } from "hono"
import type { EnvelopeKeyProvider } from "@claxedo/server-core/credentials/envelope"
import { CredentialRoutes } from "@claxedo/server-core/credentials/routes/credential"
import { ProviderAuthRoutes } from "@claxedo/server-core/credentials/routes/provider-auth"
import { createProviderAuthService } from "@claxedo/server-core/credentials/provider-auth/service"
import { ControlPlaneAuthError, controlPlaneAuthContext, type ControlPlaneAuthConfig, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { SandboxDriverKeys, SandboxKeyRemoval } from "@claxedo/server-core/credentials/routes/sandbox-driver-keys"
import type { SandboxDriverID, SandboxMachineClass } from "@claxedo/sandbox-contract"
import type { HarnessSecretDelivery } from "@claxedo/server-core/credentials/reach"
import type { ControlPlaneTelemetry } from "@claxedo/server-core/platform/telemetry/ports"
import type { ControlPlaneCredentials } from "../../authority/services"
import type { OrgAdministers } from "./org-administers"
import { orgRoutedCredentials, type CredentialChange } from "./org-routed"

export type HostedCredentialRoutesInput = {
  authentication: RequestAuthenticationAdapter
  authConfig: ControlPlaneAuthConfig
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  credentials: (orgId: string) => ControlPlaneCredentials
  change: CredentialChange
  /** Who manages the organization's own rows: its organization accounts and its sandbox provider keys. */
  administers: OrgAdministers
  /** The plane's credential keys: a sign-in's callback can land on another Worker instance than its authorize did. */
  keys: EnvelopeKeyProvider
  fetch?: typeof fetch
  /** Absent on a plane that provisions no cloud sandboxes. */
  sandboxDriverKeys?: HostedSandboxDriverKeys
  telemetry?: ControlPlaneTelemetry
}

/** The organization's sandbox provider keys: the only accounts this plane starts cloud workspaces on. */
export type HostedSandboxDriverKeys = {
  drivers: readonly SandboxDriverID[]
  chosen(orgId: string): Promise<string | undefined>
  choose(auth: SignedControlPlaneAuth, orgId: string, driver: SandboxDriverID | undefined): Promise<void>
  remove(auth: SignedControlPlaneAuth, orgId: string, keyId: string): Promise<SandboxKeyRemoval>
  /** The organization saved `keyId`: the workspace starts waiting out a failure it may have fixed run at once. */
  changed(orgId: string, keyId: string): Promise<void>
  brokering(driver: SandboxDriverID): HarnessSecretDelivery | undefined
  machineClasses(driver: SandboxDriverID): readonly SandboxMachineClass[] | undefined
}

function orgSandboxDriverKeys(
  keys: HostedSandboxDriverKeys,
  signed: (request: Request) => Promise<SignedControlPlaneAuth>,
  administers: OrgAdministers,
): SandboxDriverKeys {
  return {
    drivers: keys.drivers,
    owner: "org",
    canManage: async (request, { org }) => administers(await signed(request), org),
    chosenDriver: ({ org }) => keys.chosen(org),
    chooseDriver: async (request, { org }, driver) => keys.choose(await signed(request), org, driver),
    removeKey: async (request, { org }, keyId) => keys.remove(await signed(request), org, keyId),
    keyChanged: ({ org }, keyId) => keys.changed(org, keyId),
    brokering: (driver) => keys.brokering(driver),
    machineClasses: (driver) => keys.machineClasses(driver),
  }
}

/**
 * The shared account-setup routes, `/api/claxedo/credentials` and the
 * provider device login, served by the hosted plane: the person is the one
 * the session proves, and their organization is the authority's, never a
 * claim the request carries.
 */
export function hostedCredentialRoutes(input: HostedCredentialRoutesInput) {
  const credentials = orgRoutedCredentials(input.credentials, input.change)
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
      managesOrgAccounts: async (request, org) => await input.administers(await signed(request), org),
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.sandboxDriverKeys ? { sandboxDriverKeys: orgSandboxDriverKeys(input.sandboxDriverKeys, signed, input.administers) } : {}),
      ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    }))
    .route("/", ProviderAuthRoutes({ service, ...auth }))
}
