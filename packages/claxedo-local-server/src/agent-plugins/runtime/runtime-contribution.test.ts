import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { encodePluginTreeBase64 } from "@claxedo/server-core/agent-plugins/artifacts/codec"
import { agentPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/tree"
import { AGENT_PLUGINS_RUNTIME_APPLY_PATH } from "@claxedo/server-core/agent-plugins/runtime/apply-contract"
import { mountRouteContributions } from "@claxedo/workspace-runtime/route-contribution"
import { agentPluginWorkspaceRuntimeContribution } from "./runtime-contribution"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function fixture(input: { mcp?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugins-runtime-"))
  roots.push(root)
  const artifact = await inspectPluginTree(agentPluginTree([
    { path: "plugin.json", kind: "file", executableMode: 0, bytes: new TextEncoder().encode(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "review",
    })) },
    { path: "skills", kind: "directory" },
    { path: "skills/review", kind: "directory" },
    { path: "skills/review/SKILL.md", kind: "file", executableMode: 0, bytes: new TextEncoder().encode("# Review\n") },
    ...(input.mcp ? [{
      path: "mcp.json",
      kind: "file" as const,
      executableMode: 0,
      bytes: new TextEncoder().encode(JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { docs: { type: "streamable-http", url: "https://upstream.example/mcp" } },
      })),
    }] : []),
  ]))
  const applyHarnessLaunch = vi.fn(async () => {})
  const app = new Hono()
  mountRouteContributions({
    app,
    contributions: [agentPluginWorkspaceRuntimeContribution({
      runtimeRoot: root,
      codexHome: path.join(root, "codex"),
      userHomeDirectory: path.join(root, "home"),
      ...(input.env ? { env: input.env } : {}),
    })],
    context: {
      workspaceId: "ws_1",
      directory: "/workspace",
      stateDirectory: root,
      applyHarnessLaunch,
      registerSessionTools: () => async () => {},
      unregisterSessionTools: () => async () => {},
    },
  })
  return { root, artifact, app, applyHarnessLaunch }
}

