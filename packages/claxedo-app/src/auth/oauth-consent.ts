import { readBoolean, readString } from "@claxedo/helpers/readers"
import { authResponseBody, betterAuthApiError } from "./better-auth-error"
import { apiOrigin } from "./origins"

export type OAuthConsentSubmission = {
  accept: boolean
  oauthQuery: string
  scope?: string
}

export type OAuthConsentClient = {
  clientId: string
  name?: string
  uri?: string
}

export const MCP_CONSENT_SCOPES = [
  { scope: "claxedo:read", label: "Read sessions, workspaces and what needs you" },
  { scope: "claxedo:act", label: "Start sessions and send prompts" },
  { scope: "claxedo:approve", label: "Answer permission prompts on your behalf" },
  { scope: "claxedo:admin", label: "Create and destroy workspaces" },
] as const

export const MCP_CONSENT_DEFAULTS = ["claxedo:read", "claxedo:act"] as const

const DEPLOYMENT_CLIENT_NAMES: ReadonlyMap<string, string> = new Map([
  ["claxedo-cli", "Claxedo CLI"],
  ["claxedo-desktop", "Claxedo Desktop"],
])

export function deploymentClientName(clientId: string | undefined): string | undefined {
  return clientId === undefined ? undefined : DEPLOYMENT_CLIENT_NAMES.get(clientId)
}

export type ConsentRequester =
  | { kind: "deployment"; name: string }
  | { kind: "unverified"; clientId: string; declaredName?: string; redirectHost?: string }

function redirectHost(search: string) {
  const redirect = new URLSearchParams(search).get("redirect_uri")
  if (!redirect || !URL.canParse(redirect)) return undefined
  return new URL(redirect).host || undefined
}

export function consentRequester(search: string, clientId: string | undefined, declaredName: string | undefined): ConsentRequester {
  const deploymentName = deploymentClientName(clientId)
  if (deploymentName !== undefined) return { kind: "deployment", name: deploymentName }
  const host = redirectHost(search)
  return {
    kind: "unverified",
    clientId: clientId ?? "",
    ...(declaredName ? { declaredName } : {}),
    ...(host ? { redirectHost: host } : {}),
  }
}

export function consentDefaults(requester: ConsentRequester): readonly string[] {
  return requester.kind === "deployment" ? MCP_CONSENT_DEFAULTS : []
}

export async function readOAuthConsentClient(clientId: string): Promise<OAuthConsentClient> {
  const url = new URL("/api/auth/oauth2/public-client", apiOrigin())
  url.searchParams.set("client_id", clientId)
  const response = await fetch(url.toString(), { credentials: "include", headers: { accept: "application/json" } })
  const body = await authResponseBody(response)
  if (!response.ok) {
    throw betterAuthApiError(body, response.status, "Could not identify the requesting application")
  }
  const name = readString(body, "client_name")
  const uri = readString(body, "client_uri")
  return { clientId, ...(name ? { name } : {}), ...(uri ? { uri } : {}) }
}

export async function submitOAuthConsent(input: OAuthConsentSubmission): Promise<string> {
  const response = await fetch(new URL("/api/auth/oauth2/consent", apiOrigin()).toString(), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accept: input.accept,
      oauth_query: input.oauthQuery,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    }),
  })
  const body = await authResponseBody(response)
  if (!response.ok) throw betterAuthApiError(body, response.status, "Consent failed")
  const url = readString(body, "url")
  if (readBoolean(body, "redirect") !== true || url === undefined) {
    throw new Error("Authorization server did not return a consent redirect")
  }
  const destination = new URL(url)
  if ((destination.protocol !== "http:" && destination.protocol !== "https:") || destination.username || destination.password) {
    throw new Error("Authorization server returned an invalid consent redirect")
  }
  return destination.toString()
}

export function requestedScopes(search: string) {
  return (new URLSearchParams(search).get("scope") ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
}

export function offeredMcpScopes(scopes: readonly string[], clientId: string | undefined) {
  const requested = new Set(scopes)
  return MCP_CONSENT_SCOPES.filter((entry) => {
    if (!requested.has(entry.scope)) return false
    if (entry.scope !== "claxedo:admin") return true
    return deploymentClientName(clientId) !== undefined
  })
}

export function carriedScopes(scopes: readonly string[]) {
  return scopes.filter((scope) => !MCP_CONSENT_SCOPES.some((entry) => entry.scope === scope))
}
