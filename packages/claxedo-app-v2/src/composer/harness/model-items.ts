import { harnessSelectionValue, isCatalogHarnessId } from "@/lib/harness-selection"
import type { PickerItem } from "../view/model-list"
import type { HarnessSelectionSnapshot } from "./controller"

export function harnessModelItems(selection: Pick<HarnessSelectionSnapshot, "harness" | "models">): PickerItem[] {
  const harness = selection.harness
  if (!harness) return []
  return selection.models.flatMap((model) => {
    const providerID = harness.kind === "connection"
      ? model.providerID ?? harnessSelectionValue(harness)
      : isCatalogHarnessId(harness.harnessId) ? model.providerID : harnessSelectionValue(harness)
    if (!providerID || model.connected === false) return []
    return [{ id: model.id, name: model.name, description: model.description, provider: { id: providerID, name: providerID } }]
  })
}

export function harnessRecoveryModels(selection: Pick<HarnessSelectionSnapshot, "harness" | "models" | "selectedModelKey">): PickerItem[] {
  const selected = selection.selectedModelKey
  return harnessModelItems(selection).filter((item) => item.id !== selected?.modelID || item.provider.id !== selected.providerID)
}
