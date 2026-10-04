import { renewedCredential } from "@claxedo/server-core/credentials/operations/refresh"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import type { ControlPlaneCredentials } from "../authority/services"

/**
 * The hosted plane's one refresher: a plan login is renewed against its
 * organization's store, in place, so every delivery after it reads the new
 * token and the refresh token never leaves the store.
 */
export function storeRenewal(credentials: ControlPlaneCredentials, options: { fetch?: typeof fetch } = {}) {
  return (credential: CredentialMetadata, rejectedExpiresAt?: number) => renewedCredential(credential, {
    read: async () => await credentials.resolveCredentialSecretById?.(credential.id) ?? null,
    write: async (next) => await credentials.updateCredentialSecret?.(credential.id, next.secret, next.expiresAt),
    reread: async () => await credentials.getCredential?.(credential.id),
  }, { ...options, ...(rejectedExpiresAt === undefined ? {} : { rejectedExpiresAt }) })
}
