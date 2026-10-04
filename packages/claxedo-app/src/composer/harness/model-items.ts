import { harnessSelectionValue, isCatalogHarnessId } from "@/lib/harness-selection"
import type { PickerItem } from "../view/model-list"
import type { HarnessSelectionSnapshot } from "./controller"

export function harnessModelItems(selection: Pick<HarnessSelectionSnapshot, "harness" | "models">): PickerItem[] {
  const harness = selection.harness
  if (!harness) return []
  return selection.models.flatMap((model) => {
    const providerId = harness.kind === "connection"
      ? model.providerId ?? harnessSelectionValue(harness)
      : isCatalogHarnessId(harness.harnessId) ? model.providerId : harnessSelectionValue(harness)
    if (!providerId || model.connected === false) return []
    return [{ id: model.id, name: model.name, description: model.description, provider: { id: providerId, name: providerId } }]
  })
}

export function harnessRecoveryModels(selection: Pick<HarnessSelectionSnapshot, "harness" | "models" | "selectedModelKey">): PickerItem[] {
  const selected = selection.selectedModelKey
  return harnessModelItems(selection).filter((item) => item.id !== selected?.modelId || item.provider.id !== selected.providerId)
}
