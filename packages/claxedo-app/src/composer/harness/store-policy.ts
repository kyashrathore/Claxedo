import type { HarnessState, ModelChoice, PlacementId, PlacementKind, SessionLocation, SessionRow, TranscriptMessage } from "@/server"
import { harnessHasConfigOptions, harnessSelectionId, isCatalogHarness, type HarnessType } from "./profile"

export type HarnessScopeInput = {
  placementId?: PlacementId
  sessionId?: string
  sessionRef?: SessionLocation
  sessionHarness?: HarnessType
  sessionModel?: () => ModelChoice | undefined
  saveDraftDefault?: false
}

export function shouldShowModelOptionsStaleWarning(input: {
  stale: boolean
  models: readonly { id: string; name: string }[] | null | undefined
}) {
  return input.stale && (input.models?.length ?? 0) === 0
}

export function modelOptionsUnavailableMessage(input: {
  stale: boolean
}) {
  return input.stale ? "Model options unavailable" : "No model options available"
}

export function shouldFetchConfigOptionsForScope(type: HarnessType, failed: boolean, _input?: HarnessScopeInput) {
  return harnessHasConfigOptions(type) && !failed
}

export function shouldHydrateDraftFromHarnessStatus(input: { placementKind?: PlacementKind }) {
  return input.placementKind !== undefined && input.placementKind !== "cloud"
}

export function sessionHarnessState(type: HarnessType, model: ModelChoice | undefined): HarnessState {
  return {
    type,
    activeType: type,
    ...(model ? { model: model.modelId, modelProviderId: model.providerId } : {}),
    thoughtLevel: model?.variant,
    status: "ready",
    ready: true,
  }
}

export function harnessChangeKey(input: HarnessScopeInput, type: HarnessType) {
  return JSON.stringify([input.placementId ?? "", input.sessionId ?? "", type])
}

function messageModel(message: TranscriptMessage): ModelChoice | undefined {
  const providerId = message.providerID ?? message.model?.providerID
  const modelId = message.modelID ?? message.model?.modelID
  if (!providerId || !modelId) return undefined
  return { providerId, modelId, ...(message.variant ? { variant: message.variant } : {}) }
}

export function knownSessionModel(harness: HarnessType, row: SessionRow | undefined, messages: readonly TranscriptMessage[]): ModelChoice | undefined {
  if (row?.model) return row.model
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messageModel(messages[index])
    if (model) return isCatalogHarness(harness) || model.providerId === harnessSelectionId(harness) ? model : undefined
  }
  return undefined
}
