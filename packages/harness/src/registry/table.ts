import {
  AGENT_HARNESS_DEFINITIONS, AGENT_HARNESS_IDS, HARNESS_TABLE, isHarnessId,
  type AgentHarnessId, type HarnessId as BuiltInHarnessId,
} from "@claxedo/agent-runtime-contract"
import type { TransportKind } from "../contract/transport"

export type { BuiltInHarnessId }

export const CUSTOM_HARNESS_PROVIDER_KEYS = ["acp"] as const
export type CustomHarnessProviderKey = (typeof CUSTOM_HARNESS_PROVIDER_KEYS)[number]
export type NativeHarnessId = AgentHarnessId
export type HarnessId = NativeHarnessId | CustomHarnessProviderKey

const BUILT_IN_TRANSPORTS = {
  claude: "claude-sdk",
  codex: "codex-app-server",
  cursor: "cursor-sdk",
  pi: "pi-rpc",
  opencode: "opencode-sdk",
} as const satisfies Readonly<Record<NativeHarnessId, TransportKind>>

const BUILT_IN_MCP = {
  claude: true,
  codex: true,
  cursor: true,
  pi: false,
  opencode: true,
} as const satisfies Readonly<Record<NativeHarnessId, boolean>>

const CUSTOM_TRANSPORTS: Readonly<Record<CustomHarnessProviderKey, TransportKind>> = {
  acp: "acp",
}

const CUSTOM_MCP: Readonly<Record<CustomHarnessProviderKey, boolean>> = {
  acp: true,
}

export type BuiltInHarnessRecord = {
  id: BuiltInHarnessId
  access: "native"
  transport: TransportKind
  mcp: boolean
} & (typeof HARNESS_TABLE)[BuiltInHarnessId]

export type NativeEngineRecord = {
  id: Exclude<NativeHarnessId, BuiltInHarnessId>
  access: "native"
  transport: TransportKind
  mcp: boolean
  label: string
}

export type CustomHarnessRecord = {
  id: CustomHarnessProviderKey
  access: "connection"
  transport: TransportKind
  mcp: boolean
}

export type HarnessRecord = BuiltInHarnessRecord | NativeEngineRecord | CustomHarnessRecord

function isEngineHarnessId(id: string): id is Exclude<NativeHarnessId, BuiltInHarnessId> {
  return (AGENT_HARNESS_IDS as readonly string[]).includes(id) && !isHarnessId(id)
}

export function harnessRecord(id: BuiltInHarnessId): BuiltInHarnessRecord
export function harnessRecord(id: string): HarnessRecord | undefined
export function harnessRecord(id: string): HarnessRecord | undefined {
  if (isHarnessId(id)) return { id, access: "native", transport: BUILT_IN_TRANSPORTS[id], mcp: BUILT_IN_MCP[id], ...HARNESS_TABLE[id] }
  if (isEngineHarnessId(id)) {
    return { id, access: "native", transport: BUILT_IN_TRANSPORTS[id], mcp: BUILT_IN_MCP[id],
      label: AGENT_HARNESS_DEFINITIONS.find((item) => item.id === id)!.label }
  }
  const key = CUSTOM_HARNESS_PROVIDER_KEYS.find((candidate) => candidate === id)
  if (key) {
    return { id: key, access: "connection", transport: CUSTOM_TRANSPORTS[key], mcp: CUSTOM_MCP[key] }
  }
  return undefined
}
