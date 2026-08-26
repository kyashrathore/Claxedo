export type DisclosureResource = {
  initialize(): Promise<unknown>
  terminate(): void
}

/** Ref-counts a heavy resource and disposes it after all synchronous owner cleanup has run. */
export function createDisclosurePool<T extends DisclosureResource>(create: () => T) {
  let resource: T | undefined
  let leases = 0
  let generation = 0

  const ensure = () => (resource ??= create())
  const start = () => {
    const value = ensure()
    void value.initialize()
    return value
  }

  return {
    acquire(enabled = true) {
      if (!enabled) return { resource: undefined, release() {} }
      const value = start()
      leases += 1
      generation += 1
      let released = false
      return {
        resource: value as T | undefined,
        release() {
          if (released) return
          released = true
          leases = Math.max(0, leases - 1)
          if (leases !== 0) return
          const releaseGeneration = ++generation
          queueMicrotask(() => {
            if (leases !== 0 || generation !== releaseGeneration) return
            resource?.terminate()
            resource = undefined
          })
        },
      }
    },
    get() {
      return start()
    },
    inspect() {
      return { leases, started: !!resource }
    },
  }
}
