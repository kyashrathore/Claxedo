import { describe, expect, test } from "vitest"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { acpSessionMcpServers, flatMcpServerName, pluginMcpProjection, projectedMcpServers, runtimeMcpServers, type ProjectedPlugin } from "./mcp-projection"

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
  test("resolves plugin relative commands and cwd at the projection owner", async () => {
    const relative = { ...plugin, plugin: { ...plugin.plugin, mcp: { status: "valid" as const, servers: [
      { name: "local", type: "stdio" as const, command: "./bin/server", cwd: "./work", args: ["${PLUGIN_DATA}/state"] },
    ] } } }
    const { servers } = await acpSessionMcpServers([relative], [])
    expect(Object.values(servers)[0]).toMatchObject({ command: "/gen/plugins/docs/bin/server", cwd: "/gen/plugins/docs/work", args: ["/data/docs/state"] })
  })
  test("a server the runtime marked unavailable is left out whatever its transport", () => {
    expect(projectedMcpServers(plugin, rows.filter((row) => row.harnessId === "acp")).map((server) => server.name)).toEqual(["docs", "local"])
  })

  test("the ACP session map carries flat names, the gateway placeholder and expanded plugin roots", async () => {
    const { servers, notApplied } = await acpSessionMcpServers([plugin], rows)
    expect(notApplied).toEqual([])
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
    const { servers } = await acpSessionMcpServers([plugin], rows.filter((row) => row.harnessId === "claude"))
    const key = await sha256Hex("claxedo:docs")
    expect(servers[flatMcpServerName("docs", key, "docs")]).toMatchObject({ url: "https://mcp.example/mcp", headers: {} })
  })

  test("a server that needs plugin files where none are materialized is skipped as not installed, and the rest are delivered", async () => {
    const unmaterialized: ProjectedPlugin = { pluginInstanceId: plugin.pluginInstanceId, artifactDigest: digest, plugin: { ...plugin.plugin, mcp: { status: "valid", servers: [
      { name: "docs", type: "streamable-http", url: "https://mcp.example/mcp" },
      { name: "relative", type: "stdio", command: "./bin/server" },
      { name: "rooted", type: "stdio", command: "${PLUGIN_ROOT}/bin/server" },
      { name: "data", type: "stdio", command: "server", args: ["${PLUGIN_DATA}"] },
    ] } } }
    const key = await sha256Hex("claxedo:docs")
    const { servers, notApplied } = await acpSessionMcpServers([unmaterialized], [])
    expect(Object.keys(servers)).toEqual([flatMcpServerName("docs", key, "docs")])
    expect(notApplied).toEqual(["relative", "rooted", "data"].map((name) => ({ item: flatMcpServerName("docs", key, name), reason: "not-installed" })))
  })

  test("a harness that cannot represent a server records it under its flat name", async () => {
    const sse: ProjectedPlugin & { root: string } = { ...plugin, plugin: { ...plugin.plugin, mcp: { status: "valid", servers: [
      { name: "events", type: "sse", url: "https://mcp.example/sse" },
      { name: "work", type: "stdio", command: "./bin/server", cwd: "./work" },
    ] } } }
    const key = await sha256Hex("claxedo:docs")
    const codex = await pluginMcpProjection([sse], [], "codex")
    expect(codex.byPlugin.get(sse.pluginInstanceId)?.map((server) => server.name)).toEqual(["work"])
    expect(codex.notApplied).toEqual([{ item: flatMcpServerName("docs", key, "events"), reason: "unsupported-by-harness" }])
    const claude = await pluginMcpProjection([sse], [], "claude")
    expect(claude.notApplied).toEqual([{ item: flatMcpServerName("docs", key, "work"), reason: "unsupported-by-harness" }])
  })
})
