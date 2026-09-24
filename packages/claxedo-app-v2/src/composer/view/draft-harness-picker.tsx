import { createEffect, createMemo, createUniqueId, onMount, type JSX } from "solid-js"
import type { PlacementId } from "@/server"
import type { HarnessSelection } from "@/lib/harness-selection"
import { useHarnessConfig } from "../harness/context"
import { createHarnessSelectionController } from "../harness/controller"
import type { ModelKey } from "../harness/model-key"
import { AgentHarnessSelector } from "./agent-harness-selector"

export type DraftHarnessChoice = {
  readonly harness: HarnessSelection | undefined
  readonly model: ModelKey | undefined
  readonly effort: string | undefined
}

export function DraftHarnessPicker(props: {
  readonly placementId: PlacementId
  readonly seed: DraftHarnessChoice
  readonly active: boolean
  readonly onChange: (choice: DraftHarnessChoice) => void
}): JSX.Element {
  const controller = createHarnessSelectionController(useHarnessConfig())
  const scope = `draft:picker:${createUniqueId()}`
  const scopeInput = createMemo(() => ({ placementId: props.placementId }))
  onMount(() => {
    const seed = props.seed
    if (!seed.harness) return
    void controller.setHarness(scope, seed.harness, scopeInput())
    if (seed.model) void controller.setModel(scope, seed.model, scopeInput())
    controller.setThoughtLevel(scope, seed.effort)
  })
  const snapshot = createMemo(() => controller.read(scope))
  createEffect(() => {
    const current = snapshot()
    props.onChange({ harness: current.harness, model: current.selectedModelKey, effort: current.selectedThoughtLevel })
  })
  return (
    <AgentHarnessSelector harnessController={controller} scope={scope} scopeInput={scopeInput()} active={props.active} />
  )
}
