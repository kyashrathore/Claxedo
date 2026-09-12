import { claxedoCredentialRequest, type ClaxedoCredentialRequestInput } from "@/platform/api/credential-request"
import { readArray, readBoolean, readField, readFiniteNumber, readString } from "@/lib/record"
import type { AICredentialVerification, AIDiscoveryItem, AIDiscoveryProbe, AIUsageWindow } from "./ai-connect-state"

export type AIConnectRequest = (input?: ClaxedoCredentialRequestInput, init?: RequestInit) => Promise<Response>

export type AIVerificationResult = {
  credentialId: string
  providerId: string
  result: AICredentialVerification
  /** The plan's windows, when the provider's check was a usage read. */
  usage?: AIUsageWindow[]
}

/**
 * A credential the server named back to us, reduced to what verification needs.
 * The save, list and discovery routes each spell the id differently on the wire;
 * every one of them is parsed into this single shape.
 */
type CredentialRef = { credentialId: string; providerId: string }

export async function discoverAIConnections(input: {
  serverUrl?: string
  request?: AIConnectRequest
}) {
  const res = await (input.request ?? claxedoCredentialRequest)({ serverUrl: input.serverUrl, action: "discover" }, {
    method: "POST",
  })
  const body: unknown = await res.json()
  const discoveryId = readString(body, "discovery_id")
  const items = readArray(body, "items")
  if (discoveryId === undefined || !items) {
    throw new Error("Credential discovery returned an invalid response")
  }
  return {
    discoveryId,
    items: items.flatMap(redactedDiscoveryItem),
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
  const saved = readArray(await res.json(), "saved")
  if (!saved) throw new Error("Credential discovery save returned an invalid response")
  const credentials = saved.flatMap(redactedSavedCredential)
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
  const credential = redactedCredentialId(readField(await res.json(), "credential"))
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
  const body: unknown = await res.json()
  const result = readField(body, "result")
  if (!isVerificationResult(result)) throw new Error("Credential verification returned an invalid response")
  const usage = redactedUsage(readField(body, "usage"))
  return { credentialId: input.credentialId, providerId: input.providerId, result, ...(usage ? { usage } : {}) }
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
  const credentials = readArray(await res.json(), "credentials")
  if (!credentials) throw new Error("Credential listing returned an invalid response")
  return credentials.flatMap((value) => {
    const credential = redactedCredentialId(value)
    return credential ? [credential] : []
  })
}

function redactedDiscoveryItem(value: unknown): AIDiscoveryItem[] {
  const providerId = readString(value, "provider_id")
  const kind = readString(value, "kind")
  const label = readString(value, "label")
  const origin = readString(value, "origin")
  if (providerId === undefined || kind === undefined || label === undefined || origin === undefined) return []
  const accountId = readString(value, "account_id")
  const freshUntil = readFiniteNumber(value, "fresh_until")
  const probe = redactedProbe(readField(value, "probe"))
  return [{
    providerId,
    kind,
    label,
    origin,
    ...(accountId === undefined ? {} : { accountId }),
    ...(freshUntil === undefined ? {} : { freshUntil }),
    ...(readBoolean(value, "already_connected") === true ? { alreadyConnected: true } : {}),
    ...(probe ? { probe } : {}),
  }]
}

function redactedProbe(value: unknown): AIDiscoveryProbe | undefined {
  const state = readString(value, "state")
  if (state === "working") {
    const usage = redactedUsage(readField(value, "usage"))
    return { state: "working", ...(usage ? { usage } : {}) }
  }
  if (state !== "broken" && state !== "unknown") return undefined
  return { state, reason: readString(value, "reason") ?? "" }
}

function redactedUsage(value: unknown): AIUsageWindow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const windows = value.flatMap((entry): AIUsageWindow[] => {
    const window = readString(entry, "window")
    const usedPercent = readFiniteNumber(entry, "usedPercent")
    if (window === undefined || usedPercent === undefined) return []
    return [{ window, usedPercent, resetsAt: readFiniteNumber(entry, "resetsAt") ?? null }]
  })
  return windows.length ? windows : undefined
}

function redactedCredentialId(value: unknown): CredentialRef | undefined {
  const credentialId = readString(value, "id")
  const providerId = readString(value, "provider_id")
  if (credentialId === undefined || providerId === undefined) return undefined
  return { credentialId, providerId }
}

function redactedSavedCredential(value: unknown): CredentialRef[] {
  const credentialId = readString(value, "credential_id")
  const providerId = readString(value, "provider_id")
  if (credentialId === undefined || providerId === undefined) return []
  return [{ credentialId, providerId }]
}

function isVerificationResult(value: unknown): value is AICredentialVerification {
  return value === "ok" || value === "auth_failed" || value === "no_billing" || value === "rate_capped" || value === "expired"
}
