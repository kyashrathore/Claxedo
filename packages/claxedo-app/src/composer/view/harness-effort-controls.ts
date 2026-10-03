import { createMemo, type Accessor } from "solid-js"
import type { HarnessScopeInput, HarnessSelectionController, HarnessSelectionSnapshot } from "../harness/controller"
import type { SelectorCatalog } from "./selector-catalog"

type EffortControlsInput = {
  selection: Accessor<HarnessSelectionSnapshot>
  catalogSelected: Accessor<boolean>
  catalog: SelectorCatalog
  scope: Accessor<string>
  scopeInput: Accessor<HarnessScopeInput>
  controller: Accessor<HarnessSelectionController>
}

export function createEffortControls(input: EffortControlsInput) {
  const harnessThoughtLevels = createMemo(() => input.selection().thoughtLevels ?? [])
  const variants = createMemo(() => {
    if (!input.catalogSelected()) return harnessThoughtLevels().map((item) => item.id)
    const variants = input.catalog.variants({ providerId: input.selection().selectedModelProvider, modelId: input.selection().selectedModel })
    return variants.length ? ["default", ...variants] : []
  })
  const showEffort = createMemo(() => variants().length > 1 || (input.catalog.unread() && !!input.selection().selectedThoughtLevel))
  const currentVariant = createMemo(() => input.selection().selectedThoughtLevel)
  const levelName = (value: string) =>
    harnessThoughtLevels().find((item) => item.id === value)?.name ?? value
  const select = (value: string) => {
    const effort = input.catalogSelected() && value === "default" ? undefined : value
    void Promise.resolve(input.controller().setThoughtLevel(input.scope(), effort, input.scopeInput()))
      .catch((error: unknown) => console.warn(`The session refused effort ${effort ?? "default"}; the previous effort is kept`, error))
  }
  return { variants, showEffort, currentVariant, levelName, select }
}

export function createFastControl(input: Pick<EffortControlsInput, "selection" | "catalogSelected" | "scope" | "controller">) {
  const tier = createMemo(() => (input.catalogSelected() ? undefined : input.selection().serviceTiers[0]))
  const control = createMemo(() => {
    const current = tier()
    if (!current) return undefined
    return {
      on: input.selection().selectedServiceTier === current.id,
      label: current.name,
      ...(current.description ? { description: current.description } : {}),
    }
  })
  const toggle = (next: boolean) => input.controller().setServiceTier(input.scope(), next ? tier()?.id : undefined)
  return { control, toggle }
}
