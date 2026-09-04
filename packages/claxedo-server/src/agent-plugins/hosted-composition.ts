import type { D1Database } from "@cloudflare/workers-types"
import type { Hono } from "hono"
import { sandboxDriverCatalog, sandboxDriverId } from "@claxedo/sandbox-manager/driver-catalog"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { CloudflareKvNamespaceBinding } from "@claxedo/server-core/credentials/backends/cloudflare"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import { claxedoPublicGitHubCatalogSourceProvider } from "@claxedo/server-core/agent-plugins/sources/github-public"
import {
  agentPluginCatalogSources,
  createAgentPluginSourceProviderCache,
} from "@claxedo/server-core/agent-plugins/sources/registry"
import { AGENT_PLUGINS_ROUTE_PATH } from "@claxedo/server-core/agent-plugins/module"
import type { HostedControlPlane } from "../authority/hosted-services"
import { hostedOrgCredentials } from "../credentials/worker/index"
import {
  createHostedCapabilityAuthFailureReporter,
  createHostedCapabilityConnectionResolver,
  createHostedCapabilityTokenResolver,
  createHostedD1ConnectionsSetup,
  hostedConnectionsAuthenticate,
} from "../connections/hosted-d1/setup"
import type { WorkspaceRuntimePreparation } from "../workspace/route-support"
import { D1SignedAgentPluginActivationStore } from "./activation/d1-store"
import { hostedAgentPluginArtifactStore, type AgentPluginR2Bucket } from "./artifacts/r2-artifact-adapter"
import { hostedAgentPluginsModule } from "./module"
import { D1AgentPluginSourceStore } from "./sources/d1-store"
import { githubEdgeCachedFetch, type EdgeCache } from "./sources/github-edge-cache"
import { oauthMetadataEdgeCachedFetch } from "./mcp/oauth-metadata-edge-cache"
import { HostedAgentPluginSourceRoutes } from "./sources/routes"
import { createHostedAgentPluginRuntimeProvisioner } from "./runtime/provision"
import { createHostedAgentPluginSelfRuntime } from "./runtime/self-runtime"
import { hostedAgentPluginConnectionIntegrations } from "./mcp/connections"
import { HostedMcpGatewayRoutes } from "./mcp/routes"
import { hostedMcpGatewayAuthorization } from "./mcp/gateway-authorization"
import {
  agentPluginMcpRuntimePlan,
  createHostedMcpRuntimePreparer,
  type McpGatewayEndpointStyle,
} from "./mcp/runtime-preparation"
import { hostedMcpCatalogAuthentication } from "./mcp/catalog-auth"
import { hostedMcpClientMetadata } from "./mcp/client-metadata"
import { createD1McpOAuthClientRegistry } from "./mcp/d1-client-registry"

/**
 * The credential partition a deployment-wide secret belongs to. Not an org id:
 * `hostedOrgCredentials` partitions its KV keys and HKDF subkeys by this value,
 * and a deployment-wide OAuth client is owned by the deployment, not by any one
 * tenant. Orgs are minted as `org_...`, so this value can never collide with
 * one.
 */
const DEPLOYMENT_CREDENTIAL_PARTITION = "deployment"

export type HostedAgentPluginsWorkerEnv = Record<string, unknown> & {
  CLAXEDO_AGENT_PLUGINS?: AgentPluginR2Bucket
  CLAXEDO_CREDENTIALS?: CloudflareKvNamespaceBinding
}

