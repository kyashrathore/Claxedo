import { singleFlightUntil } from "@claxedo/helpers"
import { createCatalogPort, type OpenCodeCatalogPort } from "./catalog-port.js"
import { createConfigurationPort, type OpenCodeConfigurationPort } from "./configuration-port.js"
import { createEventPump, type EventPump, type ProjectedEvent } from "./event-pump.js"
import { createOpenCodeHost, type OpenCodeHost, type OpenCodeHostOptions } from "./host.js"
import { createInteractionPort, type OpenCodeInteractionPort } from "./interaction-port.js"
import { createSessionPort, type OpenCodeSessionPort } from "./session-port.js"
import { createToolPort, type OpenCodeToolPort } from "./tool-port.js"
import { createInstances, type OpenCodeInstances } from "./instances.js"
import { createProviderBindingPolicy, type ProviderBinding } from "./provider-binding.js"
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

  bindProviders(binding: ProviderBinding): Promise<void>

  providerUnavailableReason(providerID: string): string | undefined
  instances: OpenCodeInstances
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

export type OpenCodeRuntimeOptions = Omit<OpenCodeHostOptions, "instances">

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
  return singleFlightUntil(async () => {
    const drained = pump.stop()
    try {
      await host.close()
    } finally {
      await drained
    }
  }, () => true)
}

export function createOpenCodeRuntime(options: OpenCodeRuntimeOptions): OpenCodeRuntime {
  const policy = createProviderPolicy()
  const definitions = createProviderDefinitionPolicy()
  const bindings = createProviderBindingPolicy()
  const instances = createInstances()
  const tools = createToolPort()
  const host = createOpenCodeHost({
    ...options,
    plugins: [...(options.plugins ?? []), policy.plugin, definitions.plugin, bindings.plugin],
    instances: { key: (session) => instances.keyOf(session), configure: (key) => ({ plugins: [instances.plugin(key), tools.plugin] }) },
  })
  const { pump, events } = eventSurface(host)

  return {
    host,
    sessions: createSessionPort(host),
    catalog: createCatalogPort(host),
    configuration: createConfigurationPort(host),
    providerConfig: (scope) => policy.store(host, scope),
    defineProviders: (next) => definitions.apply(next),
    bindProviders: (binding) => bindings.apply(binding),
    providerUnavailableReason: (providerID) => bindings.unavailableReason(providerID),
    instances,
    interactions: createInteractionPort(host),
    tools,
    events,
    close: closeRuntime(host, pump),
  }
}
