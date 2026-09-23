import { sessionResourceUrl } from "./harness-config-routes"
import {
  sessionModelSyncKey,
  type HarnessScopeInput,
} from "./store-policy"
import type { ModelKey } from "@/features/session/composer/model-strategy"
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
  request: () => Promise<Response>
  publishConfig?: (config: unknown) => void
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
    .then(async (res) => {
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `Failed to update session model (${res.status})`)
      const config = await res.json().catch(() => undefined)
      const latest = input.cache.getState(input.key)
      if (latest?.desired !== input.model) return
      if (config !== undefined) input.publishConfig?.(config)
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
  base: string
  seed(scope: string): void
  acceptsDraftModel(scope: string, model: ModelKey): boolean
  currentModel(scope: string): ModelKey | undefined
  setSelectedModel(scope: string, model: ModelKey): void
  /** A held pick is not the session's harness yet, so its model is a choice the next send carries. */
  holdsHarness(scope: string): boolean
  /** Effort levels and their default belong to the model, so a new one re-asks the harness. */
  reloadOptions(scope: string, params?: ScopeInput): Promise<void> | void
  rememberDraftModel(scope: string, model: ModelKey, input?: ScopeInput, labels?: DraftDefaultLabels): void
  publishSessionConfig(input: ScopeInput, config: unknown): void
  dropPrepared(scope: string): void
  runtime: {
    harnessSessionFetch(params?: ScopeInput): typeof fetch
  }
  cache: HarnessSessionModelSyncCache
}) {
  const syncSessionModel = async (params: ScopeInput | undefined, model: ModelKey) => {
    const key = sessionModelSyncKey({ serverUrl: input.base, ...params })
    if (!key) return undefined
    const syncValue = `${model.providerID}/${model.modelID}`
    return syncHarnessSessionModel({
      key,
      model: syncValue,
      cache: input.cache,
      publishConfig: (config) => input.publishSessionConfig(params!, config),
      request: () =>
        input.runtime.harnessSessionFetch(params)(
          sessionResourceUrl({
            serverUrl: input.base,
            resource: "config",
            sessionID: params!.sessionId!,
            directory: params!.directory!,
          }),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model }),
          },
        ),
    })
  }

  const saving = new Map<string, Promise<void>>()

  const setModel = async (scope: string, model: ModelKey, params?: ScopeInput, labels?: DraftDefaultLabels) => {
    input.seed(scope)
    if ((!params?.sessionId || params.sessionId === "new") && !input.acceptsDraftModel(scope, model)) return
    const previous = input.currentModel(scope)
    input.setSelectedModel(scope, model)
    const changed = previous?.providerID !== model.providerID || previous.modelID !== model.modelID
    if (!params?.sessionId || params.sessionId === "new") {
      input.rememberDraftModel(scope, model, params, labels)
      input.dropPrepared(scope)
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
      if (previous && shown?.providerID === model.providerID && shown.modelID === model.modelID) input.setSelectedModel(scope, previous)
      throw error
    } finally {
      if (saving.get(scope) === run) saving.delete(scope)
    }
    if (changed) await input.reloadOptions(scope, params)
  }

  /** Settles once the scope's in-flight model save has landed or been rolled back. */
  const settledModel = async (scope: string) => {
    await saving.get(scope)?.catch(() => undefined)
  }

  return {
    setModel,
    settledModel,
    syncSessionModel,
  }
}
