import { createMemo, type Accessor } from "solid-js"
import type { HarnessScopeInput, HarnessSelectionController, HarnessSelectionSnapshot } from "../harness/controller"
import { createModelSelectionController, modelKeyFromPickerSelection, type ModelSelectionCommand } from "../harness/model-selection"
import type { PickerItem, PickerState } from "./model-list"

type ModelPickInput = {
  controller: Accessor<HarnessSelectionController>
  scope: Accessor<string>
  scopeInput: Accessor<HarnessScopeInput>
  selection: Accessor<HarnessSelectionSnapshot>
  rows: Accessor<PickerItem[]>
  picked: Accessor<PickerItem | undefined>
  catalogSelected: Accessor<boolean>
  catalogVariants: (model: { providerId?: string; modelId?: string }) => string[]
  openProviders: () => void
}

function writeModelPick(input: ModelPickInput, command: ModelSelectionCommand) {
  if (!command.model) return undefined
  const hit = input.rows().find(
    (item) => item.id === command.model?.modelId && item.provider.id === command.model.providerId,
  )
  const level = input.selection().selectedThoughtLevel
  if (input.catalogSelected() && level && !input.catalogVariants(command.model).includes(level)) {
    input.controller().setThoughtLevel(input.scope(), undefined)
  }
  return input.controller().setModel(
    input.scope(),
    command.model,
    input.scopeInput(),
    hit ? { provider: hit.provider.name, model: hit.name } : undefined,
  )
}

export function createModelPickerState(input: ModelPickInput): Accessor<PickerState> {
  const modelSelection = createMemo(() =>
    createModelSelectionController({ write: (command) => writeModelPick(input, command) }),
  )
  return createMemo<PickerState>(() => ({
    list: input.rows,
    current: input.picked,
    set: (item) => {
      const modelKey = modelKeyFromPickerSelection(item)
      if (!modelKey) return
      const hit = input.rows().find((row) => row.id === modelKey.modelId && row.provider.id === modelKey.providerId)
      if (!hit) return
      if (hit.connected === false) {
        input.openProviders()
        return
      }
      void modelSelection().set({
        scope: {
          key: `harness:${input.scope()}`,
          current: () => input.selection().selectedModelKey,
        },
        model: { providerId: hit.provider.id, modelId: hit.id },
        source: "ui",
      })
    },
  }))
}
