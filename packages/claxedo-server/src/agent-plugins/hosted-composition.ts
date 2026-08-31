import type { HostedAppOverrides } from "../deployments/hosted-shared/hosted-app"
import { sandboxDriver, type HostedControlPlane } from "../authority/hosted-services"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { ConvexSignedAgentPluginActivationStore } from "./activation/convex-store"
import {
  hostedAgentPluginArtifactStore,
  type AgentPluginR2Bucket,
} from "./artifacts/r2-artifact-adapter"
import { hostedAgentPluginsModule } from "./module"
import { createHostedAgentPluginRuntimeProvisioner } from "./runtime/provision"
import { claxedoPublicGitHubCatalogSourceProvider } from "@claxedo/server-core/agent-plugins/sources/github-public"
import { hostedAgentPluginConnectionIntegrations } from "./mcp/connections"
import { HostedMcpGatewayRoutes } from "./mcp/routes"
import { hostedMcpGatewayAuthorization } from "./mcp/gateway-authorization"
import {
  agentPluginMcpRuntimePlan,
  createHostedMcpRuntimePreparation,
} from "./mcp/runtime-preparation"
import { hostedMcpCatalogAuthentication } from "./mcp/catalog-auth"
import { hostedOrgCredentials } from "../credentials/worker/index"
import type { CloudflareKvNamespaceBinding } from "@claxedo/server-core/credentials/backends/cloudflare"
import { hostedMcpClientMetadata } from "./mcp/client-metadata"

export type HostedAgentPluginsWorkerEnv = Record<string, unknown> & {
  CLAXEDO_AGENT_PLUGINS?: AgentPluginR2Bucket
  CLAXEDO_CREDENTIALS?: CloudflareKvNamespaceBinding
}

