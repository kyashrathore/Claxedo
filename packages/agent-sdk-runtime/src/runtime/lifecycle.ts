export type RuntimeDisposeResult = { ok: true } | { ok: false; error: unknown }

/** Fences new calls while admitted operations and their producer tails drain. */
export function createRuntimeLifecycle(input: { onTeardownFailure: (error: unknown) => void }) {
  let closing = false
  let disposal: Promise<RuntimeDisposeResult> | undefined
  const pendingTasks = new Set<Promise<void>>()

  function track<T>(operation: () => T): T {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    pendingTasks.add(pending)
    const done = () => { pendingTasks.delete(pending); finish() }
    try {
      const result = operation()
      if (result instanceof Promise) void result.then(done, done)
      else done()
      return result
    } catch (error) { done(); throw error }
  }

  type ResourceMethods = Record<string, (...args: any[]) => Promise<any>>
  function resource<T extends ResourceMethods>(methods: T): T
  // Each wrapper has the signature of the method it replaces, so the wrapped map
  // keeps the caller's type; the implementation is typed at the shape it walks.
  function resource(methods: ResourceMethods): ResourceMethods {
    return Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, (...args: any[]) => {
      if (closing) return Promise.reject(new Error("AgentRuntime is disposed"))
      return track(() => method(...args))
    }]))
  }

  return {
    get closing() { return closing },
    track,
    resource,
    /**
     * A teardown failure is reported and returned as soon as it happens. It
     * cannot wait for `pendingTasks`, because the producer that will not drain
     * is exactly the one whose owner needs to hear that its stop failed.
     *
     * Resolving early is not permission to close what the failed teardown still
     * owns: `cleanup` runs only once the producers have actually drained, so a
     * caller that treats the result as final still leaves the store open to the
     * writers that are live.
     */
    dispose(stop: () => Promise<unknown>, cleanup: () => void): Promise<RuntimeDisposeResult> {
      if (disposal) return disposal
      closing = true
      const drained = (async () => {
        while (pendingTasks.size) await Promise.all(pendingTasks)
      })()
      disposal = (async () => {
        const failure = await Promise.resolve().then(stop).then(
          () => undefined,
          (error: unknown) => error ?? new Error("AgentRuntime teardown failed"),
        )
        if (failure !== undefined) {
          input.onTeardownFailure(failure)
          void drained.then(cleanup, (error: unknown) => input.onTeardownFailure(error))
          return { ok: false as const, error: failure }
        }
        await drained
        cleanup()
        return { ok: true as const }
      })()
      return disposal
    },
  }
}
