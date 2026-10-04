import { createEffect, createMemo, type Accessor, type JSX } from "solid-js"
import type { HarnessSelectionSnapshot } from "../harness/controller"
import type { useModelNames } from "../harness/model-names"
import { harnessDisplayLabel, harnessSelectionId, isCatalogHarness, isClientDefaultPlaceholder, type HarnessType } from "../harness/profile"
import type { ModelAvailability } from "./harness-model-availability"
import type { PickerItem } from "./model-list"
import type { SelectorCatalog } from "./selector-catalog"

type TriggerLabelInput = {
  selection: Accessor<HarnessSelectionSnapshot>
  harness: Accessor<HarnessType | undefined>
  picked: Accessor<PickerItem | undefined>
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

function rememberPickedModelName(input: Pick<TriggerLabelInput, "picked" | "modelNames">) {
  createEffect(() => {
    const current = input.picked()
    if (current && current.name !== current.id) input.modelNames.remember({ providerId: current.provider.id, modelId: current.id }, current.name)
  })
}

export type ModelLabelInput = {
  readonly polling: boolean
  readonly harness?: HarnessType
  readonly harnessLabel: (harness: HarnessType) => string
  readonly picked?: Pick<PickerItem, "id" | "name">
  readonly selectedModel: string
  readonly rememberedName?: string
  readonly savedModelUnavailable?: string
  readonly managedDefault: boolean
  readonly modelLoading: boolean
  readonly catalogUnread: boolean
  readonly hasModelOptions: boolean
}

export function modelLabel(input: ModelLabelInput): string {
  const { harness, picked, selectedModel } = input
  if (input.polling) return "Connecting"
  if (picked && picked.name !== picked.id) return picked.name
  if (input.savedModelUnavailable !== undefined) return input.savedModelUnavailable
  if (input.managedDefault && harness) return `${input.harnessLabel(harness)} default`
  if (!harness) return "Select a harness"
  const known = input.rememberedName ?? (isClientDefaultPlaceholder(selectedModel) ? undefined : selectedModel)
  if (known) return known
  if (input.modelLoading) return "Loading models"
  if (input.catalogUnread) return "Select model"
  if (!input.hasModelOptions && isCatalogHarness(harness)) return `No ${harnessDisplayLabel(harnessSelectionId(harness))} models available`
  return picked?.name || "Select model"
}

function createModelLabel(input: TriggerLabelInput) {
  const rememberedName = () => {
    const providerId = input.selection().selectedModelProvider
    const modelId = input.selection().selectedModel
    return providerId && modelId ? input.modelNames.name({ providerId, modelId }) : undefined
  }
  return createMemo(() => {
    const selection = input.selection()
    return modelLabel({
      polling: input.polling(),
      harness: input.harness(),
      harnessLabel: input.harnessLabel,
      picked: input.picked(),
      selectedModel: selection.selectedModel,
      rememberedName: rememberedName(),
      savedModelUnavailable: selection.draftDefaultState === "saved-model-unavailable" ? selection.draftDefaultLabels?.model ?? selection.selectedModel : undefined,
      managedDefault: input.availability.managedDefaultModel(),
      modelLoading: input.availability.modelLoading(),
      catalogUnread: input.catalog.unread(),
      hasModelOptions: input.availability.hasModelOptions(),
    })
  })
}

export function createHarnessTriggerLabel(input: TriggerLabelInput) {
  rememberPickedModelName(input)
  const label = createModelLabel(input)
  const modelHint = createMemo(() => {
    if (input.availability.managedDefaultModel() && input.harness()) return `Model is managed by ${input.harnessLabel(input.harness()!)}`
    if (input.availability.isStale() && !input.availability.modelOptionsFailed()) return "Model list may be outdated"
    return undefined
  })
  return { label, hint: modelHint }
}
