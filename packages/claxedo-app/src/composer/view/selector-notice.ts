import { createMemo, type Accessor } from "solid-js"
import type { HarnessScopeInput, HarnessSelectionController, HarnessSelectionSnapshot } from "../harness/controller"
import { harnessDisplayLabel, harnessSelectionId, isCatalogHarness, type HarnessType } from "../harness/profile"
import type { ComposerNotice } from "./composer-notice"
import { resolveHarnessNotice, type HarnessNoticeInput } from "./harness-notice"
import type { ModelAvailability } from "./harness-model-availability"
import type { PickerItem } from "./model-list"
import type { SelectorCatalog } from "./selector-catalog"

type SelectorNoticeInput = {
  active: Accessor<boolean | undefined>
  controller: Accessor<HarnessSelectionController>
  scope: Accessor<string>
  scopeInput: Accessor<HarnessScopeInput>
  selection: Accessor<HarnessSelectionSnapshot>
  harness: Accessor<HarnessType | undefined>
  picked: Accessor<PickerItem | undefined>
  catalog: SelectorCatalog
  availability: ModelAvailability
  polling: Accessor<boolean>
  harnessLabel: (harness: HarnessType) => string
  openProviders: () => void
}

function createProviderSetupNeed(input: SelectorNoticeInput) {
  return createMemo(() => {
    if (input.availability.modelOptionsFailed()) return false
    if (input.harness() && isCatalogHarness(input.harness())) {
      return input.catalog.providers.resolved() && !input.catalog.providers.loading() && !input.catalog.providers.error() && input.catalog.rows().rows.length === 0
    }
    return input.availability.modelsAnswered() && !input.availability.managedDefaultModel() && !input.availability.modelLoading() && !input.availability.hasModelOptions() && !input.polling() && !input.availability.isError()
  })
}

function harnessNoticeInput(input: SelectorNoticeInput, setupRequired: boolean): HarnessNoticeInput {
  const { selection, harness, catalog, availability } = input
  return {
    harnessLabel: harness() ? input.harnessLabel(harness()!) : "Agent",
    runtimeUnavailable: availability.isError(),
    connectionState: selection().connectionState,
    optionsFailed: availability.modelOptionsFailed(),
    noModels: !availability.hasModelOptions() && !availability.modelLoading() && !catalog.unread(),
    configError: (harness() && isCatalogHarness(harness()) ? catalog.providers.error() : undefined) ?? selection().configError,
    savedModelUnavailable:
      selection().draftDefaultState === "saved-model-unavailable"
        ? selection().draftDefaultLabels?.model || selection().selectedModel || "Saved model"
        : harness() && isCatalogHarness(harness()) && catalog.providers.resolved() && selection().selectedModel && !input.picked()
          ? selection().selectedModel
          : undefined,
    setupRequired,
    openProviders: input.openProviders,
  }
}

function retryAction(input: SelectorNoticeInput): NonNullable<ComposerNotice["action"]> {
  return {
    label: "Retry",
    ariaLabel: input.harness() && isCatalogHarness(input.harness()) ? `Retry loading ${harnessDisplayLabel(harnessSelectionId(input.harness()!))} models` : "Retry loading harness models",
    run: () => {
      if (input.harness() && isCatalogHarness(input.harness())) {
        void input.catalog.providers.refresh()
        return
      }
      void input.controller().reprobe(input.scope(), input.scopeInput())
    },
  }
}

export function createSelectorNotice(input: SelectorNoticeInput) {
  const needsProviderSetup = createProviderSetupNeed(input)
  const notice = createMemo<ComposerNotice | undefined>(() => {
    if (input.active() === false || !input.selection().isHarnessMode || input.selection().readiness === "unresolved") return undefined
    const resolved = resolveHarnessNotice(harnessNoticeInput(input, needsProviderSetup()))
    if (!resolved) return undefined
    const { retry, action, ...rest } = resolved
    if (action) return { ...rest, action }
    if (!retry) return rest
    return { ...rest, action: retryAction(input) }
  })
  const modelError = () => {
    const failure = notice()
    if (!failure || failure.tone !== "critical") return undefined
    return {
      message: failure.message,
      ...(failure.detail ? { detail: failure.detail } : {}),
      ...(failure.action ? { action: { label: failure.action.label, run: failure.action.run } } : {}),
    }
  }
  return { notice, modelError }
}
