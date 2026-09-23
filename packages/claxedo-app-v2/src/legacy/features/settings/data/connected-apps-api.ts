import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { onlyStrings, readArray, readField, readString } from "@/lib/record"
import { betterAuthApiError } from "@/platform/auth/better-auth-api-error"

export type ConnectedApp = {
  /** The consent record, which is what revoking deletes. */
  consentId: string
  clientId: string
  name?: string
  scopes: string[]
  grantedAt?: string
}

async function authApi(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  if (!headers.has("accept")) headers.set("accept", "application/json")
  const response = await authFetch(new URL(`/api/auth${path}`, getClaxedoServerUrl()).toString(), {
    credentials: "include",
    ...init,
    headers,
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw betterAuthApiError(body, response.status, "Connected applications are unavailable")
  return body
}

function consentRow(value: unknown): ConnectedApp | undefined {
  const consentId = readString(value, "id")
  const clientId = readString(value, "clientId")
  if (!consentId || !clientId) return undefined
  const grantedAt = readString(value, "createdAt")
  return {
    consentId,
    clientId,
    scopes: onlyStrings(readArray(value, "scopes")),
    ...(grantedAt ? { grantedAt } : {}),
  }
}

/**
 * Every application this account has consented to, named where the
 * authorization server still knows the client.
 *
 * The name is a second read per row because Better Auth's consent records
 * carry only the client id; a client the deployment has since deleted answers
 * 404 there, and the row still has to appear so the consent can be revoked.
 */
export async function listConnectedApps(): Promise<ConnectedApp[]> {
  const rows = await authApi("/oauth2/get-consents")
  const consents = (Array.isArray(rows) ? rows : []).map(consentRow).filter((row): row is ConnectedApp => !!row)
  return await Promise.all(consents.map(async (row) => {
    const name = await readClientName(row.clientId)
    return name ? { ...row, name } : row
  }))
}

async function readClientName(clientId: string) {
  try {
    const client = await authApi(`/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`)
    return readString(client, "client_name") ?? readString(readField(client, "client"), "client_name")
  } catch {
    return undefined
  }
}

export async function revokeConnectedApp(consentId: string): Promise<void> {
  await authApi("/oauth2/delete-consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: consentId }),
  })
}
