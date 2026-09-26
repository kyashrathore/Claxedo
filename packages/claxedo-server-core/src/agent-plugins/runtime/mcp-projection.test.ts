import { describe, expect, test } from "vitest"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { acpSessionMcpServers, flatMcpServerName, projectedMcpServers, runtimeMcpServers, type ProjectedPlugin } from "./mcp-projection"

const digest = `sha256:${"a".repeat(64)}` as const

const plugin: ProjectedPlugin & { root: string; dataRoot: string } = {
  pluginInstanceId: "claxedo:docs",
  artifactDigest: digest,
  root: "/gen/plugins/docs",
  dataRoot: "/data/docs",
  plugin: {
    manifest: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "docs" },
    mcp: { status: "valid", servers: [
      { name: "docs", type: "streamable-http", url: "https://mcp.example/mcp" },
      { name: "local", type: "stdio", command: "${PLUGIN_ROOT}/bin/local", args: ["--data", "${PLUGIN_DATA}"], env: { HOME: "${PLUGIN_DATA}" } },
      { name: "missing", type: "stdio", command: "absent-from-image" },
    ] },
  },
}

const rows = runtimeMcpServers([
  { pluginInstanceId: "claxedo:docs", artifactDigest: digest, harnessId: "acp", serverName: "docs", state: "gateway", url: "https://gateway.example/api/claxedo/plugins/mcp/i1", brokeredSecretName: "CLAXEDO_MCP_ABC" },
  { pluginInstanceId: "claxedo:docs", artifactDigest: digest, harnessId: "acp", serverName: "missing", state: "unavailable", reason: "mcp_command_not_in_image" },
  { pluginInstanceId: "claxedo:docs", artifactDigest: digest, harnessId: "claude", serverName: "docs", state: "gateway", url: "https://gateway.example/api/claxedo/plugins/mcp/i1", brokeredSecretName: "CLAXEDO_MCP_ABC" },
], { CLAXEDO_MCP_ABC: "claxedo-broker:CLAXEDO_MCP_ABC" })

describe("runtime MCP projections", () => {
  test("a server the runtime marked unavailable is left out whatever its transport", () => {
    expect(projectedMcpServers(plugin, rows.filter((row) => row.harnessId === "acp")).map((server) => server.name)).toEqual(["docs", "local"])
  })

  test("the ACP session map carries flat names, the gateway placeholder and expanded plugin roots", async () => {
    const servers = await acpSessionMcpServers([plugin], rows)
    const key = await sha256Hex("claxedo:docs")
    expect(Object.keys(servers)).toEqual([flatMcpServerName("docs", key, "docs"), flatMcpServerName("docs", key, "local")])
    expect(servers[flatMcpServerName("docs", key, "docs")]).toEqual({
      name: flatMcpServerName("docs", key, "docs"),
      source: "plugin",
      transport: "remote",
      url: "https://gateway.example/api/claxedo/plugins/mcp/i1",
      headers: { Authorization: "claxedo-broker:CLAXEDO_MCP_ABC" },
    })
    expect(servers[flatMcpServerName("docs", key, "local")]).toEqual({
      name: flatMcpServerName("docs", key, "local"),
      source: "plugin",
      transport: "stdio",
      command: "/gen/plugins/docs/bin/local",
      args: ["--data", "/data/docs"],
      env: { HOME: "/data/docs" },
    })
  })

  test("rows for another harness never reach the ACP map", async () => {
    const servers = await acpSessionMcpServers([plugin], rows.filter((row) => row.harnessId === "claude"))
    const key = await sha256Hex("claxedo:docs")
    expect(servers[flatMcpServerName("docs", key, "docs")]).toMatchObject({ url: "https://mcp.example/mcp", headers: {} })
  })
})
