import {
  HARNESS_IDS, HARNESS_TABLE, isHarnessId,
  type HarnessId as BuiltInHarnessId,
} from "@claxedo/agent-runtime-contract"
import type { TransportKind } from "../contract/transport"

export type { BuiltInHarnessId }

export const CUSTOM_HARNESS_PROVIDER_KEYS = ["acp", "pi-rpc"] as const
export type CustomHarnessProviderKey = (typeof CUSTOM_HARNESS_PROVIDER_KEYS)[number]
export type HarnessId = BuiltInHarnessId | CustomHarnessProviderKey

const BUILT_IN_TRANSPORTS: Readonly<Record<BuiltInHarnessId, TransportKind>> = {
  claude: "claude-sdk",
  codex: "codex-app-server",
  cursor: "cursor-sdk",
}

const CUSTOM_TRANSPORTS: Readonly<Record<CustomHarnessProviderKey, TransportKind>> = {
  acp: "acp",
  "pi-rpc": "pi-rpc",
}

const CUSTOM_MCP: Readonly<Record<CustomHarnessProviderKey, boolean>> = {
  acp: true,
  "pi-rpc": false,
}

export type BuiltInHarnessRecord = {
  id: BuiltInHarnessId
  access: "native"
  transport: TransportKind
  mcp: boolean
} & (typeof HARNESS_TABLE)[BuiltInHarnessId]

export type CustomHarnessRecord = {
  id: CustomHarnessProviderKey
  access: "connection"
  transport: TransportKind
  mcp: boolean
}

export type HarnessRecord = BuiltInHarnessRecord | CustomHarnessRecord

export function harnessRecord(id: BuiltInHarnessId): BuiltInHarnessRecord
export function harnessRecord(id: string): HarnessRecord | undefined
export function harnessRecord(id: string): HarnessRecord | undefined {
  if (isHarnessId(id)) return { id, access: "native", transport: BUILT_IN_TRANSPORTS[id], mcp: true, ...HARNESS_TABLE[id] }
  const key = CUSTOM_HARNESS_PROVIDER_KEYS.find((candidate) => candidate === id)
  if (key) {
    return { id: key, access: "connection", transport: CUSTOM_TRANSPORTS[key], mcp: CUSTOM_MCP[key] }
  }
  return undefined
}

export function harnessesForTransport(kind: TransportKind): readonly HarnessRecord[] {
  return [...HARNESS_IDS, ...CUSTOM_HARNESS_PROVIDER_KEYS]
    .map((id) => harnessRecord(id))
    .filter((record): record is HarnessRecord => record !== undefined && record.transport === kind)
}
