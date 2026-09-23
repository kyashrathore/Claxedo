import type { Disposer, Registry } from "@/shell/types"

export type RegistrationSink = {
  readonly add: <Entry>(registry: Registry<Entry>, entry: Entry) => Disposer
  readonly disposeAll: () => void
}

export function createRegistrationSink(): RegistrationSink {
  const disposers = new Set<Disposer>()
  return {
    add: (registry, entry) => {
      const remove = registry.add(entry)
      const dispose: Disposer = () => {
        if (!disposers.delete(dispose)) return
        remove()
      }
      disposers.add(dispose)
      return dispose
    },
    disposeAll: () => {
      for (const dispose of [...disposers]) dispose()
    },
  }
}
