import { getClaxedoServerUrl, normalizeUrl } from "@/shared/data/api"

export async function claxedoCredentialRequest(input?: { serverUrl?: string; providerId?: string }, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("Accept", "application/json")
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")

  const res = await globalThis.fetch(
    new URL(
      input?.providerId
        ? `/api/claxedo/credentials/provider/${encodeURIComponent(input.providerId)}`
        : "/api/claxedo/credentials",
      normalizeUrl(input?.serverUrl) ?? getClaxedoServerUrl(),
    ),
    { ...init, headers },
  )
  if (res.ok) return res

  throw new Error(await claxedoCredentialErrorMessage(res))
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
