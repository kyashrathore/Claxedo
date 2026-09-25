import { expect, test } from "bun:test"
import { sessionMcpServers } from "./mcp"

const input = {
  sessionId: "s", locality: "local",
  projection: { mcpServers: [{ kind: "http", name: "configured", url: "http://localhost/mcp", origin: "configured" }] },
} as const

test("merges first-party MCP after configured servers", () => {
  const servers = sessionMcpServers(input, { firstPartyMcp: () =>
    ({ kind: "http", name: "claxedo", url: "http://localhost/first" }) }, {
    includeFirstParty: true, duplicate: (name) => new Error(name),
  })
  expect(servers.map((server) => [server.name, server.origin])).toEqual([
    ["configured", "configured"], ["claxedo", "first-party"],
  ])
})

test("a duplicate name fails before vendor mapping", () => {
  expect(() => sessionMcpServers(input, { firstPartyMcp: () =>
    ({ kind: "http", name: "configured", url: "http://localhost/first" }) }, {
    includeFirstParty: true, duplicate: (name) => new Error(`duplicate ${name}`),
  })).toThrow("duplicate configured")
})
