import { resolveEffectiveActivation } from "@claxedo/server-core/agent-plugins/activation/effective"
import type { SignedActivationSnapshot } from "@claxedo/server-core/agent-plugins/activation/store"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import { mcpOAuthIntegrationId } from "@claxedo/server-core/agent-plugins/mcp/integration"
import type { McpGatewayTokenScope } from "./runtime-token"

export type RuntimeActivationReader = {
  readRuntime(input: {
    ownerUserId: string
    organizationId: string
    projectId: string
    workspaceId: string
    pluginInstanceId: string
    harnessId: McpGatewayTokenScope["harnessId"]
  }): Promise<SignedActivationSnapshot>
}

/** Resolves the exact currently effective retained server for one runtime credential. */
export function hostedMcpGatewayAuthorization(input: {
  activations: RuntimeActivationReader
  artifacts: AgentPluginArtifactStore
}) {
  return async (scope: McpGatewayTokenScope) => {
    let snapshot: SignedActivationSnapshot
    try {
      // This service query rechecks the canonical user/org membership,
      // project access, and workspace ownership before returning activation.
      snapshot = await input.activations.readRuntime({
        ownerUserId: scope.userId,
        organizationId: scope.orgId,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        pluginInstanceId: scope.pluginInstanceId,
        harnessId: scope.harnessId,
      })
    } catch {
      return undefined
    }
    const effective = resolveEffectiveActivation({
      mode: "signed",
      pluginInstanceId: snapshot.pluginInstanceId,
      harnessId: snapshot.harnessId,
      projectOverride: snapshot.projectOverride,
      userDefault: snapshot.userDefault,
      organizationDefault: snapshot.organizationDefault,
      claxedoDefault: snapshot.claxedoDefault,
      pins: snapshot.pins,
    })
    if (!effective.effective || effective.status !== "ready") return undefined
    const artifact = await input.artifacts.get(effective.artifactDigest)
    if (!artifact || artifact.plugin.mcp.status !== "valid") return undefined
    const server = artifact.plugin.mcp.servers.find((candidate) => candidate.name === scope.serverName)
    if (!server || server.type !== "streamable-http" || await mcpOAuthIntegrationId({
      pluginInstanceId: scope.pluginInstanceId,
      serverName: server.name,
    }) !== scope.integrationId) return undefined
    return { resource: server.url }
  }
}
