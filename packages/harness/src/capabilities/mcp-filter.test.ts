import { expect, test } from "bun:test"
import type { ProjectedMcpServer } from "../contract/projection"
import { filterMcpServers } from "./mcp-filter"

const servers: ProjectedMcpServer[] = [
  { origin: "first-party", kind: "http", name: "claxedo", url: "http://127.0.0.1:1234", headers: { Authorization: "Bearer owner" } },
  { origin: "configured", kind: "stdio", name: "local-tool", command: "tool" },
  { origin: "configured", kind: "http", name: "http-tool", url: "https://tool.example" },
  { origin: "configured", kind: "sse", name: "sse-tool", url: "https://events.example" },
  { origin: "plugin", kind: "http", name: "plugin-tool", url: "https://plugin.example", headers: { Authorization: "Bearer plugin" } },
]

test("local sessions honor an unsupported MCP flag", () => {
  const result = filterMcpServers({ servers, locality: "local", supportsMcpServers: false })
  expect(result.servers).toEqual([])
  expect(result.notApplied).toHaveLength(servers.length)
  expect(filterMcpServers({ servers, locality: "local" }).servers).toEqual(servers)
})

test.each([
  [{}, []],
  [{ http: true }, ["http-tool"]],
  [{ sse: true }, ["sse-tool"]],
  [{ http: true, sse: true, acp: true }, ["http-tool", "sse-tool"]],
  [{ http: false, sse: false }, []],
] as const)("remote capability declaration %p permits %p", (mcpCapabilities, names) => {
  const result = filterMcpServers({ servers, locality: "remote", mcpCapabilities })
  expect(result.servers.map((server) => server.name)).toEqual([...names])
  expect(result.servers.some((server) => server.origin === "first-party" || server.origin === "plugin" || server.kind === "stdio")).toBe(false)
  expect(result.notApplied.map((entry) => entry.item).sort()).toEqual(servers.filter((server) => !names.some((name) => name === server.name)).map((server) => server.name).sort())
})

test("an explicit unsupported MCP flag excludes configured servers too", () => {
  const result = filterMcpServers({ servers, locality: "remote", supportsMcpServers: false, mcpCapabilities: { http: true, sse: true } })
  expect(result.servers).toEqual([])
  expect(result.notApplied.find((entry) => entry.item === "http-tool")?.reason).toBe("unsupported-by-harness")
})
