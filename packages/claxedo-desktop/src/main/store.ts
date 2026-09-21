import Store from "electron-store"

import { SETTINGS_STORE } from "./constants"
import { assertStoreName } from "./store-policy"

const cache = new Map<string, Store>()

export function getStore(name = SETTINGS_STORE) {
  // `name` arrives from the renderer over IPC and `conf` resolves
  // `${name}.json` under its cwd — see ./store-policy for the grammar.
  assertStoreName(name)
  const cached = cache.get(name)
  if (cached) return cached
  const next = new Store({ name })
  cache.set(name, next)
  return next
}

export const store = getStore(SETTINGS_STORE)
