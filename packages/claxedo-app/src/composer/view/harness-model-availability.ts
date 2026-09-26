import { createMemo, type Accessor } from "solid-js"
import type { HarnessSelectionSnapshot } from "../harness/controller"
import { isCatalogHarness, type HarnessType } from "../harness/profile"
import { connectionAllowsNoModel } from "../harness/selection"
import type { PickerItem } from "./model-list"
import type { SelectorCatalog } from "./selector-catalog"
import type { createScopeSelection } from "./selector-scope"

type ModelAvailabilityInput = {
  harness: Accessor<HarnessType | undefined>
  selection: Accessor<HarnessSelectionSnapshot>
  connectionDeclaration: ReturnType<typeof createScopeSelection>["connectionDeclaration"]
  catalog: SelectorCatalog
  rows: Accessor<PickerItem[]>
  switching: Accessor<boolean>
}

function createManagedDefaultModel(input: Pick<ModelAvailabilityInput, "selection" | "connectionDeclaration">) {
  return createMemo(() =>
    connectionAllowsNoModel({
      connectionDeclaration: input.connectionDeclaration(),
      harness: input.selection().harness,
      selectedModel: input.selection().selectedModel,
      dynamicModels: input.selection().models,
      readiness: input.selection().readiness,
      optionsLoading: input.selection().optionsLoading,
      configError: input.selection().configError,
      selectedThoughtLevel: input.selection().selectedThoughtLevel,
    }),
  )
}

export function createModelAvailability(input: ModelAvailabilityInput) {
  const isError = () => input.selection().readiness === "error"
  const isStale = () => input.selection().optionsStale
  const optionsLoading = () => input.selection().optionsLoading
  const modelLoading = createMemo(() => input.harness() && isCatalogHarness(input.harness()) ? input.catalog.providers.loading() : optionsLoading())
  const hasModelOptions = createMemo(() => input.rows().length > 0)
  const managedDefaultModel = createManagedDefaultModel(input)
  const modelUnavailable = createMemo(() => {
    return !modelLoading() && !hasModelOptions() && !managedDefaultModel() && !input.catalog.unread()
  })
  const modelOptionsFailed = createMemo(() => {
    if (input.harness() && isCatalogHarness(input.harness())) return !!input.catalog.providers.error() && !modelLoading()
    const error = input.selection().configError
    if (!error || error === "Loading model options..." || error === "Selected model unavailable") return false
    return !optionsLoading() && !hasModelOptions()
  })
  const modelDisabled = createMemo(() => {
    return !input.harness() || managedDefaultModel() || modelLoading() || isError() || modelUnavailable() || modelOptionsFailed()
  })
  const modelLoadingOrSwitching = createMemo(() => modelLoading() || input.switching())
  return { isError, isStale, modelLoading, hasModelOptions, managedDefaultModel, modelOptionsFailed, modelDisabled, modelLoadingOrSwitching }
}

export type ModelAvailability = ReturnType<typeof createModelAvailability>
