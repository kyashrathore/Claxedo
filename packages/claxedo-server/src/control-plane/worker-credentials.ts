/**
 * Worker-safe credentials.
 *
 * The hosted Worker control plane's first surface (health, JWKS, status,
 * device-login, workspace connection/register/heartbeat/pause,
 * relay resolver) does NOT manage provider credentials, so this stays
 * fail-closed by default. It exists to satisfy the `ControlPlaneServices`
 * shape without importing `credentials/store.ts` or `credentials/registry.ts`,
 * which statically pull in the local encrypted file backend (`fs`).
 *
 * D10 (launch plan 2026-07-11-012, tenant-hardening design 015 §5): the
 * hosted credential byte path is envelope-encrypted Cloudflare KV —
 * `createHostedOrgSecretBackend(orgId)` composes the mandatory encryption
 * wrapper (per-org HKDF subkeys, key-id-prefixed AES-256-GCM, Web Crypto
 * only) over the KV byte store. The raw KV backend is not exported anywhere,
 * so no future call site can reach KV unencrypted.
 *
 * Enabling is gated behind CLAXEDO_HOSTED_CREDENTIALS_ENABLED=1 (default
 * OFF). Even when enabled, the credential CRUD surface keeps failing closed:
 * hosted credential *metadata* requires the org-partitioned store from the
 * D7 follow-up (Decision 1 in design 015), which is not in this wave. What
 * the flag changes today is the boot posture: with the flag on, composition
 * FAILS CLOSED AT CONSTRUCTION TIME unless the envelope KEK
 * (CLAXEDO_CREDENTIALS_KEK, optional CLAXEDO_CREDENTIALS_KEK_NEXT rotation
 * slot) and the KV config (CLAXEDO_CF_KV_URL / CLAXEDO_CF_KV_TOKEN) are all
 * present — a hosted deployment that cannot encrypt must be down, not open.
 */

import type { ControlPlaneCredentials } from "./services"
import type { SecretBackend } from "../credentials/types"
import { createEncryptedCloudflareBackend } from "../credentials/cloudflare"
import { envelopeKeyProviderFromEnv } from "../credentials/envelope"

type WorkerCredentialEnv = Record<string, string | undefined>

/** Default-off feature flag for the hosted credential surface. */
export const HOSTED_CREDENTIALS_FLAG = "CLAXEDO_HOSTED_CREDENTIALS_ENABLED"

export function hostedCredentialsEnabled(env: WorkerCredentialEnv = process.env): boolean {
  return env[HOSTED_CREDENTIALS_FLAG]?.trim() === "1"
}

/**
 * The ONLY sanctioned path to hosted credential bytes: envelope-encrypted
 * Cloudflare KV, partitioned to one org. Throws (fail closed) when the KEK
 * or KV configuration is missing. Later waves resolve `orgId` from the
 * authenticated principal (Decision 1 org partitioning) and call this
 * per-request or per-org — never the raw KV store.
 */
export function createHostedOrgSecretBackend(orgId: string, env: WorkerCredentialEnv = process.env): SecretBackend {
  return createEncryptedCloudflareBackend({ orgId, env })
}

/**
 * Asserts the hosted credential configuration is complete. Throws with the
 * missing piece named. Used at composition time when the feature flag is on.
 */
function assertHostedCredentialConfig(env: WorkerCredentialEnv) {
  for (const name of ["CLAXEDO_CF_KV_URL", "CLAXEDO_CF_KV_TOKEN"] as const) {
    if (!env[name]?.trim()) {
      throw new Error(`${HOSTED_CREDENTIALS_FLAG}=1 but ${name} is not configured — refusing to start`)
    }
  }
  // Throws naming CLAXEDO_CREDENTIALS_KEK when absent or malformed.
  envelopeKeyProviderFromEnv(env)
}

export function workerCredentials(env: WorkerCredentialEnv = process.env): ControlPlaneCredentials {
  if (!hostedCredentialsEnabled(env)) {
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

  // Flag on: prove the encrypted store CAN be composed, at boot, or refuse to
  // start. The CRUD surface below still fails closed pending org-partitioned
  // credential metadata (Decision 1) — that wave replaces `gated` with real
  // implementations built on `createHostedOrgSecretBackend(orgId)`.
  assertHostedCredentialConfig(env)

  const gated = (): never => {
    throw new Error(
      "Hosted credential management is gated on org-partitioned credential metadata (launch-plan D10 + D7 follow-up); " +
        "the envelope-encrypted KV backend is composed and verified, but no org-agnostic credential surface exists by design",
    )
  }
  return {
    listCredentials: async () => [],
    getCredentialByProvider: async () => undefined,
    resolveCredentialSecret: async () => null,
    putCredential: async () => gated(),
    deleteCredential: async () => gated(),
    deleteCredentialsByProvider: async () => gated(),
    updateCredentialStatus: async () => gated(),
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
  }
}
