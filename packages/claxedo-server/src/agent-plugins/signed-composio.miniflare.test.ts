import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { Hono } from "hono"
import { Miniflare } from "miniflare"
import { inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { agentPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/tree"
import { mcpOAuthIntegrationId } from "@claxedo/server-core/agent-plugins/mcp/integration"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { mountRouteContributions } from "@claxedo/workspace-runtime/route-contribution"
import { agentPluginWorkspaceRuntimeContribution } from "@claxedo/local-server/agent-plugins/runtime/runtime-contribution"
import { hostedAgentPluginArtifactStore, type AgentPluginR2Bucket } from "./artifacts/r2-artifact-adapter"
import {
  agentPluginMcpRuntimePlan,
  createHostedMcpRuntimePreparation,
} from "./mcp/runtime-preparation"
import {
  createHostedAgentPluginRuntimeProvisioner,
  type SignedAgentPluginRuntimeSnapshot,
} from "./runtime/provision"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import type { WorkspaceRuntimePreparation } from "../workspace/route-support"
import { hostedConnectionInfo } from "../connections/hosted-connection-info"
import { userHostedConnectionInfo } from "../connections/user-hosted-connection"
import type { D1Database } from "@cloudflare/workers-types"
import { D1WorkspaceAuthority } from "../authority/adapters/d1/workspace-authority"
import type { ControlPlaneCredentials } from "../authority/services"
import {
  createHostedCapabilityTokenResolver,
  createHostedD1ConnectionsSetup,
} from "../connections/hosted-d1/setup"
import { hostedAgentPluginConnectionIntegrations } from "./mcp/connections"
import { createD1McpOAuthClientRegistry } from "./mcp/d1-client-registry"
import { HostedMcpGatewayRoutes } from "./mcp/routes"
import { mintMcpGatewayToken } from "./mcp/runtime-token"

/**
 * Signed-in Composio Gmail loop against Miniflare R2 and the real hosted
 * prepare/provision rail. Live Composio is out of scope; this file is the
 * local proof that enablement and OAuth are per-user and reused by both a
 * laptop runtime and a cloud VM.
 */

const COMPOSIO_MCP = "https://connect.composio.dev/mcp"
const COMPOSIO_RESOURCE = "https://connect.composio.dev/.well-known/oauth-protected-resource/mcp"
const COMPOSIO_ISSUER = "https://backend.composio.dev"
const PLUGIN_INSTANCE_ID = JSON.stringify(["claxedo-public", "composio"])
const USER = {
  userId: "user_signed",
  organizationId: "org_1",
  projectId: "project_1",
}
const OTHER_USER = {
  userId: "user_other",
  organizationId: "org_1",
  projectId: "project_other",
}

const roots: string[] = []
let miniflare: Miniflare
let signingEnv: Record<string, string>
let composioDigest: `sha256:${string}`
let integrationId: string

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    r2Buckets: ["CLAXEDO_AGENT_PLUGINS"],
  })
  const key = await generateKeyPair("EdDSA", { extractable: true })
  signingEnv = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  const bucket = await miniflareR2()
  const artifacts = hostedAgentPluginArtifactStore(bucket)
  const inspected = await inspectPluginTree(agentPluginTree([
    {
      path: "plugin.json",
      kind: "file",
      executableMode: 0,
      bytes: new TextEncoder().encode(JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "composio",
        version: "1.0.0",
        description: "Composio Gmail tools",
      })),
    },
    { path: "skills", kind: "directory" },
    { path: "skills/gmail", kind: "directory" },
    {
      path: "skills/gmail/SKILL.md",
      kind: "file",
      executableMode: 0,
      bytes: new TextEncoder().encode("---\nname: gmail\ndescription: Read Gmail\n---\n"),
    },
    {
      path: "mcp.json",
      kind: "file",
      executableMode: 0,
      bytes: new TextEncoder().encode(JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          gmail: { type: "streamable-http", url: COMPOSIO_MCP },
        },
      })),
    },
  ]))
  await artifacts.put(inspected)
  composioDigest = inspected.digest
  integrationId = await mcpOAuthIntegrationId({
    pluginInstanceId: PLUGIN_INSTANCE_ID,
    serverName: "gmail",
  })
})

