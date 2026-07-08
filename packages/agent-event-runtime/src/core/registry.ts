import type { HarnessEventAdapter } from "./adapter"

export type AdapterRegistry = {
  register: <State>(adapter: HarnessEventAdapter<State>) => void
  get: (name: string) => HarnessEventAdapter<unknown> | undefined
}

export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<string, HarnessEventAdapter<unknown>>()
  return {
    register(adapter) {
      adapters.set(adapter.name, adapter as unknown as HarnessEventAdapter<unknown>)
    },
    get(name) {
      return adapters.get(name)
    },
  }
}
