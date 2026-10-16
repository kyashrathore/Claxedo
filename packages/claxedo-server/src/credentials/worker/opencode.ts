import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ProviderCatalogEntry } from "@claxedo/harness/contract"
import { openCodeLaunchEntries, projectOpenCodeProviderCatalog } from "@claxedo/server-core/credentials/opencode-provider-projection"
import { holderAccountSources, spendsAccount } from "@claxedo/server-core/credentials/account-holder"
import type { ControlPlaneCredentials } from "../../authority/services"

/** The accounts a sandbox is delivered, one per vendor host, which are the only ones its engine can spend. */
async function effectiveCredentials(store: ControlPlaneCredentials) {
  if (!store.effectiveCredentials) throw new Error("A hosted credential store reports its effective accounts")
  return await store.effectiveCredentials("shared")
}

export function hostedOpenCodeCredentials(input: {
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  credentials: ((orgId: string) => ControlPlaneCredentials) | undefined
  runtimeProviders(auth: SignedControlPlaneAuth, workspaceId: string): Promise<ProviderCatalogEntry[] | undefined>
}) {
  return {
    opencodeProviderCatalog: async (auth: SignedControlPlaneAuth, workspaceId?: string) => {
      const store = input.credentials?.(await input.resolveOrgId(auth))
      const person = auth.user.subject
      const sources = holderAccountSources(store ? await store.accountSelections() : {}, person, person)
      const credentials = store ? (await effectiveCredentials(store)).filter((row) => spendsAccount(row, person, sources, person)) : []
      const engine = workspaceId ? await input.runtimeProviders(auth, workspaceId) : openCodeLaunchEntries(credentials)
      return projectOpenCodeProviderCatalog({ engine, declared: [], credentials })
    },
  }
}
