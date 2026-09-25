import { createEffect, type Accessor } from "solid-js"
import type { HarnessScopeInput, HarnessSelectionController, HarnessSelectionSnapshot } from "./controller"
import type { ResolveDraftDefaultInput } from "./draft-default-policy"
import { isCatalogHarness, type HarnessType } from "./profile"
import type { ProviderCatalogRead, ProviderCatalogRows } from "./provider-catalog"
import type { PickerItem } from "../view/model-list"

export function catalogDraftDefaultInput(input: {
  options: Accessor<HarnessType[]>
  catalog: ProviderCatalogRows
  providers: ProviderCatalogRead
}): Omit<ResolveDraftDefaultInput, "saved"> {
  return {
    supportedHarnesses: input.options(),
    eligibleModels: input.catalog.eligibleModels,
    connectedProviderIds: [...input.catalog.connected],
    providerDefaults: input.providers.default(),
  }
}

type CatalogDraftDefaultWatch = {
  controller: Accessor<HarnessSelectionController>
  scope: Accessor<string>
  scopeInput: Accessor<HarnessScopeInput>
  placementId: Accessor<HarnessScopeInput["placementId"]>
  sessionLocked: Accessor<boolean>
  selection: Accessor<HarnessSelectionSnapshot>
  harness: Accessor<HarnessType | undefined>
  options: Accessor<HarnessType[]>
  catalog: { providers: ProviderCatalogRead; rows: Accessor<ProviderCatalogRows>; ready: () => boolean }
  picked: Accessor<PickerItem | undefined>
}

function resolveOnCatalogReady(input: CatalogDraftDefaultWatch) {
  createEffect(() => {
    const current = input.selection()
    if (current.draftDefaultState !== undefined) return
    if (current.harness && isCatalogHarness(current.harness)) {
      if (!input.catalog.ready()) return
      input.controller().resolveDraftDefault(
        input.scope(),
        catalogDraftDefaultInput({ options: input.options, catalog: input.catalog.rows(), providers: input.catalog.providers }),
      )
      return
    }
  })
}

function pickOnlyConnectedModel(input: CatalogDraftDefaultWatch) {
  createEffect(() => {
    const currentHarness = input.harness()
    if (!currentHarness || !isCatalogHarness(currentHarness)) return
    if (input.sessionLocked()) return
    if (!input.catalog.ready()) return
    if (input.selection().selectedModelKey || input.picked()) return
    if (input.selection().draftDefaultState === "saved-model-unavailable") return
    const connectedModels = input.catalog.rows().rows.filter((row) => row.connected)
    if (connectedModels.length !== 1) return
    const only = connectedModels[0]
    if (!input.placementId()) return
    void input.controller().setModel(
      input.scope(),
      { providerId: only.provider.id, modelId: only.id },
      input.scopeInput(),
      { provider: only.provider.name, model: only.name },
    )
  })
}

export function watchCatalogDraftDefault(input: CatalogDraftDefaultWatch) {
  resolveOnCatalogReady(input)
  pickOnlyConnectedModel(input)
}
