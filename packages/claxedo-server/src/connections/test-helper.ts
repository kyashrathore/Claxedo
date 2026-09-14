/**
 * Test-only: the SQLite credential registry behind the `ControlPlaneCredentials`
 * port, for suites that exercise the connections host on real storage.
 *
 * The registry module reads `CLAXEDO_DATA_DIR` at import time, so every suite
 * here imports it dynamically after pointing that env at a temp root. The
 * already-loaded module is therefore passed IN rather than imported here — a
 * static import in this file would load it too early for every consumer.
 */
import type { ControlPlaneCredentials } from "../authority/services"

type CredentialRegistry = typeof import("@claxedo/server-core/credentials/registry")

export function registryCredentialsPort(registry: CredentialRegistry): ControlPlaneCredentials {
  return {
    listCredentials: async () => registry.listCredentials(),
    getCredentialByProvider: async (providerId) => registry.credentialByProvider(providerId, { onOutage: "empty" }),
    resolveCredentialSecret: (providerId) => registry.resolveSecret(providerId),
    // The status-independent re-verify seam. Omitting it used to be invisible:
    // the SQLite adapter implemented `readSecret` by repairing status instead,
    // so a port without this method still passed.
    resolveCredentialSecretById: (id) => registry.resolveSecretById(id),
    putCredential: (input) => registry.putCredential(input),
    deleteCredential: async (id) => registry.deleteCredential(id),
    deleteCredentialsByProvider: async (providerId) => registry.deleteCredentialsByProvider(providerId),
    updateCredentialStatus: async (id, status, error) => registry.updateCredentialStatus(id, status, error),
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
  }
}
