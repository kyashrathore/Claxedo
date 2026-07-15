import type { ConnectionsPort } from "@claxedo/workgraph"
import type { ConnectionID, WorkGraphContext } from "@claxedo/workgraph/contracts"
import {
  createGitHubSourceIssueConnector,
  createJiraSourceIssueConnector,
  createLinearSourceIssueConnector,
  type SourceIssue,
  type SourceIssueConnector,
} from "@claxedo/workgraph/connectors"

export const CONNECTION_OPERATION_TOOLS = {
  list: "connection_work_source_list",
  comment: "connection_work_source_comment",
  update: "connection_work_source_update",
} as const

export type ConnectionOperation =
  | Readonly<{ type: "list"; providerUserId: string; filters: Readonly<Record<string, string>>; cursor?: string }>
  | Readonly<{ type: "comment"; externalId: string; body: string; idempotencyKey: string }>
  | Readonly<{ type: "update"; externalId: string; status?: string; body?: string; idempotencyKey: string }>

export type ConnectionOperationIdentity = Readonly<{
  attemptId: string
  sessionId: string
  workspaceId: string
  connectionId: ConnectionID
}>

export type ConnectionOperationBinding = Readonly<{
  context: WorkGraphContext
  ownerPartition: string
  attemptId: string
  sessionId: string
  workspaceId: string
  connectionIds: readonly ConnectionID[]
  tools: readonly string[]
}>

export type ConnectionOperationBindingPort = Readonly<{
  resolve(identity: Omit<ConnectionOperationIdentity, "connectionId">): Promise<ConnectionOperationBinding | undefined>
}>

export class ConnectionOperationDeniedError extends Error {
  readonly code = "connection_operation_denied"
}

export function createConnectionOperationBroker(input: Readonly<{
  bindings: ConnectionOperationBindingPort
  connections: ConnectionsPort
  connectors?: Readonly<Record<string, SourceIssueConnector>>
}>) {
  const connectors = input.connectors ?? {
    github: createGitHubSourceIssueConnector(),
    linear: createLinearSourceIssueConnector(),
    jira: createJiraSourceIssueConnector(),
  }
  return {
    async execute(
      identity: ConnectionOperationIdentity,
      operation: ConnectionOperation,
      principal: Readonly<{ ownerUserId: string; ownerPartition: string }>,
    ) {
      const binding = await input.bindings.resolve(identity)
      const tool = CONNECTION_OPERATION_TOOLS[operation.type]
      if (!binding || binding.context.ownerUserId !== principal.ownerUserId || binding.ownerPartition !== principal.ownerPartition ||
        binding.attemptId !== identity.attemptId || binding.sessionId !== identity.sessionId ||
        binding.workspaceId !== identity.workspaceId || !binding.connectionIds.includes(identity.connectionId) ||
        !binding.tools.includes(tool)) throw new ConnectionOperationDeniedError("Connection operation is not bound to this Attempt")
      const handles = await input.connections.resolveCapabilities(binding.context, {
        connectionIds: [identity.connectionId],
        capability: "work-source",
      })
      const handle = handles.length === 1 && handles[0]?.id === identity.connectionId ? handles[0] : undefined
      const provider = handle?.integrationId === "atlassian" ? "jira" : handle?.integrationId
      const connector = provider ? connectors[provider] : undefined
      if (!handle || !connector || connector.provider !== provider) {
        throw new ConnectionOperationDeniedError("Connection capability is unavailable")
      }
      return handle.withAuthorization(async (authorization) => {
        if (operation.type === "list") {
          const result = await connector.list(authorization, operation)
          return { type: "list" as const, issues: result.issues.map(sanitizeIssue), ...(result.cursor ? { cursor: result.cursor } : {}) }
        }
        if (operation.type === "comment") {
          await connector.comment(authorization, operation)
          return { type: "comment" as const, ok: true as const }
        }
        await connector.update(authorization, operation)
        return { type: "update" as const, ok: true as const }
      }).catch(async (error) => {
        if (error && typeof error === "object" && "status" in error && error.status === 401) {
          await handle.reportAuthFailure(`${handle.integrationId}_401`)
        }
        throw error
      })
    },
  }
}

function sanitizeIssue(issue: SourceIssue): SourceIssue {
  return {
    externalId: issue.externalId,
    ...(issue.externalKey ? { externalKey: issue.externalKey } : {}),
    ...(issue.externalUrl ? { externalUrl: issue.externalUrl } : {}),
    title: issue.title,
    body: issue.body,
    status: issue.status,
    updatedAt: issue.updatedAt,
    ...(issue.revision ? { revision: issue.revision } : {}),
  }
}
