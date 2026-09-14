import { describe, expect, test, vi } from "vitest"
import { mcpOAuthIntegrationId } from "@claxedo/server-core/agent-plugins/mcp/integration"
import { hostedMcpGatewayAuthorization } from "./gateway-authorization"

const DIGEST = `sha256:${"a".repeat(64)}` as const

async function subject(overrides: {
  projectOverride?: boolean
  workspace?: boolean
  serverName?: string
  execution?: "default" | "selected"
  artifactDigest?: `sha256:${string}`
} = {}) {
  const pluginInstanceId = "collection:docs"
  const serverName = overrides.serverName ?? "docs"
  const scope = {
    userId: "user-1", orgId: "org-1", projectId: "project-1", workspaceId: "workspace-1",
    harnessId: "opencode" as const, pluginInstanceId, serverName,
    integrationId: await mcpOAuthIntegrationId({ pluginInstanceId, serverName }),
    artifactDigest: overrides.artifactDigest ?? DIGEST,
    execution: overrides.execution ?? ("default" as const),
  }
  const artifacts = { get: vi.fn(async () => ({
    plugin: { mcp: { status: "valid", servers: [{ name: "docs", type: "streamable-http", url: "https://mcp.example/mcp" }] } },
  })) }
  const activations = { readRuntime: vi.fn(async () => {
    if (overrides.workspace === false) throw new Error("workspace access denied")
    return {
      revision: 1, pluginInstanceId, harnessId: "opencode", projectId: "project-1",
      projectOverride: overrides.projectOverride ?? true,
      pins: { user: DIGEST },
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
    expect(value.artifacts.get).toHaveBeenCalledWith(DIGEST)
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

  test("a selected credential survives a disabled default and dies with its pin", async () => {
    const disabled = await subject({ execution: "selected", projectOverride: false })
    await expect(disabled.authorize(disabled.scope)).resolves.toEqual({ resource: "https://mcp.example/mcp" })

    const repinned = await subject({ execution: "selected", artifactDigest: `sha256:${"b".repeat(64)}` })
    await expect(repinned.authorize(repinned.scope)).resolves.toBeUndefined()
    expect(repinned.artifacts.get).not.toHaveBeenCalled()
  })
})
