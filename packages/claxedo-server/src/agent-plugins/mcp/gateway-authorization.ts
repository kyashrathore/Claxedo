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

/**
 * The artifact this credential is still allowed to reach.
 *
 * A default credential follows the project's everyday activation, and stops
 * working the moment that activation turns the plugin off. A selected
 * credential belongs to a root whose capability set was chosen against the
 * user's entitlements rather than those defaults, so its authority is the
 * retained pin the selection resolved: withdrawing that pin, or losing the
 * membership and project access the snapshot read above rechecks, is what
 * revokes it.
 */
function authorizedDigest(scope: McpGatewayTokenScope, snapshot: SignedActivationSnapshot) {
  if (scope.execution === "selected") {
    const entitled = snapshot.pins.user ?? snapshot.pins.organization ?? snapshot.pins.claxedo
    return entitled === scope.artifactDigest ? entitled : undefined
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
  return effective.effective && effective.status === "ready" ? effective.artifactDigest : undefined
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
    const digest = authorizedDigest(scope, snapshot)
    if (!digest) return undefined
    const artifact = await input.artifacts.get(digest)
    if (!artifact || artifact.plugin.mcp.status !== "valid") return undefined
    const server = artifact.plugin.mcp.servers.find((candidate) => candidate.name === scope.serverName)
    if (!server || server.type !== "streamable-http" || await mcpOAuthIntegrationId({
      pluginInstanceId: scope.pluginInstanceId,
      serverName: server.name,
    }) !== scope.integrationId) return undefined
    return { resource: server.url }
  }
}
