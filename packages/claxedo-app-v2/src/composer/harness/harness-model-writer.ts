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

export function createHarnessModelWriter<ScopeInput extends HarnessScopeInput>(input: {
  seed(scope: string): void
  acceptsDraftModel(scope: string, model: ModelChoice): boolean
  currentModel(scope: string): ModelChoice | undefined
  setSelectedModel(scope: string, model: ModelChoice): void
  /** A held pick is not the session's harness yet, so its model is a choice the next send carries. */
  holdsHarness(scope: string): boolean
  /** Effort levels and their default belong to the model, so a new one re-asks the harness. */
  reloadOptions(scope: string, params?: ScopeInput): Promise<void> | void
  rememberDraftModel(scope: string, model: ModelChoice, input?: ScopeInput, labels?: DraftDefaultLabels): void
  runtime: {
    setSessionModel(ref: SessionRef, model: ModelChoice): Promise<void>
  }
  cache: HarnessSessionModelSyncCache
}) {
  const syncSessionModel = async (params: ScopeInput | undefined, model: ModelChoice) => {
    const ref = params?.sessionRef
    const key = params ? sessionModelSyncKey(params) : undefined
    if (!ref || !key) return undefined
    const syncValue = `${model.providerId}/${model.modelId}`
    return syncHarnessSessionModel({
      key,
      model: syncValue,
      cache: input.cache,
      request: () => input.runtime.setSessionModel(ref, model),
    })
  }

  const saving = new Map<string, Promise<void>>()

  const setModel = async (scope: string, model: ModelChoice, params?: ScopeInput, labels?: DraftDefaultLabels) => {
    input.seed(scope)
    if ((!params?.sessionId || params.sessionId === "new") && !input.acceptsDraftModel(scope, model)) return
    const previous = input.currentModel(scope)
    input.setSelectedModel(scope, model)
    const changed = previous?.providerId !== model.providerId || previous.modelId !== model.modelId
    if (!params?.sessionId || params.sessionId === "new") {
      input.rememberDraftModel(scope, model, params, labels)
      if (changed) await input.reloadOptions(scope, params)
      return
    }
    if (input.holdsHarness(scope)) {
      if (changed) await input.reloadOptions(scope, params)
      return
    }
    const run = syncSessionModel(params, model)
    if (!run) {
      if (changed) await input.reloadOptions(scope, params)
      return
    }
    saving.set(scope, run)
    try {
      await run
    } catch (error) {
      // A session runs its saved model, so a save that failed must not leave
      // the picker showing one the next turn will not run on.
      const shown = input.currentModel(scope)
      if (previous && shown?.providerId === model.providerId && shown.modelId === model.modelId) input.setSelectedModel(scope, previous)
      throw error
    } finally {
      if (saving.get(scope) === run) saving.delete(scope)
    }
    if (changed) await input.reloadOptions(scope, params)
  }

  /** Settles once the scope's in-flight model save has landed or been rolled back. */
  const settledModel = async (scope: string) => {
    await Promise.allSettled([saving.get(scope)])
  }

  return {
    setModel,
    settledModel,
    syncSessionModel,
  }
}
