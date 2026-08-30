import { createCatalogPort, type OpenCodeCatalogPort } from "./catalog-port"
import { createConfigurationPort, type OpenCodeConfigurationPort } from "./configuration-port"
import { createEventPump, type EventPump, type ProjectedEvent } from "./event-pump"
import { createOpenCodeHost, type OpenCodeHost, type OpenCodeHostOptions } from "./host"
import { createInteractionPort, type OpenCodeInteractionPort } from "./interaction-port"
import { createSessionPort, type OpenCodeSessionPort } from "./session-port"
import { createToolPort, type OpenCodeToolPort } from "./tool-port"

export type OpenCodeRuntime = Readonly<{
  host: OpenCodeHost
  sessions: OpenCodeSessionPort
  catalog: OpenCodeCatalogPort
  configuration: OpenCodeConfigurationPort
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
  const host = createOpenCodeHost(options)
  const listeners = new Set<(event: ProjectedEvent) => void>()
  const pump: EventPump = createEventPump(host, {
    onEvent(event) {
      for (const listener of [...listeners]) listener(event)
    },
  })
  let closing: Promise<void> | undefined

  return {
    host,
    sessions: createSessionPort(host),
    catalog: createCatalogPort(host),
    configuration: createConfigurationPort(host),
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
      closing ??= pump.stop().finally(() => host.close())
      return closing
    },
  }
}
