import { expect, test } from "bun:test"
import { PLUGIN_HARNESSES, type PluginActivation, type PluginCandidate, type PluginMcpServer } from "@/server"
import { pluginCloudReach, serverCloudLimit } from "./cloud-reach"

const activation: PluginActivation = { explicit: null, projectOverride: null, userDefault: null, effective: { status: "ready", effective: false, winner: "none" } }

function plugin(mcpServers: readonly PluginMcpServer[]): PluginCandidate {
  return {
    pluginInstanceId: "context7", sourceId: null, sourceKind: null, source: null, skills: [], sourceRevision: null, relativePath: null,
    candidateDigest: null, sourceAvailable: true, retainedDigest: null, updateAvailable: false, manifest: { name: "context7" },
    componentDiagnostics: [], mcpServers, harnesses: Object.fromEntries(PLUGIN_HARNESSES.map((id) => [id, activation])) as PluginCandidate["harnesses"],
  }
}

const oauth = { state: "oauth", integrationId: "context7:docs" } as const

test("an OAuth MCP server on a driver that can't carry its sign-in limits the plugin's cloud to Pi", () => {
  const candidate = plugin([{ name: "docs", type: "streamable-http", authentication: oauth,
    cloud: { state: "gateway", onlyHarnesses: ["pi"], reason: "secret_brokering_unsupported" } }])
  expect(pluginCloudReach(candidate)).toEqual({ kind: "only", harnesses: ["pi"] })
  expect(serverCloudLimit(candidate.mcpServers[0]?.cloud)).toEqual({ kind: "only", harnesses: ["pi"] })
})

test("a server that reaches every cloud harness claims the whole cloud", () => {
  const candidate = plugin([{ name: "docs", type: "streamable-http", authentication: oauth, cloud: { state: "gateway" } }])
  expect(pluginCloudReach(candidate)).toEqual({ kind: "every" })
  expect(serverCloudLimit(candidate.mcpServers[0]?.cloud)).toBeUndefined()
})

test("a server the cloud can't run makes the plugin's cloud limited", () => {
  const candidate = plugin([
    { name: "docs", type: "streamable-http", authentication: oauth, cloud: { state: "gateway" } },
    { name: "local", type: "stdio", authentication: { state: "local" }, cloud: { state: "unavailable", reason: "mcp_command_not_in_image" } },
  ])
  expect(pluginCloudReach(candidate)).toEqual({ kind: "limited" })
  expect(serverCloudLimit(candidate.mcpServers[1]?.cloud)).toEqual({ kind: "unavailable", reason: "mcp_command_not_in_image" })
})

test("a server whose catalog states no cloud reach limits nothing", () => {
  expect(pluginCloudReach(plugin([{ name: "sessions", type: "streamable-http", authentication: { state: "local" } }]))).toEqual({ kind: "every" })
})
