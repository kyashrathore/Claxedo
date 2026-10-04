import type { ProviderCatalogEntry } from "@claxedo/harness/contract"
import { listCustomProviders } from "./custom-provider"
import { listCredentials, type CredentialOrgScope } from "./registry"
import { projectOpenCodeProviderCatalog } from "./opencode-provider-projection"

export function opencodeProviderCatalog(options: {
  engine: readonly ProviderCatalogEntry[] | undefined
  org: CredentialOrgScope
  actor: string
}) {
  return projectOpenCodeProviderCatalog({
    engine: options.engine,
    declared: listCustomProviders(options.org),
    credentials: listCredentials(options.org).filter((credential) => credential.owner === options.actor || credential.owner === null),
  })
}
