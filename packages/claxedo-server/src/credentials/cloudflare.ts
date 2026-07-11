/**
 * Cloudflare secret backend — stores secrets in Cloudflare Workers KV.
 *
 * Used for hosted or cloud-deployed Claxedo where secrets should not
 * live on disk. Requires CLAXEDO_CF_KV_URL and CLAXEDO_CF_KV_TOKEN env vars.
 *
 * SECURITY (launch-plan D10, invariant I-5): KV is a BYTE STORE ONLY. The raw
 * KV backend is deliberately NOT exported — every value that reaches KV must
 * pass through the envelope-encryption wrapper (`credentials/envelope.ts`),
 * so a leaked KV API token yields ciphertext, never plaintext. The only
 * construction path is `createEncryptedCloudflareBackend`, which fails closed
 * (throws) when the KEK or KV configuration is absent.
 */

import type { SecretBackend } from "./types"
import { Log } from "../log"
import { encryptedSecretBackend, envelopeKeyProviderFromEnv, type EnvelopeKeyProvider } from "./envelope"

const log = Log.create({ service: "credentials-cloudflare" })

type EnvLike = Record<string, string | undefined>

/**
 * Raw Cloudflare KV byte store. INTERNAL ON PURPOSE: it stores whatever bytes
 * it is given, so exporting it would reopen the plaintext hole. Do not export.
 */
function createCloudflareKvByteStore(env: EnvLike): SecretBackend {
  function headers() {
    const token = env.CLAXEDO_CF_KV_TOKEN?.trim()
    if (!token) throw new Error("CLAXEDO_CF_KV_TOKEN not configured")
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
  }

  function baseUrl() {
    const url = env.CLAXEDO_CF_KV_URL?.trim()
    if (!url) throw new Error("CLAXEDO_CF_KV_URL not configured")
    return url.replace(/\/$/, "")
  }

  return {
    async put(id, secret) {
      const ref = `cf:${id}`
      const url = `${baseUrl()}/values/${encodeURIComponent(ref)}`
      const res = await fetch(url, {
        method: "PUT",
        headers: headers(),
        body: secret,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        log.error("Cloudflare KV put failed", { ref, status: res.status, body })
        throw new Error(`Cloudflare KV put failed: ${res.status}`)
      }
      return ref
    },

    async get(ref) {
      const url = `${baseUrl()}/values/${encodeURIComponent(ref)}`
      const res = await fetch(url, {
        headers: headers(),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 404) return null
      if (!res.ok) {
        log.error("Cloudflare KV get failed", { ref, status: res.status })
        throw new Error(`Cloudflare KV get failed: ${res.status}`)
      }
      return res.text()
    },

    async delete(ref) {
      const url = `${baseUrl()}/values/${encodeURIComponent(ref)}`
      const res = await fetch(url, {
        method: "DELETE",
        headers: headers(),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok && res.status !== 404) {
        log.error("Cloudflare KV delete failed", { ref, status: res.status })
      }
    },

    async probe() {
      try {
        const url = `${baseUrl()}/keys?limit=1`
        const res = await fetch(url, {
          headers: headers(),
          signal: AbortSignal.timeout(5_000),
        })
        return res.ok
      } catch {
        return false
      }
    },
  }
}

/**
 * The ONLY way to obtain a Cloudflare KV secret backend: envelope encryption
 * composed over the raw byte store, partitioned to one org via HKDF subkey
 * derivation.
 *
 * Fails closed at construction time — throws when CLAXEDO_CF_KV_URL,
 * CLAXEDO_CF_KV_TOKEN, or the envelope KEK (CLAXEDO_CREDENTIALS_KEK, unless a
 * custom `keyProvider` is supplied) is missing.
 */
export function createEncryptedCloudflareBackend(opts: {
  /** Tenant partition — per-org HKDF subkey; org A ciphertext never decrypts under org B. */
  orgId: string
  /** Env source (defaults to process.env; the Worker populates it via nodejs_compat). */
  env?: EnvLike
  /** Override the env-sourced KEK provider (tests / future CF Secrets Store). */
  keyProvider?: EnvelopeKeyProvider
}): SecretBackend {
  const env = opts.env ?? process.env
  for (const name of ["CLAXEDO_CF_KV_URL", "CLAXEDO_CF_KV_TOKEN"] as const) {
    if (!env[name]?.trim()) {
      throw new Error(`${name} not configured — refusing to construct the hosted credential store`)
    }
  }
  const keys = opts.keyProvider ?? envelopeKeyProviderFromEnv(env)
  return encryptedSecretBackend(createCloudflareKvByteStore(env), keys, { orgId: opts.orgId })
}
