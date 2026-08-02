import {
  connectionWebhookSigningProviderId,
  createConnectionWebhookVerifier,
  githubConnectionWebhookVerifier,
  jiraConnectionWebhookVerifier,
  linearConnectionWebhookVerifier,
  type ConnectionWebhookVerifier,
} from "@claxedo/connections"
import { anyApi, type FunctionReference } from "convex/server"
import type { ControlPlaneCredentials } from "../authority/services"
import {
  hostedCredentialsEnabled,
  hostedOrgCredentials,
} from "../adapters/credentials/worker/index"

type Query = FunctionReference<"query">
const api = anyApi as unknown as {
  workgraphConnections: { resolveWebhookMetadata: Query }
}

type Metadata = Readonly<{
  id: string
  integrationId: "github" | "linear" | "jira"
  capabilities: string[]
  status: "connected" | "degraded" | "broken"
  orgId: string
}>

/**
 * Builds the hosted Connection-owned verifier only when encrypted hosted
 * credentials are enabled. The public webhook route is omitted otherwise.
 * Metadata selects one org; the signing secret is then opened only through
 * that org's encrypted credential namespace.
 */
export function createHostedConnectionWebhookVerifier(input: Readonly<{
  env: Record<string, string | undefined>
  executor: Readonly<{ query(fn: unknown, args: Record<string, unknown>): Promise<unknown> }>
  serviceToken: string
  credentials?: (orgId: string) => ControlPlaneCredentials
}>): ConnectionWebhookVerifier | undefined {
  if (!input.credentials && !hostedCredentialsEnabled(input.env)) return undefined
  return createConnectionWebhookVerifier({
    async resolve(connectionId) {
      const metadata = await input.executor.query(api.workgraphConnections.resolveWebhookMetadata, {
        service_token: input.serviceToken,
        connectionId,
      }) as Metadata | null
      if (!metadata || metadata.id !== connectionId ||
        metadata.status !== "connected" || !metadata.capabilities.includes("work-source")) return undefined
      const credentials = input.credentials?.(metadata.orgId) ?? hostedOrgCredentials(metadata.orgId, input.env)
      const secret = await credentials.resolveCredentialSecret?.(connectionWebhookSigningProviderId(connectionId))
      return secret ? { provider: metadata.integrationId, secret } : undefined
    },
    providers: {
      github: githubConnectionWebhookVerifier(),
      linear: linearConnectionWebhookVerifier(),
      jira: jiraConnectionWebhookVerifier(),
    },
  })
}
