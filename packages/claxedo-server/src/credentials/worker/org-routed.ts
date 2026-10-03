import type { ControlPlaneCredentials } from "../../authority/services"

/**
 * The plane's per-organization credential stores as the one org-parameterized
 * contract the shared credential routes are written against. An operation
 * that names no organization is refused: there is no store for "no
 * organization". Every write that changes what a workspace may spend tells the
 * plane, so running workspaces take it.
 */
export function orgRoutedCredentials(
  storeFor: (orgId: string) => ControlPlaneCredentials,
  changed: (orgId: string) => Promise<void>,
): ControlPlaneCredentials {
  const named = (org: string | undefined) => {
    if (!org) throw new Error("A hosted credential operation names its organization")
    return org
  }
  const at = (org: string | undefined) => storeFor(named(org))
  const write = async <T>(org: string | undefined, operation: (store: ControlPlaneCredentials) => Promise<T>) => {
    const result = await operation(at(org))
    await changed(named(org))
    return result
  }
  return {
    listCredentials: (org) => at(org).listCredentials(org),
    effectiveCredentials: async (scope, org) => {
      const store = at(org)
      if (!store.effectiveCredentials) throw new Error("A hosted credential store reports its effective accounts")
      return await store.effectiveCredentials(scope, org)
    },
    setActiveCredentials: (ids, org, actor) => write(org, async (store) => {
      if (!store.setActiveCredentials) throw new Error("A hosted credential store chooses between a person's accounts")
      return await store.setActiveCredentials(ids, org, actor)
    }),
    getCredentialByProvider: (providerId, read, org) => at(org).getCredentialByProvider(providerId, read, org),
    getCredential: async (id, org) => await at(org).getCredential?.(id, org),
    resolveCredentialSecretById: async (id, org) => (await at(org).resolveCredentialSecretById?.(id, org)) ?? null,
    putCredential: (input, org) => write(org, (store) => store.putCredential(input, org)),
    deleteCredential: (id, org) => write(org, (store) => store.deleteCredential(id, org)),
    deleteCredentialsByProvider: (providerId, kind, org) => write(org, (store) => store.deleteCredentialsByProvider(providerId, kind, org)),
    updateCredentialStatus: (id, status, error, org) => write(org, (store) => store.updateCredentialStatus(id, status, error, org)),
    updateCredentialHealth: async (id, health, validatedAt, org) => await at(org).updateCredentialHealth?.(id, health, validatedAt, org),
    updateCredentialSecret: (id, secret, expiresAt, org) => write(org, async (store) => (await store.updateCredentialSecret?.(id, secret, expiresAt, org)) ?? false),
    syncLocalCredentials: (providerIds, org, owner) => at(org).syncLocalCredentials(providerIds, org, owner),
    accountSelections: (org) => at(org).accountSelections(org),
    setAccountSources: (providerIds, source, org, person) => write(org, (store) => store.setAccountSources(providerIds, source, org, person)),
  }
}
