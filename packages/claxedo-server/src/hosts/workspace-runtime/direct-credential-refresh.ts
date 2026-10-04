import { providerDirect, type DirectCredentialRefresh } from "@claxedo/agent-runtime-contract"

/**
 * The sandbox half of a direct credential's renewal: the running turn's lease
 * proves the request, and the control plane answers the workspace owner's
 * renewed account or nothing.
 */
export function sandboxDirectCredentialRefresh(input: { workspaceId: string; authorityUrl: string }): DirectCredentialRefresh {
  const endpoint = new URL(`/api/runtime-authority/credential-refresh/${encodeURIComponent(input.workspaceId)}`, input.authorityUrl).href
  return async ({ authority, credentialProviderId, rejectedExpiresAt }) => {
    if (authority.kind !== "turn") return undefined
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnLease: authority.lease, credentialProviderId, ...(rejectedExpiresAt === undefined ? {} : { rejectedExpiresAt }) }),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 409) return undefined
    if (!response.ok) throw new Error(`Credential refresh refused (${response.status})`)
    const row = providerDirect(await response.json())
    if (!row) throw new Error("Credential refresh answered a malformed credential")
    return row
  }
}
