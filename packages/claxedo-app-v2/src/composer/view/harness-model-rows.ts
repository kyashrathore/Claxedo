import { createMemo, type Accessor } from "solid-js"
import type { HarnessSelectionSnapshot } from "../harness/controller"
import { modelGroupKey, type useModelVisibility } from "../harness/model-visibility"
import { harnessModelPickerProvider, isCatalogHarness, type HarnessType } from "../harness/profile"
import type { PickerItem } from "./model-list"
import type { SelectorCatalog } from "./selector-catalog"

export function createHarnessModelRows(input: {
  harness: Accessor<HarnessType | undefined>
  selection: Accessor<HarnessSelectionSnapshot>
  catalog: SelectorCatalog
  visibility: ReturnType<typeof useModelVisibility>
}) {
  const rows = createMemo<PickerItem[]>(() => {
    const currentHarness = input.harness()
    if (!currentHarness) return []
    const defaults = input.catalog.providers.default()
    if (isCatalogHarness(currentHarness)) return input.catalog.rows().rows.filter((item) => input.visibility.visible({ providerId: item.provider.id, modelId: item.id }, { defaults, group: item.provider.id }))
    const selectedId = input.selection().selectedModel
    return input.selection().models.flatMap((item) => {
      const provider = harnessModelPickerProvider(currentHarness, item)
      if (item.id !== selectedId && !input.visibility.visible({ providerId: provider.id, modelId: item.id }, { defaults, group: modelGroupKey(provider.id, item.id) })) return []
      return [{
        id: item.id,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
        provider,
        ...(typeof item.connected === "boolean" ? { connected: item.connected } : {}),
      }]
    })
  })
  const picked = createMemo(() => {
    const selected = input.selection().selectedModelKey
    return rows().find((item) => item.id === selected?.modelId && item.provider.id === selected.providerId)
      ?? (input.harness() && isCatalogHarness(input.harness()) ? undefined : rows().find((item) => item.id === input.selection().selectedModel))
  })
  return { rows, picked }
}
