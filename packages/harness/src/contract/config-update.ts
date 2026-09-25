import type { StartInput } from "./session"
import type { TransportConfigUpdate } from "./transport"

export function mergeStartInput(start: StartInput, update: TransportConfigUpdate): StartInput {
  return { ...start,
    ...(update.credentials ? { credentials: update.credentials } : {}),
    ...(update.projection ? { projection: update.projection } : {}) }
}

export function configGenerationChanged(start: StartInput, next: StartInput): boolean {
  return start.credentials.leaseGeneration !== next.credentials.leaseGeneration ||
    start.projection.generation !== next.projection.generation
}
