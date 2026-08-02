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
import { Log } from "../../platform/runtime/lib/log"
import {
  encryptedSecretBackend,
  envelopeKeyProviderFromEnv,
  type EnvelopeAdmin,
  type EnvelopeKeyProvider,
} from "./envelope"

const log = Log.create({ service: "credentials-cloudflare" })

type EnvLike = Record<string, string | undefined>

function kvHeaders(env: EnvLike) {
  const token = env.CLAXEDO_CF_KV_TOKEN?.trim()
  if (!token) throw new Error("CLAXEDO_CF_KV_TOKEN not configured")
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
}

function kvBaseUrl(env: EnvLike) {
  const url = env.CLAXEDO_CF_KV_URL?.trim()
  if (!url) throw new Error("CLAXEDO_CF_KV_URL not configured")
  return url.replace(/\/$/, "")
}

/**
 * Raw Cloudflare KV byte store. INTERNAL ON PURPOSE: it stores whatever bytes
 * it is given, so exporting it would reopen the plaintext hole. Do not export.
 */
function createCloudflareKvByteStore(env: EnvLike): SecretBackend {
  const headers = () => kvHeaders(env)
  const baseUrl = () => kvBaseUrl(env)

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
}): SecretBackend & EnvelopeAdmin {
  const env = opts.env ?? process.env
  for (const name of ["CLAXEDO_CF_KV_URL", "CLAXEDO_CF_KV_TOKEN"] as const) {
    if (!env[name]?.trim()) {
      throw new Error(`${name} not configured — refusing to construct the hosted credential store`)
    }
  }
  const keys = opts.keyProvider ?? envelopeKeyProviderFromEnv(env)
  return encryptedSecretBackend(createCloudflareKvByteStore(env), keys, { orgId: opts.orgId })
}

/**
 * Enumerate the KV KEY NAMES the credential backend owns — the only sanctioned
 * enumeration of the hosted store, and the reason a KEK rotation can be
 * completed at all: KV has no other directory, and `hostedOrgCredentials`
 * deliberately returns `[]` from `listCredentials`.
 *
 * This is NOT a hole in the D10 posture and must not grow into one: it reads
 * `/keys`, which returns names only, and has no path that returns a VALUE. A
 * key name is `cf:org/<orgId>/credential/<providerId>` — routing information
 * the KV token holder can already list; the secret stays behind the envelope.
 *
 * Names are returned verbatim because the KV key name IS the backend `ref`
 * (`put` stores under `cf:<id>` and `get` fetches `/values/<ref>`), so the
 * result feeds straight into a rotation sweep. Foreign keys that do not carry
 * the `cf:` scheme are dropped: they were not written by this backend.
 */
export async function listCloudflareCredentialRefs(opts: {
  env?: EnvLike
  /** Restrict to one prefix (e.g. `cf:org/<orgId>/`). */
  prefix?: string
  /** Page size; Cloudflare caps this at 1000. */
  pageSize?: number
  fetchImpl?: typeof fetch
} = {}): Promise<string[]> {
  const env = opts.env ?? process.env
  const request = opts.fetchImpl ?? fetch
  const base = kvBaseUrl(env)
  const headers = kvHeaders(env)
  const refs: string[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    const url = new URL(`${base}/keys`)
    url.searchParams.set("limit", String(opts.pageSize ?? 1000))
    if (opts.prefix) url.searchParams.set("prefix", opts.prefix)
    if (cursor) url.searchParams.set("cursor", cursor)

    const res = await request(url.toString(), { headers, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      log.error("Cloudflare KV key listing failed", { status: res.status })
      throw new Error(`Cloudflare KV key listing failed: ${res.status}`)
    }
    const body = await res.json() as {
      result?: Array<{ name?: unknown }>
      result_info?: { cursor?: unknown }
    }
    const page = Array.isArray(body.result) ? body.result : []
    for (const entry of page) {
      if (typeof entry?.name === "string" && entry.name.startsWith("cf:")) refs.push(entry.name)
    }

    const next = typeof body.result_info?.cursor === "string" ? body.result_info.cursor.trim() : ""
    // Terminate on an empty/absent cursor (Cloudflare's end-of-list signal) and
    // on a repeated one, so a misbehaving proxy cannot spin this loop forever.
    if (!next || seenCursors.has(next) || page.length === 0) break
    seenCursors.add(next)
    cursor = next
  }

  return refs
}
