import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose"
import { runtimeAccessTokenIssuer } from "@claxedo/workspace-relay"
import { randomToken } from "@claxedo/server-core/platform/auth/web-crypto"
import {
  RUNTIME_ACCESS_TOKEN_ALGORITHM,
  runtimeAccessTokenAlgorithm,
} from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"

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
}>

function pem(value: string | undefined) {
  const clean = value?.trim()
  return clean?.replaceAll("\\n", "\n") || undefined
}

/** The deployment lacks what minting or verifying needs — a fault, not a bad credential. */
export class McpGatewayConfigurationError extends Error {
  readonly code = "mcp_gateway_misconfigured"
}

function required(value: string | undefined, name: string) {
  const clean = value?.trim()
  if (!clean) throw new McpGatewayConfigurationError(`MCP gateway token requires ${name}`)
  return clean
}

function claims(payload: Record<string, unknown>): McpGatewayTokenScope | undefined {
  const read = (name: string) => {
    const value = payload[name]
    return typeof value === "string" && value ? value : undefined
  }
  const harnessId = read("harness_id")
  if (harnessId !== "opencode" && harnessId !== "claude" && harnessId !== "codex" && harnessId !== "cursor") return undefined
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
  return { userId, orgId, projectId, workspaceId, harnessId, pluginInstanceId, serverName, integrationId }
}

/** Audience-bound runtime credential; its value is delivered only through SandboxBrokeredSecret. */
export async function mintMcpGatewayToken(
  scope: McpGatewayTokenScope,
  env: Record<string, string | undefined>,
  options: { ttlSeconds?: number; now?: () => number } = {},
) {
  for (const [name, value] of Object.entries(scope)) required(value, name)
  const alg = runtimeAccessTokenAlgorithm(env)
  const key = await importPKCS8(required(pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM), "runtime signing key"), alg)
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
  const alg = runtimeAccessTokenAlgorithm(env)
  const key = await importSPKI(required(pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM), "runtime verification key"), alg)
  const result = await jwtVerify(token, key, {
    algorithms: [RUNTIME_ACCESS_TOKEN_ALGORITHM],
    issuer: runtimeAccessTokenIssuer,
    audience: MCP_GATEWAY_TOKEN_AUDIENCE,
  })
  const scope = claims(result.payload as Record<string, unknown>)
  if (!scope || result.payload.sub !== scope.userId || scope.integrationId !== expected.integrationId) {
    throw new Error("MCP gateway token scope is invalid")
  }
  return scope
}
