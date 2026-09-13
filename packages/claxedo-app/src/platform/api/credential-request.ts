import { getClaxedoServerUrl, isLoopbackHostname, normalizeUrl } from "@/platform/api/api"
import { readField, readString } from "@/lib/record"

/** Same-origin in desktop dev so Vite can proxy credential routes (no CORS). */
export function credentialRequestOrigin(input?: ClaxedoCredentialRequestInput): string {
  const configured = normalizeUrl(input?.serverUrl) ?? getClaxedoServerUrl()
  if (typeof window === "undefined" || !import.meta.env.DEV) return configured
  try {
    const page = new URL(window.location.href)
    if (page.protocol !== "http:" && page.protocol !== "https:") return configured
    const server = new URL(configured)
    if (isLoopbackHostname(page.hostname) && isLoopbackHostname(server.hostname) && page.origin !== server.origin) {
      return page.origin
    }
  } catch {
    return configured
  }
  return configured
}

export type ClaxedoCredentialRequestInput = {
  serverUrl?: string
  providerId?: string
  /** One stored row: named alone it is the row itself, with an action its subpath. */
  credentialId?: string
  action?: "discover" | "save-discovered" | "verify" | "scope" | "reconnect" | "effective" | "activate" | "machine-logins"
  /** Narrows a machine-login read to one harness. */
  harness?: string
}

export async function claxedoCredentialRequest(
  input?: ClaxedoCredentialRequestInput,
  init?: RequestInit & { accept?: readonly number[] },
) {
  const headers = new Headers(init?.headers)
  headers.set("Accept", "application/json")
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")

  const res = await globalThis.fetch(
    new URL(credentialRoute(input), credentialRequestOrigin(input)),
    { ...init, headers },
  )
  if (res.ok || init?.accept?.includes(res.status)) return res

  throw new Error(await claxedoCredentialErrorMessage(res))
}

function credentialRoute(input?: ClaxedoCredentialRequestInput) {
  if (input?.credentialId && (input.action === "verify" || input.action === "scope" || input.action === "reconnect")) {
    return `/api/claxedo/credentials/${encodeURIComponent(input.credentialId)}/${input.action}`
  }
  if (input?.action === "machine-logins") {
    const harness = input.harness === undefined ? "" : `?harness=${encodeURIComponent(input.harness)}`
    return `/api/claxedo/credentials/machine-logins${harness}`
  }
  if (input?.action === "discover" || input?.action === "save-discovered" || input?.action === "effective" || input?.action === "activate") {
    return `/api/claxedo/credentials/${input.action}`
  }
  if (input?.credentialId) return `/api/claxedo/credentials/${encodeURIComponent(input.credentialId)}`
  if (input?.providerId) return `/api/claxedo/credentials/provider/${encodeURIComponent(input.providerId)}`
  return "/api/claxedo/credentials"
}

async function claxedoCredentialErrorMessage(res: Response) {
  const text = await res.text().catch(() => "")
  if (!text) return `Request failed: ${res.status}`

  try {
    const body: unknown = JSON.parse(text)
    const failure = readField(body, "error")
    // The cause the route logged, when it sent one. "Failed to discover
    // credentials" names the route; only this names what broke inside it.
    const cause = readString(readField(readField(failure, "details"), "detail"), "message")
    if (cause?.trim()) return cause
    const nested = readString(failure, "message")
    if (nested?.trim()) return nested
    const error = readString(body, "error")
    if (error?.trim()) return error
    const message = readString(body, "message")
    if (message?.trim()) return message
  } catch {
    return text
  }

  return text
}
