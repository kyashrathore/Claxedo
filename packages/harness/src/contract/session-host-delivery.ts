import { credentialSnapshot, type CredentialSnapshot } from "@claxedo/agent-runtime-contract"
import { isNonEmptyString, isRecord } from "@claxedo/helpers/guards"
import { readProviderDefinitions, type CustomProviderDefinition } from "./provider-definitions"

export type RuntimeConfigSnapshotPlugins = {
  harnessLaunch: Record<string, Record<string, unknown>>
  mcp: Record<string, unknown>
}

export type TurnDeliveryRequest = { turnLease: string }

export type FirstPartyMcpDelivery = { name: string; url: string; token: string; toolGroups: readonly string[] }

export type TurnDelivery = {
  expiresAt: number
  auth: CredentialSnapshot
  plugins: RuntimeConfigSnapshotPlugins
  providerDefinitions: readonly CustomProviderDefinition[]
  firstPartyMcp?: FirstPartyMcpDelivery
}

export type TurnExecutionAccess = {
  relayUrl: string
  workspaceId: string
  hostId: string
  routingId?: string
  runtimeAccessToken: string
  expiresAt: number
  directory: string
}

function onlyKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(input).every((key) => keys.includes(key))
}

function epochMillis(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function plugins(input: unknown): RuntimeConfigSnapshotPlugins | undefined {
  if (!isRecord(input) || !onlyKeys(input, ["harnessLaunch", "mcp"])) return undefined
  const { harnessLaunch, mcp } = input
  if (!isRecord(mcp) || !isRecord(harnessLaunch)) return undefined
  const rows: Record<string, Record<string, unknown>> = {}
  for (const [harnessId, row] of Object.entries(harnessLaunch)) {
    if (!isRecord(row)) return undefined
    rows[harnessId] = row
  }
  return { harnessLaunch: rows, mcp }
}

function firstPartyMcp(input: unknown): FirstPartyMcpDelivery | undefined {
  if (!isRecord(input) || !onlyKeys(input, ["name", "url", "token", "toolGroups"])) return undefined
  const { name, url, token, toolGroups } = input
  if (!isNonEmptyString(name) || !isNonEmptyString(url) || !isNonEmptyString(token)) return undefined
  if (!Array.isArray(toolGroups) || toolGroups.length === 0 || !toolGroups.every(isNonEmptyString)) return undefined
  return { name, url, token, toolGroups }
}

export function parseTurnDelivery(input: unknown): TurnDelivery | undefined {
  if (!isRecord(input) || !onlyKeys(input, ["expiresAt", "auth", "plugins", "providerDefinitions", "firstPartyMcp"]) || !epochMillis(input.expiresAt)) return undefined
  const auth = credentialSnapshot(input.auth, {})
  if (!auth || Object.keys(auth.accounts).length > 0) return undefined
  const section = plugins(input.plugins)
  const providerDefinitions = input.providerDefinitions === undefined ? undefined : readProviderDefinitions(input.providerDefinitions)
  const mcp = input.firstPartyMcp === undefined ? undefined : firstPartyMcp(input.firstPartyMcp)
  if (!section || !providerDefinitions || (input.firstPartyMcp !== undefined && !mcp)) return undefined
  return { expiresAt: input.expiresAt, auth, plugins: section, providerDefinitions, ...(mcp ? { firstPartyMcp: mcp } : {}) }
}

export function parseTurnExecutionAccess(input: unknown): TurnExecutionAccess | undefined {
  if (!isRecord(input) || !onlyKeys(input, ["relayUrl", "workspaceId", "hostId", "routingId", "runtimeAccessToken", "expiresAt", "directory"])) return undefined
  const { relayUrl, workspaceId, hostId, routingId, runtimeAccessToken, expiresAt, directory } = input
  if (!isNonEmptyString(relayUrl) || !isNonEmptyString(workspaceId) || !isNonEmptyString(hostId) || !isNonEmptyString(runtimeAccessToken) || !isNonEmptyString(directory)) return undefined
  if (!epochMillis(expiresAt) || (routingId !== undefined && !isNonEmptyString(routingId))) return undefined
  return { relayUrl, workspaceId, hostId, ...(routingId === undefined ? {} : { routingId }), runtimeAccessToken, expiresAt, directory }
}
