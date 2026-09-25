import type { PlacementId, PlacementKind, SessionRef } from "@/server"
import {
  harnessHasConfigOptions,
  pickHarness,
  type HarnessState,
  type HarnessType,
} from "./profile"

export const MODEL_OPTIONS_RETRY_LIMIT = 5

export type HarnessScopeInput = {
  placementId?: PlacementId
  sessionId?: string
  sessionRef?: SessionRef
  /** The harness the session's row names, shown while its config cannot be read. */
  sessionHarness?: HarnessType
}

export function shouldShowModelOptionsStaleWarning(input: {
  stale: boolean
  models: { id: string; name: string }[] | null | undefined
}) {
  return input.stale && (input.models?.length ?? 0) === 0
}

export function shouldRetryModelOptions(input: {
  stale: boolean
  tries: number
  limit?: number
}) {
  return input.stale && input.tries < (input.limit ?? MODEL_OPTIONS_RETRY_LIMIT)
}

export function modelOptionsUnavailableMessage(input: {
  stale: boolean
}) {
  return input.stale ? "Model options unavailable" : "No model options available"
}

export function shouldFetchConfigOptionsForScope(type: HarnessType, failed: boolean, _input?: HarnessScopeInput) {
  // Existing sessions load selectable models too: an active session's picker
  // must not render empty just because the scope has already hydrated.
  return harnessHasConfigOptions(type) && !failed
}

/**
 * Whether a new-session draft takes its harness from the workspace's status
 * probe. A workspace on a machine — this one, or one reached through the relay
 * — carries that machine's harness configuration, and a draft starts from it
 * exactly as the desktop does. A provisioned sandbox keeps the draft-default
 * policy.
 */
export function shouldHydrateDraftFromHarnessStatus(input: { placementKind?: PlacementKind }) {
  return input.placementKind !== undefined && input.placementKind !== "cloud"
}

export function harnessStateFromSessionConfig(input: {
  harness?: HarnessState
  model?: { providerID?: string | null; modelID?: string | null } | null
  variant?: string
}): HarnessState | undefined {
  const harness = input.harness
  const type = pickHarness(harness?.type)
  if (!harness || !type) return undefined
  return {
    ...harness,
    type,
    model: harness.model ?? input.model?.modelID ?? undefined,
    modelProviderID: harness.modelProviderID ?? input.model?.providerID ?? undefined,
    ...(input.variant ? { thoughtLevel: input.variant } : {}),
    status: "ready",
    ready: true,
    activeType: type,
  }
}

export function harnessChangeKey(input: HarnessScopeInput, type: HarnessType) {
  return JSON.stringify([input.placementId ?? "", input.sessionId ?? "", type])
}

export function sessionModelSyncKey(input: HarnessScopeInput) {
  if (!input.placementId || !input.sessionId || input.sessionId === "new") return undefined
  return JSON.stringify([input.placementId, input.sessionId])
}
