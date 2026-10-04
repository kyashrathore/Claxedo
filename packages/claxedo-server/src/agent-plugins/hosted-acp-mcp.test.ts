import { describe, expect, test } from "vitest"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { agentPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/tree"
import { flatMcpServerName } from "@claxedo/server-core/agent-plugins/runtime/mcp-projection"
import { hostedAcpMcpServers } from "./hosted-composition"

const encoder = new TextEncoder()
const file = (path: string, value: unknown) => ({ path, kind: "file" as const, executableMode: path === "server" ? 0o111 : 0,
  bytes: encoder.encode(typeof value === "string" ? value : JSON.stringify(value)) })

describe("hosted ACP MCP delivery", () => {
  test("a plugin server that needs its files is left out and the rest of the plugin's servers are delivered", async () => {
    const inspected = await inspectPluginTree(agentPluginTree([
      file("plugin.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "tools" }),
      file("server", "#!/bin/sh\n"),
      file("mcp.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {
        local: { type: "stdio", command: "./server" },
        remote: { type: "streamable-http", url: "https://mcp.example/mcp" },
      } }),
    ]))
    const artifacts = { get: async (digest: string) => digest === inspected.digest ? { digest: inspected.digest, tree: inspected.tree, plugin: inspected.plugin } : undefined }
    const servers = await hostedAcpMcpServers("ws_1", [{ pluginInstanceId: "tools-instance", artifactDigest: inspected.digest, harnessIds: ["acp"] }], artifacts, [])
    const key = await sha256Hex("tools-instance")
    expect(Object.keys(servers)).toEqual([flatMcpServerName("tools", key, "remote")])
    expect(servers[flatMcpServerName("tools", key, "remote")]).toMatchObject({ transport: "remote", url: "https://mcp.example/mcp" })
  })
})
