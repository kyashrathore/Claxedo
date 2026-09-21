import { claxedoMcpToolGroupInventory } from "@claxedo/mcp"
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
import type { WorkspaceRuntimeContext, WorkspaceRuntimePreparation } from "../workspace/route-support"
import { D1SignedAgentPluginActivationStore } from "./activation/d1-store"
import { hostedAgentPluginArtifactStore, type AgentPluginR2Bucket } from "./artifacts/r2-artifact-adapter"
import { hostedAgentPluginsModule } from "./module"
import { D1AgentPluginSourceStore } from "./sources/d1-store"
import { githubEdgeCachedFetch, type EdgeCache } from "./sources/github-edge-cache"
import { oauthMetadataEdgeCachedFetch } from "./mcp/oauth-metadata-edge-cache"
import { dohAddressResolver } from "@claxedo/server-core/agent-plugins/mcp/dns-resolver"
import { HostedAgentPluginSourceRoutes } from "./sources/routes"
import { createHostedAgentPluginRuntimeProvisioner } from "./runtime/provision"
import { createBuiltinGroupReader, createCloudRootEnvironment, type CloudRootIdentity } from "./runtime/cloud-root-environment"
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
import { asRecord, isRecord, parseJson, stringField } from "@claxedo/server-core/platform/json/index"
import { BUILTIN_SUBAGENTS_TOOL_GROUP, BUILTIN_TASKS_TOOL_GROUP } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { OWNER_GRANT_AUDIENCE } from "../session/owner-grant"
import { TASKS_CAPABILITY_AUDIENCE } from "../tasks/capability"
import { createGrantWithdrawal } from "../tasks/grant-withdrawal"

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
  prepareRuntime: (context: WorkspaceRuntimeContext) => Promise<WorkspaceRuntimePreparation>
  provisionRuntime: (context: WorkspaceRuntimeContext, preparation?: WorkspaceRuntimePreparation) => Promise<void>
  /** Revokes every pass `prepareRuntime` minted for a root whose workspace is now deleted. */
  releaseRuntime: (context: WorkspaceRuntimeContext) => Promise<void>
  /**
   * The environment `prepareRuntime` launches a cloud root with, for a caller
   * that allocates its own workspace and prepares its own selection.
   */
  rootEnvironment: (root: CloudRootIdentity) => Promise<Record<string, string>>
  /** Whether the root's project has Tasks on now, read as the launch environment reads it. */
  tasksGroupEnabled: (root: CloudRootIdentity) => Promise<boolean>
  /** Whether the root's project has subagents on now, read the same way; what the owner grant's renewal asks. */
  subagentsGroupEnabled: (root: CloudRootIdentity) => Promise<boolean>
  /**
   * One root's own capability set, for a caller that allocates its own
   * workspace: the same preparation and apply the workspace routes run, over
   * an explicit selection instead of the project's activation defaults.
   */
  selectedCapabilities: {
    prepare(input: {
      workspaceId: string
      capabilities: { plugins: readonly { sourceId: string; pluginName: string }[]; skills: readonly { sourceId: string; skillName: string }[] }
    }): Promise<WorkspaceRuntimePreparation>
    apply(input: { workspaceId: string; preparation: WorkspaceRuntimePreparation }): Promise<void>
  }
}

function required(value: string | undefined, name: string) {
  const clean = value?.trim()
  if (!clean) throw new Error(`Enabled Agent Plugins build requires ${name}`)
  return clean
}

