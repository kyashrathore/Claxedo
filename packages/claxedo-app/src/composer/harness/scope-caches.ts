import type { HarnessHydratorCache } from "./harness-hydrator"
import type { HarnessSessionModelSyncCache, SessionModelSyncState } from "./harness-model-writer"
import type { HarnessOptionsLoaderCache } from "./harness-options-loader"
import type { HarnessSwitcherCache } from "./harness-switcher"

function pendingSlots<Value>() {
  const slots = new Map<string, Value>()
  return {
    get: (key: string) => slots.get(key),
    set: (key: string, value: Value) => void slots.set(key, value),
    remove: (key: string, value: Value) => {
      if (slots.get(key) === value) slots.delete(key)
    },
  }
}

function optionsCache(): HarnessOptionsLoaderCache {
  const seq = new Map<string, number>()
  return {
    nextSeq: (scope) => {
      const next = (seq.get(scope) ?? 0) + 1
      seq.set(scope, next)
      return next
    },
    getSeq: (scope) => seq.get(scope),
  }
}

function hydratorCache(): HarnessHydratorCache {
  const seen = new Map<string, string>()
  const hydrations = pendingSlots<Promise<void>>()
  return {
    getSeen: (scope) => seen.get(scope),
    setSeen: (scope, key) => void seen.set(scope, key),
    clearSeen: (scope) => void seen.delete(scope),
    getPending: hydrations.get,
    setPending: hydrations.set,
    removePending: hydrations.remove,
  }
}

function sessionModelCache(): HarnessSessionModelSyncCache {
  const states = new Map<string, SessionModelSyncState>()
  const syncs = pendingSlots<Promise<void>>()
  return {
    getState: (key) => states.get(key),
    setState: (key, value) => void states.set(key, value),
    getPending: (key, model) => syncs.get(`${key}\n${model}`),
    setPending: (key, model, value) => syncs.set(`${key}\n${model}`, value),
    removePending: (key, model, value) => syncs.remove(`${key}\n${model}`, value),
  }
}

export type ScopeCaches = ReturnType<typeof createScopeCaches>

export function createScopeCaches() {
  const options = optionsCache()
  const switches = pendingSlots<Promise<void>>()
  const switcher: HarnessSwitcherCache = {
    getPending: switches.get,
    setPending: switches.set,
    removePending: switches.remove,
  }
  return { options, hydrator: hydratorCache(), switcher, sessionModel: sessionModelCache() }
}
