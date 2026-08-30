import type { SessionHarnessId } from "./harness-types"
export type HarnessCapabilityTarget = SessionHarnessId
export type AdapterCapability = "runtime-config"

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

export type RuntimeConfigurableAdapter = AdapterCapabilityProvider & {
  setModel(model: string): void
  setAuth(keys: Record<string, string | undefined>): void
}

export function hasAdapterCapability<T extends AdapterCapability>(
  adapter: unknown,
  capability: T,
): adapter is AdapterCapabilityProvider & RuntimeConfigurableAdapter {
  if (!adapter || typeof adapter !== "object") return false
  const list = (adapter as { adapterCapabilities?: unknown }).adapterCapabilities
  return Array.isArray(list) && list.includes(capability)
}
