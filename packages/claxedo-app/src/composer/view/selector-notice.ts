import { createMemo, type Accessor } from "solid-js"
import type { HarnessScopeInput, HarnessSelectionController, HarnessSelectionSnapshot } from "../harness/controller"
import { harnessDisplayLabel, harnessSelectionId, isCatalogHarness, type HarnessType } from "../harness/profile"
import type { ComposerNotice } from "./notice-slot"
import { resolveHarnessNotice, type HarnessNoticeInput } from "./harness-notice"
import type { ModelAvailability } from "./harness-model-availability"
import type { PickerItem } from "./model-list"
import type { HarnessAccountState } from "./harness-account-state"
import type { SelectorCatalog } from "./selector-catalog"
import type { ModelLoadFailure } from "./harness-picker-model-section"
import { createWakeReread } from "./wake-reread"

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
  asleep: Accessor<boolean>
  rereadAfterWake: () => Promise<unknown>
  account: Accessor<HarnessAccountState>
  harnessLabel: (harness: HarnessType) => string
  openProviders: () => void
  unavailableHere: Accessor<ModelLoadFailure | undefined>
}

function liveSourceOffersNoModel(input: SelectorNoticeInput) {
  if (input.availability.modelOptionsFailed()) return false
  if (input.harness() && isCatalogHarness(input.harness())) {
    return input.catalog.providers.resolved() && !input.catalog.providers.loading() && !input.catalog.providers.error() && input.catalog.rows().rows.length === 0
  }
  return input.availability.modelsAnswered() && !input.availability.managedDefaultModel() && !input.availability.modelLoading() && !input.availability.hasModelOptions() && !input.polling() && !input.availability.isError()
}

function createUnservedAccount(input: SelectorNoticeInput) {
  return createMemo((): HarnessAccountState | undefined => (liveSourceOffersNoModel(input) ? input.account() : undefined))
}

function harnessNoticeInput(input: SelectorNoticeInput, unserved: HarnessAccountState | undefined, readAsleep: boolean): HarnessNoticeInput {
  const { selection, harness, catalog, availability } = input
  return {
    harnessLabel: harness() ? input.harnessLabel(harness()!) : "Agent",
    asleep: readAsleep,
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
    setupRequired: unserved === "missing" || unserved === "accountless",
    accountRefused: unserved === "refused",
    accountUnavailable: selection().accountUnavailable,
    openProviders: input.openProviders,
    unavailableHere: input.unavailableHere(),
  }
}

function reloadModels(input: SelectorNoticeInput) {
  if (input.harness() && isCatalogHarness(input.harness())) {
    void input.catalog.providers.refresh()
    return
  }
  void input.controller().reprobe(input.scope(), input.scopeInput())
}

function retryAction(input: SelectorNoticeInput): NonNullable<ComposerNotice["action"]> {
  return {
    label: "Retry",
    ariaLabel: input.harness() && isCatalogHarness(input.harness()) ? `Retry loading ${harnessDisplayLabel(harnessSelectionId(input.harness()!))} models` : "Retry loading harness models",
    run: () => reloadModels(input),
  }
}

export function createSelectorNotice(input: SelectorNoticeInput) {
  const readAsleep = createWakeReread({ asleep: input.asleep, active: input.active, reread: input.rereadAfterWake })
  const unservedAccount = createUnservedAccount(input)
  const notice = createMemo<ComposerNotice | undefined>(() => {
    if (input.active() === false || !input.selection().isHarnessMode || input.selection().readiness === "unresolved") return undefined
    const resolved = resolveHarnessNotice(harnessNoticeInput(input, unservedAccount(), input.asleep() || readAsleep()))
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