function stringEnvironment(value: Record<string, unknown>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function oauthClients(
  value: string | undefined,
): Record<string, { clientId: string; clientSecret?: string }> | undefined {
  if (!value?.trim()) return undefined
  // Deliberately NOT `parseJsonRecord`: malformed JSON must surface its own
  // SyntaxError to the operator rather than be flattened into "not an object".
  const parsed = parseJson(value)
  if (!isRecord(parsed)) {
    throw new Error("CLAXEDO_MCP_OAUTH_CLIENTS must be a JSON object")
  }
  const result: Record<string, { clientId: string; clientSecret?: string }> = {}
  for (const [issuer, raw] of Object.entries(parsed)) {
    const row = asRecord(raw)
    if (!row) throw new Error(`MCP OAuth client for ${issuer} is invalid`)
    const clientId = stringField(row, "clientId")
    if (!clientId?.trim()) throw new Error(`MCP OAuth client for ${issuer} has no clientId`)
    const clientSecret = stringField(row, "clientSecret")
    result[new URL(issuer).toString()] = {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
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
  /** The grant a root whose project turned Tasks on is launched with. */
  tasksGrant: (root: CloudRootIdentity) => Promise<Record<string, string>>
  /** The grant a root whose project turned subagents on is launched with: its runtime acts as the workspace's owner. */
  ownerGrant: (root: CloudRootIdentity) => Promise<Record<string, string>>
  /**
   * The register every pass a root is launched with is written to, and the
   * one its gateway checks. The Tasks and owner grants are minted by
   * `tasksGrant` and `ownerGrant` and have to be minted into the same
   * register, which is the entry's to hold.
   */
  passes: SandboxPassRegister
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
  // Hosted, documents are an account service a session reaches across the
  // network rather than a store in this process, so that group is a decision
  // rather than an inheritance.
  const builtIn = { groups: claxedoMcpToolGroupInventory(), deployment: { inProcessServices: [] } }
  const activations = new D1SignedAgentPluginActivationStore({ database: input.database, authority })
  // GitHub reads are cached at the edge across isolates (see github-edge-cache.ts);
  // `caches` exists only inside a Worker isolate, so it is looked up per call.
  // Workers adds a `default` cache the DOM `CacheStorage` does not declare, and
  // this module also builds outside a Worker isolate, where `caches` is absent
  // entirely — hence the per-call lookup through a property read rather than a
  // cast of the whole global.
  const edgeCache = (): EdgeCache | undefined => {
    const store: unknown = globalThis.caches
    const candidate = asRecord(store)?.default
    return isEdgeCache(candidate) ? candidate : undefined
  }
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
  const oauthFetch = oauthMetadataEdgeCachedFetch({ cache: edgeCache })
  const oauth = {
    callbackUrl: clientMetadata.redirectUri,
    // Discovery's well-known reads are cached at the edge across isolates
    // (see oauth-metadata-edge-cache.ts); the probe and registration POSTs
    // pass straight through.
    fetch: oauthFetch,
    // Every destination discovery and the token exchange connect to is
    // resolved and checked against the private-address policy at connection
    // time (see discovery.ts `connectableAddresses`); workerd has no
    // `node:dns`, so answers come from DNS-over-HTTPS.
    resolve: dohAddressResolver(oauthFetch),
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
    passes: input.passes,
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
  // sandbox manager. A workspace placed on the owner's machine is pulled by
  // that machine itself (`GET /runtime/self`), so the
  // connection mint for it must not fail closed on a rail that does not apply.
  const cloudWorkspace = async (workspaceId: string) => {
    const row = await input.database
      .prepare("select backing from workspaces where workspace_id = ? and deleted_at is null")
      .bind(workspaceId)
      .first<{ backing: string }>()
    return row?.backing === "cloud-vm"
  }
  const rootEnvironment = createCloudRootEnvironment({ activations, builtIn, tasksGrant: input.tasksGrant, ownerGrant: input.ownerGrant })
  const tasksGroupEnabled = createBuiltinGroupReader({ activations, builtIn }, BUILTIN_TASKS_TOOL_GROUP)
  const subagentsGroupEnabled = createBuiltinGroupReader({ activations, builtIn }, BUILTIN_SUBAGENTS_TOOL_GROUP)
  const withdrawals = {
    [BUILTIN_TASKS_TOOL_GROUP]: createGrantWithdrawal({
      passes: input.passes,
      audience: TASKS_CAPABILITY_AUDIENCE,
      reason: "tasks_group_disabled",
      groupEnabled: tasksGroupEnabled,
    }),
    [BUILTIN_SUBAGENTS_TOOL_GROUP]: createGrantWithdrawal({
      passes: input.passes,
      audience: OWNER_GRANT_AUDIENCE,
      reason: "subagents_group_disabled",
      groupEnabled: subagentsGroupEnabled,
    }),
  }
  const prepareRuntime = async ({ workspaceId }: WorkspaceRuntimeContext): Promise<WorkspaceRuntimePreparation> => {
    if (!(await cloudWorkspace(workspaceId))) return {}
    const snapshot = await activations.runtimeSnapshot(workspaceId)
    const [preparation, env] = await Promise.all([
      preparer.forSnapshot(snapshot),
      rootEnvironment({
        userId: snapshot.identity.userId,
        orgId: snapshot.identity.organizationId,
        projectId: snapshot.identity.projectId,
        workspaceId: snapshot.identity.workspaceId,
      }),
    ])
    return { ...preparation, env }
  }
  const provisionRuntime = async ({ workspaceId }: WorkspaceRuntimeContext, preparation?: WorkspaceRuntimePreparation) => {
    if (!(await cloudWorkspace(workspaceId))) return
    await provisioner.provision(workspaceId, agentPluginMcpRuntimePlan(preparation))
  }
  const selectedCapabilities: HostedAgentPluginsComposition["selectedCapabilities"] = {
    async prepare({ workspaceId, capabilities }) {
      // The same cloud-VM rail as `prepareRuntime`: a workspace the control
      // plane does not host has no projection to push, and a caller asking for
      // one here is asking for a promise this rail cannot keep.
      if (!(await cloudWorkspace(workspaceId))) {
        throw new Error(`Workspace ${workspaceId} is not a cloud root this control plane provisions`)
      }
      return preparer.forSnapshot(await activations.runtimeSnapshot(workspaceId), { selection: capabilities })
    },
    async apply({ workspaceId, preparation }) {
      await provisioner.provision(workspaceId, agentPluginMcpRuntimePlan(preparation))
    },
  }

  const gateway = HostedMcpGatewayRoutes({
    env,
    revoked: input.passes.revoked,
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
    // Hosted, documents are an account service a session reaches across the
    // network rather than a store in this process, so the group is a decision
    // rather than an inheritance.
    builtIn,
    mcpAuthentication: hostedMcpCatalogAuthentication(oauth),
    mcpClientMetadata: clientMetadata,
    mcpGatewayRoutes: gateway,
    selfRuntime: createHostedAgentPluginSelfRuntime({ activations, artifacts, preparer }),
    builtInConsentChanged: async (auth, groupId) => {
      const withdrawal = groupId === BUILTIN_TASKS_TOOL_GROUP || groupId === BUILTIN_SUBAGENTS_TOOL_GROUP
        ? withdrawals[groupId]
        : undefined
      if (withdrawal) await withdrawal.reconcile(await authority.resolveOrgId(auth))
    },
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
    // A workspace that is gone takes every pass minted for it, whatever the audience.
    releaseRuntime: async ({ workspaceId }) => { await input.passes.revoke({ workspaceId, reason: "workspace_deleted" }) },
    rootEnvironment,
    tasksGroupEnabled,
    subagentsGroupEnabled,
    selectedCapabilities,
  }
}


/** The two methods `githubEdgeCachedFetch` calls on the Workers default cache. */
function isEdgeCache(value: unknown): value is EdgeCache {
  const candidate = asRecord(value)
  return typeof candidate?.match === "function" && typeof candidate.put === "function"
}
