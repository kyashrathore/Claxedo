import { harnessHasConfigOptions, type HarnessType } from "./profile"
import { sameHarnessSelection } from "@/lib/harness-selection"
import type { HarnessStoreState } from "./store-state"
import type { DraftDefault } from "./draft-defaults"
import type { DraftDefaultApplication } from "./draft-default-policy"
import type { HarnessState, PlacementId, PlacementKind } from "@/server"
import {
  sessionHarnessState,
  shouldHydrateDraftFromHarnessStatus,
  type HarnessScopeInput,
} from "./store-policy"

export type HarnessHydratorCache = {
  getSeen(scope: string): string | undefined
  setSeen(scope: string, key: string): void
  clearSeen(scope: string): void
  getPending(scope: string): Promise<void> | undefined
  setPending(scope: string, value: Promise<void>): void
  removePending(scope: string, value: Promise<void>): void
}

type HydratorInput<ScopeInput extends HarnessScopeInput> = {
  seed(scope: string): void
  state(scope: string): HarnessStoreState | undefined
  beginDraftDefault?(scope: string, params?: ScopeInput): {
    application: DraftDefaultApplication
    saved?: DraftDefault
  } | undefined
  markServer?(scope: string): void
  applyStatus(scope: string, data: HarnessState, params?: ScopeInput): Promise<void>
  setPollingHydration(scope: string, type?: HarnessType): void
  setReadyHydration(scope: string, type: HarnessType, hasConfigOptions?: boolean): void
  setCapabilityError?(scope: string, message: string): void
  fetchConfigOptions(scope: string, type: HarnessType, params?: ScopeInput): Promise<unknown> | void
  hasConfigOptions?(type: HarnessType): Promise<boolean>
  runtime: {
    placementKind(placementId: PlacementId): PlacementKind | undefined
    folderHarness(placementId: PlacementId): Promise<HarnessState | undefined>
  }
  cache: HarnessHydratorCache
}

type Run<ScopeInput> = {
  readonly scope: string
  readonly key: string
  readonly params: ScopeInput
  readonly placementId: PlacementId
  readonly draftDefault?: { readonly saved?: DraftDefault }
  readonly active: () => boolean
}

export function createHarnessHydrator<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>) {
  const runs = createRunTracker(input.cache)
  const hydrate = async (scope: string, params?: ScopeInput) => {
    input.seed(scope)
    const key = scopeStamp(params)
    const existingSession = !!params?.sessionId && params.sessionId !== "new"
    if (existingSession && input.state(scope)?.heldFrom) return
    if (existingSession) input.markServer?.(scope)
    const draftDefault = existingSession ? undefined : input.beginDraftDefault?.(scope, params)
    if (input.cache.getSeen(scope) === key) return
    return runs.start(scope, key, async (active) => {
      const placementId = params?.placementId
      if (!params || !placementId) return
      const run = { scope, key, params, placementId, draftDefault, active }
      await (existingSession ? hydrateSessionHarness(input, run) : hydrateDraft(input, run))
    })
  }
  return {
    cancel: runs.cancel,
    hydrate,
    reprobe: async (scope: string, params?: ScopeInput) => {
      input.cache.clearSeen(scope)
      return hydrate(scope, params)
    },
  }
}

function createRunTracker(cache: HarnessHydratorCache) {
  const generations = new Map<string, number>()
  const pending = new Map<string, { key: string; run: Promise<void> }>()
  let nextGeneration = 0
  return {
    cancel: (scope: string) => void generations.delete(scope),
    start: (scope: string, key: string, work: (active: () => boolean) => Promise<void>) => {
      const joined = pending.get(scope)
      if (joined?.key === key) return joined.run
      const generation = ++nextGeneration
      generations.set(scope, generation)
      const run = work(() => generations.get(scope) === generation)
      pending.set(scope, { key, run })
      cache.setPending(scope, run)
      return run.finally(() => {
        if (pending.get(scope)?.run === run) pending.delete(scope)
        if (generations.get(scope) === generation) generations.delete(scope)
        cache.removePending(scope, run)
      })
    },
  }
}

async function hydrateDraft<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, run: Run<ScopeInput>) {
  const { scope, params, active } = run
  if (run.draftDefault?.saved) {
    if (!active()) return
    const type = input.state(scope)?.harness ?? run.draftDefault.saved.harness
    if (await settleOnHarness(input, scope, type, params) && active()) input.cache.setSeen(scope, run.key)
    return
  }
  if (shouldHydrateDraftFromHarnessStatus({ placementKind: input.runtime.placementKind(run.placementId) })) {
    const data = await readHarnessStatus(input, params)
    if (!active()) return
    if (data) return applyAndMarkSeen(input, run, data)
  }
  const type = input.state(scope)?.harness
  if (type && !await settleOnHarness(input, scope, type, params)) return
  if (active()) input.cache.setSeen(scope, run.key)
}

async function hydrateSessionHarness<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, run: Run<ScopeInput>) {
  const type = run.params.sessionHarness
  if (!type) return input.setPollingHydration(run.scope)
  const model = run.params.sessionModel?.()
  const current = input.state(run.scope)
  if (current?.harness && sameHarnessSelection(current.harness, type) && current.selectedModel === (model?.modelId ?? "") && current.selectedModelProvider === model?.providerId && current.selectedThoughtLevel === model?.variant && input.cache.getSeen(run.scope) !== undefined) {
    input.cache.setSeen(run.scope, run.key)
    return
  }
  return applyAndMarkSeen(input, run, sessionHarnessState(type, model))
}

async function applyAndMarkSeen<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, run: Run<ScopeInput>, data: HarnessState) {
  if (!run.active()) return
  await input.applyStatus(run.scope, data, run.params)
  if (run.active()) input.cache.setSeen(run.scope, run.key)
}

async function settleOnHarness<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, scope: string, type: HarnessType, params: ScopeInput) {
  input.setReadyHydration(scope, type)
  const configOptions = await probeConfigOptions(input, scope, type)
  if (configOptions === undefined) return false
  if (configOptions) await input.fetchConfigOptions(scope, type, params)
  else input.setReadyHydration(scope, type, false)
  return true
}

async function probeConfigOptions<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, scope: string, type: HarnessType) {
  try {
    return input.hasConfigOptions ? await input.hasConfigOptions(type) : harnessHasConfigOptions(type)
  } catch (error) {
    input.setCapabilityError?.(scope, error instanceof Error ? error.message : "Failed to load connection capabilities")
    return undefined
  }
}

function readHarnessStatus<ScopeInput extends HarnessScopeInput>(input: HydratorInput<ScopeInput>, params: ScopeInput): Promise<HarnessState | undefined> {
  const placementId = params.placementId
  if (!placementId) return Promise.resolve(undefined)
  return input.runtime.folderHarness(placementId).catch((error: unknown) => {
    console.warn(`The harness status of placement ${placementId} could not be read`, error)
    return undefined
  })
}

function scopeStamp(input?: HarnessScopeInput) {
  if (input?.sessionId && input.sessionId !== "new") {
    return [`session:${input.sessionId}`, input.placementId ?? "", input.sessionHarness ? JSON.stringify(input.sessionHarness) : "", JSON.stringify(input.sessionModel?.()) ?? ""].join("\n")
  }
  return `${input?.placementId ?? ""}\nnew`
}
