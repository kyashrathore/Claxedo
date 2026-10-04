import { expect, test } from "bun:test"
import type { StartInput } from "./session"
import { launchConfigChanged } from "./launch-config"

const start = {
  credentials: { leaseGeneration: "first", accountOwner: "owner", machineLoginAllowed: false, secrets: {},
    providers: { anthropic: { baseUrl: "https://broker", placeholder: "fixture", authMode: "api-key" } } },
  projection: { generation: "plugins:1", pluginRoots: [], mcpServers: [], notApplied: [] },
} as unknown as StartInput

test("launch comparisons ignore lease counters, record ordering and unrelated providers", () => {
  const next = structuredClone(start)
  next.credentials = { ...next.credentials, leaseGeneration: "second", providers: {
    cursor: { baseUrl: "https://cursor-broker", placeholder: "fixture", authMode: "bearer" },
    anthropic: { authMode: "api-key", placeholder: "fixture", baseUrl: "https://broker" },
  } }
  expect(launchConfigChanged(start, next, ["anthropic"])).toBe(false)
  expect(launchConfigChanged(start, next)).toBe(true)
})

test("launch comparisons retain credential, owner, plugin generation, MCP and secret changes", () => {
  for (const update of [
    { credentials: { ...start.credentials, accountOwner: "other" } },
    { credentials: { ...start.credentials, secrets: { token: "new" } } },
    { credentials: { ...start.credentials, providers: {} } },
    { projection: { ...start.projection, generation: "plugins:2" } },
    { projection: { ...start.projection, mcpServers: [{ kind: "http" as const, name: "docs", url: "https://docs", origin: "configured" as const }] } },
  ]) expect(launchConfigChanged(start, { ...start, ...update }, ["anthropic"])).toBe(true)
})

test("renewed binding expiry and account display labels do not replace a process", () => {
  const previous = structuredClone(start)
  const binding = { baseUrl: "https://broker", placeholder: "fixture", authMode: "api-key" as const, expiresAt: 100,
    account: { credentialId: "account", providerId: "anthropic", label: "Before" } }
  previous.credentials.providers = { anthropic: binding }
  const next = structuredClone(previous)
  next.credentials.providers = { anthropic: { ...binding, expiresAt: 200,
    account: { credentialId: "account", providerId: "anthropic", label: "After" } } }
  expect(launchConfigChanged(previous, next, ["anthropic"])).toBe(false)
})
