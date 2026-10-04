import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { pluginProjectionFor } from "@claxedo/session-core"
import { brokeredPlaceholderEnv } from "@claxedo/sandbox-manager"
import { inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { agentPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/tree"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import { mountRouteContributions } from "@claxedo/workspace-runtime/route-contribution"
import { agentPluginWorkspaceRuntimeContribution } from "@claxedo/local-server/agent-plugins/runtime/runtime-contribution"
import { SUPPORTED_AGENT_PLUGIN_HARNESSES } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import { createHostedMcpRuntimePreparer } from "../mcp/runtime-preparation"
import { verifyMcpGatewayToken } from "../mcp/runtime-token"
import { createHostedAgentPluginRuntimeProvisioner, type SignedAgentPluginRuntimeSnapshot } from "./provision"
import { createSessionHostPlugins } from "./session-host-launch"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

const file = (filePath: string, value: unknown) => ({ path: filePath, kind: "file" as const, executableMode: 0, bytes: new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)) })

function oauthFetch() {
  return vi.fn(async (url: string) => {
    if (url === "https://mcp.example/mcp") return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example/resource"' } })
    if (url === "https://mcp.example/resource") return Response.json({ resource: "https://mcp.example/mcp", authorization_servers: ["https://login.example"] })
    if (url === "https://login.example/.well-known/oauth-authorization-server") return Response.json({
      issuer: "https://login.example", authorization_endpoint: "https://login.example/authorize", token_endpoint: "https://login.example/token", code_challenge_methods_supported: ["S256"],
    })
    return new Response(null, { status: 404 })
  })
}

/**
 * The real hosted preparer and provisioner over a workspace machine running
 * the real Agent Plugins apply route, for one plugin selected for every
 * harness that carries a skill, a protected remote server and an image stdio
 * server.
 */
async function plane() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey) }
  const artifact = await inspectPluginTree(agentPluginTree([
    file("plugin.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "docs" }),
    { path: "skills", kind: "directory" },
    { path: "skills/docs", kind: "directory" },
    file("skills/docs/SKILL.md", "---\nname: docs\ndescription: Read the docs\n---\n"),
    file("mcp.json", {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        docs: { type: "streamable-http", url: "https://mcp.example/mcp" },
        local: { type: "stdio", command: "local-mcp", env: { LOCAL_TOKEN: "machine-only" } },
      },
    }),
  ]))
  const harnesses = Object.fromEntries(SUPPORTED_AGENT_PLUGIN_HARNESSES.map((harnessId) => [harnessId, {
    revision: 4, pluginInstanceId: "claxedo/docs", harnessId, projectId: "project-1", projectOverride: true, pins: { user: artifact.digest },
  }])) as SignedAgentPluginRuntimeSnapshot["plugins"][number]["harnesses"]
  const snapshot: SignedAgentPluginRuntimeSnapshot = {
    revision: 4,
    identity: { userId: "user-1", organizationId: "org-1", projectId: "project-1", workspaceId: "workspace-1" },
    plugins: [{ pluginInstanceId: "claxedo/docs", pins: {}, harnesses }],
  }
  const activations = { runtimeSnapshot: async () => snapshot }
  const artifacts: AgentPluginArtifactStore = { put: async () => artifact, get: async () => artifact }
  const preparer = createHostedMcpRuntimePreparer({
    activations,
    artifacts,
    resolveConnection: async () => ({ ok: true, connectionId: "connection-1", integrationId: "dynamic", scope: "personal", fields: { resource: "https://mcp.example/mcp" } }),
    oauth: { fetch: oauthFetch(), resolve: async () => ["93.184.216.34"], preRegistered: { "https://login.example": { clientId: "claxedo" } } },
    gatewayUrl: "https://mcp-gateway.example/",
    signingEnv: env,
    secretBrokering: "none",
    imageCommands: ["local-mcp"],
  })
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "session-host-plugins-"))
  roots.push(runtimeRoot)
  const machine = new Hono()
  let machineEnv: Record<string, string> = {}
  mountRouteContributions({
    app: machine,
    contributions: [agentPluginWorkspaceRuntimeContribution({ runtimeRoot, env: new Proxy({}, { get: (_target, name: string) => machineEnv[name] }) })],
    context: {
      workspaceId: "workspace-1", directory: "/workspace", stateDirectory: runtimeRoot,
      fetch: (request: Request) => Promise.resolve(machine.fetch(request)),
      registerSessionTools: () => async () => {}, unregisterSessionTools: () => async () => {}, sessionDrivenOnlyBy: () => false,
    },
  })
  const provisioner = createHostedAgentPluginRuntimeProvisioner({
    activations,
    artifacts,
    runtimeFetch: async (_workspaceId, _identity, requestPath, init) => machine.request(requestPath, init),
  })
  const machinePreparation = await preparer.forSnapshot(snapshot, { secretBrokering: "native" })
  machineEnv = brokeredPlaceholderEnv(machinePreparation.secrets)
  return { env, provisioner, plugins: createSessionHostPlugins({ cloudWorkspace: async (id) => id === "workspace-1", activations, preparer, provisioner }) }
}

describe("the Pi plugins a session host is delivered", () => {
  test("name the machine's skill roots, carry each remote server's own gateway credential, and name stdio servers alone", async () => {
    const { env, plugins } = await plane()
    const delivered = await plugins("workspace-1")
    expect(Object.keys(delivered.harnessLaunch)).toEqual(["pi"])
    expect(delivered.mcp).toEqual({})
    const projection = pluginProjectionFor({ id: "pi", access: "native" }, { ...delivered, generation: "turn" })
    expect(projection.pluginRoots).toEqual([expect.objectContaining({ pluginInstanceId: "claxedo/docs", skillNames: ["docs"] })])
    const remote = projection.mcpServers.find((server) => server.kind === "http")
    expect(remote).toMatchObject({ kind: "http", origin: "plugin", url: expect.stringMatching(/^https:\/\/mcp-gateway\.example\/api\/claxedo\/plugins\/mcp\//) })
    const authorization = remote && remote.kind === "http" ? remote.headers?.Authorization : undefined
    expect(authorization).toMatch(/^Bearer /)
    expect(authorization).not.toContain("claxedo-broker:")
    const integrationId = decodeURIComponent(new URL(remote!.kind === "http" ? remote!.url : "").pathname.split("/").pop()!)
    expect(await verifyMcpGatewayToken(authorization!.slice("Bearer ".length), { integrationId }, env)).toMatchObject({ harnessId: "pi", workspaceId: "workspace-1" })
    const stdio = projection.mcpServers.find((server) => server.kind === "stdio")
    expect(stdio).toEqual({ kind: "stdio", name: stdio?.name, origin: "plugin", command: expect.any(String) })
    expect(JSON.stringify(delivered)).not.toContain("machine-only")
  })

  test("deliver nothing for a workspace that is not a cloud root", async () => {
    const { plugins } = await plane()
    expect(await plugins("workspace-elsewhere")).toEqual({ harnessLaunch: {}, mcp: {} })
  })
})