function required(value: string | undefined, name: string) {
  const clean = value?.trim()
  if (!clean) throw new Error(`Enabled Agent Plugins build requires ${name}`)
  return clean
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringEnvironment(value: Record<string, unknown>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function oauthClients(
  value: string | undefined,
): Record<string, { clientId: string; clientSecret?: string }> | undefined {
  if (!value?.trim()) return undefined
  const parsed = JSON.parse(value) as unknown
  if (!record(parsed)) {
    throw new Error("CLAXEDO_MCP_OAUTH_CLIENTS must be a JSON object")
  }
  const result: Record<string, { clientId: string; clientSecret?: string }> = {}
  for (const [issuer, raw] of Object.entries(parsed)) {
    if (!record(raw)) throw new Error(`MCP OAuth client for ${issuer} is invalid`)
    const row = raw
    if (typeof row.clientId !== "string" || !row.clientId.trim()) throw new Error(`MCP OAuth client for ${issuer} has no clientId`)
    result[new URL(issuer).toString()] = {
      clientId: row.clientId,
      ...(typeof row.clientSecret === "string" && row.clientSecret ? { clientSecret: row.clientSecret } : {}),
    }
  }
  return result
}

/**
 * The complete hosted feature composition. Only the enabled Worker entry
 * imports this file, so an ordinary hosted build has no routes, storage
 * binding reads, activation adapter, catalog fetcher, or VM provisioner.
 */
export function createHostedAgentPluginsComposition(input: {
  env: HostedAgentPluginsWorkerEnv
  plane: HostedControlPlane
}): Pick<HostedAppOverrides, "connectionIntegrations" | "connectionRuntime" | "credentials"> {
  const bucket = input.env.CLAXEDO_AGENT_PLUGINS
  if (!bucket) throw new Error("Enabled Agent Plugins build requires CLAXEDO_AGENT_PLUGINS R2")
  if (!input.env.CLAXEDO_CREDENTIALS) {
    throw new Error("Enabled Agent Plugins build requires CLAXEDO_CREDENTIALS KV")
  }
  const env = stringEnvironment(input.env)
  const artifacts = hostedAgentPluginArtifactStore(bucket)
  const activations = new ConvexSignedAgentPluginActivationStore({
    url: required(env.CLAXEDO_WORKSPACE_AUTHORITY_URL, "CLAXEDO_WORKSPACE_AUTHORITY_URL"),
    serviceToken: required(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN, "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN"),
  })
  const claxedo = claxedoPublicGitHubCatalogSourceProvider()
  const publicUrl = required(env.CLAXEDO_PUBLIC_URL, "CLAXEDO_PUBLIC_URL")
  const clientMetadata = hostedMcpClientMetadata(publicUrl)
  const preRegistered = oauthClients(env.CLAXEDO_MCP_OAUTH_CLIENTS)
  const oauth = {
    callbackUrl: clientMetadata.redirectUri,
    fetch: (url: string, init?: RequestInit) => fetch(url, init),
    ...(preRegistered ? { preRegistered } : {}),
    clientIdMetadataDocumentUrl: clientMetadata.clientId,
  }
  const runtime = createHostedAgentPluginRuntimeProvisioner({
    activations,
    artifacts,
    runtimeFetch: (workspaceId, identity, requestPath, init) => {
      const workspace: Workspace = {
        id: workspaceId,
        org_id: identity.organizationId,
        project_id: identity.projectId,
        directory: "/workspace",
        kind: "cloud",
        created_at: 0,
        updated_at: 0,
      }
      return sandboxFetch(workspace, requestPath, init, {
        ...(input.plane.services.sandbox.sandboxManager
          ? { sandboxManager: input.plane.services.sandbox.sandboxManager }
          : {}),
        ...(input.plane.services.relay.provider
          ? { relayProvider: input.plane.services.relay.provider }
          : {}),
        ...(input.plane.services.defaultHomeRegion
          ? { defaultHomeRegion: input.plane.services.defaultHomeRegion }
          : {}),
        orgId: identity.organizationId,
        subject: "agent-plugins-provisioner",
        role: "owner",
        resume: false,
      })
    },
  })
  return {
    credentials: (orgId) => hostedOrgCredentials(orgId, input.env),
    connectionIntegrations: hostedAgentPluginConnectionIntegrations({ activations, artifacts, oauth }),
    connectionRuntime: (connections) => {
      const prepareRuntime = createHostedMcpRuntimePreparation({
        activations,
        artifacts,
        resolveConnection: connections.resolveConnection,
        oauth,
        gatewayUrl: required(env.CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL, "CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL"),
        signingEnv: env,
        secretBrokering: sandboxDriver(input.plane.env)?.metadata.secretBrokering ?? "none",
      })
      const gateway = HostedMcpGatewayRoutes({
        env,
        authorize: hostedMcpGatewayAuthorization({ activations, artifacts }),
        resolveConnection: async (scope) => connections.resolveToken({
          ownerUserId: scope.userId,
          orgId: scope.orgId,
          integrationId: scope.integrationId,
          capability: "mcp",
        }),
        reportAuthFailure: (scope, connectionId) => connections.reportAuthFailure({
          ownerUserId: scope.userId,
          orgId: scope.orgId,
          integrationId: scope.integrationId,
          connectionId,
          capability: "mcp",
        }),
        fetch: (url, init) => fetch(url, init),
      })
      const module = hostedAgentPluginsModule({
        services: input.plane.services,
        sources: () => claxedo,
        activations,
        artifacts,
        // Activation is durable immediately. Each runtime is brought to this
        // revision at its next readiness boundary; no route claims a running VM
        // was updated without an apply receipt.
        reconcile: { reconcile: async () => ({ state: "scheduled" }) },
        mcpAuthentication: hostedMcpCatalogAuthentication(oauth),
        mcpClientMetadata: clientMetadata,
        mcpGatewayRoutes: gateway,
      })
      return {
        routeContributions: module.routeContributions,
        prepareRuntime,
        provisionRuntime: (workspaceId, preparation) =>
          runtime.provision(workspaceId, agentPluginMcpRuntimePlan(preparation)).then(() => undefined),
      }
    },
  }
}
