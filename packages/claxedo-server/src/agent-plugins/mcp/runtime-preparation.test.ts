import { describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { SignedAgentPluginRuntimeSnapshot } from "../runtime/provision"
import { mcpOAuthIntegrationId } from "@claxedo/server-core/agent-plugins/mcp/integration"
import { verifyMcpGatewayToken } from "./runtime-token"
import { agentPluginMcpRuntimePlan, createHostedMcpRuntimePreparation } from "./runtime-preparation"

const digest = `sha256:${"a".repeat(64)}` as const

function snapshot(): SignedAgentPluginRuntimeSnapshot {
  const harnesses = Object.fromEntries(([
    "opencode", "claude", "codex", "cursor",
  ] as AgentPluginHarnessId[]).map((harnessId) => [harnessId, {
    revision: 4,
    pluginInstanceId: "claxedo/docs",
    harnessId,
    projectId: "project-1",
    ...(harnessId === "opencode" || harnessId === "claude" ? { projectOverride: true } : {}),
    pins: { user: digest },
  }])) as SignedAgentPluginRuntimeSnapshot["plugins"][number]["harnesses"]
  return {
    revision: 4,
    identity: { userId: "user-1", organizationId: "org-1", projectId: "project-1", workspaceId: "workspace-1" },
    plugins: [{ pluginInstanceId: "claxedo/docs", pins: {}, harnesses }],
  }
}

async function signingEnv() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
}

function oauthFetch(publicServer = false, multipleIssuers = false) {
  return vi.fn(async (url: string) => {
    if (url === "https://mcp.example/mcp") {
      return publicServer
        ? Response.json({ jsonrpc: "2.0" })
        : new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example/resource"' } })
    }
    if (url === "https://mcp.example/resource") return Response.json({
      resource: "https://mcp.example/mcp",
      authorization_servers: multipleIssuers
        ? ["https://login.example", "https://login-two.example"]
        : ["https://login.example"],
    })
    if (url === "https://login.example/.well-known/oauth-authorization-server"
      || url === "https://login-two.example/.well-known/oauth-authorization-server") {
      const issuer = url.startsWith("https://login-two.example")
        ? "https://login-two.example"
        : "https://login.example"
      return Response.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      code_challenge_methods_supported: ["S256"],
    })
    }
    return new Response(null, { status: 404 })
  })
}

async function subject(input: {
  publicServer?: boolean
  brokering?: "native" | "proxy" | "none"
  connected?: boolean
  multipleIssuers?: boolean
} = {}) {
  const env = await signingEnv()
  const resolveConnection = vi.fn(async () => input.connected === false
    ? { ok: false as const, status: 404, code: "connection_not_found" }
    : {
        ok: true as const,
        connectionId: "connection-1",
        integrationId: "dynamic",
        scope: "personal" as const,
        fields: {
          resource: "https://mcp.example/mcp",
          ...(input.multipleIssuers ? { issuer: "https://login-two.example" } : {}),
        },
      })
  const prepare = createHostedMcpRuntimePreparation({
    activations: { runtimeSnapshot: async () => snapshot() },
    artifacts: {
      put: async (value) => value,
      get: async () => ({
        digest,
        tree: { entries: [] },
        plugin: {
          root: ".",
          manifest: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "docs" },
          skills: [{ name: "docs", description: "Docs", path: "skills/docs/SKILL.md" }],
          mcp: { status: "valid", servers: [{ name: "docs", type: "streamable-http", url: "https://mcp.example/mcp" }] },
        },
      }),
    },
    resolveConnection,
    oauth: {
      fetch: oauthFetch(input.publicServer, input.multipleIssuers),
      preRegistered: {
        "https://login.example": { clientId: "claxedo" },
        ...(input.multipleIssuers
          ? { "https://login-two.example": { clientId: "claxedo-two" } }
          : {}),
      },
    },
    gatewayUrl: "https://mcp-gateway.example/",
    signingEnv: env,
    secretBrokering: input.brokering ?? "native",
  })
  return { env, resolveConnection, preparation: await prepare("workspace-1") }
}

describe("hosted MCP runtime preparation", () => {
  test("delivers one unreadable, exact-scope gateway credential per active harness", async () => {
    const value = await subject()
    expect(value.preparation.secrets).toHaveLength(2)
    const plan = agentPluginMcpRuntimePlan(value.preparation)
    expect(plan.revision).toBe(4)
    expect(plan.mcpServers).toHaveLength(2)
    expect(new Set(value.preparation.secrets!.map((secret) => secret.hosts[0])).size).toBe(2)
    expect(value.resolveConnection).toHaveBeenCalledTimes(1)

    const first = value.preparation.secrets![0]!
    expect(first.header).toBe("Authorization")
    expect(first.value).not.toContain("upstream")
    expect(first.hosts[0]).toMatch(/^mcp-[a-f0-9]{32}-mcp-gateway\.example$/)
    const scope = await verifyMcpGatewayToken(first.value.replace(/^Bearer /, ""), {
      integrationId: await mcpOAuthIntegrationId({ pluginInstanceId: "claxedo/docs", serverName: "docs" }),
    }, value.env)
    expect(scope).toMatchObject({ workspaceId: "workspace-1", pluginInstanceId: "claxedo/docs" })
  })

  test("fails only the protected server closed when the driver cannot broker", async () => {
    const value = await subject({ brokering: "none" })
    expect(value.preparation.secrets).toBeUndefined()
    expect(agentPluginMcpRuntimePlan(value.preparation).mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "unavailable", reason: "secret_brokering_unsupported" }),
    ]))
  })

  test("leaves public MCP direct and requires no Connection or brokered secret", async () => {
    const value = await subject({ publicServer: true, connected: false })
    expect(value.preparation.secrets).toBeUndefined()
    expect(agentPluginMcpRuntimePlan(value.preparation).mcpServers).toEqual([])
    expect(value.resolveConnection).not.toHaveBeenCalled()
  })

  test("reuses the Connection's frozen issuer when the resource advertises multiple compatible issuers", async () => {
    const value = await subject({ multipleIssuers: true })

    expect(value.resolveConnection).toHaveBeenCalledTimes(1)
    expect(value.preparation.secrets).toHaveLength(2)
    expect(agentPluginMcpRuntimePlan(value.preparation).mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "gateway", serverName: "docs" }),
    ]))
  })
})
