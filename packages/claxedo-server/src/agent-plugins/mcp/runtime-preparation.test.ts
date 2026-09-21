import { describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { RetainedAgentPluginArtifact } from "@claxedo/server-core/agent-plugins/artifacts/types"
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
  brokering?: "native" | "none"
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
  const oauthFetchSpy = oauthFetch(input.publicServer, input.multipleIssuers)
  // Only the issuer the Connection froze. Registering both let the preparer
  // pick either one and still resolve, so a wrong pick passed.
  const preRegistered: Record<string, { clientId: string }> = input.multipleIssuers
    ? { "https://login-two.example": { clientId: "claxedo-two" } }
    : { "https://login.example": { clientId: "claxedo" } }
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
      fetch: oauthFetchSpy,
      preRegistered,
    },
    gatewayUrl: "https://mcp-gateway.example/",
    signingEnv: env,
    secretBrokering: input.brokering ?? "native",
  } satisfies Parameters<typeof createHostedMcpRuntimePreparation>[0]
  const prepare = createHostedMcpRuntimePreparation(preparerInput)
  const preparer = createHostedMcpRuntimePreparer(preparerInput)
  return { env, resolveConnection, oauthFetch: oauthFetchSpy, preparation: await prepare("workspace-1"), preparer, snapshot }
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

    const first = value.preparation.secrets![0]
    expect(first.header).toBe("Authorization")
    expect(first.value).not.toContain("upstream")
    expect(first.hosts[0]).toMatch(/^mcp-[a-f0-9]{32}-mcp-gateway\.example$/)
    const scope = await verifyMcpGatewayToken(first.value.replace(/^Bearer /, ""), {
      integrationId: await mcpOAuthIntegrationId({ pluginInstanceId: "claxedo/docs", serverName: "docs" }),
    }, value.env)
    expect(scope).toMatchObject({ workspaceId: "workspace-1", pluginInstanceId: "claxedo/docs" })
  })

  test("the runtime credential's subject is the activation owner, not the signed caller", async () => {
    // The identity is looked up by workspace id — `runtimeSnapshot` reads
    // `workspaces.owner_user_id` — so two different signed callers mint the
    // same credential. Per-user identity is a change to the lease key.
    const env = await signingEnv()
    const runtimeSnapshot = vi.fn(async (workspaceId: string) => ({
      ...snapshot(),
      identity: { userId: "owner-of-record", organizationId: "org-1", projectId: "project-1", workspaceId },
    }))
    const prepare = createHostedMcpRuntimePreparation({
      activations: { runtimeSnapshot },
      artifacts: {
        put: async (value) => value,
        get: async () => ({
          digest,
          tree: { entries: [] },
          plugin: {
            root: ".",
            manifest: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "docs" },
            skills: [],
            mcp: { status: "valid", servers: [{ name: "docs", type: "streamable-http" as const, url: "https://mcp.example/mcp" }] },
          },
        }),
      },
      resolveConnection: async () => ({
        ok: true as const,
        connectionId: "connection-1",
        integrationId: "dynamic",
        scope: "personal" as const,
        fields: { resource: "https://mcp.example/mcp" },
      }),
      oauth: { fetch: oauthFetch(), preRegistered: { "https://login.example": { clientId: "claxedo" } } },
      gatewayUrl: "https://mcp-gateway.example/",
      signingEnv: env,
      secretBrokering: "native",
    })

    const preparation = await prepare("workspace-1")

    // The workspace id is the whole of the lookup; no subject reaches it.
    expect(runtimeSnapshot).toHaveBeenCalledWith("workspace-1")
    const secret = preparation.secrets![0]
    const scope = await verifyMcpGatewayToken(secret.value.replace(/^Bearer /, ""), {
      integrationId: await mcpOAuthIntegrationId({ pluginInstanceId: "claxedo/docs", serverName: "docs" }),
    }, env)
    expect(scope?.userId).toBe("owner-of-record")
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
    expect(value.preparation.secrets).toEqual([])
    expect(agentPluginMcpRuntimePlan(value.preparation).mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "unavailable", reason: "secret_brokering_unsupported" }),
    ]))
  })

  test("fails the protected server closed on an unrecognized broker capability", async () => {
    // A malformed driver declaration is not `"none"`; the minted credential
    // still must not be handed out.
    const value = await subject({ brokering: "proxy" as never })
    expect(value.preparation.secrets).toEqual([])
    expect(agentPluginMcpRuntimePlan(value.preparation).mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "unavailable", reason: "secret_brokering_unsupported" }),
    ]))
  })

  test("leaves public MCP direct and requires no Connection or brokered secret", async () => {
    const value = await subject({ publicServer: true, connected: false })
    expect(value.preparation.secrets).toEqual([])
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
    // Both are discovered, because compatibility is what the resource
    // advertises; only the frozen one is registered, so a preparation that
    // picked the other has no client to present.
    const reached = value.oauthFetch.mock.calls.map(([url]) => url)
    expect(reached).toContain("https://login-two.example/.well-known/oauth-authorization-server")
  })
  test("mints a credential only for a selected plugin's own server, scoped to that workspace", async () => {
    const env = await signingEnv()
    const docs = `sha256:${"a".repeat(64)}` as const
    const helpers = `sha256:${"b".repeat(64)}` as const
    const retained: Record<string, RetainedAgentPluginArtifact> = {
      [docs]: {
        digest: docs,
        tree: { entries: [] },
        plugin: {
          root: ".",
          manifest: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "docs" },
          skills: [{ name: "docs", description: "Docs", path: "skills/docs" }],
          mcp: { status: "valid", servers: [{ name: "docs", type: "streamable-http", url: "https://mcp.example/mcp" }] },
        },
      },
      [helpers]: {
        digest: helpers,
        tree: { entries: [] },
        plugin: {
          root: ".",
          manifest: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "helpers" },
          skills: [{ name: "summarize", description: "Summarize", path: "skills/summarize" }],
          mcp: { status: "valid", servers: [{ name: "helpers", type: "streamable-http", url: "https://mcp.example/mcp" }] },
        },
      },
    }
    const both: SignedAgentPluginRuntimeSnapshot = {
      revision: 4,
      identity: { userId: "user-1", organizationId: "org-1", projectId: "project-1", workspaceId: "workspace-1" },
      plugins: ([
        ["docs", docs],
        ["helpers", helpers],
      ] as const).map(([name, digest]) => ({
        pluginInstanceId: `["acme","${name}"]`,
        pins: { user: { digest, sourceId: "acme", relativePath: name, sourceRevision: "rev-1" } },
        harnesses: Object.fromEntries((["opencode", "claude", "codex", "cursor"] as AgentPluginHarnessId[])
          .map((harnessId) => [harnessId, {
            revision: 4,
            pluginInstanceId: `["acme","${name}"]`,
            harnessId,
            projectId: "project-1",
            projectOverride: true,
            pins: { user: digest },
          }])) as SignedAgentPluginRuntimeSnapshot["plugins"][number]["harnesses"],
      })),
    }
    const preparer = createHostedMcpRuntimePreparer({
      activations: { runtimeSnapshot: async () => both },
      artifacts: {
        put: async (value) => value,
        get: async (digest: string) => retained[digest],
      },
      resolveConnection: async () => ({
        ok: true as const,
        connectionId: "connection-1",
        integrationId: "dynamic",
        scope: "personal" as const,
        fields: { resource: "https://mcp.example/mcp" },
      }),
      oauth: { fetch: oauthFetch(), preRegistered: { "https://login.example": { clientId: "claxedo" } } },
      gatewayUrl: "https://mcp-gateway.example/",
      signingEnv: env,
      secretBrokering: "native",
    })

    const defaults = agentPluginMcpRuntimePlan(await preparer.forSnapshot(both))
    expect(new Set(defaults.mcpServers.map((server) => server.pluginInstanceId)))
      .toEqual(new Set(['["acme","docs"]', '["acme","helpers"]']))

    // `helpers` is chosen as guidance, `docs` not at all: neither contributes a
    // server, so there is no credential for either to be hidden behind.
    const preparation = await preparer.forSnapshot(both, {
      selection: { plugins: [], skills: [{ sourceId: "acme", skillName: "summarize" }] },
    })
    const selected = agentPluginMcpRuntimePlan(preparation)
    expect(selected.mcpServers).toEqual([])
    expect(preparation.secrets).toEqual([])
    expect(selected.execution?.selectionHash).toMatch(/^[a-f0-9]{64}$/)

    const whole = await preparer.forSnapshot(both, {
      selection: { plugins: [{ sourceId: "acme", pluginName: "helpers" }], skills: [] },
    })
    const wholePlan = agentPluginMcpRuntimePlan(whole)
    expect(new Set(wholePlan.mcpServers.map((server) => server.pluginInstanceId))).toEqual(new Set(['["acme","helpers"]']))
    const credential = whole.secrets![0]
    const scope = await verifyMcpGatewayToken(credential.value.replace(/^Bearer /, ""), {
      integrationId: await mcpOAuthIntegrationId({ pluginInstanceId: '["acme","helpers"]', serverName: "helpers" }),
    }, env)
    expect(scope).toMatchObject({
      workspaceId: "workspace-1",
      pluginInstanceId: '["acme","helpers"]',
      artifactDigest: helpers,
      execution: "selected",
    })
  })
})
