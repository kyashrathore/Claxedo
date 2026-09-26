import { createCatalogPort, type OpenCodeCatalogPort } from "./catalog-port.js"
import { createConfigurationPort, type OpenCodeConfigurationPort } from "./configuration-port.js"
import { createEventPump, type EventPump, type ProjectedEvent } from "./event-pump.js"
import { createOpenCodeHost, type OpenCodeHost, type OpenCodeHostOptions } from "./host.js"
import { createInteractionPort, type OpenCodeInteractionPort } from "./interaction-port.js"
import { createSessionPort, type OpenCodeSessionPort } from "./session-port.js"
import { createToolPort, type OpenCodeToolPort } from "./tool-port.js"
import { createLaunchPolicy, type LaunchPolicyStore } from "./launch-policy.js"
import { createProviderBindingPolicy, type ProviderBindingOverlay } from "./provider-binding.js"
import { createProviderDefinitionPolicy, type ProviderDefinition } from "./provider-definition.js"
import { createProviderPolicy, type ProviderConfigStore } from "./provider-policy.js"
import type { WorkspaceScope } from "./scope.js"

export type OpenCodeRuntime = Readonly<{
  host: OpenCodeHost
  sessions: OpenCodeSessionPort
  catalog: OpenCodeCatalogPort
  configuration: OpenCodeConfigurationPort
  providerConfig(scope: WorkspaceScope): Promise<ProviderConfigStore>

  defineProviders(definitions: readonly ProviderDefinition[]): Promise<void>

  bindProviders(overlays: Record<string, ProviderBindingOverlay>): Promise<void>

  providerUnavailableReason(providerID: string): string | undefined

  providersBound(): Promise<void>

  launch(scope: WorkspaceScope): Promise<LaunchPolicyStore>
  interactions: OpenCodeInteractionPort
  tools: OpenCodeToolPort
  events: Readonly<{
    start(): void
    ready(): Promise<void>
    subscribe(listener: (event: ProjectedEvent) => void): () => void
    subscribeLoss?(listener: () => void): () => void
    checkpoint(aggregateID: string): number | undefined
  }>
  close(): Promise<void>
}>

export type OpenCodeRuntimeOptions = OpenCodeHostOptions & Readonly<{

  providersBound?: () => Promise<void>
}>

function eventSurface(host: OpenCodeHost) {
  const listeners = new Set<(event: ProjectedEvent) => void>()
  const lossListeners = new Set<() => void>()
  const pump: EventPump = createEventPump(host, {
    onEvent(event) {
      for (const listener of Array.from(listeners)) listener(event)
    },
    onStreamLoss() {
      for (const listener of Array.from(lossListeners)) listener()
    },
  })
  return {
    pump,
    events: {
      start: () => pump.start(),
      ready: () => pump.ready(),
      subscribe(listener: (event: ProjectedEvent) => void) {
        listeners.add(listener)
        pump.start()
        return () => listeners.delete(listener)
      },
      subscribeLoss(listener: () => void) {
        lossListeners.add(listener)
        pump.start()
        return () => lossListeners.delete(listener)
      },
      checkpoint: (aggregateID: string) => pump.checkpoint(aggregateID),
    },
  }
}

function closeRuntime(host: OpenCodeHost, pump: EventPump): () => Promise<void> {
  let closing: Promise<void> | undefined
  return () => {
    closing ??= (async () => {
      const drained = pump.stop()
      try {
        await host.close()
      } finally {
        await drained
      }
    })()
    return closing
  }
}

export function createOpenCodeRuntime(options: OpenCodeRuntimeOptions): OpenCodeRuntime {
  const policy = createProviderPolicy()
  const definitions = createProviderDefinitionPolicy()
  const bindings = createProviderBindingPolicy()
  const launch = createLaunchPolicy()
  const { providersBound, ...hostOptions } = options
  const host = createOpenCodeHost({
    ...hostOptions,
    plugins: [...(options.plugins ?? []), policy.plugin, definitions.plugin, bindings.plugin, launch.plugin],
  })
  const { pump, events } = eventSurface(host)

  return {
    host,
    sessions: createSessionPort(host),
    catalog: createCatalogPort(host),
    configuration: createConfigurationPort(host),
    providerConfig: (scope) => policy.store(host, scope),
    defineProviders: (next) => definitions.apply(next),
    bindProviders: (overlays) => bindings.apply(overlays),
    providerUnavailableReason: (providerID) => bindings.unavailableReason(providerID),
    providersBound: providersBound ?? (() => Promise.resolve()),
    launch: (scope) => launch.store(host, scope),
    interactions: createInteractionPort(host),
    tools: createToolPort(host),
    events,
    close: closeRuntime(host, pump),
  }
}