describe("agentPluginWorkspaceRuntimeContribution", () => {
  test("verifies delivered bytes, atomically materializes, and reapplies an idempotent revision", async () => {
    const { artifact, app, applyHarnessLaunch } = await fixture()
    const body = {
      version: 1,
      identity: { mode: "signed", userId: "user_1", projectId: "project_1" },
      revision: 1,
      selections: [{ pluginInstanceId: "claxedo/review", artifactDigest: artifact.digest, harnessIds: ["claude"] }],
      artifacts: [{ digest: artifact.digest, tree: encodePluginTreeBase64(artifact.tree) }],
      mcpServers: [],
    }
    const first = await app.request(AGENT_PLUGINS_RUNTIME_APPLY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(first.status).toBe(200)
    const applied = await first.json() as { generationId: string; harnessLaunch: { claude: { pluginRoots: string[] } } }
    expect(applied.harnessLaunch.claude.pluginRoots).toHaveLength(1)
    expect(await fs.readFile(path.join(applied.harnessLaunch.claude.pluginRoots[0]!, "plugin.json"), "utf8")).toContain("review")

    const second = await app.request(AGENT_PLUGINS_RUNTIME_APPLY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(second.status).toBe(200)
    expect((await second.json() as { generationId: string }).generationId).toBe(applied.generationId)
    expect(applyHarnessLaunch).toHaveBeenCalledTimes(2)
  })

  test("refuses bytes outside the exact selected digest set", async () => {
    const { artifact, app, applyHarnessLaunch } = await fixture()
    const response = await app.request(AGENT_PLUGINS_RUNTIME_APPLY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: { mode: "signed", userId: "user_1", projectId: "project_1" },
        revision: 1,
        selections: [],
        artifacts: [{ digest: artifact.digest, tree: encodePluginTreeBase64(artifact.tree) }],
        mcpServers: [],
      }),
    })
    expect(response.status).toBe(400)
    expect(applyHarnessLaunch).not.toHaveBeenCalled()
  })

  test("projects only the sandbox-native broker reference, never the gateway credential", async () => {
    const secretName = "CLAXEDO_MCP_ABC"
    const { artifact, app } = await fixture({ mcp: true, env: { [secretName]: "dtn_secret_reference" } })
    const response = await app.request(AGENT_PLUGINS_RUNTIME_APPLY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: { mode: "signed", userId: "user_1", projectId: "project_1" },
        revision: 1,
        selections: [{ pluginInstanceId: "claxedo/review", artifactDigest: artifact.digest, harnessIds: ["claude"] }],
        artifacts: [{ digest: artifact.digest, tree: encodePluginTreeBase64(artifact.tree) }],
        mcpServers: [{
          pluginInstanceId: "claxedo/review",
          artifactDigest: artifact.digest,
          harnessId: "claude",
          serverName: "docs",
          state: "gateway",
          url: "https://mcp-abc.gateway.example/api/claxedo/plugins/mcp/id",
          brokeredSecretName: secretName,
        }],
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { harnessLaunch: { claude: { pluginRoots: string[] } } }
    const config = JSON.parse(await fs.readFile(path.join(body.harnessLaunch.claude.pluginRoots[0]!, ".mcp.json"), "utf8"))
    expect(config.mcpServers.docs).toEqual({
      type: "http",
      url: "https://mcp-abc.gateway.example/api/claxedo/plugins/mcp/id",
      headers: { Authorization: "Bearer dtn_secret_reference" },
    })
    expect(JSON.stringify(config)).not.toContain("upstream-oauth-token")
  })

  test("routes brokered MCP through the existing Cloudflare egress capability", async () => {
    const secretName = "CLAXEDO_MCP_ABC"
    const target = "https://mcp-abc.gateway.example/api/claxedo/plugins/mcp/id"
    const { artifact, app } = await fixture({
      mcp: true,
      env: {
        CLAXEDO_EGRESS_PROXY_URL: "https://sandbox-worker.example/egress",
        CLAXEDO_EGRESS_TOKEN: "sandbox-bound-egress-token",
        CLAXEDO_EGRESS_HOSTS: JSON.stringify(["mcp-abc.gateway.example"]),
      },
    })
    const response = await app.request(AGENT_PLUGINS_RUNTIME_APPLY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        identity: { mode: "signed", userId: "user_1", projectId: "project_1" },
        revision: 1,
        selections: [{ pluginInstanceId: "claxedo/review", artifactDigest: artifact.digest, harnessIds: ["claude"] }],
        artifacts: [{ digest: artifact.digest, tree: encodePluginTreeBase64(artifact.tree) }],
        mcpServers: [{
          pluginInstanceId: "claxedo/review",
          artifactDigest: artifact.digest,
          harnessId: "claude",
          serverName: "docs",
          state: "gateway",
          url: target,
          brokeredSecretName: secretName,
        }],
      }),
    })
    const body = await response.json() as { harnessLaunch: { claude: { pluginRoots: string[] } } }
    const config = JSON.parse(await fs.readFile(path.join(body.harnessLaunch.claude.pluginRoots[0]!, ".mcp.json"), "utf8"))
    expect(config.mcpServers.docs).toMatchObject({
      url: "https://sandbox-worker.example/egress",
      headers: {
        Authorization: "Bearer sandbox-bound-egress-token",
        "x-claxedo-egress-target": target,
      },
    })
  })

  test("fails closed when Cloudflare egress configuration is partial or malformed", async () => {
    const secretName = "CLAXEDO_MCP_ABC"
    const target = "https://mcp-abc.gateway.example/api/claxedo/plugins/mcp/id"
    const body = (artifact: Awaited<ReturnType<typeof fixture>>["artifact"]) => ({
      version: 1,
      identity: { mode: "signed", userId: "user_1", projectId: "project_1" },
      revision: 1,
      selections: [{ pluginInstanceId: "claxedo/review", artifactDigest: artifact.digest, harnessIds: ["claude"] }],
      artifacts: [{ digest: artifact.digest, tree: encodePluginTreeBase64(artifact.tree) }],
      mcpServers: [{
        pluginInstanceId: "claxedo/review",
        artifactDigest: artifact.digest,
        harnessId: "claude",
        serverName: "docs",
        state: "gateway",
        url: target,
        brokeredSecretName: secretName,
      }],
    })

    for (const env of [
      {
        CLAXEDO_EGRESS_PROXY_URL: "https://sandbox-worker.example/egress",
        CLAXEDO_EGRESS_TOKEN: "sandbox-bound-egress-token",
      },
      {
        CLAXEDO_EGRESS_PROXY_URL: "https://sandbox-worker.example/egress",
        CLAXEDO_EGRESS_TOKEN: "sandbox-bound-egress-token",
        CLAXEDO_EGRESS_HOSTS: "mcp-abc.gateway.example",
      },
    ]) {
      const { artifact, app, applyHarnessLaunch } = await fixture({ mcp: true, env })
      const response = await app.request(AGENT_PLUGINS_RUNTIME_APPLY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body(artifact)),
      })
      expect(response.status).toBe(500)
      expect(applyHarnessLaunch).not.toHaveBeenCalled()
    }
  })
})
