import { createMemo, createSignal, type Accessor } from "solid-js"
import { sameHarnessSelection } from "@/lib/harness-selection"
import { catalogDraftDefaultInput } from "../harness/catalog-draft-default"
import type { HarnessScopeInput, HarnessSelectionController } from "../harness/controller"
import { resolveDraftDefault } from "../harness/draft-default-policy"
import { isCatalogHarness, type HarnessType } from "../harness/profile"
import { shouldApplyHarnessSelection } from "./agent-harness-selection-guard"
import type { SelectorCatalog } from "./selector-catalog"

type HarnessSwitchInput = {
  controller: Accessor<HarnessSelectionController>
  scope: Accessor<string>
  scopeInput: Accessor<HarnessScopeInput>
  harness: Accessor<HarnessType | undefined>
  polling: Accessor<boolean>
  options: Accessor<HarnessType[]>
  catalog: SelectorCatalog
}

async function restoreCatalogModel(input: HarnessSwitchInput, harness: HarnessType, switchScope: string, switchInput: HarnessScopeInput) {
  if (!isCatalogHarness(harness)) return undefined
  await input.catalog.providers.refresh()
  if (input.scope() !== switchScope || input.scopeInput() !== switchInput) return undefined
  if (input.catalog.providers.error()) return undefined
  const catalog = input.catalog.rows()
  const result = resolveDraftDefault({
    saved: { harness },
    ...catalogDraftDefaultInput({ options: input.options, catalog, providers: input.catalog.providers }),
  })
  if (!result.model) return undefined
  const hit = catalog.rows.find((item) => item.provider.id === result.model?.providerId && item.id === result.model.modelId)
  return input.controller().setModel(switchScope, result.model, switchInput, hit ? { provider: hit.provider.name, model: hit.name } : undefined)
}

export function createHarnessSwitch(input: HarnessSwitchInput) {
  const [switchingHarness, setSwitchingHarness] = createSignal<HarnessType | undefined>()
  const switching = () => !!switchingHarness()
  const harnessDisabled = createMemo(() => input.polling() || switching())
  let openedViaMenu = false
  const apply = (next: HarnessType | undefined) => {
    openedViaMenu = true
    const current = input.harness()
    const allowed = shouldApplyHarnessSelection({
      next,
      current,
      disabled: harnessDisabled(),
      openedViaMenu,
    })
    openedViaMenu = false
    if (!allowed || !next) return
    setSwitchingHarness(next)
    const switchScope = input.scope()
    const switchInput = input.scopeInput()
    void Promise.resolve(
      input.controller().setHarness(switchScope, next, switchInput),
    ).then(() => restoreCatalogModel(input, next, switchScope, switchInput)).finally(() => {
      setSwitchingHarness((current) => sameHarnessSelection(current, next) ? undefined : current)
    })
  }
  return { switching, harnessDisabled, apply }
}
