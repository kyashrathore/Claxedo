/**
 * Worker-safe credentials.
 *
 * The hosted Worker control plane's first surface (health, JWKS, status,
 * device-login, workspace connection/register/heartbeat/pause,
 * relay resolver) does NOT manage provider credentials, so this is a
 * fail-closed stub. It exists only to satisfy the `ControlPlaneServices` shape
 * without importing `credentials/store.ts` or `credentials/registry.ts`, which
 * statically pull in the local encrypted file backend (`fs`).
 *
 * When credential management is added to the hosted surface, back this with the
 * Worker-safe Cloudflare KV backend (`credentials/cloudflare.ts`) only.
 */

import type { ControlPlaneCredentials } from "./services"

export function workerCredentials(): ControlPlaneCredentials {
  const unavailable = (): never => {
    throw new Error("Credential management is not available in the hosted Worker control plane")
  }
  return {
    listCredentials: async () => [],
    getCredentialByProvider: async () => undefined,
    resolveCredentialSecret: async () => null,
    putCredential: async () => unavailable(),
    deleteCredential: async () => unavailable(),
    deleteCredentialsByProvider: async () => unavailable(),
    updateCredentialStatus: async () => unavailable(),
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
  }
}
