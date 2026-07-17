import { claxedoCredentialRequest, type ClaxedoCredentialRequestInput } from "@/platform/api/credential-request"
import type { AICredentialVerification, AIDiscoveryItem } from "./ai-connect-state"

export type AIConnectRequest = (input?: ClaxedoCredentialRequestInput, init?: RequestInit) => Promise<Response>

export type AIVerificationResult = {
  credentialId: string
  providerId: string
  result: AICredentialVerification
}

export async function discoverAIConnections(input: {
  serverUrl?: string
  request?: AIConnectRequest
}) {
  const res = await (input.request ?? claxedoCredentialRequest)({ serverUrl: input.serverUrl, action: "discover" }, {
    method: "POST",
  })
  const body = await res.json() as { discovery_id?: unknown; items?: unknown }
  if (typeof body.discovery_id !== "string" || !Array.isArray(body.items)) {
    throw new Error("Credential discovery returned an invalid response")
  }
  return {
    discoveryId: body.discovery_id,
    items: body.items.flatMap(redactedDiscoveryItem),
  }
}

export async function saveDiscoveredAIConnections(input: {
  serverUrl?: string
  discoveryId: string
  items: Array<{ providerId: string; accountId?: string; scope: "local" | "shared" }>
  request?: AIConnectRequest
}) {
  const request = input.request ?? claxedoCredentialRequest
  const res = await request({ serverUrl: input.serverUrl, action: "save-discovered" }, {
    method: "POST",
    body: JSON.stringify({
      discovery_id: input.discoveryId,
      items: input.items.map((item) => ({
        provider_id: item.providerId,
        ...(item.accountId ? { account_id: item.accountId } : {}),
        scope: item.scope,
      })),
    }),
  })
  const body = await res.json() as { saved?: unknown }
  if (!Array.isArray(body.saved)) throw new Error("Credential discovery save returned an invalid response")
  const credentials = body.saved.flatMap(redactedSavedCredential)
  if (credentials.length !== input.items.length) throw new Error("Credential discovery save returned incomplete results")
  return Promise.all(credentials.map((credential) => verifyAIConnection({
    ...credential,
    serverUrl: input.serverUrl,
    request,
  })))
}

export async function connectAIKey(input: {
  serverUrl?: string
  providerId: string
  providerName: string
  apiKey: string
  scope: "local" | "shared"
  request?: AIConnectRequest
}) {
  const request = input.request ?? claxedoCredentialRequest
  const res = await request({ serverUrl: input.serverUrl }, {
    method: "PUT",
    body: JSON.stringify({
      provider_id: input.providerId,
      kind: "api_key",
      source: input.scope === "local" ? "local_only" : "managed",
      scope: input.scope,
      label: input.providerName,
      secret: input.apiKey,
    }),
  })
  const body = await res.json() as { credential?: unknown }
  const credential = redactedCredentialId(body.credential)
  if (!credential) throw new Error("Credential save returned an invalid response")
  return verifyAIConnection({ ...credential, serverUrl: input.serverUrl, request })
}

export async function verifyAIConnection(input: {
  serverUrl?: string
  credentialId: string
  providerId: string
  request?: AIConnectRequest
}) {
  const res = await (input.request ?? claxedoCredentialRequest)({
    serverUrl: input.serverUrl,
    credentialId: input.credentialId,
    action: "verify",
  }, { method: "POST" })
  const body = await res.json() as { result?: unknown }
  if (!isVerificationResult(body.result)) throw new Error("Credential verification returned an invalid response")
  return { credentialId: input.credentialId, providerId: input.providerId, result: body.result }
}

export async function verifyProviderAIConnections(input: {
  serverUrl?: string
  providerId: string
  request?: AIConnectRequest
}) {
  const request = input.request ?? claxedoCredentialRequest
  const credentials = (await listCredentialIds(input.serverUrl, request)).filter(
    (credential) => credential.providerId === input.providerId,
  )
  if (credentials.length === 0) throw new Error("The provider connected, but no saved credential was available to verify.")
  return Promise.all(credentials.map((credential) => verifyAIConnection({
    ...credential,
    serverUrl: input.serverUrl,
    request,
  })))
}

async function listCredentialIds(serverUrl: string | undefined, request: AIConnectRequest) {
  const res = await request({ serverUrl })
  const body = await res.json() as { credentials?: unknown }
  if (!Array.isArray(body.credentials)) throw new Error("Credential listing returned an invalid response")
  return body.credentials.flatMap((value) => {
    const credential = redactedCredentialId(value)
    return credential ? [credential] : []
  })
}

function redactedDiscoveryItem(value: unknown): AIDiscoveryItem[] {
  if (!value || typeof value !== "object") return []
  const item = value as Record<string, unknown>
  if (
    typeof item.provider_id !== "string" ||
    typeof item.kind !== "string" ||
    typeof item.label !== "string" ||
    typeof item.origin !== "string"
  ) return []
  return [{
    providerId: item.provider_id,
    kind: item.kind,
    label: item.label,
    origin: item.origin,
    ...(typeof item.account_id === "string" ? { accountId: item.account_id } : {}),
    ...(typeof item.fresh_until === "number" ? { freshUntil: item.fresh_until } : {}),
    ...(item.already_connected === true ? { alreadyConnected: true } : {}),
  }]
}

function redactedCredentialId(value: unknown) {
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.id !== "string" || typeof item.provider_id !== "string") return
  return { credentialId: item.id, providerId: item.provider_id }
}

function redactedSavedCredential(value: unknown) {
  if (!value || typeof value !== "object") return []
  const item = value as Record<string, unknown>
  if (typeof item.credential_id !== "string" || typeof item.provider_id !== "string") return []
  return [{ credentialId: item.credential_id, providerId: item.provider_id }]
}

function isVerificationResult(value: unknown): value is AICredentialVerification {
  return value === "ok" || value === "auth_failed" || value === "no_billing" || value === "rate_capped" || value === "expired"
}
