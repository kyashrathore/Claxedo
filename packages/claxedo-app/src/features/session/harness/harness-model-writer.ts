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
  cache: HarnessSessionModelSyncCache
}) {
  const current = input.cache.getState(input.key) ?? {}
  input.cache.setState(input.key, {
    ...current,
    desired: input.model,
  })
  if (current.synced === input.model) return

  const pending = input.cache.getPending(input.key, input.model)
  if (pending) return pending

  const run = input.request()
    .then(async (res) => {
      const latest = input.cache.getState(input.key)
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `Failed to update session model (${res.status})`)
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
  base: string
  seed(scope: string): void
  acceptsDraftModel(scope: string, model: ModelKey): boolean
  setSelectedModel(scope: string, model: ModelKey): void
  setSelectedAgent(scope: string, name: string): void
  saveModel(scope: string, model: string): void
  saveAgent(scope: string, name: string): void
  rememberDraftModel(scope: string, model: ModelKey, input?: ScopeInput, labels?: DraftDefaultLabels): void
  dropPrepared(scope: string): void
  runtime: {
    harnessSessionFetch(params?: ScopeInput): typeof fetch
  }
  cache: HarnessSessionModelSyncCache
}) {
  const syncSessionModel = async (params: ScopeInput | undefined, model: ModelKey) => {
    const key = sessionModelSyncKey(input.base, params)
    if (!key) return
    const syncValue = `${model.providerID}/${model.modelID}`
    return syncHarnessSessionModel({
      key,
      model: syncValue,
      cache: input.cache,
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

  const setModel = async (scope: string, model: ModelKey, params?: ScopeInput, labels?: DraftDefaultLabels) => {
    input.seed(scope)
    if ((!params?.sessionId || params.sessionId === "new") && !input.acceptsDraftModel(scope, model)) return
    input.setSelectedModel(scope, model)
    input.saveModel(scope, JSON.stringify(model))
    if (!params?.sessionId || params.sessionId === "new") {
      input.rememberDraftModel(scope, model, params, labels)
      input.dropPrepared(scope)
      return
    }
    await syncSessionModel(params, model)
  }

  const setAgent = (scope: string, name: string) => {
    input.seed(scope)
    input.setSelectedAgent(scope, name)
    input.saveAgent(scope, name)
  }

  return {
    setAgent,
    setModel,
    syncSessionModel,
  }
}
