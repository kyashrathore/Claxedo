import { assertTarget } from "@claxedo/workspace-runtime/host"
import { createVmConnectionSecretResolver } from "@claxedo/server-core/agent-config/connection-secrets"
import type { ConnectionSecretAuthority } from "@claxedo/agent-sdk-runtime"

/**
 * The sandbox half of the connection secret lease: every request carries the
 * proof of the operation that needs the connection, a relay proof for a
 * request or the signed lease of the turn, so a background turn is proven by
 * its own admission and never by whichever request is running at the time.
 */
export function sandboxConnectionSecrets(input: { workspaceId: string; directory: string; authorityUrl: string }) {
  const endpoint = new URL(`/api/runtime-authority/connection-secrets/${encodeURIComponent(input.workspaceId)}`, input.authorityUrl).href
  return createVmConnectionSecretResolver({
    workspaceForDirectory: (directory) => {
      assertTarget(directory, { WORKSPACE_RUNTIME_WORKSPACE_ID: input.workspaceId, WORKSPACE_RUNTIME_DIRECTORY: input.directory })
      return { workspaceId: input.workspaceId }
    },
    resolveLease: async ({ connectionId, providerKey, configRevision, authority, owner }) => {
      if (!authority) throw new Error("Connection secret lease requires the authority its operation was admitted under")
      if (owner.kind !== "person") throw new Error("A sandbox session spends a person's accounts, and this session names none")
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { ...authorizationHeader(authority), "content-type": "application/json" },
        body: JSON.stringify({ connectionId, providerKey, configRevision, ownerActorId: owner.userId,
          ...(authority.kind === "turn" ? { turnLease: authority.lease } : {}) }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Connection secret lease refused (${response.status})`)
      return response.json()
    },
  })
}

function authorizationHeader(authority: ConnectionSecretAuthority): Record<string, string> {
  return authority.kind === "request" ? { authorization: authority.credential } : {}
}