/** What the feature entry hands the hosted core app. Nothing here is a runtime flag. */
export type HostedAgentPluginsComposition = {
  routeContributions: readonly ControlPlaneRouteContribution[]
  integrationRoutes: Hono
  prepareRuntime: (workspaceId: string) => Promise<WorkspaceRuntimePreparation>
  provisionRuntime: (workspaceId: string, preparation?: WorkspaceRuntimePreparation) => Promise<void>
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

function endpointStyle(value: string | undefined): McpGatewayEndpointStyle {
  if (value === undefined || value === "" || value === "origin") return "origin"
  if (value === "subdomain") return "subdomain"
  throw new Error("CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_STYLE must be origin or subdomain")
}

/**
 * The runtime credential can only stay unreadable to the agent when the
 * selected sandbox driver brokers secrets. A control-plane-only deployment
 * has no driver at all, and its cloud runtimes are never created, so the
 * answer there is "none" — authenticated cloud MCP is refused per server, not
 * per plugin (`runtime-preparation.ts`).
 */
function secretBrokering(plane: HostedControlPlane) {
  if (!plane.services.sandbox.sandboxManager) return "none" as const
  const selected = sandboxDriverId(plane.env.CLAXEDO_SANDBOX_DRIVER?.trim())
  if (!selected) return "none" as const
  return sandboxDriverCatalog[selected].metadata.secretBrokering
}

/**
 * The complete hosted feature composition over Better Auth + D1.
 *
 * Only the Agent Plugins Worker entry imports this file, so an ordinary hosted
 * build has no plugin routes, storage binding reads, activation store,
 * Connections family, catalog fetcher, or VM provisioner. Everything durable
 * lives in `CONTROL_PLANE_DB` (activations, Connections rows, attempts), the
 * `CLAXEDO_AGENT_PLUGINS` R2 bucket (immutable plugin artifacts), and the
 * org-partitioned `CLAXEDO_CREDENTIALS` KV namespace (envelope-encrypted
 * OAuth material). Identity and authorization come from the same D1 authority
 * every other hosted route uses.
 */
export function createHostedAgentPluginsComposition(input: {
  env: HostedAgentPluginsWorkerEnv
  plane: HostedControlPlane
  database: D1Database
  authentication: RequestAuthenticationAdapter
}): HostedAgentPluginsComposition {
  const bucket = input.env.CLAXEDO_AGENT_PLUGINS
  if (!bucket) throw new Error("Enabled Agent Plugins build requires CLAXEDO_AGENT_PLUGINS R2")
  if (!input.env.CLAXEDO_CREDENTIALS) {
    throw new Error("Enabled Agent Plugins build requires CLAXEDO_CREDENTIALS KV")
  }
  const env = stringEnvironment(input.env)
  const services = input.plane.services
  const authority = requireAuthority(services)
  const artifacts = hostedAgentPluginArtifactStore(bucket)
  const activations = new D1SignedAgentPluginActivationStore({ database: input.database, authority })
  // GitHub reads are cached at the edge across isolates (see github-edge-cache.ts);
  // `caches` exists only inside a Worker isolate, so it is looked up per call.
  const edgeCache = () => (globalThis as { caches?: { default?: EdgeCache } }).caches?.default
  const githubFetch = githubEdgeCachedFetch({ cache: edgeCache })
  const claxedo = claxedoPublicGitHubCatalogSourceProvider(githubFetch)
  const sourceRegistry = new D1AgentPluginSourceStore({ database: input.database, authority })
  const sourceProviders = createAgentPluginSourceProviderCache(githubFetch)
  // The public origin doubles as the OAuth client identity document host and,
  // by default, as the MCP gateway origin (see `McpGatewayEndpointStyle`).
  const publicUrl = required(env.CLAXEDO_PUBLIC_URL ?? env.BETTER_AUTH_URL, "CLAXEDO_PUBLIC_URL")
  const clientMetadata = hostedMcpClientMetadata(publicUrl)
  const preRegistered = oauthClients(env.CLAXEDO_MCP_OAUTH_CLIENTS)
  // The RFC 7591 registration body is this deployment's PUBLISHED client
  // metadata document minus `client_id` (which RFC 7591 forbids a client from
  // choosing). Reusing the same object is what keeps a dynamically registered
  // client and a client-id-metadata-document client one identity rather than
  // two drifting ones.
  const { client_id: _published, ...registrationMetadata } = clientMetadata.document
  const oauth = {
    callbackUrl: clientMetadata.redirectUri,
    // Discovery's well-known reads are cached at the edge across isolates
    // (see oauth-metadata-edge-cache.ts); the probe and registration POSTs
    // pass straight through.
    fetch: oauthMetadataEdgeCachedFetch({ cache: edgeCache }),
    ...(preRegistered ? { preRegistered } : {}),
    clientIdMetadataDocumentUrl: clientMetadata.clientId,
    dynamicRegistration: {
      clientMetadata: registrationMetadata,
      ...createD1McpOAuthClientRegistry({
        database: input.database,
        // A dynamic client registration is DEPLOYMENT-wide (`mcp_oauth_clients`
        // is keyed by issuer alone), while the encrypted credential store is
        // partitioned per organization and needs a tenant id. There is no
        // "deployment org" the composition can reach here — it is constructed
        // once, before any request resolves an org — and filing the secret
        // under whichever org happened to connect first would make it
        // unreadable for every other org that shares the client. So the fixed
        // partition id "deployment" names the deployment itself, matching the
        // row's scope exactly. It is constructed lazily because
        // `hostedOrgCredentials` fails closed when the hosted credential flag
        // or KEK is absent, and both live targets
        // (`token_endpoint_auth_method: "none"`) never issue a secret at all.
        secrets: {
          put: async (providerId, secret) => {
            await hostedOrgCredentials(DEPLOYMENT_CREDENTIAL_PARTITION, input.env).putCredential({
              provider_id: providerId,
              kind: "oauth_token",
              source: "managed",
              label: "MCP OAuth client secret",
              secret,
            })
          },
          get: async (providerId) =>
            (await hostedOrgCredentials(DEPLOYMENT_CREDENTIAL_PARTITION, input.env)
              .resolveCredentialSecret?.(providerId)) ?? undefined,
        },
      }),
    },
  }

  const connectionsInput = {
    env,
    database: input.database,
    services,
    authenticate: hostedConnectionsAuthenticate({ authentication: input.authentication, services }),
    dynamicIntegrations: hostedAgentPluginConnectionIntegrations({ activations, artifacts, oauth }),
    credentials: (orgId: string) => hostedOrgCredentials(orgId, input.env),
  }
  const integrationRoutes = createHostedD1ConnectionsSetup(connectionsInput)
  const resolveConnection = createHostedCapabilityConnectionResolver(connectionsInput)
  const resolveToken = createHostedCapabilityTokenResolver(connectionsInput)
  const reportAuthFailure = createHostedCapabilityAuthFailureReporter(connectionsInput)

  const preparer = createHostedMcpRuntimePreparer({
    activations,
    artifacts,
    resolveConnection,
    oauth,
    gatewayUrl: env.CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL?.trim() || publicUrl,
    endpointStyle: endpointStyle(env.CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_STYLE),
    signingEnv: env,
    secretBrokering: secretBrokering(input.plane),
  })
  const provisioner = createHostedAgentPluginRuntimeProvisioner({
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
        ...(services.sandbox.sandboxManager ? { sandboxManager: services.sandbox.sandboxManager } : {}),
        ...(services.relay.provider ? { relayProvider: services.relay.provider } : {}),
        ...(services.defaultHomeRegion ? { defaultHomeRegion: services.defaultHomeRegion } : {}),
        orgId: identity.organizationId,
        // Provisioning is a machine actor, not the signed human: it materializes
        // the pinned plugin trees before any user turn runs. The D1 runtime
        // authority mints service runtime tokens only for the one control-plane
        // service actor ("control-plane", owner role), the same actor the
        // checkpoint routes use; a feature-named actor is refused.
        runtimeActor: { principalKind: "service", actorId: "control-plane", actorKind: "agent" },
        role: "owner",
        resume: false,
      })
    },
  })

  // The hosted prepare/provision rail is a CLOUD VM rail: it pushes the
  // retained trees into a sandbox the control plane can reach through the
  // sandbox manager. A user-hosted workspace runs on the owner's machine, and
  // that machine pulls the signed world itself (`GET /runtime/self`), so the
  // connection mint for it must not fail closed on a rail that does not apply.
  const cloudWorkspace = async (workspaceId: string) => {
    const row = await input.database
      .prepare("select backing, access from workspaces where workspace_id = ? and deleted_at is null")
      .bind(workspaceId)
      .first<{ backing: string; access: string }>()
    return row?.backing === "cloud-vm" && row.access === "cloud"
  }
  const prepareRuntime = async (workspaceId: string): Promise<WorkspaceRuntimePreparation> => {
    if (!(await cloudWorkspace(workspaceId))) return {}
    return preparer.forSnapshot(await activations.runtimeSnapshot(workspaceId))
  }
  const provisionRuntime = async (workspaceId: string, preparation?: WorkspaceRuntimePreparation) => {
    if (!(await cloudWorkspace(workspaceId))) return
    await provisioner.provision(workspaceId, agentPluginMcpRuntimePlan(preparation))
  }

  const gateway = HostedMcpGatewayRoutes({
    env,
    authorize: hostedMcpGatewayAuthorization({ activations, artifacts }),
    resolveConnection: async (scope) => resolveToken({
      ownerUserId: scope.userId,
      orgId: scope.orgId,
      integrationId: scope.integrationId,
      capability: "mcp",
    }),
    reportAuthFailure: (scope, connectionId) => reportAuthFailure({
      ownerUserId: scope.userId,
      orgId: scope.orgId,
      integrationId: scope.integrationId,
      connectionId,
      capability: "mcp",
    }),
    fetch: (url, init) => fetch(url, init),
  })
  const module = hostedAgentPluginsModule({
    services,
    authentication: input.authentication,
    // Resolved per catalog read so a repository registered through
    // `POST /api/claxedo/plugins/sources` appears in the next read, and per
    // caller so a personal source stays invisible to the rest of the org.
    sources: (auth) => agentPluginCatalogSources({
      base: claxedo,
      cache: sourceProviders,
      list: () => sourceRegistry.list(auth),
    }),
    activations,
    artifacts,
    // Activation is durable immediately. Each runtime is brought to this
    // revision at its next readiness boundary; no route claims a running VM
    // was updated without an apply receipt.
    reconcile: { reconcile: async () => ({ state: "scheduled" }) },
    mcpAuthentication: hostedMcpCatalogAuthentication(oauth),
    mcpClientMetadata: clientMetadata,
    mcpGatewayRoutes: gateway,
    selfRuntime: createHostedAgentPluginSelfRuntime({ activations, artifacts, preparer }),
  })
  return {
    routeContributions: [
      ...module.routeContributions,
      {
        id: "agent-plugins-sources",
        path: `${AGENT_PLUGINS_ROUTE_PATH}/sources`,
        routes: HostedAgentPluginSourceRoutes({
          services,
          authentication: input.authentication,
          registry: sourceRegistry,
          cache: sourceProviders,
        }),
      },
    ],
    integrationRoutes,
    prepareRuntime,
    provisionRuntime,
  }
}
