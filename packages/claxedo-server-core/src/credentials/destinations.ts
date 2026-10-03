import { credentialSecretMaterial } from "./secret-material"
import type { CredentialKind } from "./types"
import { listCustomProviders } from "./custom-provider"
import type { CredentialOrgScope } from "./registry"
import { builtInProviderRow, type ProviderRow, type ProviderDestination } from "./built-in-destinations"
export { destinationAuthMode } from "./built-in-destinations"
export type { ProviderDestination } from "./built-in-destinations"

/**
 * An operator-declared provider's row: its own base URL, reached with the key
 * at the header the operator declared for it. It wins over a vendor row of the
 * same id because the catalog serves the custom provider in that row's place,
 * and the engine sends that id's requests to it.
 */
function customProviderRow(providerId: string, org: CredentialOrgScope | undefined): ProviderRow | undefined {
  if (org === undefined) return undefined
  const config = listCustomProviders(org).find((provider) => provider.providerID === providerId)
  if (!config) return undefined
  const url = new URL(config.baseURL)
  const apiPath = url.pathname.replace(/\/+$/, "")
  if (providerId === "cursor" || providerId === "cursor-sdk") {
    return (material) => ({ ...builtInProviderRow(providerId)!(material), origin: url.origin })
  }
  return () => ({
    origin: url.origin,
    methods: ["POST", "GET"],
    pathPrefixes: [`${apiPath}/`],
    apiPath,
    injection: { header: config.credentialHeader.name, ...(config.credentialHeader.scheme ? { scheme: config.credentialHeader.scheme } : {}) },
  })
}

/**
 * The row for a provider. `org` names whose custom providers count; a caller
 * delivering somewhere custom providers cannot be reached passes none.
 *
 * `Object.hasOwn`, because `in` reaches `Object.prototype`: a provider id of
 * `constructor` or `toString` answered true here and then had no row to bind.
 */
function providerRow(providerId: string, org: CredentialOrgScope | undefined): ProviderRow | undefined {
  return customProviderRow(providerId, org) ?? (builtInProviderRow(providerId))
}

/** Whether this provider can be bound at all, asked without reading its secret. */
export function hasProviderDestination(providerId: string, org?: CredentialOrgScope): boolean {
  return providerRow(providerId, org) !== undefined
}

export function providerDestination(input: {
  providerId: string
  kind: CredentialKind
  secret: string
  org?: CredentialOrgScope
}): ProviderDestination | undefined {
  const row = providerRow(input.providerId, input.org)
  if (!row) return undefined
  const material = credentialSecretMaterial({ kind: input.kind, secret: input.secret })
  if (!material) return undefined
  return { ...row(material), value: material.token }
}
