import type { Disposer, Registry } from "@/shell"

export class PluginDisposedError extends Error {
  constructor(readonly pluginId: string) {
    super(`Plugin ${pluginId} is off; it can no longer register anything`)
    this.name = "PluginDisposedError"
  }
}

export type RegistrationSink = {
  readonly add: <Entry>(registry: Registry<Entry>, entry: Entry) => Disposer
  readonly track: (dispose: Disposer) => Disposer
  readonly disposeAll: () => void
}

export function createRegistrationSink(pluginId: string): RegistrationSink {
  const disposers = new Set<Disposer>()
  let closed = false
  const track = (remove: Disposer): Disposer => {
    if (closed) {
      remove()
      throw new PluginDisposedError(pluginId)
    }
    const dispose: Disposer = () => {
      if (!disposers.delete(dispose)) return
      remove()
    }
    disposers.add(dispose)
    return dispose
  }
  return {
    add: (registry, entry) => {
      if (closed) throw new PluginDisposedError(pluginId)
      return track(registry.add(entry))
    },
    track,
    disposeAll: () => {
      closed = true
      for (const dispose of [...disposers].reverse()) dispose()
    },
  }
}
