import type { ConnectionsService } from "@claxedo/connections"
import type { ConnectionCapabilityHandle, ConnectionsPort } from "@claxedo/workgraph"
import { ConnectionIDSchema, type WorkGraphContext } from "@claxedo/workgraph/contracts"

/**
 * Adapts the shared Connections service to WorkGraph's exact-ID, team-scoped
 * capability port. Tokens are resolved only inside `withAuthorization` and
 * are never returned by the adapter itself.
 */
export function createWorkGraphConnectionsPort(input: Readonly<{
  service: ConnectionsService
  resolveTeamOwner(context: WorkGraphContext): string | undefined
}>): ConnectionsPort {
  return {
    async resolveCapabilities(context, request) {
      if (context.access.mode !== "owner") return []
      const teamOwner = input.resolveTeamOwner(context)
      const rows = await Promise.all(request.connectionIds.map((id) => input.service.getById(id)))
      return rows.flatMap((row, index): ConnectionCapabilityHandle[] => {
        if (!row || row.id !== request.connectionIds[index]) return []
        if (row.owner !== teamOwner) return []
        if (!row.grantedCapabilities.includes(request.capability)) return []
        return [{
          id: ConnectionIDSchema.parse(row.id),
          integrationId: row.integrationId,
          capability: request.capability,
          scope: "team",
          ...(row.accountLabel ? { accountLabel: row.accountLabel } : {}),
          withAuthorization: async (use) => {
            const result = await input.service.getToken(row.id, request.capability)
            if (!result.ok) throw Object.assign(new Error("Connection authorization unavailable"), { status: result.status })
            return use(result.response)
          },
          reportAuthFailure: (reason) => input.service.reportAuthFailure(row.id, reason),
        }]
      })
    },
  }
}

export class HostedConnectionCredentialUnavailableError extends Error {
  readonly code = "hosted_connection_credential_unavailable"

  constructor(connectionId: string) {
    super(`Credential for Connection ${connectionId} is unavailable`)
  }
}

export class HostedConnectionReconnectRequiredError extends Error {
  readonly code = "hosted_connection_reconnect_required"
  readonly status = 409

  constructor(connectionId: string) {
    super(`Connection ${connectionId} requires reconnect`)
  }
}
