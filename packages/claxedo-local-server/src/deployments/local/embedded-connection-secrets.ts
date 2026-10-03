import type { ConnectionSecretResolver } from "@claxedo/agent-runtime-contract"
import { ConnectionUnavailableError, createLocalConnectionSecretResolver } from "@claxedo/server-core/agent-config/connection-secrets"
import { credentialById, resolveSecretById } from "@claxedo/server-core/credentials/registry"
import { localConnectionSecretScope } from "./connection-secret-scope"

export const resolveEmbeddedConnectionSecrets: ConnectionSecretResolver = (request) => {
  const scope = localConnectionSecretScope(request.owner)
  if (Object.keys(request.descriptor.secretRefs ?? {}).length === 0 && !scope.machineLoginAllowed) {
    throw new ConnectionUnavailableError(request.descriptor.connectionId, "missing_secret")
  }
  return createLocalConnectionSecretResolver({ resolveReference: async ({ reference }) => {
    const credential = credentialById(reference, { onOutage: "empty" })
    if (!credential || !scope.admits(credential)) return { leaseGeneration: "missing" }
    const value = await resolveSecretById(reference)
    return {
      ...(value ? { value } : {}),
      leaseGeneration: String(credential.updated_at),
      ...(credential.expires_at === null || credential.expires_at === undefined
        ? credential.status === "expired" ? { expiresAt: 0 } : {}
        : { expiresAt: credential.expires_at }),
      ...(credential.status === "revoked" ? { revoked: true } : {}),
    }
  } })(request)
}
