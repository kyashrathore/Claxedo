import { createMemo, type Accessor } from "solid-js"
import { sameModelKey, type ModelChoice } from "@/server"
import type { HarnessScopeInput, HarnessSelectionController, HarnessSelectionSnapshot } from "../harness/controller"
import type { PickerItem, PickerState } from "./model-list"

type ModelPickInput = {
  controller: Accessor<Pick<HarnessSelectionController, "setThoughtLevel" | "setModel">>
  scope: Accessor<string>
  scopeInput: Accessor<HarnessScopeInput>
  selection: Accessor<Pick<HarnessSelectionSnapshot, "selectedThoughtLevel" | "selectedModelKey">>
  rows: Accessor<PickerItem[]>
  picked: Accessor<PickerItem | undefined>
  catalogSelected: Accessor<boolean>
  catalogVariants: (model: { providerId?: string; modelId?: string }) => string[]
  openProviders: () => void
}

function writeModelPick(input: ModelPickInput, model: ModelChoice) {
  const hit = input.rows().find(
    (item) => item.id === model.modelId && item.provider.id === model.providerId,
  )
  const level = input.selection().selectedThoughtLevel
  if (input.catalogSelected() && level && !input.catalogVariants(model).includes(level)) {
    input.controller().setThoughtLevel(input.scope(), undefined)
  }
  return input.controller().setModel(
    input.scope(),
    model,
    input.scopeInput(),
    hit ? { provider: hit.provider.name, model: hit.name } : undefined,
  )
}

export function createModelPickerState(input: ModelPickInput): Accessor<PickerState> {
  const pending = new Map<string, Promise<void>>()
  const choose = async (model: ModelChoice) => {
    if (sameModelKey(input.selection().selectedModelKey, model)) return
    const key = `${input.scope()}\n${model.providerId}\n${model.modelId}`
    const existing = pending.get(key)
    if (existing) return existing
    const run = Promise.resolve(writeModelPick(input, model))
    pending.set(key, run)
    try {
      await run
    } finally {
      if (pending.get(key) === run) pending.delete(key)
    }
  }
  return createMemo<PickerState>(() => ({
    list: input.rows,
    current: input.picked,
    set: (item) => {
      if (!item?.providerId || !item.modelId) return
      const hit = input.rows().find((row) => row.id === item.modelId && row.provider.id === item.providerId)
      if (!hit) return
      if (hit.connected === false) {
        input.openProviders()
        return
      }
      void choose({ providerId: hit.provider.id, modelId: hit.id })
    },
  }))
}
