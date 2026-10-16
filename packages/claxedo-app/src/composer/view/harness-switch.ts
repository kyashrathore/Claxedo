import { createMemo, createSignal, type Accessor } from "solid-js"
import type { HarnessAlternative, ModelChoice } from "@/server"
import { sameHarnessSelection } from "@/lib/harness-selection"
import { catalogDraftDefaultInput } from "../harness/catalog-draft-default"
import type { HarnessScopeInput, HarnessSelectionController } from "../harness/controller"
import { resolveDraftDefault } from "../harness/draft-default-policy"
import { harnessSelectionId, isCatalogHarness, type HarnessType } from "../harness/profile"
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

function rereadCatalog(input: HarnessSwitchInput, harness: HarnessType, scope: string, scopeInput: HarnessScopeInput) {
  if (!isCatalogHarness(harness)) return undefined
  if (input.controller().read(scope).selectedModelKey) return input.catalog.providers.refresh()
  return restoreCatalogModel(input, harness, scope, scopeInput)
}

type SwitchingHold = ReturnType<typeof createSwitchingHold>["hold"]

async function rereadHarness(input: HarnessSwitchInput, hold: SwitchingHold) {
  const current = input.harness()
  if (!current) return
  const scope = input.scope()
  const scopeInput = input.scopeInput()
  await hold(current, async () => {
    await input.controller().reprobe(scope, scopeInput)
    await rereadCatalog(input, current, scope, scopeInput)
  })
}

function createSwitchingHold() {
  const [switchingHarness, setSwitchingHarness] = createSignal<HarnessType | undefined>()
  const hold = async (harness: HarnessType, work: () => unknown) => {
    setSwitchingHarness(harness)
    try {
      await work()
    } finally {
      setSwitchingHarness((current) => sameHarnessSelection(current, harness) ? undefined : current)
    }
  }
  return { switching: () => !!switchingHarness(), hold }
}

export function createHarnessSwitch(input: HarnessSwitchInput) {
  const { switching, hold } = createSwitchingHold()
  const harnessDisabled = createMemo(() => input.polling() || switching())
  let openedViaMenu = false
  const run = (next: HarnessType, model?: ModelChoice) => {
    const switchScope = input.scope()
    const switchInput = input.scopeInput()
    void hold(next, async () => {
      await input.controller().setHarness(switchScope, next, switchInput, model)
      if (!model) await restoreCatalogModel(input, next, switchScope, switchInput)
    })
  }
  const adopt = (alternative: HarnessAlternative) => {
    if (harnessDisabled()) return
    run(alternative.harness, { providerId: harnessSelectionId(alternative.harness), modelId: alternative.model.id })
  }
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
    run(next)
  }
  return { switching, harnessDisabled, apply, adopt, reread: () => rereadHarness(input, hold) }
}
