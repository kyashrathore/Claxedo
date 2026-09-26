import {
  sessionModelSyncKey,
  type HarnessScopeInput,
} from "./store-policy"
import type { ModelChoice, SessionRef } from "@/server"
import type { DraftDefaultLabels } from "./draft-defaults"

export type SessionModelSyncState = {
  desired?: string
  synced?: string
}

export type HarnessSessionModelSyncCache = {
  getState(key: string): SessionModelSyncState | undefined
  setState(key: string, value: SessionModelSyncState): void
  getPending(key: string, model: string): Promise<void> | undefined
  setPending(key: string, model: string, value: Promise<void>): void
  removePending(key: string, model: string, value: Promise<void>): void
}

export function syncHarnessSessionModel(input: {
  key: string
  model: string
  request: () => Promise<void>
  cache: HarnessSessionModelSyncCache
}) {
  const current = input.cache.getState(input.key) ?? {}
  input.cache.setState(input.key, {
    ...current,
    desired: input.model,
  })
  if (current.synced === input.model) return undefined

  const pending = input.cache.getPending(input.key, input.model)
  if (pending) return pending

  const run = input.request()
    .then(() => {
      const latest = input.cache.getState(input.key)
      if (latest?.desired !== input.model) return
      input.cache.setState(input.key, {
        ...latest,
        synced: input.model,
      })
    })
    .finally(() => input.cache.removePending(input.key, input.model, run))

  input.cache.setPending(input.key, input.model, run)
  return run
}

type ModelWriterInput<ScopeInput extends HarnessScopeInput> = {
  seed(scope: string): void
  acceptsDraftModel(scope: string, model: ModelChoice): boolean
  currentModel(scope: string): ModelChoice | undefined
  setSelectedModel(scope: string, model: ModelChoice): void
  holdsHarness(scope: string): boolean
  reloadOptions(scope: string, params?: ScopeInput): Promise<void> | void
  rememberDraftModel(scope: string, model: ModelChoice, input?: ScopeInput, labels?: DraftDefaultLabels): void
  runtime: {
    setSessionModel(ref: SessionRef, model: ModelChoice): Promise<void>
  }
  cache: HarnessSessionModelSyncCache
}

export function createHarnessModelWriter<ScopeInput extends HarnessScopeInput>(input: ModelWriterInput<ScopeInput>) {
  const saving = new Map<string, Promise<void>>()
  const setModel = async (scope: string, model: ModelChoice, params?: ScopeInput, labels?: DraftDefaultLabels) => {
    input.seed(scope)
    const draft = !params?.sessionId || params.sessionId === "new"
    if (draft && !input.acceptsDraftModel(scope, model)) return
    const previous = input.currentModel(scope)
    input.setSelectedModel(scope, model)
    const changed = previous?.providerId !== model.providerId || previous.modelId !== model.modelId
    if (draft) input.rememberDraftModel(scope, model, params, labels)
    const run = draft || input.holdsHarness(scope) ? undefined : syncSessionModel(input, params, model)
    if (run) await saveSessionModel(input, saving, { scope, model, previous, run })
    if (changed) await input.reloadOptions(scope, params)
  }
  return {
    setModel,
    settledModel: async (scope: string) => {
      await Promise.allSettled([saving.get(scope)])
    },
  }
}

function syncSessionModel<ScopeInput extends HarnessScopeInput>(input: ModelWriterInput<ScopeInput>, params: ScopeInput | undefined, model: ModelChoice) {
  const ref = params?.sessionRef
  const key = params ? sessionModelSyncKey(params) : undefined
  if (!ref || !key) return undefined
  return syncHarnessSessionModel({
    key,
    model: `${model.providerId}/${model.modelId}`,
    cache: input.cache,
    request: () => input.runtime.setSessionModel(ref, model),
  })
}

async function saveSessionModel<ScopeInput extends HarnessScopeInput>(
  input: ModelWriterInput<ScopeInput>,
  saving: Map<string, Promise<void>>,
  save: { readonly scope: string; readonly model: ModelChoice; readonly previous: ModelChoice | undefined; readonly run: Promise<void> },
) {
  const { scope, model, previous, run } = save
  saving.set(scope, run)
  try {
    await run
  } catch (error) {
    const shown = input.currentModel(scope)
    if (previous && shown?.providerId === model.providerId && shown.modelId === model.modelId) input.setSelectedModel(scope, previous)
    throw error
  } finally {
    if (saving.get(scope) === run) saving.delete(scope)
  }
}
