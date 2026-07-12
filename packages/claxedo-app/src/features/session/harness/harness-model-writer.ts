import { harnessConfigUrl } from "./harness-config-routes"
import {
  sessionModelSyncKey,
  type HarnessScopeInput,
} from "./store-policy"

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
    .then((res) => {
      const latest = input.cache.getState(input.key)
      if (!res.ok || latest?.desired !== input.model) return
      input.cache.setState(input.key, {
        ...latest,
        synced: input.model,
      })
    })
    .catch(() => {})
    .finally(() => input.cache.removePending(input.key, input.model, run))

  input.cache.setPending(input.key, input.model, run)
  return run
}

export function createHarnessModelWriter<ScopeInput extends HarnessScopeInput>(input: {
  base: string
  seed(scope: string): void
  setSelectedModel(scope: string, model: string): void
  setSelectedAgent(scope: string, name: string): void
  saveModel(scope: string, model: string): void
  saveAgent(scope: string, name: string): void
  dropPrepared(scope: string): void
  runtime: {
    useLocalHarnessConfig(params?: ScopeInput): boolean
    localHarnessConfigFetch(params?: ScopeInput): typeof fetch
  }
  cache: HarnessSessionModelSyncCache
}) {
  const syncSessionModel = async (params: ScopeInput | undefined, model: string) => {
    if (!input.runtime.useLocalHarnessConfig(params)) return
    const key = sessionModelSyncKey(input.base, params)
    if (!key || !model) return
    return syncHarnessSessionModel({
      key,
      model,
      cache: input.cache,
      request: () =>
        input.runtime.localHarnessConfigFetch(params)(
          harnessConfigUrl({
            serverUrl: input.base,
            resource: "harness/model",
          }),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, sessionId: params?.sessionId, directory: params?.directory }),
          },
        ),
    })
  }

  const setModel = async (scope: string, model: string, params?: ScopeInput) => {
    input.seed(scope)
    input.setSelectedModel(scope, model)
    input.saveModel(scope, model)
    if (!params?.sessionId || params.sessionId === "new") {
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
