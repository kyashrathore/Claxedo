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
  if (!input.model) return
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

/**
 * What a new OpenCode draft opens on.
 *
 * OpenCode is the one harness with no `harness-config-options` surface — both
 * the workspace runtime and the daemon answer that route 404 for it
 * ("opencode model options are exposed through /provider, not harness config
 * options"), so the model OpenCode would run is the provider catalog's own
 * answer, `resolvedDefault`, rather than anything a harness probe reports.
 *
 * Two sources, one order, and the order IS the rule: a model this workspace
 * remembers for OpenCode wins, and only a workspace that remembers nothing
 * falls to the resolved default. The resolved default is SHOWN, never
 * remembered — `writeOpenCodeDraftModel` is the only path that persists a
 * choice, and it runs on an explicit pick.
 *
 * The two sources reach the composer by two different routes, because the
 * draft-default policy only has something to settle when the workspace saved a
 * pair. `beginDraftDefault` finishes a no-memory scope the instant it reads
 * one: the scope is left `defaulted`/`ready` carrying NO model, and from then
 * on `draftDefaultApplication` refuses an application and
 * `resolveCurrentDraftDefault` finds no saved harness to resolve. So a
 * remembered pair is validated through the policy, while the catalog's own
 * answer is written straight to the composer — routing it through the policy is
 * what left a fresh profile reading "Select model" until a reload.
 */
export function restoreOpenCodeDraftDefault(input: DraftInput & {
  ready: boolean
  models: ModelRow[]
  /** The model OpenCode resolves for itself: the highest-ranked connected provider's default. */
  resolvedDefault?: ModelKey
  write(model: ModelKey): void
  writeVariant(variant?: string): void
}) {
  if (!input.newSession || !input.controller || !input.ready) return false
  const snapshot = input.controller.read(input.scope)
  if (snapshot.harness !== "opencode") return false
  const eligibleModels = input.models.flatMap((item) => {
    const model = { providerID: item.provider.id, modelID: item.id }
    return [model, ...Object.keys(item.variants ?? {}).map((variant) => ({ ...model, variant }))]
  })
  const saved = snapshot.draftDefaultModel
  if (!saved) {
    const resolved = input.resolvedDefault
    // Still only the catalog's own answer, never a guess: a machine with no
    // connected provider resolves nothing, and a model the catalog does not
    // offer is not shown.
    if (!resolved) return false
    if (!eligibleModels.some((model) => sameModelKey(model, resolved))) return false
    input.write(resolved)
    input.writeVariant(resolved.variant)
    return true
  }
  if (snapshot.draftDefaultState !== undefined) return false
  const applied = input.controller.resolveDraftDefault(input.scope, {
    supportedHarnesses: ["opencode"],
    eligibleModels,
    ...(input.resolvedDefault ? { declaredDefaultModel: input.resolvedDefault } : {}),
  })
  if (applied) {
    input.write(saved)
    input.writeVariant(saved.variant)
  }
  return applied
}

function sameModelKey(left: ModelKey, right: ModelKey) {
  return left.providerID === right.providerID
    && left.modelID === right.modelID
    && left.variant === right.variant
}
