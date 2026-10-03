import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { PI_LAUNCH_PROVIDERS, piCredentialConnected, piCredentialProviderIDs, projectPiProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-projection"
import type { ControlPlaneCredentials } from "../../authority/services"
import { holderAccountSources, spendsAccount } from "@claxedo/server-core/credentials/account-holder"

/**
 * Production hosted ports: every credential operation is bound to the
 * authority's org. `credentials` is the plane's per-org store, absent while
 * `CLAXEDO_HOSTED_CREDENTIALS_ENABLED` is off.
 */
export function hostedPiCredentials(input: {
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  credentials: ((orgId: string) => ControlPlaneCredentials) | undefined
}) {
  return {
    piProviderCatalog: async (auth: SignedControlPlaneAuth) => {
      if (!input.credentials) return projectPiProviderCatalog(new Map())
      const store = input.credentials(await input.resolveOrgId(auth))
      const person = auth.user.subject
      const rows = await store.listCredentials()
      const sources = holderAccountSources(await store.accountSelections(), person, person)
      const account = (id: string) => rows.find((row) => row.provider_id === id && spendsAccount(row, person, sources, person))
      return projectPiProviderCatalog(new Map(PI_LAUNCH_PROVIDERS.flatMap((provider) => {
        const by = piCredentialProviderIDs(provider).find((id) => piCredentialConnected(provider, account(id)))
        return by === undefined ? [] : [[provider, by] as const]
      })))
    },
  }
}

