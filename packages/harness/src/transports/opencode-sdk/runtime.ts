import { createCatalogPort, type OpenCodeCatalogPort } from "./catalog-port"
import { createConfigurationPort, type OpenCodeConfigurationPort } from "./configuration-port"
import { createEventPump, type EventPump, type ProjectedEvent } from "./event-pump"
import { createOpenCodeHost, type OpenCodeHost, type OpenCodeHostOptions } from "./host"
import { createInteractionPort, type OpenCodeInteractionPort } from "./interaction-port"
import { createSessionPort, type OpenCodeSessionPort } from "./session-port"
import { createToolPort, type OpenCodeToolPort } from "./tool-port"
import { createLaunchPolicy, type LaunchPolicyStore } from "./launch-policy"
import { createProviderBindingPolicy, type ProviderBindingOverlay } from "./provider-binding"
import { createProviderDefinitionPolicy, type ProviderDefinition } from "./provider-definition"
import { createProviderPolicy, type ProviderConfigStore } from "./provider-policy"
import type { WorkspaceScope } from "./scope"

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
    checkpoint(aggregateID: string): number | undefined
  }>
  close(): Promise<void>
}>

export type OpenCodeRuntimeOptions = OpenCodeHostOptions & Readonly<{
  
  providersBound?: () => Promise<void>
}>

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
  const listeners = new Set<(event: ProjectedEvent) => void>()
  const pump: EventPump = createEventPump(host, {
    onEvent(event) {

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
    defineProviders: (next) => definitions.apply(next),
    bindProviders: (overlays) => bindings.apply(overlays),
    providerUnavailableReason: (providerID) => bindings.unavailableReason(providerID),
    providersBound: providersBound ?? (() => Promise.resolve()),
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

        const drained = pump.stop()
        try {
          await host.close()
        } finally {

          await drained
        }
      })()
      return closing
    },
  }
}
