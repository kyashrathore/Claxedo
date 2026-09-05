/** Fences new calls while admitted operations and their producer tails drain. */
export function createRuntimeLifecycle() {
  let closing = false
  let disposal: Promise<void> | undefined
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

  function resource<T extends Record<string, (...args: any[]) => Promise<any>>>(methods: T): T {
    return Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, (...args: any[]) => {
      if (closing) return Promise.reject(new Error("AgentRuntime is disposed"))
      return track(() => method(...args))
    }])) as T
  }

  return {
    get closing() { return closing },
    track,
    resource,
    dispose(stop: () => Promise<unknown>, cleanup: () => void) {
      if (disposal) return disposal
      closing = true
      disposal = (async () => {
        const stopped = Promise.resolve().then(stop)
        // Observe early teardown failure while admitted producers drain.
        void stopped.catch(() => {})
        while (pendingTasks.size) await Promise.all([...pendingTasks])
        await stopped
        cleanup()
      })()
      void disposal.catch((error) => console.error("AgentRuntime disposal failed", error))
      return disposal
    },
  }
}
