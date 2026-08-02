import type { ModelKey } from "./model-strategy"
import type { DraftDefaultResult, ResolveDraftDefaultInput } from "../harness/draft-default-policy"
import type { DraftDefaultLabels } from "../harness/draft-defaults"

type ModelRow = {
  id: string
  name?: string
  variants?: Record<string, unknown>
  provider: { id: string; name?: string }
}

type DraftController = {
  read(scope: string): {
    harness: string
    draftDefaultState?: DraftDefaultResult["state"]
    draftDefaultModel?: ModelKey
  }
  rememberDraftModel(
    scope: string,
    model: ModelKey,
    input?: { directory?: string; sessionId?: string },
    labels?: DraftDefaultLabels,
  ): unknown
  resolveDraftDefault(scope: string, input: Omit<ResolveDraftDefaultInput, "saved">): boolean
}

type DraftInput = {
  controller?: DraftController
  scope: string
  directory?: string
  sessionId?: string
  newSession: boolean
}

export function openCodeDraftLabels(model: ModelKey | undefined, models: ModelRow[]): DraftDefaultLabels | undefined {
  const hit = model && models.find((item) => item.id === model.modelID && item.provider.id === model.providerID)
  return hit ? { provider: hit.provider.name ?? hit.provider.id, model: hit.name ?? hit.id } : undefined
}

export function writeOpenCodeDraftModel(input: DraftInput & {
  model?: ModelKey
  options?: { recent?: boolean }
  labels?: DraftDefaultLabels
  write(model?: ModelKey, options?: { recent?: boolean }): void
}) {
  input.write(input.model, input.options)
  if (!input.model || !input.newSession) return
  if (input.controller?.read(input.scope).harness !== "opencode") return
  input.controller.rememberDraftModel(input.scope, input.model, {
    directory: input.directory,
    sessionId: input.sessionId,
  }, input.labels)
}

export function writeOpenCodeDraftVariant(input: DraftInput & {
  model?: ModelKey
  variant?: string
  labels?: DraftDefaultLabels
  write(): void
}) {
  input.write()
  if (!input.model || !input.newSession) return
  if (input.controller?.read(input.scope).harness !== "opencode") return
  input.controller.rememberDraftModel(input.scope, {
    providerID: input.model.providerID,
    modelID: input.model.modelID,
    ...(input.variant ? { variant: input.variant } : {}),
  }, {
    directory: input.directory,
    sessionId: input.sessionId,
  }, input.labels)
}

export function restoreOpenCodeDraftDefault(input: DraftInput & {
  ready: boolean
  models: ModelRow[]
  write(model: ModelKey): void
  writeVariant(variant?: string): void
}) {
  if (!input.newSession || !input.controller || !input.ready) return false
  const snapshot = input.controller.read(input.scope)
  if (snapshot.harness !== "opencode" || snapshot.draftDefaultState !== undefined) return false
  const saved = snapshot.draftDefaultModel
  if (!saved) return false
  const eligibleModels = input.models.flatMap((item) => {
    const model = { providerID: item.provider.id, modelID: item.id }
    return [model, ...Object.keys(item.variants ?? {}).map((variant) => ({ ...model, variant }))]
  })
  const applied = input.controller.resolveDraftDefault(input.scope, {
    supportedHarnesses: ["opencode"],
    eligibleModels,
  })
  if (applied) {
    input.write(saved)
    input.writeVariant(saved.variant)
  }
  return applied
}
