import type { ModelChoice, SessionLocation } from "@/server"
import type { DraftDefaultLabels } from "./draft-defaults"
import type { HarnessScopeInput } from "./store-policy"

type ModelWriterInput<ScopeInput extends HarnessScopeInput> = {
  seed: (scope: string) => void
  acceptsDraftModel: (scope: string, model: ModelChoice) => boolean
  currentModel: (scope: string) => ModelChoice | undefined
  setSelectedModel: (scope: string, model: ModelChoice) => void
  holdsHarness: (scope: string) => boolean
  reloadOptions: (scope: string, params?: ScopeInput) => Promise<void> | void
  rememberDraftModel: (scope: string, model: ModelChoice, input?: ScopeInput, labels?: DraftDefaultLabels) => void
  selectedEffort: (scope: string) => string | undefined
  setSelectedEffort: (scope: string, effort: string | undefined) => void
  runtime: {
    setSessionModel: (ref: SessionLocation, model: ModelChoice) => Promise<void>
    setSessionEffort: (ref: SessionLocation, effort: string | undefined) => Promise<void>
  }
}

function createScopeWrites() {
  const tails = new Map<string, Promise<void>>()
  return {
    inOrder: (scope: string, write: () => Promise<void>): Promise<void> => {
      const run = (tails.get(scope) ?? Promise.resolve()).then(write, write)
      tails.set(scope, run)
      const clear = () => {
        if (tails.get(scope) === run) tails.delete(scope)
      }
      run.then(clear, clear)
      return run
    },
    settled: async (scope: string) => {
      await Promise.allSettled([tails.get(scope)])
    },
  }
}

type SelectionField<Value> = {
  read(scope: string): Value
  restore(scope: string, value: Value): void
  same(a: Value, b: Value): boolean
}

function createConfirmedSelection<Value>(field: SelectionField<Value>) {
  const confirmed = new Map<string, { value: Value; writes: number }>()
  return async (scope: string, write: { readonly value: Value; readonly previous: Value; readonly run: () => Promise<void> }) => {
    const slot = confirmed.get(scope) ?? { value: write.previous, writes: 0 }
    confirmed.set(scope, slot)
    slot.writes++
    try {
      await write.run()
      slot.value = write.value
    } catch (error) {
      if (field.same(field.read(scope), write.value)) field.restore(scope, slot.value)
      throw error
    } finally {
      if (--slot.writes === 0) confirmed.delete(scope)
    }
  }
}

function sameProviderModel(a: ModelChoice | undefined, b: ModelChoice | undefined) {
  return a?.providerId === b?.providerId && a?.modelId === b?.modelId
}

export function createHarnessModelWriter<ScopeInput extends HarnessScopeInput>(input: ModelWriterInput<ScopeInput>) {
  const writes = createScopeWrites()
  const models = createConfirmedSelection<ModelChoice | undefined>({
    read: input.currentModel,
    restore: (scope, model) => model && input.setSelectedModel(scope, model),
    same: sameProviderModel,
  })
  const efforts = createConfirmedSelection<string | undefined>({ read: input.selectedEffort, restore: input.setSelectedEffort, same: (a, b) => a === b })
  const sessionRef = (scope: string, params?: ScopeInput) =>
    params?.sessionId && params.sessionId !== "new" && !input.holdsHarness(scope) ? params.sessionRef : undefined
  const setModel = async (scope: string, model: ModelChoice, params?: ScopeInput, labels?: DraftDefaultLabels) => {
    input.seed(scope)
    const draft = !params?.sessionId || params.sessionId === "new"
    if (draft && !input.acceptsDraftModel(scope, model)) return
    const previous = input.currentModel(scope)
    input.setSelectedModel(scope, model)
    const changed = !sameProviderModel(previous, model)
    if (draft) input.rememberDraftModel(scope, model, params, labels)
    const ref = sessionRef(scope, params)
    if (ref && changed) await models(scope, { value: model, previous, run: () => writes.inOrder(scope, () => input.runtime.setSessionModel(ref, model)) })
    if (changed) await input.reloadOptions(scope, params)
  }
  const setEffort = async (scope: string, effort: string | undefined, params?: ScopeInput) => {
    const previous = input.selectedEffort(scope)
    input.setSelectedEffort(scope, effort)
    const ref = sessionRef(scope, params)
    if (ref && previous !== effort) await efforts(scope, { value: effort, previous, run: () => writes.inOrder(scope, () => input.runtime.setSessionEffort(ref, effort)) })
  }
  return { setModel, setEffort, inOrder: writes.inOrder, settledConfig: writes.settled }
}
