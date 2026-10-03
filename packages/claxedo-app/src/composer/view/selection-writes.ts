import type { Accessor } from "solid-js"
import { showToast } from "@/ui"
import type { HarnessScopeInput, HarnessSelectionController, HarnessSelectionSnapshot } from "../harness/controller"
import { useComposerText } from "../text"
import { createEffortControls, createFastControl } from "./harness-effort-controls"
import { createModelPickerState } from "./harness-model-pick"
import type { PickerItem } from "./model-list"
import type { SelectorCatalog } from "./selector-catalog"

type SelectionWritesInput = {
  controller: Accessor<HarnessSelectionController>
  scope: Accessor<string>
  scopeInput: Accessor<HarnessScopeInput>
  selection: Accessor<HarnessSelectionSnapshot>
  rows: Accessor<PickerItem[]>
  picked: Accessor<PickerItem | undefined>
  catalogSelected: Accessor<boolean>
  catalog: SelectorCatalog
  openProviders: () => void
}

export function createSelectionWrites(input: SelectionWritesInput) {
  const t = useComposerText()
  const refused = (error: unknown) => showToast({ title: t("composer.requestFailed"), description: error instanceof Error ? error.message : String(error) })
  return {
    model: createModelPickerState({ ...input, catalogVariants: input.catalog.variants, refused }),
    effort: createEffortControls({ ...input, refused }),
    fast: createFastControl(input),
  }
}
