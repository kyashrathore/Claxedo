import type { HarnessInfo, ModelChoice } from "@/server"
import type { Selection } from "./model"

export const modelChoiceId = (choice: ModelChoice) => `${choice.providerId}/${choice.modelId}${choice.variant ? `#${choice.variant}` : ""}`

export const sameModel = (a: ModelChoice | undefined, b: ModelChoice | undefined) =>
  !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId && (a.variant ?? undefined) === (b.variant ?? undefined)

export function selectionFor(harness: HarnessInfo | undefined, current: Selection): Selection {
  if (!harness) return current
  const model = current.model && harness.models.some((choice) => sameModel(choice, current.model)) ? current.model : harness.models[0]
  const effort = current.effort && harness.efforts.includes(current.effort) ? current.effort : undefined
  const permissionMode =
    current.permissionMode && harness.permissionModes.includes(current.permissionMode)
      ? current.permissionMode
      : harness.permissionModes[0]
  return { harness: harness.id, model, effort, permissionMode }
}

export function pickHarness(harnesses: readonly HarnessInfo[], chosen: string | undefined) {
  const found = chosen ? harnesses.find((harness) => harness.id === chosen) : undefined
  if (found) return found
  return harnesses.find((harness) => harness.available) ?? harnesses[0]
}

export function sessionHarness(harnesses: readonly HarnessInfo[], harness: string | undefined) {
  return harness ? harnesses.find((candidate) => candidate.id === harness) : undefined
}

export function selectionChanged(a: Selection, b: Selection) {
  return a.harness !== b.harness || !sameModel(a.model, b.model) || a.effort !== b.effort || a.permissionMode !== b.permissionMode
}