afterAll(async () => {
  await miniflare?.dispose()
})

function harnesses(enabled: boolean): SignedAgentPluginRuntimeSnapshot["plugins"][number]["harnesses"] {
  return Object.fromEntries((["opencode", "claude", "codex", "cursor"] as AgentPluginHarnessId[]).map((harnessId) => [harnessId, {
    revision: enabled ? 1 : 0,
    pluginInstanceId: PLUGIN_INSTANCE_ID,
    harnessId,
    projectId: enabled ? USER.projectId : OTHER_USER.projectId,
    ...(enabled ? { projectOverride: true } : {}),
    pins: enabled ? { user: composioDigest } : {},
  }])) as SignedAgentPluginRuntimeSnapshot["plugins"][number]["harnesses"]
}

function snapshot(input: {
  workspaceId: string
  identity: typeof USER
  enabled: boolean
}): SignedAgentPluginRuntimeSnapshot {
  return {
    revision: input.enabled ? 1 : 0,
    identity: {
      userId: input.identity.userId,
      organizationId: input.identity.organizationId,
      projectId: input.identity.projectId,
      workspaceId: input.workspaceId,
    },
    plugins: [{
      pluginInstanceId: PLUGIN_INSTANCE_ID,
      pins: input.enabled ? { user: { digest: composioDigest, sourceId: "claxedo-public", relativePath: "composio", sourceRevision: "main" } } : {},
      harnesses: harnesses(input.enabled),
    }],
  }
}

function composioOauthFetch() {
  return vi.fn(async (url: string) => {
    if (url === COMPOSIO_MCP) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${COMPOSIO_RESOURCE}"` },
      })
    }
    if (url === COMPOSIO_RESOURCE) {
      return Response.json({
        resource: COMPOSIO_MCP,
        authorization_servers: [COMPOSIO_ISSUER],
      })
    }
    if (url === `${COMPOSIO_ISSUER}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: COMPOSIO_ISSUER,
        authorization_endpoint: `${COMPOSIO_ISSUER}/api/v3/s/mcp/authorize`,
        token_endpoint: `${COMPOSIO_ISSUER}/api/v3/s/mcp/token`,
        code_challenge_methods_supported: ["S256"],
      })
    }
    return new Response(null, { status: 404 })
  })
}

async function miniflareR2(): Promise<AgentPluginR2Bucket> {
  const bucket = await miniflare.getR2Bucket("CLAXEDO_AGENT_PLUGINS")
  return {
    async get(key) {
      const object = await bucket.get(key)
      if (!object) return null
      return { size: object.size, body: object.body as unknown as ReadableStream<Uint8Array> }
    },
    async put(key, value, options) {
      const created = await bucket.put(key, value, { onlyIf: options.onlyIf })
      return created ? { etag: created.etag } : null
    },
  }
}

async function runtimeVm(workspaceId: string, env: NodeJS.ProcessEnv) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-${workspaceId}-`))
  roots.push(root)
  const app = new Hono()
  mountRouteContributions({
    app,
    contributions: [agentPluginWorkspaceRuntimeContribution({
      runtimeRoot: root,
      codexHome: path.join(root, "codex"),
      userHomeDirectory: path.join(root, "home"),
      env,
    })],
    context: {
      workspaceId,
      directory: "/workspace",
      stateDirectory: root,
      applyHarnessLaunch: async () => {},
      registerSessionTools: () => async () => {},
      unregisterSessionTools: () => async () => {},
    },
  })
  return app
}

