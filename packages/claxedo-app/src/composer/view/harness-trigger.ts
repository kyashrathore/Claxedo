import { createEffect, createMemo, type Accessor, type JSX } from "solid-js"
import type { HarnessSelectionSnapshot } from "../harness/controller"
import type { useModelNames } from "../harness/model-names"
import { harnessDisplayLabel, harnessSelectionId, isCatalogHarness, type HarnessType } from "../harness/profile"
import type { ModelAvailability } from "./harness-model-availability"
import type { PickerItem } from "./model-list"
import type { SelectorCatalog } from "./selector-catalog"

type TriggerLabelInput = {
  selection: Accessor<HarnessSelectionSnapshot>
  harness: Accessor<HarnessType | undefined>
  picked: Accessor<PickerItem | undefined>
  catalogSelected: Accessor<boolean>
  catalog: SelectorCatalog
  polling: Accessor<boolean>
  availability: ModelAvailability
  harnessLabel: (harness: HarnessType) => string
  modelNames: ReturnType<typeof useModelNames>
}

export function createTriggerStyle(triggerStyle: Accessor<JSX.CSSProperties | undefined>) {
  return (off: boolean) => {
    const base = triggerStyle()
    const opacity = base?.opacity
    return {
      height: "28px",
      ...base,
      opacity: typeof opacity === "number" ? opacity * (off ? 0.45 : 1) : off ? 0.45 : opacity,
    }
  }
}

export function triggerStateOf(selection: HarnessSelectionSnapshot) {
  return {
    harness: selection.harness ? harnessSelectionId(selection.harness) : "",
    model: selection.selectedModel,
    provider: selection.selectedModelProvider,
    readiness: selection.readiness,
    readyForSubmit: !!selection.selectedModelKey,
  }
}

function rememberPickedModelName(input: Pick<TriggerLabelInput, "picked" | "catalogSelected" | "modelNames">) {
  createEffect(() => {
    const current = input.picked()
    if (current && input.catalogSelected()) input.modelNames.remember({ providerId: current.provider.id, modelId: current.id }, current.name)
  })
}

function createModelLabel(input: TriggerLabelInput) {
  const knownModelName = () => {
    const providerId = input.selection().selectedModelProvider
    const modelId = input.selection().selectedModel
    return providerId && modelId ? input.modelNames.name({ providerId, modelId }) : undefined
  }
  return createMemo(() => {
    const { selection, harness, picked, availability } = input
    if (input.polling()) return "Connecting"
    if (availability.modelLoading()) return "Loading models"
    if (picked()) return picked()?.name
    if (selection().draftDefaultState === "saved-model-unavailable") {
      return selection().draftDefaultLabels?.model ?? selection().selectedModel
    }
    if (availability.managedDefaultModel()) return `${input.harnessLabel(harness()!)} default`
    if (!harness()) return "Select agent"
    if (isCatalogHarness(harness()) && selection().selectedModel) return knownModelName() ?? selection().selectedModel
    if (input.catalog.unread()) return "Select model"
    if (!availability.hasModelOptions()) return isCatalogHarness(harness()) ? `No ${harnessDisplayLabel(harnessSelectionId(harness()!))} models available` : "Select model"
    return selection().selectedModel || "Select model"
  })
}

export function createHarnessTriggerLabel(input: TriggerLabelInput) {
  rememberPickedModelName(input)
  const modelLabel = createModelLabel(input)
  const modelHint = createMemo(() => {
    if (input.availability.managedDefaultModel() && input.harness()) return `Model is managed by ${input.harnessLabel(input.harness()!)}`
    if (input.availability.isStale() && !input.availability.modelOptionsFailed()) return "Model list may be outdated"
    return undefined
  })
  const label = createMemo(() => modelLabel() || "Select model")
  return { label, hint: modelHint }
}
