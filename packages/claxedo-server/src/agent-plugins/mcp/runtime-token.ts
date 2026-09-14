import { jwtVerify, SignJWT } from "jose"
import { runtimeAccessTokenIssuer } from "@claxedo/workspace-relay"
import { randomToken } from "@claxedo/server-core/platform/auth/web-crypto"
import { RUNTIME_ACCESS_TOKEN_ALGORITHM } from "@claxedo/server-core/platform/auth/runtime-access-token"
import {
  requiredCredentialField,
  runtimeTokenSigningKey,
  runtimeTokenVerificationKey,
} from "../../platform/auth/runtime-token-keys"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { isArtifactDigest, type ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"

export const MCP_GATEWAY_TOKEN_AUDIENCE = "agent-plugins-mcp-gateway" as const
const DEFAULT_TTL_SECONDS = 30 * 60
const MAX_TTL_SECONDS = 60 * 60

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

const misconfigured = (name: string) => new McpGatewayConfigurationError(`MCP gateway token requires ${name}`)

function gatewayScope(payload: Record<string, unknown>): McpGatewayTokenScope | undefined {
  const read = (name: string) => {
    const value = payload[name]
    return typeof value === "string" && value ? value : undefined
  }
  const harnessId = read("harness_id")
  if (harnessId !== "opencode" && harnessId !== "claude" && harnessId !== "codex" && harnessId !== "cursor") return undefined
  const execution = read("execution")
  if (execution !== "default" && execution !== "selected") return undefined
  const artifactDigest = read("artifact_digest")
  if (!isArtifactDigest(artifactDigest)) return undefined
  const userId = read("user_id")
  const orgId = read("org_id")
  const projectId = read("project_id")
  const workspaceId = read("workspace_id")
  const pluginInstanceId = read("plugin_instance_id")
  const serverName = read("server_name")
  const integrationId = read("integration_id")
  if (!userId || !orgId || !projectId || !workspaceId || !pluginInstanceId || !serverName || !integrationId) {
    return undefined
  }
  return {
    userId,
    orgId,
    projectId,
    workspaceId,
    harnessId,
    pluginInstanceId,
    serverName,
    integrationId,
    artifactDigest,
    execution,
  }
}

/** Audience-bound runtime credential; its value is delivered only through SandboxBrokeredSecret. */
export async function mintMcpGatewayToken(
  scope: McpGatewayTokenScope,
  env: Record<string, string | undefined>,
  options: { ttlSeconds?: number; now?: () => number } = {},
) {
  for (const [name, value] of Object.entries(scope)) requiredCredentialField(value, name, misconfigured)
  const { alg, key } = await runtimeTokenSigningKey(env, misconfigured)
  const now = Math.floor((options.now?.() ?? Date.now()) / 1_000)
  const requested = Math.floor(options.ttlSeconds ?? DEFAULT_TTL_SECONDS)
  const ttl = Math.min(MAX_TTL_SECONDS, Math.max(60, requested))
  const token = await new SignJWT({
    user_id: scope.userId,
    org_id: scope.orgId,
    project_id: scope.projectId,
    workspace_id: scope.workspaceId,
    harness_id: scope.harnessId,
    plugin_instance_id: scope.pluginInstanceId,
    server_name: scope.serverName,
    integration_id: scope.integrationId,
    artifact_digest: scope.artifactDigest,
    execution: scope.execution,
  })
    .setProtectedHeader({ alg })
    .setIssuer(runtimeAccessTokenIssuer)
    .setAudience(MCP_GATEWAY_TOKEN_AUDIENCE)
    .setSubject(scope.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(randomToken())
    .sign(key)
  return { token, expiresAt: (now + ttl) * 1_000 }
}

export async function verifyMcpGatewayToken(
  token: string,
  expected: Pick<McpGatewayTokenScope, "integrationId">,
  env: Record<string, string | undefined>,
) {
  const { key } = await runtimeTokenVerificationKey(env, misconfigured)
  const result = await jwtVerify(token, key, {
    algorithms: [RUNTIME_ACCESS_TOKEN_ALGORITHM],
    issuer: runtimeAccessTokenIssuer,
    audience: MCP_GATEWAY_TOKEN_AUDIENCE,
  })
  const scope = gatewayScope(result.payload as Record<string, unknown>)
  if (!scope || result.payload.sub !== scope.userId || scope.integrationId !== expected.integrationId) {
    throw new Error("MCP gateway token scope is invalid")
  }
  return scope
}
