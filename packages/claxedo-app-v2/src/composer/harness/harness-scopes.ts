import { batch } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { sameHarnessSelection } from "@/lib/harness-selection"
import type { HarnessType } from "./profile"
import { initialHarnessStoreState, type HarnessStorePatch, type HarnessStoreState } from "./store-state"

export type HarnessScopes = ReturnType<typeof createHarnessScopes>

export function createHarnessScopes() {
  const [store, setStore] = createStore<Record<string, HarnessStoreState>>({})
  const initialByScope = new Map<string, HarnessStoreState>()
  const initialState = (scope: string) => {
    const existing = initialByScope.get(scope)
    if (existing) return existing
    const created = initialHarnessStoreState({ scope })
    initialByScope.set(scope, created)
    return created
  }
  const seed = (scope: string) => {
    if (store[scope]) return
    setStore(scope, initialState(scope))
    initialByScope.delete(scope)
  }
  return {
    store,
    setStore,
    seed,
    read: (scope: string) => store[scope] ?? initialState(scope),
    applyPatch: (scope: string, patch: HarnessStorePatch) => batch(() => {
      seed(scope)
      setStore(scope, patch)
    }),
  }
}

/** Show `patch` in an existing session's scope as a choice, keeping what the session itself runs. */
export function holdHarness(scopes: HarnessScopes, scope: string, patch: HarnessStorePatch) {
  scopes.seed(scope)
  const { heldFrom, ...bound } = structuredClone(unwrap(scopes.read(scope)))
  scopes.setStore(scope, { ...patch, heldFrom: heldFrom ?? bound })
}

/** Undo a held pick when `type` is the harness the session still runs. */
export function restoreHeldHarness(scopes: HarnessScopes, scope: string, type: HarnessType) {
  const heldFrom = scopes.read(scope).heldFrom
  if (!heldFrom || !sameHarnessSelection(heldFrom.harness, type)) return false
  scopes.setStore({ [scope]: structuredClone(unwrap(heldFrom)) })
  return true
}
