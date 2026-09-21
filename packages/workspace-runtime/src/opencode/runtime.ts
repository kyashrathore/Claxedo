import { createCatalogPort, type OpenCodeCatalogPort } from "./catalog-port"
import { createConfigurationPort, type OpenCodeConfigurationPort } from "./configuration-port"
import { createEventPump, type EventPump, type ProjectedEvent } from "./event-pump"
import { createOpenCodeHost, type OpenCodeHost, type OpenCodeHostOptions } from "./host"
import { createInteractionPort, type OpenCodeInteractionPort } from "./interaction-port"
import { createSessionPort, type OpenCodeSessionPort } from "./session-port"
import { createToolPort, type OpenCodeToolPort } from "./tool-port"
import { createLaunchPolicy, type LaunchPolicyStore } from "./launch-policy"
import { createProviderBindingPolicy, type ProviderBindingOverlay } from "./provider-binding"
import { createProviderPolicy, type ProviderConfigStore } from "./provider-policy"
import type { WorkspaceScope } from "./scope"

export type OpenCodeRuntime = Readonly<{
  host: OpenCodeHost
  sessions: OpenCodeSessionPort
  catalog: OpenCodeCatalogPort
  configuration: OpenCodeConfigurationPort
  providerConfig(scope: WorkspaceScope): Promise<ProviderConfigStore>
  /** Route the engine's providers at Claxedo's credential broker; absent providers keep the engine's own auth. */
  bindProviders(overlays: Record<string, ProviderBindingOverlay>): Promise<void>
  /** Why a turn on this provider must be refused, or nothing when it may run. */
  providerUnavailableReason(providerID: string): string | undefined
  /** The workspace's launch document (skills + MCP servers) enforced in the engine. */
  launch(scope: WorkspaceScope): Promise<LaunchPolicyStore>
  interactions: OpenCodeInteractionPort
  tools: OpenCodeToolPort
  events: Readonly<{
    start(): void
    ready(): Promise<void>
    subscribe(listener: (event: ProjectedEvent) => void): () => void
    checkpoint(aggregateID: string): number | undefined
  }>
  close(): Promise<void>
}>

/**
 * Compose the one SDK owner and its typed ports.
 *
 * This is the only object a host composition needs to retain. The event pump
 * is process-wide and fans out downstream; adapters and browser subscribers
 * never create their own SDK subscription.
 */
export function createOpenCodeRuntime(options: OpenCodeHostOptions): OpenCodeRuntime {
  const policy = createProviderPolicy()
  const bindings = createProviderBindingPolicy()
  const launch = createLaunchPolicy()
  const host = createOpenCodeHost({
    ...options,
    plugins: [...(options.plugins ?? []), policy.plugin, bindings.plugin, launch.plugin],
  })
  const listeners = new Set<(event: ProjectedEvent) => void>()
  const pump: EventPump = createEventPump(host, {
    onEvent(event) {
      // Iterated over a copy: a listener that unsubscribes during dispatch
      // would otherwise mutate the set mid-iteration and skip its neighbour.
      for (const listener of Array.from(listeners)) listener(event)
    },
  })
  let closing: Promise<void> | undefined

  return {
    host,
    sessions: createSessionPort(host),
    catalog: createCatalogPort(host),
    configuration: createConfigurationPort(host),
    providerConfig: (scope) => policy.store(host, scope),
    bindProviders: (overlays) => bindings.apply(overlays),
    providerUnavailableReason: (providerID) => bindings.unavailableReason(providerID),
    launch: (scope) => launch.store(host, scope),
    interactions: createInteractionPort(host),
    tools: createToolPort(host),
    events: {
      start: () => pump.start(),
      ready: () => pump.ready(),
      subscribe(listener) {
        listeners.add(listener)
        pump.start()
        return () => listeners.delete(listener)
      },
      checkpoint: (aggregateID) => pump.checkpoint(aggregateID),
    },
    close() {
      closing ??= (async () => {
        // `stop()` refuses synchronously and only then waits, so the pump is
        // already refusing and its subscription already aborted while the host
        // closes. The order matters both ways: the engine ends the read it
        // handed out when its host closes, so draining the pump first waits on
        // the engine's own schedule, and closing without the refusal in place
        // first would let a late event reach a disposed consumer.
        const drained = pump.stop()
        try {
          await host.close()
        } finally {
          // A close that failed still handed the pump a read, and a runtime
          // that reported the failure while that read was outstanding would be
          // reporting a shutdown it had not finished.
          await drained
        }
      })()
      return closing
    },
  }
}
