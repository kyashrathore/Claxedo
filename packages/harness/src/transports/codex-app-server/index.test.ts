import { expect, test } from "bun:test"
import type { HarnessServices, StartInput } from "../../contract"
import { projectCodexThreadConfig } from "."

const input: StartInput = {
  sessionId: "s1", directory: "/work", locality: "local",
  owner: { kind: "machine-owner" },
  config: { harness: { id: "codex", access: "native" } },
  projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [
    { kind: "stdio", name: "configured", command: "server", args: ["--port", "47501"], env: { TOKEN: "sentinel" }, origin: "configured" },
    { kind: "http", name: "plugin", url: "http://127.0.0.1:47502", headers: { Authorization: "Bearer sentinel" }, origin: "plugin" },
  ] },
  credentials: { providers: {}, secrets: {}, leaseGeneration: "g1" },
}

test("Codex receives every projected MCP server and local first-party server", () => {
  const services = { firstPartyMcp: () => ({ kind: "http", name: "claxedo", url: "http://127.0.0.1:47503" }) } as unknown as HarnessServices
  const config = projectCodexThreadConfig(input, services)
  expect(config.mcp_servers).toEqual({
    configured: { command: "server", args: ["--port", "47501"], env: { TOKEN: "sentinel" } },
    plugin: { url: "http://127.0.0.1:47502", http_headers: { Authorization: "Bearer sentinel" } },
    claxedo: { url: "http://127.0.0.1:47503", http_headers: {} },
  })
  expect((projectCodexThreadConfig({ ...input, locality: "remote" }, services).mcp_servers as Record<string, unknown>).claxedo).toBeUndefined()
})
