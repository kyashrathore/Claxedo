import type BetterSqlite3 from "better-sqlite3"
import type { ConnectionsService, ConnectionWebhookVerifier } from "@claxedo/connections"
import type { SourceIssueConnector } from "@claxedo/workgraph/connectors"
import {
  createGitHubSourceIssueConnector,
  createIntakeService,
  createJiraSourceIssueConnector,
  createLinearSourceIssueConnector,
  createSourceViewService,
  createSqliteIntakeStores,
  createSqliteWebhookIntakeStore,
  createWebhookIntakeService,
} from "@claxedo/workgraph"
import type { CommandResult, WorkGraphCommandRequest, WorkGraphContext } from "@claxedo/workgraph/contracts"
import { createWorkGraphConnectionsPort } from "./connections"
import { createWorkGraphIntakeRouter } from "./intake-router"
import { createWorkGraphWebhookRouter } from "./webhook-router"

export function createWorkGraphIntakeHost(input: Readonly<{
  database: BetterSqlite3.Database
  service: Readonly<{ execute(context: WorkGraphContext, request: WorkGraphCommandRequest): Promise<CommandResult> }>
  connections: ConnectionsService
  resolveContext(request: Request): Promise<WorkGraphContext>
  resolveTeamOwner(context: WorkGraphContext): string | undefined
  sourceIssueConnectors?: readonly SourceIssueConnector[]
  webhookVerifier?: ConnectionWebhookVerifier
}>) {
  const stores = createSqliteIntakeStores(input.database)
  const connections = createWorkGraphConnectionsPort({ service: input.connections, resolveTeamOwner: input.resolveTeamOwner })
  const sourceViews = createSourceViewService({
    store: stores.sourceViews,
    connections,
    ids: { next: () => `source_view_${crypto.randomUUID()}` },
  })
  const connectors = input.sourceIssueConnectors ?? [
    createGitHubSourceIssueConnector(),
    createLinearSourceIssueConnector(),
    createJiraSourceIssueConnector(),
  ]
  const intake = createIntakeService({
    ...stores,
    connections,
    connectors: { get: (provider) => connectors.find((connector) => connector.provider === provider) },
    ids: { next: () => `intake_${crypto.randomUUID()}` },
    commands: input.service,
  })
  const router = createWorkGraphIntakeRouter({ sourceViews, intake, resolveContext: input.resolveContext })
  const webhooks = createWebhookIntakeService({
    store: createSqliteWebhookIntakeStore(input.database),
    refresh: intake.refresh,
  })

  return {
    router,
    sourceViews,
    intake,
    webhooks,
    ...(input.webhookVerifier ? {
      webhookRouter: createWorkGraphWebhookRouter({
        verifier: input.webhookVerifier,
        intake: webhooks,
        resolveOrganizationId: async (connectionId) => {
          const connection = await input.connections.getById(connectionId)
          if (!connection) return
          if (connection.owner === undefined) return "local"
          if (!connection.owner.startsWith("org:") || connection.owner.length === 4) return
          return connection.owner.slice(4)
        },
      }),
    } : {}),
  }
}
