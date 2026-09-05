import { describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { SignedAgentPluginRuntimeSnapshot } from "../runtime/provision"
import { mcpOAuthIntegrationId } from "@claxedo/server-core/agent-plugins/mcp/integration"
import { verifyMcpGatewayToken } from "./runtime-token"
import { agentPluginMcpRuntimePlan, createHostedMcpRuntimePreparation, createHostedMcpRuntimePreparer } from "./runtime-preparation"

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
  const preparerInput = {
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
  } satisfies Parameters<typeof createHostedMcpRuntimePreparation>[0]
  const prepare = createHostedMcpRuntimePreparation(preparerInput)
  const preparer = createHostedMcpRuntimePreparer(preparerInput)
  return { env, resolveConnection, preparation: await prepare("workspace-1"), preparer, snapshot }
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

  test("starts every server's discovery before walking any of them", async () => {
    const env = await signingEnv()
    const requested: string[] = []
    const servers = ["https://mcp.example/mcp", "https://mcp-two.example/mcp"]
    const fetch = vi.fn(async (url: string) => {
      requested.push(url)
      const origin = new URL(url).origin
      if (servers.includes(url)) {
        return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/resource"` } })
      }
      if (url === `${origin}/resource`) return Response.json({ resource: `${origin}/mcp`, authorization_servers: ["https://login.example"] })
      if (url === "https://login.example/.well-known/oauth-authorization-server") return Response.json({
        issuer: "https://login.example",
        authorization_endpoint: "https://login.example/authorize",
        token_endpoint: "https://login.example/token",
        code_challenge_methods_supported: ["S256"],
      })
      return new Response(null, { status: 404 })
    })
    const preparer = createHostedMcpRuntimePreparer({
      activations: { runtimeSnapshot: async () => snapshot() },
      artifacts: {
        put: async (value) => value,
        get: async () => ({
          digest,
          tree: { entries: [] },
          plugin: {
            root: ".",
            manifest: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "docs" },
            skills: [],
            mcp: { status: "valid", servers: servers.map((url, index) => ({ name: `docs-${index}`, type: "streamable-http" as const, url })) },
          },
        }),
      },
      resolveConnection: async () => ({ ok: false as const, status: 404, code: "connection_not_found" }),
      oauth: { fetch, preRegistered: { "https://login.example": { clientId: "claxedo" } } },
      gatewayUrl: "https://mcp-gateway.example/",
      signingEnv: env,
      secretBrokering: "native",
    })
    const plan = agentPluginMcpRuntimePlan(await preparer.forSnapshot(snapshot()))
    expect(plan.mcpServers).toHaveLength(4)
    // Both probes go out before either server's metadata walk begins; a
    // serial walk would place the first server's whole chain ahead of the
    // second probe.
    expect(requested.slice(0, 2)).toEqual(servers)
  })

  test("a consumer that carries the secrets itself gets gateway servers even where the deployment has no broker", async () => {
    // Staging is control-plane-only (no sandbox driver, brokering "none"), yet
    // the signed desktop receives its credentials in the runtime/self answer.
    const value = await subject({ brokering: "none" })
    const own = await value.preparer.forSnapshot(value.snapshot(), { secretBrokering: "native" })
    const plan = agentPluginMcpRuntimePlan(own)
    expect(plan.mcpServers.length).toBeGreaterThan(0)
    expect(plan.mcpServers.every((server) => server.state === "gateway")).toBe(true)
    expect(own.secrets?.length).toBe(plan.mcpServers.length)
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
