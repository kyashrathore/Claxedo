import { credentialFault } from "../../platform/auth/runtime-token-keys"
import { mintSandboxPass, verifySandboxPass } from "../../platform/auth/sandbox-pass"
import type { SandboxPassRegister } from "../../platform/auth/sandbox-pass-register"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { isArtifactDigest, type ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"

export const MCP_GATEWAY_TOKEN_AUDIENCE = "agent-plugins-mcp-gateway" as const
/** The gateway answers one thing: forwarding MCP traffic to the integration the token names. */
export const MCP_GATEWAY_OPERATIONS = ["forward"] as const

export type McpGatewayTokenScope = Readonly<{
  userId: string
  orgId: string
  projectId: string
  workspaceId: string
  harnessId: AgentPluginHarnessId
  pluginInstanceId: string
  serverName: string
  integrationId: string
  /** The retained artifact whose declared server this credential reaches. */
  artifactDigest: ArtifactDigest
  /**
   * Which configuration issued it. A `selected` credential belongs to a root
   * that named its own capability set, so its authority is the user's
   * entitlement to the retained artifact rather than the project's everyday
   * activation — which the selection deliberately does not follow.
   */
  execution: "default" | "selected"
}>

/** The deployment lacks what minting or verifying needs — a fault, not a bad credential. */
export class McpGatewayConfigurationError extends Error {
  readonly code = "mcp_gateway_misconfigured"
}

const gatewayTokenFault = credentialFault("MCP gateway token", McpGatewayConfigurationError)

function gatewayScope(
  scope: { userId: string; orgId: string; workspaceId: string; projectId?: string },
  extra: Readonly<Record<string, unknown>>,
): McpGatewayTokenScope | undefined {
  const read = (name: string) => {
    const value = extra[name]
    return typeof value === "string" && value ? value : undefined
  }
  const harnessId = read("harness_id")
  if (harnessId !== "opencode" && harnessId !== "claude" && harnessId !== "codex" && harnessId !== "cursor") return undefined
  const execution = read("execution")
  if (execution !== "default" && execution !== "selected") return undefined
  const artifactDigest = read("artifact_digest")
  if (!isArtifactDigest(artifactDigest)) return undefined
  const pluginInstanceId = read("plugin_instance_id")
  const serverName = read("server_name")
  const integrationId = read("integration_id")
  if (!scope.projectId || !pluginInstanceId || !serverName || !integrationId) return undefined
  return {
    userId: scope.userId,
    orgId: scope.orgId,
    projectId: scope.projectId,
    workspaceId: scope.workspaceId,
    harnessId,
    pluginInstanceId,
    serverName,
    integrationId,
    artifactDigest,
    execution,
  }
}

/** Audience-bound sandbox pass; its value is delivered only through SandboxBrokeredSecret. */
export async function mintMcpGatewayToken(
  scope: McpGatewayTokenScope,
  env: Record<string, string | undefined>,
  options: { ttlSeconds?: number; now?: () => number; register?: SandboxPassRegister } = {},
) {
  const { userId, orgId, projectId, workspaceId, ...plugin } = scope
  return await mintSandboxPass(
    {
      audience: MCP_GATEWAY_TOKEN_AUDIENCE,
      scope: { userId, orgId, projectId, workspaceId },
      operations: MCP_GATEWAY_OPERATIONS,
      extra: {
        harness_id: plugin.harnessId,
        plugin_instance_id: plugin.pluginInstanceId,
        server_name: plugin.serverName,
        integration_id: plugin.integrationId,
        artifact_digest: plugin.artifactDigest,
        execution: plugin.execution,
      },
      ...options,
    },
    env,
    gatewayTokenFault,
  )
}

export async function verifyMcpGatewayToken(
  token: string,
  expected: Pick<McpGatewayTokenScope, "integrationId">,
  env: Record<string, string | undefined>,
  options: { revoked?: (jti: string) => Promise<boolean> } = {},
) {
  const pass = await verifySandboxPass(token, env, { audience: MCP_GATEWAY_TOKEN_AUDIENCE, fault: gatewayTokenFault, ...options })
  const scope = gatewayScope(pass.scope, pass.extra)
  if (!scope || scope.integrationId !== expected.integrationId) throw new Error("MCP gateway token scope is invalid")
  return scope
}