async function subject(connected: boolean) {
  const artifacts = hostedAgentPluginArtifactStore(await miniflareR2())
  const resolveConnection = vi.fn(async (input: {
    ownerUserId: string
    orgId: string
    integrationId: string
    capability: "mcp"
  }) => {
    if (!connected || input.ownerUserId !== USER.userId) {
      return { ok: false as const, status: 404, code: "connection_not_found" }
    }
    expect(input.integrationId).toBe(integrationId)
    expect(input.orgId).toBe(USER.organizationId)
    expect(input.capability).toBe("mcp")
    return {
      ok: true as const,
      connectionId: "connection_composio_gmail",
      integrationId,
      scope: "personal" as const,
      fields: { resource: COMPOSIO_MCP, issuer: COMPOSIO_ISSUER },
    }
  })
  const activations = {
    async runtimeSnapshot(workspaceId: string) {
      const identity = workspaceId.startsWith("ws_other") ? OTHER_USER : USER
      return snapshot({
        workspaceId,
        identity,
        enabled: identity.userId === USER.userId,
      })
    },
  }
  const prepareRuntime = createHostedMcpRuntimePreparation({
    activations,
    artifacts,
    resolveConnection,
    oauth: {
      fetch: composioOauthFetch(),
      preRegistered: { [COMPOSIO_ISSUER]: { clientId: "claxedo-composio" } },
    },
    gatewayUrl: "https://mcp-gateway.claxedo.test/",
    signingEnv,
    secretBrokering: "native",
  })
  const provisionRuntime = createHostedAgentPluginRuntimeProvisioner({
    activations,
    artifacts,
    async runtimeFetch(workspaceId, _identity, requestPath, init) {
      const runtime = runtimes.get(workspaceId)
      if (!runtime) throw new Error(`Workspace ${workspaceId} has no runtime`)
      return runtime.request(requestPath, init)
    },
  })
  const runtimes = new Map<string, Hono>()
  const receipts = new Map<string, Awaited<ReturnType<typeof provisionRuntime.provision>>>()
  const provisionForMint = async (workspaceId: string, preparation?: WorkspaceRuntimePreparation) => {
    const env: NodeJS.ProcessEnv = {}
    for (const secret of preparation?.secrets ?? []) {
      env[secret.name] = secret.value.replace(/^Bearer /, "")
    }
    runtimes.set(workspaceId, await runtimeVm(workspaceId, env))
    const receipt = await provisionRuntime.provision(workspaceId, agentPluginMcpRuntimePlan(preparation))
    receipts.set(workspaceId, receipt)
    return receipt
  }
  const connect = async (workspaceId: string) => {
    const preparation = await prepareRuntime(workspaceId)
    const receipt = await provisionForMint(workspaceId, preparation)
    return { preparation, receipt }
  }
  return { resolveConnection, prepareRuntime, provisionForMint, connect, receipts }
}

