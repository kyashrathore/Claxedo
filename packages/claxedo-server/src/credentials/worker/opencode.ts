import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ProviderCatalogEntry } from "@claxedo/harness/contract"
import { projectOpenCodeProviderCatalog } from "@claxedo/server-core/credentials/opencode-provider-projection"
import { holderAccountSources, spendsAccount } from "@claxedo/server-core/credentials/account-holder"
import type { ControlPlaneCredentials } from "../../authority/services"

export function hostedOpenCodeCredentials(input: {
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  credentials: ((orgId: string) => ControlPlaneCredentials) | undefined
  runtimeProviders(auth: SignedControlPlaneAuth, workspaceId: string | undefined): Promise<ProviderCatalogEntry[] | undefined>
}) {
  return {
    opencodeProviderCatalog: async (auth: SignedControlPlaneAuth, workspaceId?: string) => {
      const engine = await input.runtimeProviders(auth, workspaceId)
      const store = input.credentials?.(await input.resolveOrgId(auth))
      const person = auth.user.subject
      const sources = holderAccountSources(store ? await store.accountSelections() : {}, person, person)
      const credentials = store ? (await store.listCredentials()).filter((row) => spendsAccount(row, person, sources, person)) : []
      return projectOpenCodeProviderCatalog({ engine, declared: [], credentials })
    },
  }
}
