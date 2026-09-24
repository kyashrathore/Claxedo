import type { HarnessInfo, ModelChoice } from "@/server"
import type { Selection } from "./model"

export const modelChoiceId = (choice: ModelChoice) => `${choice.providerId}/${choice.modelId}${choice.variant ? `#${choice.variant}` : ""}`

export const sameModel = (a: ModelChoice | undefined, b: ModelChoice | undefined) =>
  !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId && (a.variant ?? undefined) === (b.variant ?? undefined)

export function selectionFor(harness: HarnessInfo | undefined, current: Selection): Selection {
  if (!harness) return current
  const model = current.model && harness.models.some((choice) => sameModel(choice, current.model)) ? current.model : harness.models[0]
  const effort = current.effort && harness.efforts.includes(current.effort) ? current.effort : harness.efforts[0]
  const permissionMode =
    current.permissionMode && harness.permissionModes.includes(current.permissionMode)
      ? current.permissionMode
      : harness.permissionModes[0]
  return { harness: harness.id, model, effort, permissionMode }
}

export function pickHarness(harnesses: readonly HarnessInfo[], locked: string | undefined, chosen: string | undefined) {
  const wanted = locked ?? chosen
  const found = wanted ? harnesses.find((harness) => harness.id === wanted) : undefined
  if (found) return found
  return harnesses.find((harness) => harness.available) ?? harnesses[0]
}

export function selectionChanged(a: Selection, b: Selection) {
  return a.harness !== b.harness || !sameModel(a.model, b.model) || a.effort !== b.effort || a.permissionMode !== b.permissionMode
}
