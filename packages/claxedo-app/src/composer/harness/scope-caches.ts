import type { HarnessHydratorCache } from "./harness-hydrator"
import type { HarnessOptionsLoaderCache } from "./harness-options-loader"
import type { HarnessSwitcherCache } from "./harness-switcher"
import type { HarnessScopeInput } from "./store-policy"

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

function hydratorCache(): HarnessHydratorCache<HarnessScopeInput> {
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

export type ScopeCaches = ReturnType<typeof createScopeCaches>

export function createScopeCaches() {
  const options = optionsCache()
  const switches = pendingSlots<Promise<void>>()
  const switcher: HarnessSwitcherCache = {
    getPending: switches.get,
    setPending: switches.set,
    removePending: switches.remove,
  }
  return { options, hydrator: hydratorCache(), switcher }
}
