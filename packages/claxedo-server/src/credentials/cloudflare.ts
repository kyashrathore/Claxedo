/**
 * Cloudflare secret backend — stores secrets in Cloudflare Workers KV.
 *
 * Used for hosted or cloud-deployed Claxedo where secrets should not
 * live on disk. Requires CLAXEDO_CF_KV_URL and CLAXEDO_CF_KV_TOKEN env vars.
 */

import type { SecretBackend } from "./types"
import { Log } from "../log"

const log = Log.create({ service: "credentials-cloudflare" })

function kvUrl() {
  return process.env.CLAXEDO_CF_KV_URL
}

function kvToken() {
  return process.env.CLAXEDO_CF_KV_TOKEN
}

export function createCloudflareBackend(): SecretBackend {
  function headers() {
    const token = kvToken()
    if (!token) throw new Error("CLAXEDO_CF_KV_TOKEN not configured")
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
  }

  function baseUrl() {
    const url = kvUrl()
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
