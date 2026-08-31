import { describe, expect, test, vi } from "vitest"
import { mcpOAuthIntegrationId } from "@claxedo/server-core/agent-plugins/mcp/integration"
import { hostedMcpGatewayAuthorization } from "./gateway-authorization"

async function subject(overrides: { projectOverride?: boolean; workspace?: boolean; serverName?: string } = {}) {
  const pluginInstanceId = "collection:docs"
  const serverName = overrides.serverName ?? "docs"
  const scope = {
    userId: "user-1", orgId: "org-1", projectId: "project-1", workspaceId: "workspace-1",
    harnessId: "opencode" as const, pluginInstanceId, serverName,
    integrationId: await mcpOAuthIntegrationId({ pluginInstanceId, serverName }),
  }
  const artifacts = { get: vi.fn(async () => ({
    plugin: { mcp: { status: "valid", servers: [{ name: "docs", type: "streamable-http", url: "https://mcp.example/mcp" }] } },
  })) }
  const activations = { readRuntime: vi.fn(async () => {
    if (overrides.workspace === false) throw new Error("workspace access denied")
    return {
      revision: 1, pluginInstanceId, harnessId: "opencode", projectId: "project-1",
      projectOverride: overrides.projectOverride ?? true,
      pins: { user: "sha256:user" },
    }
  }) }
  const authorize = hostedMcpGatewayAuthorization({
    activations: activations as never,
    artifacts: artifacts as never,
  })
  return { authorize, scope, activations, artifacts }
}

describe("hosted MCP gateway activation authorization", () => {
  test("returns only the exact currently effective retained HTTP resource", async () => {
    const value = await subject()
    await expect(value.authorize(value.scope)).resolves.toEqual({ resource: "https://mcp.example/mcp" })
    expect(value.artifacts.get).toHaveBeenCalledWith("sha256:user")
  })

  test("denies a disabled plugin before reading retained bytes", async () => {
    const value = await subject({ projectOverride: false })
    await expect(value.authorize(value.scope)).resolves.toBeUndefined()
    expect(value.artifacts.get).not.toHaveBeenCalled()
  })

  test("denies a removed workspace and a plugin/server substitution", async () => {
    const removed = await subject({ workspace: false })
    await expect(removed.authorize(removed.scope)).resolves.toBeUndefined()
    expect(removed.activations.readRuntime).toHaveBeenCalledOnce()

    const substituted = await subject({ serverName: "issues" })
    await expect(substituted.authorize(substituted.scope)).resolves.toBeUndefined()
  })
})
