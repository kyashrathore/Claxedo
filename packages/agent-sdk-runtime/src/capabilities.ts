import type { AgentHarnessId } from "./harness-types"
import type { OpenCodeRequestFn } from "./harnesses/opencode"

export type HarnessCapabilityTarget = AgentHarnessId
export type AdapterCapability = "http-proxy" | "runtime-config"

export type HarnessCapabilities = {
  harness: HarnessCapabilityTarget
  abort: boolean
  reconnect: boolean
  replay: boolean
  permissions: boolean
  questions: boolean
  todos: boolean
  commands: boolean
  fork: boolean
  revert: boolean
  unrevert: boolean
  configOptions: boolean
  subagents: boolean
}

export type HarnessCapabilityContext = {
  sessionId?: string
}

export function harnessCapabilities(input: HarnessCapabilities): HarnessCapabilities {
  return input
}

export type AdapterCapabilityProvider = {
  readonly adapterCapabilities: readonly AdapterCapability[]
}

export type HttpProxyAdapter = AdapterCapabilityProvider & {
  // `getServerUrl` is valid in URL/spawn mode only (throws in injected mode).
  // `getRequestFn` is the transport-agnostic accessor kit proxies should use.
  getServerUrl(): Promise<string>
  getRequestFn(): Promise<OpenCodeRequestFn>
}

export type RuntimeConfigurableAdapter = AdapterCapabilityProvider & {
  setModel(model: string): void
  setAuth(keys: Record<string, string | undefined>): void
}

export function hasAdapterCapability<T extends AdapterCapability>(
  adapter: unknown,
  capability: T,
): adapter is AdapterCapabilityProvider & (
  T extends "http-proxy" ? HttpProxyAdapter : RuntimeConfigurableAdapter
) {
  if (!adapter || typeof adapter !== "object") return false
  const list = (adapter as { adapterCapabilities?: unknown }).adapterCapabilities
  return Array.isArray(list) && list.includes(capability)
}
