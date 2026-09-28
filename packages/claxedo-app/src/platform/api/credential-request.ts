import { getClaxedoServerUrl, isLoopbackHostname, normalizeUrl } from "@/platform/api/api"
import { readField, readString, readStringArray, recordOrEmpty } from "@/lib/record"

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
  action?:
    | "discover"
    | "save-discovered"
    | "verify"
    | "scope"
    | "reconnect"
    | "effective"
    | "activate"
    | "machine-logins"
    | "account-sources"
  /** Narrows a machine-login read to one harness. */
  harness?: string
  /** Asks the harness again rather than reusing the answer it last gave. */
  fresh?: boolean
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
    const query = new URLSearchParams()
    if (input.harness !== undefined) query.set("harness", input.harness)
    if (input.fresh === true) query.set("fresh", "1")
    const search = query.size > 0 ? `?${query.toString()}` : ""
    return `/api/claxedo/credentials/machine-logins${search}`
  }
  if (
    input?.action === "discover"
    || input?.action === "save-discovered"
    || input?.action === "effective"
    || input?.action === "activate"
    || input?.action === "account-sources"
  ) {
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

/**
 * Store one provider API key on the hosted plane, which keeps harness keys
 * under its own `PUT /auth/:providerID?harness=<id>` (`HostedShellRoutes` →
 * `hostedPiCredentials.putPiCredential` → the plane's per-org credential
 * store) and serves no `/api/claxedo/credentials`. The body is the plane's
 * `{ auth: { key } }`; the plane refuses with its own sentence — a provider
 * that signs in rather than taking a key, or a deployment whose credential
 * store is off — and that sentence is what the thrown error carries.
 */
export async function putHostedProviderKey(input: {
  serverUrl: string
  providerId: string
  harness: string
  key: string
  directory?: string
  request: (url: URL, init?: RequestInit) => Promise<Response>
}) {
  const url = new URL(`/auth/${encodeURIComponent(input.providerId)}`, input.serverUrl)
  url.searchParams.set("harness", input.harness)
  if (input.directory) url.searchParams.set("directory", input.directory)
  const res = await input.request(url, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ auth: { key: input.key } }),
  })
  if (!res.ok) throw new Error(await claxedoCredentialErrorMessage(res))
  await res.text().catch(() => undefined)
}

/**
 * Whose account a person's sessions spend for one provider: their own, or the
 * organization's team account. Only the chosen one is spent; a provider the
 * person never chose for is "own".
 */
export type AccountSource = "own" | "team"

/** The `sources` map both the local and the hosted routes answer with, by provider id. */
export function readAccountSources(body: unknown): Map<string, AccountSource> {
  const sources = new Map<string, AccountSource>()
  for (const [providerId, source] of Object.entries(recordOrEmpty(readField(body, "sources")))) {
    if (source !== "own" && source !== "team") throw new Error("Account source response is invalid")
    sources.set(providerId, source)
  }
  return sources
}

function hostedSourcesUrl(serverUrl: string, path: string, harness: string) {
  const url = new URL(path, serverUrl)
  url.searchParams.set("harness", harness)
  return url
}

/**
 * The hosted plane's answer for one harness: which account the person chose
 * per provider, and the providers the organization holds a team account for.
 */
export async function getHostedAccountSources(input: {
  serverUrl: string
  harness: string
  request: (url: URL, init?: RequestInit) => Promise<Response>
}) {
  const res = await input.request(hostedSourcesUrl(input.serverUrl, "/auth/sources", input.harness), {
    headers: { Accept: "application/json" },
  })
  if (!res.ok) throw new Error(await claxedoCredentialErrorMessage(res))
  const body: unknown = await res.json()
  return { sources: readAccountSources(body), team: new Set(readStringArray(body, "team") ?? []) }
}

export async function putHostedAccountSource(input: {
  serverUrl: string
  providerId: string
  harness: string
  source: AccountSource
  request: (url: URL, init?: RequestInit) => Promise<Response>
}) {
  const url = hostedSourcesUrl(input.serverUrl, `/auth/${encodeURIComponent(input.providerId)}/source`, input.harness)
  const res = await input.request(url, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ source: input.source }),
  })
  if (!res.ok) throw new Error(await claxedoCredentialErrorMessage(res))
  await res.text().catch(() => undefined)
}
