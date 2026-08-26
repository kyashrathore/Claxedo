import { getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"

export type ClaxedoCredentialRequestInput = {
  serverUrl?: string
  providerId?: string
  credentialId?: string
  action?: "discover" | "save-discovered" | "verify" | "scope"
}

export async function claxedoCredentialRequest(input?: ClaxedoCredentialRequestInput, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("Accept", "application/json")
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")

  const res = await globalThis.fetch(
    new URL(credentialRoute(input), normalizeUrl(input?.serverUrl) ?? getClaxedoServerUrl()),
    { ...init, headers },
  )
  if (res.ok) return res

  throw new Error(await claxedoCredentialErrorMessage(res))
}

function credentialRoute(input?: ClaxedoCredentialRequestInput) {
  if (input?.credentialId && (input.action === "verify" || input.action === "scope")) {
    return `/api/claxedo/credentials/${encodeURIComponent(input.credentialId)}/${input.action}`
  }
  if (input?.action === "discover" || input?.action === "save-discovered") {
    return `/api/claxedo/credentials/${input.action}`
  }
  if (input?.providerId) return `/api/claxedo/credentials/provider/${encodeURIComponent(input.providerId)}`
  return "/api/claxedo/credentials"
}

async function claxedoCredentialErrorMessage(res: Response) {
  const text = await res.text().catch(() => "")
  if (!text) return `Request failed: ${res.status}`

  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown }
    if (body.error && typeof body.error === "object" && "message" in body.error) {
      const message = body.error.message
      if (typeof message === "string" && message.trim()) return message
    }
    if (typeof body.error === "string" && body.error.trim()) return body.error
    if (typeof body.message === "string" && body.message.trim()) return body.message
  } catch {
    return text
  }

  return text
}
