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

export function createPreparedRuntimeSessionQueryCache(): PreparedRuntimeSessionCache {
  return {
    getSeq: (scope) => queryClient.getQueryData<number>(harnessPreparedSessionSeqKey(scope)),
    setSeq: (scope, value) => queryClient.setQueryData(harnessPreparedSessionSeqKey(scope), value),
    getPrepared: (scope) => queryClient.getQueryData<PreparedRuntimeSession>(harnessPreparedSessionKey(scope)),
    setPrepared: (scope, value) => queryClient.setQueryData(harnessPreparedSessionKey(scope), value),
    removePrepared: (scope) => removeExactQuery(harnessPreparedSessionKey(scope)),
    getPreparing: (scope) => queryClient.getQueryData<PreparedRuntimeSessionPending>(harnessPreparingSessionKey(scope)),
    setPreparing: (scope, value) => queryClient.setQueryData(harnessPreparingSessionKey(scope), value),
    removePreparing: (scope) => removeExactQuery(harnessPreparingSessionKey(scope)),
  }
}

export function createHarnessOptionsQueryCache(): HarnessOptionsLoaderCache {
  return {
    nextSeq: (scope) => {
      const next = (queryClient.getQueryData<number>(harnessOptionsSeqKey(scope)) ?? 0) + 1
      queryClient.setQueryData(harnessOptionsSeqKey(scope), next)
      return next
    },
    getSeq: (scope) => queryClient.getQueryData<number>(harnessOptionsSeqKey(scope)),
    getTries: (scope) => queryClient.getQueryData<number>(harnessOptionsTriesKey(scope)),
    setTries: (scope, value) => queryClient.setQueryData(harnessOptionsTriesKey(scope), value),
    clearTries: clearHarnessOptionsTries,
  }
}

export function clearHarnessOptionsTries(scope: string) {
  removeExactQuery(harnessOptionsTriesKey(scope))
}

export function createHarnessHydratorQueryCache<ScopeInput extends HarnessScopeInput>(
  serverUrl: string,
): HarnessHydratorCache<ScopeInput> {
  return {
    getSeen: (scope) => queryClient.getQueryData<string>(harnessHydrateSeenKey(scope)),
    setSeen: (scope, key) => queryClient.setQueryData(harnessHydrateSeenKey(scope), key),
    clearSeen: (scope) => removeExactQuery(harnessHydrateSeenKey(scope)),
    getPending: (scope) => queryClient.getQueryData<Promise<void>>(harnessHydrateRequestKey(scope)),
    setPending: (scope, value) => queryClient.setQueryData(harnessHydrateRequestKey(scope), value),
    removePending: (scope, value) => {
      if (queryClient.getQueryData(harnessHydrateRequestKey(scope)) === value) {
        removeExactQuery(harnessHydrateRequestKey(scope))
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

export function createHarnessSwitcherQueryCache(): HarnessSwitcherCache {
  return {
    getPending: (key) => queryClient.getQueryData<Promise<void>>(harnessChangeRequestKey(key)),
    setPending: (key, value) => queryClient.setQueryData(harnessChangeRequestKey(key), value),
    removePending: (key, value) => {
      if (queryClient.getQueryData(harnessChangeRequestKey(key)) === value) {
        removeExactQuery(harnessChangeRequestKey(key))
      }
    },
    clearOptionsTries: clearHarnessOptionsTries,
  }
}
