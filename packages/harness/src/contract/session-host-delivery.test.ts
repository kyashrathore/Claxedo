import { expect, test } from "bun:test"
import { parseTurnDelivery, parseTurnExecutionAccess } from "./session-host-delivery"

const direct = { delivery: "direct" as const, baseUrl: "https://api.anthropic.com", secret: "sk-ant", authKind: "api-key" as const, expiresAt: 1_800_000_000_000 }
const provider = {
  id: "lab", name: "Lab", npm: "@ai-sdk/openai-compatible" as const, baseURL: "https://lab.example/v1", headers: {},
  models: { small: { name: "Small" } }, credentialProviderId: "lab", credentialSource: "account" as const,
}
const delivery = {
  expiresAt: 1_800_000_000_000,
  auth: { machineOwnerUserId: "owner", accounts: {}, direct: { owner: { anthropic: direct } } },
  plugins: { harnessLaunch: { pi: { generation: "g1", pluginRoots: [] } }, mcp: {} },
  providerDefinitions: [provider],
}
const execution = {
  relayUrl: "https://relay.example", workspaceId: "ws_1", hostId: "host_1", routingId: "route-1",
  runtimeAccessToken: "rat", expiresAt: 1_800_000_000_000, directory: "/workspace",
}

test("a turn delivery round-trips the owner's direct rows, the plugin section and provider definitions", () => {
  expect(parseTurnDelivery(JSON.parse(JSON.stringify(delivery)))).toEqual(delivery)
})

test("a turn delivery carries the first-party MCP server it names, and refuses one missing its token or tool groups, or carrying more", () => {
  const firstPartyMcp = { name: "claxedo", url: "https://plane.example/api/claxedo/mcp?session=ses_1", token: "session-mcp", toolGroups: ["sessions"] }
  expect(parseTurnDelivery({ ...delivery, firstPartyMcp })).toEqual({ ...delivery, firstPartyMcp })
  expect(parseTurnDelivery({ ...delivery, firstPartyMcp: { ...firstPartyMcp, token: "" } })).toBeUndefined()
  expect(parseTurnDelivery({ ...delivery, firstPartyMcp: { ...firstPartyMcp, toolGroups: [] } })).toBeUndefined()
  expect(parseTurnDelivery({ ...delivery, firstPartyMcp: { ...firstPartyMcp, headers: {} } })).toBeUndefined()
})

test("a turn delivery carrying brokered accounts, an unknown field or no expiry is refused", () => {
  const binding = { baseUrl: "https://broker.example", placeholder: "p", authMode: "api-key" }
  expect(parseTurnDelivery({ ...delivery, auth: { ...delivery.auth, accounts: { owner: { anthropic: binding } } } })).toBeUndefined()
  expect(parseTurnDelivery({ ...delivery, auth: { ...delivery.auth, direct: { owner: { anthropic: { ...direct, secret: "a\nb" } } } } })).toBeUndefined()
  expect(parseTurnDelivery({ ...delivery, extra: true })).toBeUndefined()
  const { expiresAt: _expiresAt, ...unbounded } = delivery
  expect(parseTurnDelivery(unbounded)).toBeUndefined()
  const { providerDefinitions: _providerDefinitions, ...undeclared } = delivery
  expect(parseTurnDelivery(undeclared)).toBeUndefined()
  expect(parseTurnDelivery({ ...delivery, plugins: { harnessLaunch: { pi: [] }, mcp: {} } })).toBeUndefined()
})

test("execution access round-trips with and without a routing id and refuses what it does not model", () => {
  expect(parseTurnExecutionAccess(execution)).toEqual(execution)
  const { routingId: _routingId, ...unrouted } = execution
  expect(parseTurnExecutionAccess(unrouted)).toEqual(unrouted)
  expect(parseTurnExecutionAccess({ ...execution, runtimeAccessToken: "" })).toBeUndefined()
  expect(parseTurnExecutionAccess({ ...execution, expiresAt: -1 })).toBeUndefined()
  expect(parseTurnExecutionAccess({ ...execution, role: "editor" })).toBeUndefined()
})
