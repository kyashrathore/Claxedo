import { CLAXEDO_MCP_TOOL_GROUPS, createClaxedoMcpRoutes } from "@claxedo/mcp"
import type { ClaxedoMcpClient } from "@claxedo/mcp/client"

const client: ClaxedoMcpClient = {
  deployment: "hosted",
  runtime: async () => async () => new Response(null, { status: 204 }),
  resolveTarget: async () => ({ kind: "loopback", baseUrl: "", headers: {} }),
  server: () => Promise.reject(new Error("the fixture has no typed client")),
  workspaces: async () => [],
}

const mount = createClaxedoMcpRoutes({
  mount: "hosted",
  verifyRuntimeCredential: (token) =>
    token === "fixture-runtime" ? { runtimeId: "rt_1", workspaceId: "ws_1", sessionId: "ses_1", userId: "user_1", expiresAt: Number.MAX_SAFE_INTEGER } : undefined,
  createClient: () => client,
  registerTools: CLAXEDO_MCP_TOOL_GROUPS,
  enabledToolGroups: () => ["sessions"],
  audit: () => {},
})

export default { fetch: (request: Request) => mount.routes.fetch(request) }