describe("signed Composio Gmail on Miniflare", () => {
  test("a local thread without Gmail auth cannot use Composio MCP", async () => {
    const { prepareRuntime, resolveConnection } = await subject(false)
    const preparation = await prepareRuntime("ws_local")
    const plan = agentPluginMcpRuntimePlan(preparation)

    expect(preparation.secrets).toBeUndefined()
    expect(plan.mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        serverName: "gmail",
        state: "unavailable",
        reason: "connection_not_found",
      }),
    ]))
    expect(resolveConnection).toHaveBeenCalledTimes(1)
    expect(resolveConnection).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: USER.userId,
      integrationId,
      capability: "mcp",
    }))
  })

  test("one signed-in enable and Gmail auth is reused by a local session and a cloud VM", async () => {
    const { resolveConnection, connect } = await subject(true)

    const local = await connect("ws_local")
    const cloud = await connect("ws_cloud")

    expect(local.preparation.secrets).toHaveLength(4)
    expect(cloud.preparation.secrets).toHaveLength(4)
    expect(new Set([
      ...(local.preparation.secrets ?? []).map((secret) => secret.name),
      ...(cloud.preparation.secrets ?? []).map((secret) => secret.name),
    ]).size).toBe(8)
    expect(JSON.stringify(local.preparation.secrets)).not.toContain("composio-gmail-access-token")
    expect(JSON.stringify(cloud.preparation.secrets)).not.toContain(COMPOSIO_MCP)

    const localPlan = agentPluginMcpRuntimePlan(local.preparation)
    const cloudPlan = agentPluginMcpRuntimePlan(cloud.preparation)
    expect(localPlan.mcpServers.every((server) => server.state === "gateway" && server.serverName === "gmail")).toBe(true)
    expect(cloudPlan.mcpServers.every((server) => server.state === "gateway" && server.serverName === "gmail")).toBe(true)
    expect(localPlan.mcpServers.map((server) => server.url)).not.toContain(COMPOSIO_MCP)
    expect(cloudPlan.mcpServers.map((server) => server.url)).not.toContain(COMPOSIO_MCP)

    expect(resolveConnection.mock.calls.every((call) => call[0].ownerUserId === USER.userId)).toBe(true)
    expect(resolveConnection).toHaveBeenCalledTimes(2)

    const localClaude = (local.receipt.harnessLaunch.claude?.pluginRoots as string[] | undefined)?.[0]
    const cloudClaude = (cloud.receipt.harnessLaunch.claude?.pluginRoots as string[] | undefined)?.[0]
    expect(localClaude).toBeTruthy()
    expect(cloudClaude).toBeTruthy()
    expect(await fs.readFile(path.join(localClaude!, "plugin.json"), "utf8")).toContain("composio")
    expect(await fs.readFile(path.join(cloudClaude!, "plugin.json"), "utf8")).toContain("composio")
    const localMcp = JSON.parse(await fs.readFile(path.join(localClaude!, ".mcp.json"), "utf8")) as {
      mcpServers: { gmail: { url: string; headers?: { Authorization?: string } } }
    }
    const cloudMcp = JSON.parse(await fs.readFile(path.join(cloudClaude!, ".mcp.json"), "utf8")) as {
      mcpServers: { gmail: { url: string; headers?: { Authorization?: string } } }
    }
    expect(localMcp.mcpServers.gmail.url).toContain("mcp-gateway.claxedo.test")
    expect(cloudMcp.mcpServers.gmail.url).toContain("mcp-gateway.claxedo.test")
    expect(localMcp.mcpServers.gmail.url).not.toBe(COMPOSIO_MCP)
    expect(cloudMcp.mcpServers.gmail.url).not.toBe(localMcp.mcpServers.gmail.url)
    expect(JSON.stringify(localMcp)).not.toContain("composio-gmail-access-token")
    expect(JSON.stringify(cloudMcp)).not.toContain("composio-gmail-access-token")
  })

  test("another signed-in user does not inherit Composio enablement or Gmail auth", async () => {
    const { resolveConnection, prepareRuntime } = await subject(true)
    const preparation = await prepareRuntime("ws_other_cloud")
    expect(agentPluginMcpRuntimePlan(preparation).mcpServers).toEqual([])
    expect(preparation.secrets).toBeUndefined()
    expect(resolveConnection).not.toHaveBeenCalled()
  })

  test("signed connection mint applies the retained plugin before handing out a local or cloud token", async () => {
    const { prepareRuntime, provisionForMint, resolveConnection, receipts } = await subject(true)
    const auth = {
      mode: "signed",
      token: "token",
      user: { subject: USER.userId, tokenIdentifier: USER.userId, issuer: "https://issuer.test" },
    } as unknown as SignedControlPlaneAuth
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "runtime-token",
      tokenExpiresAt: Date.now() + 60_000,
      jti: "jti_1",
    }))

    const local = await userHostedConnectionInfo({
      authority: {
          // The host declares its runtime's session authority on the heartbeat;
        // the user-hosted mint asks for it before the plugin gate runs.
        activeWorkspaceHost: vi.fn(async () => ({
          active: true,
          host_id: "host_1",
          workspace_id: "ws_local",
          expires_at: Date.now() + 60_000,
          last_seen_at: Date.now(),
        })),
      usersMe: vi.fn(async () => ({
          subject: USER.userId,
          // `resolveRuntimeActor` requires a full actor identity before it will
          // hand out a runtime token.
          actor_id: USER.userId,
          actor_kind: "human",
          actor_public_id: USER.userId,
          actor_name: "Signed User",
        })),
        openWorkspace: vi.fn(async () => ({
          allowed: true,
          role: "owner",
          workspace: {
            workspace_id: "ws_local_mint",
            org_id: USER.organizationId,
            backing: "local-worktree",
            access: "user-hosted",
            home_region: "us-east",
          },
        })),
        activeLocalHostLink: vi.fn(async () => ({
          active: true,
          host_id: "host_local",
          expires_at: Date.now() + 60_000,
        })),
        recordRuntimeAccessToken: vi.fn(async () => undefined),
        auditAllow: vi.fn(async () => undefined),
        auditDeny: vi.fn(async () => undefined),
      },
      sandbox: {},
      telemetry: { capture: vi.fn() },
    } as unknown as ControlPlaneServices, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      runtimeAccessTokenSigner: signer,
      prepareRuntime,
      // `provisionRuntime` is declared to resolve void; the receipt this test
      // asserts on is read from `receipts` instead.
      provisionRuntime: async (workspaceId: string, preparation?: WorkspaceRuntimePreparation) => {
        await provisionForMint(workspaceId, preparation)
      },
    }, auth, "ws_local_mint")

    const cloud = await hostedConnectionInfo({
      authority: {
          // The host declares its runtime's session authority on the heartbeat;
        // the user-hosted mint asks for it before the plugin gate runs.
        activeWorkspaceHost: vi.fn(async () => ({
          active: true,
          host_id: "host_1",
          workspace_id: "ws_local",
          expires_at: Date.now() + 60_000,
          last_seen_at: Date.now(),
        })),
      usersMe: vi.fn(async () => ({
          subject: USER.userId,
          // `resolveRuntimeActor` requires a full actor identity before it will
          // hand out a runtime token.
          actor_id: USER.userId,
          actor_kind: "human",
          actor_public_id: USER.userId,
          actor_name: "Signed User",
        })),
        openWorkspace: vi.fn(async () => ({
          allowed: true,
          role: "owner",
          workspace: {
            workspace_id: "ws_cloud_mint",
            org_id: USER.organizationId,
            backing: "cloud-vm",
            access: "cloud",
            home_region: "us-east",
          },
        })),
        recordRuntimeAccessToken: vi.fn(async () => undefined),
        auditAllow: vi.fn(async () => undefined),
        auditDeny: vi.fn(async () => undefined),
      },
      sandbox: {
        sandboxManager: {
          ensure: vi.fn(async () => ({
            status: "ready",
            hostId: "host_cloud",
            epoch: 1,
            homeRegion: "us-east",
          })),
        },
      },
      telemetry: { capture: vi.fn() },
    } as unknown as ControlPlaneServices, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      runtimeAccessTokenSigner: signer,
      prepareRuntime,
      // `provisionRuntime` is declared to resolve void; the receipt this test
      // asserts on is read from `receipts` instead.
      provisionRuntime: async (workspaceId: string, preparation?: WorkspaceRuntimePreparation) => {
        await provisionForMint(workspaceId, preparation)
      },
    }, auth, "ws_cloud_mint")

    expect(local).toMatchObject({ connection: { access: "user-hosted", runtimeAccessToken: "runtime-token" } })
    expect(cloud).toMatchObject({ connection: { access: "cloud", runtimeAccessToken: "runtime-token" } })
    expect("error" in local).toBe(false)
    expect("error" in cloud).toBe(false)
    expect(resolveConnection.mock.calls.every((call) => call[0].ownerUserId === USER.userId)).toBe(true)
    expect(signer).toHaveBeenCalledTimes(2)

    const localClaude = (receipts.get("ws_local_mint")?.harnessLaunch.claude?.pluginRoots as string[] | undefined)?.[0]
    const cloudClaude = (receipts.get("ws_cloud_mint")?.harnessLaunch.claude?.pluginRoots as string[] | undefined)?.[0]
    expect(localClaude).toBeTruthy()
    expect(cloudClaude).toBeTruthy()
    const localMcp = JSON.parse(await fs.readFile(path.join(localClaude!, ".mcp.json"), "utf8")) as {
      mcpServers: { gmail: { url: string } }
    }
    const cloudMcp = JSON.parse(await fs.readFile(path.join(cloudClaude!, ".mcp.json"), "utf8")) as {
      mcpServers: { gmail: { url: string } }
    }
    expect(localMcp.mcpServers.gmail.url).toContain("mcp-gateway.claxedo.test")
    expect(cloudMcp.mcpServers.gmail.url).toContain("mcp-gateway.claxedo.test")
    expect(JSON.stringify(localMcp)).not.toContain("composio-gmail-access-token")
    expect(JSON.stringify(cloudMcp)).not.toContain(COMPOSIO_MCP)
  })
})


