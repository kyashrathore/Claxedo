import type { ControlPlaneCredentials } from "../../authority/services"

/**
 * A credential write as the plane sees it: called before the write with its
 * organization, it reads what that organization's running workspaces are
 * delivered, and the function it answers hands their accounts again to each
 * one whose delivery the write changed.
 */
export type CredentialChange = (orgId: string) => Promise<() => Promise<void>>

export const UNDELIVERED_CREDENTIAL_CHANGE: CredentialChange = async () => async () => {}

/**
 * The plane's per-organization credential stores as the one org-parameterized
 * contract the shared credential routes are written against. An operation
 * that names no organization is refused: there is no store for "no
 * organization". Every write goes through `change`, so the running workspaces
 * whose accounts it changed take them.
 */
export function orgRoutedCredentials(
  storeFor: (orgId: string) => ControlPlaneCredentials,
  change: CredentialChange,
): ControlPlaneCredentials {
  const named = (org: string | undefined) => {
    if (!org) throw new Error("A hosted credential operation names its organization")
    return org
  }
  const at = (org: string | undefined) => storeFor(named(org))
  const write = async <T>(org: string | undefined, operation: (store: ControlPlaneCredentials) => Promise<T>) => {
    const settle = await change(named(org))
    const result = await operation(at(org))
    await settle()
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
    deleteCredential: (id, org, administeredBy) => write(org, (store) => store.deleteCredential(id, org, administeredBy)),
    deleteCredentialsByProvider: (providerId, kind, org) => write(org, (store) => store.deleteCredentialsByProvider(providerId, kind, org)),
    updateCredentialStatus: (id, status, error, org) => write(org, (store) => store.updateCredentialStatus(id, status, error, org)),
    updateCredentialHealth: async (id, health, validatedAt, org, evidence) => await at(org).updateCredentialHealth?.(id, health, validatedAt, org, evidence),
    updateCredentialUsage: async (id, windows, usedAt, org) => await at(org).updateCredentialUsage?.(id, windows, usedAt, org),
    updateCredentialLabel: async (id, label, org) => (await at(org).updateCredentialLabel?.(id, label, org)) ?? false,
    updateCredentialSecret: (id, secret, expiresAt, org) => write(org, async (store) => (await store.updateCredentialSecret?.(id, secret, expiresAt, org)) ?? false),
    syncLocalCredentials: (providerIds, org, owner) => at(org).syncLocalCredentials(providerIds, org, owner),
    accountSelections: (org) => at(org).accountSelections(org),
    setAccountSources: (providerIds, source, org, person) => write(org, (store) => store.setAccountSources(providerIds, source, org, person)),
  }
}
