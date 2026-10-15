import { expect, test } from "bun:test"
import { marketplaceCatalogFromWire } from "@/server/wire/marketplace-catalog"
import { pluginCloudReach, serverCloudLimit } from "./cloud-reach"

const activation = { explicit: null, projectOverride: null, userDefault: null, effective: { status: "ready", effective: false, winner: "none" } }
const harnesses = Object.fromEntries(["opencode", "claude", "codex", "cursor", "pi", "acp"].map((id) => [id, activation]))

function catalogWith(mcpServers: unknown[]) {
  const parsed = marketplaceCatalogFromWire({
    revision: 1, supportedHarnesses: ["claude", "pi"], errors: [],
    candidates: [{
      pluginInstanceId: "context7", source: null, sourceAvailable: true, updateAvailable: false, groups: [], skills: [],
      manifest: { name: "context7" }, componentDiagnostics: [], mcpServers, harnesses,
    }],
  })
  const plugin = parsed?.candidates[0]
  if (!plugin) throw new Error("catalog did not parse")
  return plugin
}

const oauth = { state: "oauth", integrationId: "context7:docs" }

test("an OAuth MCP server on a driver that can't carry its sign-in limits the plugin's cloud to Pi", () => {
  const plugin = catalogWith([{ name: "docs", type: "streamable-http", authentication: oauth,
    cloud: { state: "gateway", onlyHarnesses: ["pi"], reason: "secret_brokering_unsupported" } }])
  expect(pluginCloudReach(plugin)).toEqual({ kind: "only", harnesses: ["pi"] })
  expect(serverCloudLimit(plugin.mcpServers[0]?.cloud)).toEqual({ kind: "only", harnesses: ["pi"] })
})

test("a server that reaches every cloud harness claims the whole cloud", () => {
  const plugin = catalogWith([{ name: "docs", type: "streamable-http", authentication: oauth, cloud: { state: "gateway" } }])
  expect(pluginCloudReach(plugin)).toEqual({ kind: "every" })
  expect(serverCloudLimit(plugin.mcpServers[0]?.cloud)).toBeUndefined()
})

test("a server the cloud can't run makes the plugin's cloud limited", () => {
  const plugin = catalogWith([
    { name: "docs", type: "streamable-http", authentication: oauth, cloud: { state: "gateway" } },
    { name: "local", type: "stdio", authentication: { state: "local" }, cloud: { state: "unavailable", reason: "mcp_command_not_in_image" } },
  ])
  expect(pluginCloudReach(plugin)).toEqual({ kind: "limited" })
  expect(serverCloudLimit(plugin.mcpServers[1]?.cloud)).toEqual({ kind: "unavailable", reason: "mcp_command_not_in_image" })
})

test("a cloud reach naming an unknown harness or no reason is a contract mismatch", () => {
  const read = (cloud: unknown) => marketplaceCatalogFromWire({
    revision: 1, supportedHarnesses: ["pi"], errors: [],
    candidates: [{ pluginInstanceId: "p", source: null, sourceAvailable: true, updateAvailable: false, groups: [], skills: [],
      manifest: null, componentDiagnostics: [], harnesses,
      mcpServers: [{ name: "docs", type: "streamable-http", authentication: oauth, cloud }] }],
  })
  expect(read({ state: "gateway", onlyHarnesses: ["acme"], reason: "secret_brokering_unsupported" })).toBeUndefined()
  expect(read({ state: "gateway", onlyHarnesses: ["pi"] })).toBeUndefined()
})
