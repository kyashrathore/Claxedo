import { connectionProviderId } from "@claxedo/connections"
import type { ControlPlaneCredentials } from "../control-plane/services"
import type { ConnectionsPort } from "@claxedo/workgraph"
import type { ConnectionID, WorkGraphContext } from "@claxedo/workgraph/contracts"

export type HostedConnectionMetadata = Readonly<{
  id: ConnectionID
  ownerUserId: string
  orgId: string
  integrationId: "github" | "linear" | "jira"
  capabilities: readonly string[]
  status: "connected" | "degraded" | "broken"
  tokenType?: "bearer" | "basic"
  fields?: Readonly<Record<string, string>>
  accountLabel?: string
}>

/**
 * Worker-safe ConnectionsPort. Durable rows contain only metadata; the
 * encrypted org credential is opened just-in-time inside withAuthorization.
 */
export function createHostedWorkGraphConnectionsPort(input: Readonly<{
  resolveMetadata(context: WorkGraphContext, connectionIds: readonly ConnectionID[]): Promise<readonly HostedConnectionMetadata[]>
  credentials(orgId: string): ControlPlaneCredentials
}>): ConnectionsPort {
  return {
    async resolveCapabilities(context, request) {
      const rows = await input.resolveMetadata(context, request.connectionIds)
      return rows.flatMap((row) => {
        if (row.orgId !== context.organizationId ||
          !request.connectionIds.includes(row.id) || !row.capabilities.includes(request.capability)) return []
        return [{
          id: row.id,
          integrationId: row.integrationId,
          capability: request.capability,
          scope: "team" as const,
          ...(row.accountLabel ? { accountLabel: row.accountLabel } : {}),
          withAuthorization: async <Result>(use: (authorization: {
            token: string
            tokenType: "bearer" | "basic"
            fields?: Readonly<Record<string, string>>
          }) => Promise<Result>) => {
            if (row.status !== "connected" || !row.tokenType) throw new HostedConnectionReconnectRequiredError(row.id)
            const credentials = input.credentials(row.orgId)
            if (!credentials.resolveCredentialSecret) throw new HostedConnectionCredentialUnavailableError(row.id)
            const secret = await credentials.resolveCredentialSecret(connectionProviderId(row.id))
            if (!secret) throw new HostedConnectionCredentialUnavailableError(row.id)
            return await use({
              token: secret,
              tokenType: row.tokenType,
              ...(row.fields ? { fields: row.fields } : {}),
            })
          },
          reportAuthFailure: async (reason: string) => {
            const update = input.credentials(row.orgId).updateCredentialStatus
            if (update) await update(connectionProviderId(row.id), "error", reason)
          },
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
