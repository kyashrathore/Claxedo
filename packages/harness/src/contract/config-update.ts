import type { SessionConfig, SessionConfigUpdate } from "@claxedo/agent-runtime-contract"
import type { StartInput } from "./session"
import type { TransportConfigUpdate } from "./transport"

export function mergeStartInput(start: StartInput, update: TransportConfigUpdate): StartInput {
  return { ...start,
    ...(update.providerDefinitions ? { providerDefinitions: update.providerDefinitions } : {}),
    ...(update.credentials ? { credentials: update.credentials } : {}),
    ...(update.projection ? { projection: update.projection } : {}) }
}

export function configGenerationChanged(start: StartInput, next: StartInput): boolean {
  return start.credentials.leaseGeneration !== next.credentials.leaseGeneration ||
    start.projection.generation !== next.projection.generation
}

export function applySessionConfigUpdate(config: SessionConfig, update: SessionConfigUpdate): SessionConfig {
  return { ...config,
    ...(update.harness !== undefined ? { harness: update.harness } : {}),
    ...(update.permissionCeiling !== undefined ? { permissionCeiling: update.permissionCeiling } : {}),
    ...(update.permissionMode !== undefined ? { permissionMode: update.permissionMode ?? undefined } : {}),
    ...(update.permissionState !== undefined ? { permissionState: update.permissionState ?? undefined } : {}),
    ...(update.model !== undefined ? { model: update.model ?? undefined } : {}),
    ...(update.variant !== undefined ? { variant: update.variant ?? undefined } : {}),
    ...(update.agent !== undefined ? { agent: update.agent ?? undefined } : {}),
    ...(update.instructions !== undefined ? { instructions: update.instructions ?? undefined } : {}),
    ...(update.group !== undefined ? { group: update.group ?? undefined } : {}),
    ...(update.handoff !== undefined ? { handoff: update.handoff ?? undefined } : {}) }
}
