import type { McpOAuthDynamicRegistrationPort } from "@claxedo/server-core/agent-plugins/mcp/discovery"
import { createHash } from "node:crypto"
import type { SandboxBrokeredSecret, SandboxDriverMetadata } from "@claxedo/sandbox-manager"
import {
  discoverMcpOAuth,
  McpOAuthDiscoveryError,
} from "@claxedo/server-core/agent-plugins/mcp/discovery"
import { mcpOAuthIntegrationId } from "@claxedo/server-core/agent-plugins/mcp/integration"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import type { AgentPluginRuntimeApplyRequest } from "@claxedo/server-core/agent-plugins/runtime/apply-contract"
import { isAgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { WorkspaceRuntimePreparation } from "../../workspace/route-support"
import {
  desiredAgentPluginSelections,
  type AgentPluginRuntimeProjectionPlan,
  type SignedAgentPluginRuntimeSnapshot,
  type SignedAgentPluginRuntimeSnapshotReader,
} from "../runtime/provision"
import { mintMcpGatewayToken, type McpGatewayTokenScope } from "./runtime-token"

type ConnectionReadiness = (input: {
  ownerUserId: string
  orgId: string
  integrationId: string
  capability: "mcp"
}) => Promise<
  | { ok: true; connectionId: string; integrationId: string; scope: "personal" | "team"; fields: Record<string, string> }
  | { ok: false; status: number; code: string }
>

export type AgentPluginMcpRuntimeState = {
  kind: "agent-plugins-mcp-runtime"
  plan: AgentPluginRuntimeProjectionPlan
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function runtimeMcpServer(
  value: unknown,
): value is AgentPluginRuntimeApplyRequest["mcpServers"][number] {
  if (!record(value)
    || typeof value.pluginInstanceId !== "string"
    || typeof value.artifactDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(value.artifactDigest)
    || !isAgentPluginHarnessId(value.harnessId)
    || typeof value.serverName !== "string") return false
  if (value.state === "unavailable") return typeof value.reason === "string"
  return value.state === "gateway"
    && typeof value.url === "string"
    && typeof value.brokeredSecretName === "string"
}

function runtimeState(value: unknown): value is AgentPluginMcpRuntimeState {
  return record(value)
    && value.kind === "agent-plugins-mcp-runtime"
    && record(value.plan)
    && typeof value.plan.revision === "number"
    && Number.isSafeInteger(value.plan.revision)
    && value.plan.revision >= 0
    && Array.isArray(value.plan.mcpServers)
    && value.plan.mcpServers.every(runtimeMcpServer)
}

function gatewayBase(input: string) {
  const url = new URL(input)
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname !== "/") {
    throw new Error("Agent Plugins MCP gateway URL must be an HTTPS origin")
  }
  return url
}

/**
 * Where a runtime's brokered gateway credential may travel.
 *
 * `subdomain`: one `mcp-<key>-<gateway-host>` origin per brokered secret, so a
 * sandbox driver's host-scoped secret injection cannot leak one server's
 * credential to another. Needs a proxied wildcard DNS record below the gateway
 * zone. `origin`: the gateway on its own origin, for runtimes whose credential
 * lives in a process the user already owns (the signed desktop) and for
 * deployments without wildcard DNS. The gateway route verifies the token's
 * audience and scope either way; the host split is an egress-isolation
 * property, not an authorization one.
 */
export type McpGatewayEndpointStyle = "subdomain" | "origin"

function gatewayEndpoint(base: URL, scope: McpGatewayTokenScope, style: McpGatewayEndpointStyle) {
  const key = createHash("sha256").update(JSON.stringify([
    scope.workspaceId,
    scope.harnessId,
    scope.pluginInstanceId,
    scope.serverName,
    scope.integrationId,
  ])).digest("hex").slice(0, 32)
  const endpoint = new URL(base)
  // Keep every brokered secret on its own origin without creating a deep
  // subdomain. Cloudflare Universal SSL covers one label below the zone; the
  // former `mcp-<key>.<gateway-host>` shape required a paid/custom wildcard
  // certificate before a runtime could complete TLS.
  if (style === "subdomain") endpoint.hostname = `mcp-${key}-${base.hostname}`
  endpoint.pathname = `/api/claxedo/plugins/mcp/${encodeURIComponent(scope.integrationId)}`
  const secretName = `CLAXEDO_MCP_${key.toUpperCase()}`
  return { url: endpoint.toString(), host: endpoint.hostname, secretName }
}

function unavailable(input: {
  pluginInstanceId: string
  artifactDigest: `sha256:${string}`
  harnessId: McpGatewayTokenScope["harnessId"]
  serverName: string
  reason: string
}): AgentPluginRuntimeApplyRequest["mcpServers"][number] {
  return { ...input, state: "unavailable" }
}

/**
 * Resolve one immutable activation snapshot into runtime MCP projections and
 * the existing sandbox-manager secret channel. No upstream token is read here.
 */
export type HostedMcpRuntimePreparerInput = {
  activations: SignedAgentPluginRuntimeSnapshotReader
  artifacts: AgentPluginArtifactStore
  resolveConnection: ConnectionReadiness
  oauth: {
    fetch(url: string, init?: RequestInit): Promise<Response>
    preRegistered?: Readonly<Record<string, { clientId: string; clientSecret?: string }>>
    clientIdMetadataDocumentUrl?: string
    /** RFC 7591 registration port; absent means only pre-registered/CIMD clients resolve. */
    dynamicRegistration?: McpOAuthDynamicRegistrationPort
  }
  gatewayUrl: string
  /** Defaults to `subdomain`, the sandbox-isolating shape. */
  endpointStyle?: McpGatewayEndpointStyle
  signingEnv: Record<string, string | undefined>
  secretBrokering: SandboxDriverMetadata["secretBrokering"]
}

export function createHostedMcpRuntimePreparation(input: HostedMcpRuntimePreparerInput) {
  const preparer = createHostedMcpRuntimePreparer(input)
  return async (workspaceId: string): Promise<WorkspaceRuntimePreparation> =>
    preparer.forSnapshot(await input.activations.runtimeSnapshot(workspaceId))
}

/**
 * The same preparation over an already-resolved snapshot. The signed desktop
 * pull resolves the user's all-projects world itself, so it needs the plan and
 * secrets without a workspace to look up.
 */
export function createHostedMcpRuntimePreparer(input: HostedMcpRuntimePreparerInput) {
  const base = gatewayBase(input.gatewayUrl)
  const style = input.endpointStyle ?? "subdomain"
  const oauthFetch = (url: string, init?: RequestInit) => input.oauth.fetch(url, init)
  const forSnapshot = async (snapshot: SignedAgentPluginRuntimeSnapshot): Promise<WorkspaceRuntimePreparation> => {
    const selections = desiredAgentPluginSelections(snapshot)
    const mcpServers: AgentPluginRuntimeApplyRequest["mcpServers"] = []
    const secrets: SandboxBrokeredSecret[] = []
    const discovery = new Map<string, ReturnType<typeof discoverMcpOAuth>>()

    for (const selection of selections) {
      const artifact = await input.artifacts.get(selection.artifactDigest)
      if (!artifact) throw new Error(`Retained Agent Plugin artifact ${selection.artifactDigest} is unavailable`)
      if (artifact.plugin.mcp.status !== "valid") continue
      for (const server of artifact.plugin.mcp.servers) {
        if (server.type !== "streamable-http") continue
        const integrationId = await mcpOAuthIntegrationId({
          pluginInstanceId: selection.pluginInstanceId,
          serverName: server.name,
        })
        let discovered = discovery.get(server.url)
        if (!discovered) {
          discovered = discoverMcpOAuth({
            resourceUrl: server.url,
            fetch: oauthFetch,
            ...(input.oauth.preRegistered ? { preRegistered: input.oauth.preRegistered } : {}),
            ...(input.oauth.clientIdMetadataDocumentUrl
              ? { clientIdMetadataDocumentUrl: input.oauth.clientIdMetadataDocumentUrl }
              : {}),
            ...(input.oauth.dynamicRegistration ? { dynamicRegistration: input.oauth.dynamicRegistration } : {}),
          })
          discovery.set(server.url, discovered)
        }
        let connection: Awaited<ReturnType<ConnectionReadiness>> | undefined
        let auth: Awaited<ReturnType<typeof discoverMcpOAuth>> | undefined
        let discoveryFailure: unknown
        try {
          auth = await discovered
        } catch (cause) {
          discoveryFailure = cause
          if (cause instanceof McpOAuthDiscoveryError && cause.code === "ambiguous-issuer") {
            connection = await input.resolveConnection({
              ownerUserId: snapshot.identity.userId,
              orgId: snapshot.identity.organizationId,
              integrationId,
              capability: "mcp",
            })
            const selectedIssuer = connection.ok
              && connection.fields.resource === server.url
              && typeof connection.fields.issuer === "string"
              ? connection.fields.issuer
              : undefined
            if (selectedIssuer) {
              try {
                auth = await discoverMcpOAuth({
                  resourceUrl: server.url,
                  fetch: oauthFetch,
                  selectedIssuer,
                  ...(input.oauth.preRegistered ? { preRegistered: input.oauth.preRegistered } : {}),
                  ...(input.oauth.clientIdMetadataDocumentUrl
                    ? { clientIdMetadataDocumentUrl: input.oauth.clientIdMetadataDocumentUrl }
                    : {}),
                  ...(input.oauth.dynamicRegistration ? { dynamicRegistration: input.oauth.dynamicRegistration } : {}),
                })
              } catch (selectedCause) {
                discoveryFailure = selectedCause
              }
            }
          }
        }
        if (!auth) {
          const reason = record(discoveryFailure) && typeof discoveryFailure.code === "string"
            ? discoveryFailure.code
            : "mcp_auth_discovery_failed"
          for (const harnessId of selection.harnessIds) {
            mcpServers.push(unavailable({
              pluginInstanceId: selection.pluginInstanceId,
              artifactDigest: selection.artifactDigest,
              harnessId,
              serverName: server.name,
              reason,
            }))
          }
          continue
        }
        if (auth.status === "public") continue
        connection ??= await input.resolveConnection({
          ownerUserId: snapshot.identity.userId,
          orgId: snapshot.identity.organizationId,
          integrationId,
          capability: "mcp",
        })
        const ready = connection.ok && connection.fields.resource === server.url
        for (const harnessId of selection.harnessIds) {
          const identity = {
            pluginInstanceId: selection.pluginInstanceId,
            artifactDigest: selection.artifactDigest,
            harnessId,
            serverName: server.name,
          }
          if (!ready) {
            mcpServers.push(unavailable({ ...identity, reason: connection.ok ? "mcp_connection_resource_mismatch" : connection.code }))
            continue
          }
          if (input.secretBrokering === "none") {
            mcpServers.push(unavailable({ ...identity, reason: "secret_brokering_unsupported" }))
            continue
          }
          const scope: McpGatewayTokenScope = {
            userId: snapshot.identity.userId,
            orgId: snapshot.identity.organizationId,
            projectId: snapshot.identity.projectId,
            workspaceId: snapshot.identity.workspaceId,
            harnessId,
            pluginInstanceId: selection.pluginInstanceId,
            serverName: server.name,
            integrationId,
          }
          const endpoint = gatewayEndpoint(base, scope, style)
          const credential = await mintMcpGatewayToken(scope, input.signingEnv)
          secrets.push({
            name: endpoint.secretName,
            value: `Bearer ${credential.token}`,
            hosts: [endpoint.host],
            header: "Authorization",
          })
          mcpServers.push({
            ...identity,
            state: "gateway",
            url: endpoint.url,
            brokeredSecretName: endpoint.secretName,
          })
        }
      }
    }
    const state: AgentPluginMcpRuntimeState = {
      kind: "agent-plugins-mcp-runtime",
      plan: { revision: snapshot.revision, mcpServers },
    }
    return { ...(secrets.length ? { secrets } : {}), state }
  }
  return { forSnapshot }
}

export function agentPluginMcpRuntimePlan(preparation: WorkspaceRuntimePreparation | undefined) {
  const value = preparation?.state
  if (!runtimeState(value)) {
    throw new Error("Agent Plugins runtime preparation is missing")
  }
  return value.plan
}
