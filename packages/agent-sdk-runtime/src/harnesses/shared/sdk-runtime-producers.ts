/** Tracks native creates and complete stream generators, including their post-terminal writes. */
export function createSdkRuntimeProducers() {
  const pending = new Set<Promise<void>>()
  let disposal: Promise<void> | undefined
  return {
    begin() {
      if (disposal) throw new Error("SDK adapter is disposed")
      let resolve!: () => void
      const producer = new Promise<void>((done) => { resolve = done })
      pending.add(producer)
      return () => { pending.delete(producer); resolve() }
    },
    dispose(stop: () => void | Promise<void>, close: () => void): Promise<void> {
      if (disposal) return disposal
      let resolve!: () => void
      let reject!: (error: unknown) => void
      disposal = new Promise<void>((done, fail) => { resolve = done; reject = fail })
      try {
        const stopped = stop()
        if (!pending.size && !stopped) {
          close()
          resolve()
        } else {
          void Promise.all([stopped, ...pending]).then(close).then(resolve, reject)
        }
      } catch (error) { reject(error) }
      void disposal.catch((error) => console.error("SDK adapter disposal failed", error))
      return disposal
    },
  }
}
