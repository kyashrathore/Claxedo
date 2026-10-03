import { credentialSnapshot, type CredentialSnapshot, type ProviderProjectionSource } from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"
import { readProviderDefinitions, type CustomProviderDefinition } from "./provider-definitions"

export type RuntimeConfigSnapshotPlugins = {
  harnessLaunch: Record<string, Record<string, unknown>>
  mcp: Record<string, unknown>
}

export type TurnDeliveryRequest = { turnLease: string }

export type TurnDelivery = {
  expiresAt: number
  auth: CredentialSnapshot<ProviderProjectionSource>
  plugins: RuntimeConfigSnapshotPlugins
  providerDefinitions: readonly CustomProviderDefinition[]
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

function text(value: unknown): value is string {
  return typeof value === "string" && value !== ""
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

export function parseTurnDelivery(input: unknown): TurnDelivery | undefined {
  if (!isRecord(input) || !onlyKeys(input, ["expiresAt", "auth", "plugins", "providerDefinitions"]) || !epochMillis(input.expiresAt)) return undefined
  const auth = credentialSnapshot(input.auth, {})
  if (!auth || Object.keys(auth.accounts).length > 0) return undefined
  const section = plugins(input.plugins)
  const providerDefinitions = input.providerDefinitions === undefined ? undefined : readProviderDefinitions(input.providerDefinitions)
  if (!section || !providerDefinitions) return undefined
  return { expiresAt: input.expiresAt, auth, plugins: section, providerDefinitions }
}

export function parseTurnExecutionAccess(input: unknown): TurnExecutionAccess | undefined {
  if (!isRecord(input) || !onlyKeys(input, ["relayUrl", "workspaceId", "hostId", "routingId", "runtimeAccessToken", "expiresAt", "directory"])) return undefined
  const { relayUrl, workspaceId, hostId, routingId, runtimeAccessToken, expiresAt, directory } = input
  if (!text(relayUrl) || !text(workspaceId) || !text(hostId) || !text(runtimeAccessToken) || !text(directory)) return undefined
  if (!epochMillis(expiresAt) || (routingId !== undefined && !text(routingId))) return undefined
  return { relayUrl, workspaceId, hostId, ...(routingId === undefined ? {} : { routingId }), runtimeAccessToken, expiresAt, directory }
}
