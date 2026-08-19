import type { SessionHarnessId } from "./harness-types"
import type { OpenCodeRequestFn } from "./harnesses/opencode"
import type { ActivityLease } from "./harnesses/shared/process-lifecycle"

export type HarnessCapabilityTarget = SessionHarnessId
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
  /**
   * Whether a proxy can attach without paying a harness start.
   *
   * Long-lived compatibility streams are opened for the shell's benefit, not
   * because the user asked for harness work. A proxy that starts the harness to
   * serve one is why an idle desktop was never idle. Callers that only want to
   * ride an already-live transport check this first.
   */
  transportLive?(): boolean
  /**
   * Attach a stream that outlives the request that opened it, holding the
   * transport open until the returned lease is released. Without the lease the
   * idle countdown starts the moment the request returns and can tear the
   * harness down mid-stream.
   */
  acquireRequestFn?(): Promise<{ request: OpenCodeRequestFn; lease: ActivityLease }>
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
