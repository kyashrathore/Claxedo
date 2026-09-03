import { queryClient, removeExactQuery } from "@/platform/query/query-client"
import { sessionConfigRawQueryKey } from "../store/session-config-selection"
import type { PreparedRuntimeSession } from "./prepared-session"
import {
  harnessChangeRequestKey,
  harnessHydrateRequestKey,
  harnessHydrateSeenKey,
  harnessOptionsSeqKey,
  harnessOptionsTriesKey,
  harnessPreparedSessionKey,
  harnessPreparedSessionSeqKey,
  harnessPreparingSessionKey,
  sessionModelSyncRequestKey,
  sessionModelSyncStateKey,
  type HarnessScopeInput,
} from "./store-policy"
import type { HarnessHydratorCache } from "./harness-hydrator"
import {
  syncHarnessSessionModel as syncHarnessSessionModelWithCache,
  type HarnessSessionModelSyncCache,
  type SessionModelSyncState,
} from "./harness-model-writer"
import type { HarnessOptionsLoaderCache } from "./harness-options-loader"
import type {
  PreparedRuntimeSessionCache,
  PreparedRuntimeSessionPending,
} from "./harness-prepared-runtime-session"
import type { HarnessSwitcherCache } from "./harness-switcher"

export function createSessionModelSyncQueryCache(): HarnessSessionModelSyncCache {
  return {
    getState: (key) => queryClient.getQueryData<SessionModelSyncState>(sessionModelSyncStateKey(key)),
    setState: (key, value) => queryClient.setQueryData(sessionModelSyncStateKey(key), value),
    getPending: (key, model) => queryClient.getQueryData<Promise<void>>(sessionModelSyncRequestKey(key, model)),
    setPending: (key, model, value) => queryClient.setQueryData(sessionModelSyncRequestKey(key, model), value),
    removePending: (key, model, value) => {
      if (queryClient.getQueryData(sessionModelSyncRequestKey(key, model)) === value) {
        removeExactQuery(sessionModelSyncRequestKey(key, model))
      }
    },
  }
}

export function syncHarnessSessionModel(input: {
  key: string
  model: string
  request: () => Promise<Response>
}) {
  return syncHarnessSessionModelWithCache({
    ...input,
    cache: createSessionModelSyncQueryCache(),
  })
}

export function createPreparedRuntimeSessionQueryCache(serverUrl: string): PreparedRuntimeSessionCache {
  return {
    getSeq: (scope) => queryClient.getQueryData<number>(harnessPreparedSessionSeqKey(serverUrl, scope)),
    setSeq: (scope, value) => queryClient.setQueryData(harnessPreparedSessionSeqKey(serverUrl, scope), value),
    getPrepared: (scope) => queryClient.getQueryData<PreparedRuntimeSession>(harnessPreparedSessionKey(serverUrl, scope)),
    setPrepared: (scope, value) => queryClient.setQueryData(harnessPreparedSessionKey(serverUrl, scope), value),
    removePrepared: (scope) => removeExactQuery(harnessPreparedSessionKey(serverUrl, scope)),
    getPreparing: (scope) => queryClient.getQueryData<PreparedRuntimeSessionPending>(harnessPreparingSessionKey(serverUrl, scope)),
    setPreparing: (scope, value) => queryClient.setQueryData(harnessPreparingSessionKey(serverUrl, scope), value),
    removePreparing: (scope) => removeExactQuery(harnessPreparingSessionKey(serverUrl, scope)),
  }
}

export function createHarnessOptionsQueryCache(serverUrl: string): HarnessOptionsLoaderCache {
  return {
    nextSeq: (scope) => {
      const next = (queryClient.getQueryData<number>(harnessOptionsSeqKey(serverUrl, scope)) ?? 0) + 1
      queryClient.setQueryData(harnessOptionsSeqKey(serverUrl, scope), next)
      return next
    },
    getSeq: (scope) => queryClient.getQueryData<number>(harnessOptionsSeqKey(serverUrl, scope)),
    getTries: (scope) => queryClient.getQueryData<number>(harnessOptionsTriesKey(serverUrl, scope)),
    setTries: (scope, value) => queryClient.setQueryData(harnessOptionsTriesKey(serverUrl, scope), value),
    clearTries: (scope) => clearHarnessOptionsTries(serverUrl, scope),
  }
}

export function clearHarnessOptionsTries(serverUrl: string, scope: string) {
  removeExactQuery(harnessOptionsTriesKey(serverUrl, scope))
}

export function createHarnessHydratorQueryCache<ScopeInput extends HarnessScopeInput>(
  serverUrl: string,
): HarnessHydratorCache<ScopeInput> {
  return {
    getSeen: (scope) => queryClient.getQueryData<string>(harnessHydrateSeenKey(serverUrl, scope)),
    setSeen: (scope, key) => queryClient.setQueryData(harnessHydrateSeenKey(serverUrl, scope), key),
    clearSeen: (scope) => removeExactQuery(harnessHydrateSeenKey(serverUrl, scope)),
    getPending: (scope) => queryClient.getQueryData<Promise<void>>(harnessHydrateRequestKey(serverUrl, scope)),
    setPending: (scope, value) => queryClient.setQueryData(harnessHydrateRequestKey(serverUrl, scope), value),
    removePending: (scope, value) => {
      if (queryClient.getQueryData(harnessHydrateRequestKey(serverUrl, scope)) === value) {
        removeExactQuery(harnessHydrateRequestKey(serverUrl, scope))
      }
    },
    fetchSessionConfig: async (input, run) => await queryClient.fetchQuery({
      queryKey: sessionConfigRawQueryKey({
        sessionID: input.sessionId!,
        directory: input.directory,
        sessionRef: input.sessionRef,
        serverUrl,
      }),
      staleTime: 30 * 1000,
      queryFn: run,
    }),
  }
}

export function createHarnessSwitcherQueryCache(serverUrl: string): HarnessSwitcherCache {
  return {
    getPending: (key) => queryClient.getQueryData<Promise<void>>(harnessChangeRequestKey(key)),
    setPending: (key, value) => queryClient.setQueryData(harnessChangeRequestKey(key), value),
    removePending: (key, value) => {
      if (queryClient.getQueryData(harnessChangeRequestKey(key)) === value) {
        removeExactQuery(harnessChangeRequestKey(key))
      }
    },
    clearOptionsTries: (scope) => clearHarnessOptionsTries(serverUrl, scope),
  }
}