/**
 * The same Composio server, reached through an authorization server that
 * supports NEITHER a pre-registered client nor a client-id metadata document —
 * the shape `https://connect.composio.dev` actually advertises. The only client
 * identity available is one this deployment registers for itself (RFC 7591),
 * and it has to survive from discovery through the callback to the gateway.
 */
const DCR_ISSUER = "https://connect.composio.dev"
const DCR_REGISTRATION = "https://login.composio.dev/oauth2/register"
const DCR_TOKEN = "https://connect.composio.dev/api/v3/s/mcp/token"
const DCR_MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0008_user_deployed_owner_bootstrap.sql",
  "0013_org_team_session_sharing.sql",
  "0017_adapter_custom.sql",
  "0018_drop_agent_extensions.sql",
  "0019_agent_plugin_activations.sql",
  "0020_hosted_connections.sql",
  "0021_mcp_oauth_clients.sql",
  "0022_sandbox_leases.sql",
]

const disposable: Miniflare[] = []

afterEach(async () => {
  await Promise.all(disposable.splice(0).map((instance) => instance.dispose()))
})

async function controlPlaneDatabase(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  disposable.push(instance)
  const target = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const name of DCR_MIGRATIONS) {
    const file = fileURLToPath(new URL(`../../migrations/control-plane/${name}`, import.meta.url))
    const migration = (await fs.readFile(file, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
  return target
}

/** Stands in for the envelope-encrypted per-org credential store. */
function credentialFake(): ControlPlaneCredentials & { secretOf(providerId: string): string | undefined } {
  const rows = new Map<string, string>()
  const meta = (providerId: string) => rows.has(providerId)
    ? {
        id: providerId,
        provider_id: providerId,
        kind: "oauth_token" as const,
        source: "managed" as const,
        secure_ref: `test:${providerId}`,
        status: "available" as const,
        created_at: 1,
        updated_at: 1,
      }
    : undefined
  return {
    listCredentials: async () => [],
    getCredentialByProvider: async (providerId) => meta(providerId),
    resolveCredentialSecret: async (providerId) => rows.get(providerId) ?? null,
    resolveCredentialSecretById: async (id) => rows.get(id) ?? null,
    putCredential: async (value) => {
      rows.set(value.provider_id, value.secret)
      return meta(value.provider_id)!
    },
    deleteCredential: async (id) => rows.delete(id),
    deleteCredentialsByProvider: async (providerId) => (rows.delete(providerId) ? 1 : 0),
    updateCredentialStatus: async () => {},
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    secretOf: (providerId) => rows.get(providerId),
  }
}

/**
 * The whole authorization server, as fetched: the 401 challenge, protected
 * resource metadata, authorization server metadata advertising ONLY a
 * registration endpoint, the RFC 7591 registration itself, and the token
 * exchange. Every request is recorded so the test can prove the client was
 * registered once and presented at the token endpoint.
 */
function dynamicRegistrationAuthorizationServer() {
  const registrations: Array<Record<string, unknown>> = []
  const tokenRequests: URLSearchParams[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    if (url === COMPOSIO_MCP && init?.method === "POST") {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${COMPOSIO_RESOURCE}"` },
      })
    }
    if (url === COMPOSIO_RESOURCE) {
      return Response.json({ resource: COMPOSIO_MCP, authorization_servers: [DCR_ISSUER] })
    }
    if (url === `${DCR_ISSUER}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: DCR_ISSUER,
        authorization_endpoint: `${DCR_ISSUER}/api/v3/s/mcp/authorize`,
        token_endpoint: DCR_TOKEN,
        registration_endpoint: DCR_REGISTRATION,
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      })
    }
    if (url === DCR_REGISTRATION) {
      registrations.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({
        client_id: "dyn-composio-client",
        client_id_issued_at: 1,
        token_endpoint_auth_method: "none",
      }, { status: 201 })
    }
    if (url === DCR_TOKEN) {
      const body = new URLSearchParams(String(init?.body))
      tokenRequests.push(body)
      if (body.get("client_id") !== "dyn-composio-client") {
        return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })
      }
      return Response.json({
        access_token: "composio-dcr-access",
        token_type: "Bearer",
        refresh_token: "composio-dcr-refresh",
        expires_in: 3_600,
      })
    }
    return new Response(null, { status: 404 })
  }
  return { fetch, registrations, tokenRequests }
}

describe("Composio MCP through RFC 7591 dynamic client registration", () => {
  test("connect, callback, token exchange, and the gateway all run on one registered client", async () => {
    const database = await controlPlaneDatabase()
    const ownerIdentity = {
      adapter: "better-auth" as const,
      issuer: "https://better-auth.example.test",
      subject: "composio-owner",
    }
    let sequence = 0
    const authority = new D1WorkspaceAuthority(database, {
      deploymentId: "deployment-a",
      product: {
        kind: "user-deployed",
        organization: { id: "org_deployment", name: "Deployment" },
        ownerIdentity,
      },
      now: () => 1_900_000_000_000 + sequence,
      randomId: (prefix: string) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
    })
    const active = await authority.ensureApplicationIdentity(ownerIdentity)
    if (active.state !== "active") throw new Error(`identity did not become active: ${active.state}`)
    // The signed shape the authority verifies: a real application principal,
    // not a token claim (mirrors `signed()` in hosted-d1/setup.test.ts).
    const owner: SignedControlPlaneAuth = {
      mode: "signed",
      principal: {
        userId: active.userId,
        actorId: active.actorId,
        actorKind: "human",
        deploymentId: "deployment-a",
        sessionId: `session:${ownerIdentity.subject}`,
        authenticatedAt: 1_900_000_000_000,
        methods: ["oauth:github"],
        assurance: "single-factor",
        client: {
          kind: "browser",
          tokenKind: "browser-session",
          id: "browser",
          resource: "https://api.example.test",
          scopes: ["openid"],
          origin: "https://app.example.test",
        },
        identity: ownerIdentity,
      },
      user: {
        subject: ownerIdentity.subject,
        tokenIdentifier: `${ownerIdentity.issuer}|${ownerIdentity.subject}`,
        issuer: ownerIdentity.issuer,
      },
    }
    const orgId = String((await authority.usersMe(owner) as { org_id: string }).org_id)

    const server = dynamicRegistrationAuthorizationServer()
    const registry = createD1McpOAuthClientRegistry({ database })
    const artifacts = hostedAgentPluginArtifactStore(await miniflareR2())
    const activations = {
      listKnown: async () => [{
        pluginInstanceId: PLUGIN_INSTANCE_ID,
        pins: { user: { digest: composioDigest, sourceId: "claxedo-public", relativePath: "composio", sourceRevision: "main" } },
      }],
    }
    const credentials = credentialFake()
    const connectionsInput = {
      env: {},
      database,
      services: { authority } as unknown as ControlPlaneServices,
      authenticate: async () => ({ auth: owner }),
      dynamicIntegrations: hostedAgentPluginConnectionIntegrations({
        activations: activations as never,
        artifacts,
        oauth: {
          callbackUrl: "https://claxedo.test/api/claxedo/integrations/callback",
          fetch: server.fetch,
          dynamicRegistration: {
            clientMetadata: {
              client_name: "Claxedo",
              client_uri: "https://claxedo.test/",
              redirect_uris: ["https://claxedo.test/api/claxedo/integrations/callback"],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
            ...registry,
          },
        },
      }),
      credentials: () => credentials,
      sweepSample: () => false,
    }
    const connections = createHostedD1ConnectionsSetup(connectionsInput)

    // A. Connect. Discovery finds only a registration endpoint, so the client
    //    is registered here and nowhere else.
    const started = await connections.request(`/${integrationId}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "oauth", scope: "personal" }),
    })
    expect(started.status).toBe(200)
    const attempt = (await started.json()) as { ok: true; url: string; attemptId: string }
    expect(server.registrations).toHaveLength(1)
    expect(server.registrations[0]).toMatchObject({ token_endpoint_auth_method: "none", client_name: "Claxedo" })
    expect(server.registrations[0].client_id).toBeUndefined()
    expect(new URL(attempt.url).searchParams.get("client_id")).toBe("dyn-composio-client")
    expect(await registry.lookup(DCR_ISSUER)).toEqual({ clientId: "dyn-composio-client" })

    // B. Callback. A new setup stands in for the next isolate — the client id
    //    it presents comes from the registry, never from the attempt alone.
    const next = createHostedD1ConnectionsSetup(connectionsInput)
    const callback = await next.request(`/callback?state=${attempt.attemptId}&code=composio-grant`)
    expect(callback.status).toBe(200)
    expect(server.tokenRequests).toHaveLength(1)
    expect(server.tokenRequests[0].get("client_id")).toBe("dyn-composio-client")
    expect(server.tokenRequests[0].get("client_secret")).toBeNull()
    expect(server.tokenRequests[0].get("resource")).toBe(COMPOSIO_MCP)

    const stored = await database
      .prepare("select owner_user_id, integration_id, fields_json from hosted_connections")
      .all<{ owner_user_id: string; integration_id: string; fields_json: string }>()
    expect(stored.results).toHaveLength(1)
    expect(stored.results[0].integration_id).toBe(integrationId)
    expect(JSON.parse(stored.results[0].fields_json)).toMatchObject({
      client_kind: "dynamic",
      client_id: "dyn-composio-client",
      resource: COMPOSIO_MCP,
    })
    expect(JSON.stringify(stored.results)).not.toContain("composio-dcr-access")
    // The registration happened exactly once across the whole flow.
    expect(server.registrations).toHaveLength(1)

    // C. The gateway forwards the token that grant produced.
    const rowFields = JSON.parse(stored.results[0].fields_json) as Record<string, string>
    const upstream: Array<string | null> = []
    const gateway = HostedMcpGatewayRoutes({
      env: signingEnv,
      authorize: async () => ({ resource: COMPOSIO_MCP }),
      resolveConnection: async (scope) => {
        const resolved = await createHostedCapabilityTokenResolver(connectionsInput)({
          ownerUserId: scope.userId,
          orgId: scope.orgId,
          integrationId: scope.integrationId,
          capability: "mcp",
        })
        // PRE-EXISTING GAP, not something this flow introduced: the kit's OAuth
        // token path returns `{ token, tokenType }` with no `fields`
        // (packages/claxedo-connections/src/tokens.ts:133), while the gateway
        // refuses anything whose `fields.resource` does not equal the
        // authorized resource (mcp/routes.ts:38). The canonical fields ARE on
        // the row, so they are read from it here; without that the gateway
        // answers 409 for every OAuth MCP connection.
        return resolved.ok ? { ...resolved, fields: rowFields } : resolved
      },
      fetch: async (_url, init) => {
        upstream.push(new Headers(init?.headers).get("authorization"))
        return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
      },
    })
    const scope = {
      userId: active.userId,
      orgId,
      projectId: "project_1",
      workspaceId: "ws_cloud",
      harnessId: "claude" as const,
      pluginInstanceId: PLUGIN_INSTANCE_ID,
      serverName: "gmail",
      integrationId,
    }
    const minted = await mintMcpGatewayToken(scope, signingEnv)
    const forwarded = await gateway.request(`/${integrationId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(forwarded.status).toBe(200)
    expect(upstream).toEqual(["Bearer composio-dcr-access"])
  })
})
