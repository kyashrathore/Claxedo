import type { ModelChoice, SessionRow, TranscriptMessage } from "@/server"
import { harnessSelectionId, isCatalogHarness, type HarnessType } from "./profile"

function turnModel(message: TranscriptMessage): ModelChoice | undefined {
  const providerId = message.providerID ?? message.model?.providerID
  const modelId = message.modelID ?? message.model?.modelID
  if (!providerId || !modelId) return undefined
  return { providerId, modelId, ...(message.variant ? { variant: message.variant } : {}) }
}

export function knownSessionModel(harness: HarnessType, row: SessionRow | undefined, messages: readonly TranscriptMessage[]): ModelChoice | undefined {
  if (row?.model) return row.model
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = turnModel(messages[index])
    if (model) return isCatalogHarness(harness) || model.providerId === harnessSelectionId(harness) ? model : undefined
  }
  return undefined
}
