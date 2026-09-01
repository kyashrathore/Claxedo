import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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

